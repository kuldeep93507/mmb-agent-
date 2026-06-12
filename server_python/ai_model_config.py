"""
Tiered AI model routing — Haiku (cheap) / Sonnet (balanced) / Opus (powerful).

Task → tier mapping keeps cost low for frequent calls while using stronger models
for vision, error recovery, and selector healing.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Literal

log = logging.getLogger("mmb.ai_model_config")

TaskTier = Literal["simple", "balanced", "powerful"]

# Default Anthropic model IDs (user can override in Settings UI)
DEFAULT_MODELS: dict[TaskTier, str] = {
    "simple":    "claude-haiku-4-5",
    "balanced":  "claude-sonnet-4-5",
    "powerful":  "claude-opus-4-5",
}

# Which ai_brain function uses which tier
TASK_TIER_MAP: dict[str, TaskTier] = {
    "generate_comment":       "simple",
    "pick_keyword":           "simple",
    "pick_keyword_persona":   "simple",
    "watch_pattern":          "simple",
    "identify_video":         "balanced",
    "scan_page":              "balanced",
    "verify_engagement":      "balanced",
    "recover_error":          "balanced",
    "vision_ad_skip":         "balanced",
    "selector_heal":          "powerful",
    "popup_solve":            "powerful",
}

_SETTINGS_FILE = Path(__file__).resolve().parent.parent / "user-settings.json"
_cached: dict | None = None


def _load_settings() -> dict:
    global _cached
    if _cached is not None:
        return _cached
    try:
        if _SETTINGS_FILE.exists():
            _cached = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
            return _cached
    except Exception as e:
        log.debug("ai_model_config settings read failed: %s", e)
    _cached = {}
    return _cached


def reload_config() -> None:
    """Call after settings save so new model picks take effect."""
    global _cached
    _cached = None


def tiered_models_enabled() -> bool:
    s = _load_settings()
    v = s.get("aiTieredModelsEnabled", True)
    return v is True or str(v).lower() == "true"


def get_model_for_task(task: str) -> str:
    """Return Anthropic model ID for a named task."""
    s = _load_settings()
    tier = TASK_TIER_MAP.get(task, "simple")

    if not tiered_models_enabled():
        return s.get("aiModelDefault", DEFAULT_MODELS["simple"]) or DEFAULT_MODELS["simple"]

    tier_key = {
        "simple":    "aiModelHaiku",
        "balanced":  "aiModelSonnet",
        "powerful":  "aiModelOpus",
    }[tier]
    default = DEFAULT_MODELS[tier]
    return str(s.get(tier_key, default) or default).strip()


def get_tier_for_task(task: str) -> TaskTier:
    return TASK_TIER_MAP.get(task, "simple")


def get_model_config_summary() -> dict:
    """For API / UI — current tier → model mapping."""
    s = _load_settings()
    return {
        "tieredEnabled": tiered_models_enabled(),
        "tasks": {t: {"tier": tier, "model": get_model_for_task(t)} for t, tier in TASK_TIER_MAP.items()},
        "models": {
            "haiku":  s.get("aiModelHaiku",  DEFAULT_MODELS["simple"]),
            "sonnet": s.get("aiModelSonnet", DEFAULT_MODELS["balanced"]),
            "opus":   s.get("aiModelOpus",   DEFAULT_MODELS["powerful"]),
            "default": s.get("aiModelDefault", DEFAULT_MODELS["simple"]),
        },
        "tierGuide": {
            "simple":    "Keywords, watch pattern, basic comments — cheap & fast",
            "balanced":  "Vision, element find, error recovery, ad-skip locate",
            "powerful":  "Selector healing, hard popups, strategy",
        },
    }
