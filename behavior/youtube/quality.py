"""
Bulletproof video quality change — V2 selectors + diagnostic logging (Bug #1/#2).
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Tuple

from behavior.youtube.player_focus import focus_player, reveal_controls
from behavior.youtube.player_controls import click_menu_item_by_label, read_quality_label_in_settings
from behavior.youtube.safe_actions import safe_click, safe_eval_js, safe_wait
from behavior.youtube.selectors import DESKTOP
from behavior.youtube.verify_actions import verify_quality_changed

log = logging.getLogger("mmb.quality")

QUALITY_ALIASES: dict[str, tuple[str, ...]] = {
    "1080p": ("1080", "1080p", "hd1080", "full hd"),
    "720p": ("720", "720p", "hd720", "hd"),
    "480p": ("480", "480p", "sd"),
    "360p": ("360", "360p"),
    "240p": ("240", "240p"),
    "144p": ("144", "144p"),
    "auto": ("auto",),
}


def _normalize_target(target_quality: str) -> str:
    t = (target_quality or "auto").strip().lower()
    if t in QUALITY_ALIASES:
        return t
    for key, aliases in QUALITY_ALIASES.items():
        if t in aliases:
            return key
    return t


async def _menu_opened(tab: Any) -> bool:
    popup = DESKTOP.get("settings_menu_popup", (".ytp-settings-menu",))
    found = await safe_wait(tab, popup, timeout=2, action_name="QUALITY_MENU_WAIT")
    return bool(found)


async def _close_settings_menus(tab: Any) -> None:
    """Dismiss open settings/quality popups so next attempt starts clean."""
    try:
        import nodriver.cdp.input_ as cdp_input
    except ImportError:
        return
    for _ in range(2):
        await tab.send(cdp_input.dispatch_key_event(
            type_="keyDown", key="Escape", code="Escape", windows_virtual_key_code=27,
        ))
        await asyncio.sleep(0.08)
        await tab.send(cdp_input.dispatch_key_event(
            type_="keyUp", key="Escape", code="Escape", windows_virtual_key_code=27,
        ))
        await asyncio.sleep(0.25)
    await safe_eval_js(
        tab,
        """
        var pop = document.querySelector('.ytp-popup.ytp-settings-menu');
        if (pop) pop.style.display = 'none';
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        """,
        action_name="QUALITY_MENU_CLOSE",
        wrap=False,
        log_result=False,
    )


async def _list_menu_labels(tab: Any) -> list[str]:
    items = DESKTOP.get("settings_menu_item", (".ytp-menuitem",))
    sel_json = json.dumps(list(items))
    raw = await safe_eval_js(
        tab,
        f"""
        var sels = {sel_json};
        var out = [];
        for (var s = 0; s < sels.length; s++) {{
            var nodes = document.querySelectorAll(sels[s]);
            for (var i = 0; i < nodes.length; i++) {{
                var el = nodes[i];
                if (!el.offsetParent) continue;
                var label = (el.getAttribute('aria-label') || el.textContent || '').trim();
                if (label) out.push(label);
            }}
        }}
        return out;
        """,
        action_name="QUALITY_LIST_LABELS",
        wrap=False,
        log_result=False,
    )
    if isinstance(raw, list):
        return [str(x) for x in raw]
    return []


async def change_quality(
    tab: Any,
    target_quality: str = "auto",
    *,
    profile_name: str = "",
    rng: random.Random | None = None,
    max_attempts: int = 4,
) -> Tuple[bool, str]:
    """
    Change video quality with bulletproof fallback chain + step logging.

    Args:
        tab: nodriver Tab.
        target_quality: e.g. '360p', '720p', '1080p', 'auto'.
        profile_name: For diagnostic logs.
        rng: Optional session RNG.
        max_attempts: Retry count if menu fails to open.

    Returns:
        (success, proof_string)
    """
    r = rng or random.Random()
    target = _normalize_target(target_quality)
    tag = f"[QUALITY][{profile_name or 'agent'}]"

    if target in ("auto", ""):
        log.info("%s target=auto — skip", tag)
        return True, "QUALITY_AUTO_SKIP"

    aliases = QUALITY_ALIASES.get(target, (target.replace("p", ""), target))
    before_label = await read_quality_label_in_settings(tab, open_menu=True)
    log.info("%s Starting change → target=%s | visible BEFORE=%r", tag, target, before_label)

    for attempt in range(1, max_attempts + 1):
        log.info("%s Attempt %d/%d", tag, attempt, max_attempts)

        if attempt > 1:
            await _close_settings_menus(tab)
            await asyncio.sleep(r.uniform(0.6, 1.2))

        # 1. Player ready & focused
        if not await focus_player(tab):
            log.warning("%s Player not found — waiting 2s", tag)
            await asyncio.sleep(2.0)
        await reveal_controls(tab)
        await asyncio.sleep(r.uniform(0.3, 0.7))

        # 2. Settings gear — V2 fallback chain
        gear_ok = await safe_click(tab, DESKTOP["settings_gear_button"], action_name="QUALITY:settings")
        log.info("%s Settings button clicked: %s", tag, gear_ok)
        if not gear_ok:
            log.error("%s Settings button not found — ABORT attempt", tag)
            await asyncio.sleep(r.uniform(0.8, 1.2))
            continue

        await asyncio.sleep(r.uniform(0.5, 1.2))

        # 3. Verify menu opened
        menu_opened = await _menu_opened(tab)
        log.info("%s Settings menu opened: %s", tag, menu_opened)
        if not menu_opened:
            log.error("%s Settings menu didn't open — retry", tag)
            await asyncio.sleep(0.5)
            continue

        labels = await _list_menu_labels(tab)
        log.info("%s Top-level menu labels: %s", tag, labels[:12])

        # 4. Open Quality submenu
        quality_menu_clicked = await click_menu_item_by_label(
            tab, ("quality",), action_name="QUALITY:menu"
        )
        log.info("%s Quality submenu clicked: %s", tag, quality_menu_clicked)
        if not quality_menu_clicked:
            log.error("%s Quality menu item not found in: %s", tag, labels)
            continue

        await asyncio.sleep(r.uniform(0.4, 0.9))

        # 5. List available qualities
        quality_labels = await _list_menu_labels(tab)
        log.info("%s Available qualities: %s", tag, quality_labels)

        # 6. Click target quality
        clicked = await click_menu_item_by_label(
            tab, aliases, action_name=f"QUALITY:set_{target}"
        )
        log.info("%s Target '%s' CDP-clicked: %s", tag, target, clicked)

        if clicked:
            await _close_settings_menus(tab)
            await asyncio.sleep(r.uniform(0.9, 1.6))
            for verify_pass in range(1, 3):
                after_label = await read_quality_label_in_settings(tab, open_menu=True)
                verified = await verify_quality_changed(tab, target)
                log.info(
                    "%s verify_pass %d visible AFTER=%r verified=%s (before=%r)",
                    tag, verify_pass, after_label, verified, before_label,
                )
                if verified:
                    log.info("%s Changed to %s (UI VERIFIED attempt %d)", tag, target, attempt)
                    await _close_settings_menus(tab)
                    return True, f"QUALITY={target} UI_VERIFIED label={after_label} attempt={attempt}"
                if verify_pass < 2:
                    await asyncio.sleep(r.uniform(1.0, 1.8))
                    await reveal_controls(tab)
            log.error("%s UI quality NOT verified — still shows %r want %s", tag, after_label, target)
            await _close_settings_menus(tab)
            continue

        log.error("%s Target '%s' not in available list: %s", tag, target, quality_labels)
        await _close_settings_menus(tab)

    return False, f"QUALITY_FAIL_{target} UNVERIFIED after {max_attempts} attempts"
