"""
Self-healing YouTube selectors — AI proposes new CSS selectors when DOM changes.

Design:
  - NEVER auto-edit MMB_YOUTUBE_SELECTORS_FINAL_V2.py (too risky)
  - Overrides stored in data/selector_overrides.json
  - behavior.youtube.selectors merges overrides at load time
  - Heal history in data/selector_heals/ for audit trail
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("mmb.selector_healer")

_ROOT = Path(__file__).resolve().parent.parent
_OVERRIDES_FILE = _ROOT / "data" / "selector_overrides.json"
_HEAL_DIR = _ROOT / "data" / "selector_heals"
_V2_FILE = _ROOT / "MMB_YOUTUBE_SELECTORS_FINAL_V2.py"

# All user-facing ACTION selector keys the healer can patch.
# (Internal keys like progress_bar / heatmap / storyboard are intentionally
#  excluded — they aren't bot actions.) Keys not present in the loaded
# selector set are skipped in get_status(), so this list can stay broad.
HEALABLE_KEYS: tuple[str, ...] = (
    # Ads
    "ad_skip_button",
    "ad_overlay_close",
    # Playback
    "play_button",
    "pause_button",
    "large_play_button_center",
    "mute_button",
    "captions_subtitles_button",
    # Settings menu (quality / speed)
    "settings_gear_button",
    "quality_menu_item",
    "quality_submenu_radio",
    "playback_speed_menu_item",
    "playback_speed_submenu_radio",
    # Engagement
    "like_button",
    "dislike_button",
    "subscribe_button",
    "bell_notification_button",
    "bell_all_notifications_option",
    # Comment
    "comment_input_placeholder_click",
    "comment_input_active_typing",
    "comment_submit_button",
    "comment_like_button",
    # Autoplay / Description
    "autoplay_toggle_button",
    "description_more_button",
    "description_text_expanded",
)


def _load_overrides() -> dict[str, list[str]]:
    if not _OVERRIDES_FILE.exists():
        return {}
    try:
        data = json.loads(_OVERRIDES_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as e:
        log.warning("selector_overrides load failed: %s", e)
        return {}


def _save_overrides(data: dict[str, list[str]]) -> None:
    _OVERRIDES_FILE.parent.mkdir(parents=True, exist_ok=True)
    _OVERRIDES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def get_overrides() -> dict[str, list[str]]:
    return _load_overrides()


def get_merged_selector_count(key: str) -> int:
    """How many selectors exist for a key (V2 + overrides)."""
    try:
        from server_python.behavior.youtube.selectors import DESKTOP
        base = DESKTOP.get(key, ())
        return len(base) if base else 0
    except Exception:
        return 0


def get_status() -> dict[str, Any]:
    overrides = _load_overrides()
    v2_exists = _V2_FILE.exists()
    heal_count = len(list(_HEAL_DIR.glob("*.json"))) if _HEAL_DIR.exists() else 0
    keys_status = []
    try:
        from server_python.behavior.youtube.selectors import DESKTOP
        for key in HEALABLE_KEYS:
            base = list(DESKTOP.get(key, ()))
            extra = overrides.get(key, [])
            # Skip keys that don't exist in the loaded selector set (no empty rows),
            # UNLESS the user has already added an override for them.
            if not base and not extra:
                continue
            keys_status.append({
                "key": key,
                "v2Count": len(base) - len(extra),
                "overrideCount": len(extra),
                "totalCount": len(base),
                "overrides": extra[:5],
            })
    except Exception as e:
        keys_status = [{"error": str(e)}]

    # Ad-skip failure tracker — Self-Healing page pe banner ke liye
    try:
        from server_python.ad_skip_failure_tracker import get_status as _adskip_status
        ad_skip_failures = _adskip_status()
    except Exception:
        ad_skip_failures = {}

    return {
        "v2FileExists": v2_exists,
        "v2FilePath": str(_V2_FILE),
        "overridesFile": str(_OVERRIDES_FILE),
        "overrideKeys": list(overrides.keys()),
        "healHistoryCount": heal_count,
        "healableKeys": list(HEALABLE_KEYS),
        "keys": keys_status,
        "adSkipFailures": ad_skip_failures,
    }


def apply_override(key: str, selectors: list[str], mode: str = "prepend") -> dict:
    """
    Add selectors to override store.
    mode: prepend (try first) | append (fallback) | replace (only overrides)
    """
    if key not in HEALABLE_KEYS:
        return {"success": False, "error": f"Key '{key}' not healable"}
    clean = [s.strip() for s in selectors if s and s.strip()]
    if not clean:
        return {"success": False, "error": "No valid selectors provided"}

    overrides = _load_overrides()
    existing = overrides.get(key, [])

    if mode == "replace":
        overrides[key] = clean
    elif mode == "append":
        merged = list(dict.fromkeys(existing + clean))
        overrides[key] = merged
    else:  # prepend
        merged = list(dict.fromkeys(clean + existing))
        overrides[key] = merged

    _save_overrides(overrides)

    # Invalidate selector cache by touching module — next import reloads
    try:
        from server_python.behavior.youtube import selectors as sel_mod
        sel_mod._apply_selector_overrides()  # type: ignore[attr-defined]
    except Exception:
        pass

    record = {
        "ts": int(time.time()),
        "key": key,
        "mode": mode,
        "added": clean,
        "total": overrides[key],
    }
    _save_heal_record(record)

    # Ad-skip heal apply hua → failure counter reset (fresh start naye selector ke saath)
    if key == "ad_skip_button":
        try:
            from server_python.ad_skip_failure_tracker import clear as _clear_adskip_failures
            _clear_adskip_failures()
        except Exception:
            pass

    log.info("[SelectorHealer] Applied override for %s: +%d selectors", key, len(clean))
    return {"success": True, "key": key, "selectors": overrides[key], "record": record}


def remove_override(key: str, selector: str | None = None) -> dict:
    overrides = _load_overrides()
    if key not in overrides:
        return {"success": False, "error": "No overrides for this key"}
    if selector:
        overrides[key] = [s for s in overrides[key] if s != selector]
        if not overrides[key]:
            del overrides[key]
    else:
        del overrides[key]
    _save_overrides(overrides)
    return {"success": True, "overrides": overrides}


def _save_heal_record(record: dict) -> None:
    _HEAL_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"heal_{record.get('key', 'unknown')}_{int(time.time())}.json"
    (_HEAL_DIR / fname).write_text(json.dumps(record, indent=2), encoding="utf-8")


def ai_propose_selectors(
    element_key: str,
    element_description: str,
    dom_dump: str = "",
    screenshot_b64: str | None = None,
) -> dict:
    """
    Ask Claude (Opus tier) to propose new CSS selectors from DOM dump or screenshot.
    Returns proposed selectors — does NOT auto-apply (user confirms in UI).
    """
    from server_python.ai_brain import _call, is_available

    if not is_available():
        return {"success": False, "error": "AI not configured — set ANTHROPIC_API_KEY"}

    prompt = (
        f"YouTube DOM changed. I need NEW CSS selectors for: **{element_key}**\n"
        f"Element purpose: {element_description}\n\n"
    )
    if dom_dump:
        prompt += f"Live DOM dump:\n{dom_dump[:4000]}\n\n"
    prompt += (
        "Rules:\n"
        "- Propose 2-5 robust CSS selectors (prefer aria-label, role, stable classes)\n"
        "- Avoid brittle auto-generated IDs unless no alternative\n"
        "- Selectors must work in desktop YouTube 2025-2026\n\n"
        'Reply as JSON only:\n'
        '{"selectors": ["sel1", "sel2"], "confidence": 0.0-1.0, "explanation": "...", "fallback_strategy": "..."}'
    )

    result = _call(prompt, max_tokens=300, image_b64=screenshot_b64, task="selector_heal")
    if not result:
        return {"success": False, "error": "AI returned no content"}

    import re
    try:
        m = re.search(r"\{.*\}", result, re.DOTALL)
        if m:
            data = json.loads(m.group())
            sels = data.get("selectors") or []
            if isinstance(sels, list) and sels:
                return {
                    "success": True,
                    "key": element_key,
                    "proposed": [str(s) for s in sels if s],
                    "confidence": data.get("confidence", 0.5),
                    "explanation": data.get("explanation", ""),
                    "fallbackStrategy": data.get("fallback_strategy", ""),
                }
    except Exception as e:
        log.warning("selector_heal parse error: %s", e)

    return {"success": False, "error": "Could not parse AI response", "raw": result[:500]}


def get_heal_history(limit: int = 20) -> list[dict]:
    if not _HEAL_DIR.exists():
        return []
    files = sorted(_HEAL_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for f in files[:limit]:
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    return out
