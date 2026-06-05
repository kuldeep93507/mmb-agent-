"""
Visible player control interactions — DOM/slider reads the USER actually sees.

YouTube internal APIs (getPlaybackQuality, setVolume) lie — UI may not change.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from behavior.youtube.player_focus import focus_player, reveal_controls
from behavior.youtube.safe_actions import safe_click, safe_eval_js, safe_wait
from behavior.youtube.selectors import DESKTOP

log = logging.getLogger("mmb.player_controls")


async def read_quality_label_in_settings(tab: Any, *, open_menu: bool = True) -> str:
    """
    Read Quality row value from VISIBLE settings menu (e.g. 'Auto', '360p').
    This is what the user sees — NOT getPlaybackQuality().
    """
    if open_menu:
        await focus_player(tab)
        await reveal_controls(tab)
        await asyncio.sleep(0.3)
        # Close stray menu first
        await safe_eval_js(
            tab,
            "document.querySelector('.ytp-popup')?.style && (document.activeElement?.blur?.());",
            action_name="QUALITY_MENU_PREP",
            wrap=False,
            log_result=False,
        )
        await safe_click(tab, DESKTOP["settings_gear_button"], action_name="QUALITY_READ_OPEN_GEAR", timeout=3)
        await asyncio.sleep(0.6)
        await safe_wait(tab, DESKTOP["settings_menu_popup"], timeout=2, action_name="QUALITY_MENU_VISIBLE")

    raw = await safe_eval_js(
        tab,
        """
        var items = document.querySelectorAll('.ytp-menuitem, .ytp-panel-menu .ytp-menuitem');
        for (var i = 0; i < items.length; i++) {
            var el = items[i];
            if (!el.offsetParent) continue;
            var label = (el.querySelector('.ytp-menuitem-label') || el).textContent || '';
            if (!/quality/i.test(label)) continue;
            var content = el.querySelector('.ytp-menuitem-content');
            if (content) {
                var primary = content.querySelector('span:not(.ytp-menu-label-secondary)');
                var secondary = content.querySelector('.ytp-menu-label-secondary');
                var main = primary ? primary.textContent.trim() : '';
                var sub = secondary ? secondary.textContent.trim() : '';
                if (main && sub) return main + ' ' + sub;
                if (main) return main;
                if (content.textContent) return content.textContent.trim();
            }
            var parts = label.split(/\\n|\\r/);
            for (var j = 0; j < parts.length; j++) {
                var p = parts[j].trim();
                if (/\\d+p|auto|hd|high|medium|low/i.test(p) && !/quality/i.test(p)) return p;
            }
            return label.trim();
        }
        return '';
        """,
        action_name="QUALITY_READ_LABEL",
        wrap=False,
        log_result=False,
    )
    return str(raw or "").strip()


async def click_menu_item_by_label(tab: Any, match_substrings: tuple[str, ...], action_name: str) -> bool:
    """Real CDP click on settings menu item — NOT dispatchEvent."""
    from server_python.cdp_mouse import cdp_click

    want_json = json.dumps([m.lower() for m in match_substrings])
    raw = await safe_eval_js(
        tab,
        f"""
        var want = {want_json};
        var items = document.querySelectorAll('.ytp-menuitem, .ytp-panel-menu .ytp-menuitem');
        for (var i = 0; i < items.length; i++) {{
            var el = items[i];
            if (!el.offsetParent) continue;
            var label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
            for (var w = 0; w < want.length; w++) {{
                if (label.includes(want[w])) {{
                    var r = el.getBoundingClientRect();
                    if (r.width < 2 || r.height < 2) continue;
                    return JSON.stringify({{
                        x: Math.round(r.left + r.width / 2),
                        y: Math.round(r.top + r.height / 2)
                    }});
                }}
            }}
        }}
        return null;
        """,
        action_name=f"{action_name}_FIND",
        wrap=False,
        log_result=False,
    )
    if not raw or str(raw) == "null":
        return False
    try:
        coords = json.loads(str(raw))
        x, y = float(coords["x"]), float(coords["y"])
        await cdp_click(tab, x, y)
        await asyncio.sleep(0.4)
        return True
    except Exception as exc:
        log.debug("%s CDP click failed: %s", action_name, exc)
        return False


async def read_volume_slider_pct(tab: Any) -> int | None:
    """Visible volume slider aria-valuenow ONLY — never trust video.volume API."""
    raw = await safe_eval_js(
        tab,
        """
        var panel = document.querySelector('.ytp-volume-panel[role="slider"], .ytp-volume-panel');
        if (!panel || !panel.offsetParent) return null;
        var v = panel.getAttribute('aria-valuenow');
        if (v === null || v === '') return null;
        return parseInt(v, 10);
        """,
        action_name="VOLUME_READ_SLIDER",
        wrap=False,
        log_result=False,
    )
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


async def set_volume_via_slider(tab: Any, percent: int) -> tuple[bool, str]:
    """
    Delhi horizontal volume: unmute first, then CDP-click slider track.
    """
    from server_python.cdp_mouse import cdp_click, cdp_move_bezier
    from behavior.youtube.anti_detect import get_rng

    percent = max(0, min(100, percent))
    await focus_player(tab)
    await reveal_controls(tab)
    await asyncio.sleep(0.35)

    # Unmute if Delhi player shows "Unmute (m)" — muted slider reads wrong
    await safe_click(tab, DESKTOP["mute_button"], action_name="VOLUME_UNMUTE_IF_NEEDED", timeout=2)
    await asyncio.sleep(0.4)

    before = await read_volume_slider_pct(tab)
    r = get_rng()

    vol_raw = await safe_eval_js(
        tab,
        """
        var el = document.querySelector('.ytp-volume-area .ytp-volume-icon, .ytp-mute-button button, button[aria-keyshortcuts="m"]');
        if (!el || !el.offsetParent) return null;
        var rect = el.getBoundingClientRect();
        return JSON.stringify({x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2)});
        """,
        action_name="VOLUME_ICON_POS",
        wrap=False,
        log_result=False,
    )
    if vol_raw and str(vol_raw) != "null":
        try:
            c = json.loads(str(vol_raw))
            await cdp_move_bezier(tab, c["x"] - 40, c["y"], c["x"], c["y"], r)
            await asyncio.sleep(0.8)
        except Exception:
            pass

    slider_raw = await safe_eval_js(
        tab,
        f"""
        var track = document.querySelector('.ytp-volume-slider, .ytp-volume-panel[role="slider"], .ytp-volume-panel');
        if (!track || !track.offsetParent) return null;
        var rect = track.getBoundingClientRect();
        if (rect.width < 8) return null;
        var pct = {percent} / 100.0;
        return JSON.stringify({{
            x: Math.round(rect.left + rect.width * pct),
            y: Math.round(rect.top + rect.height / 2)
        }});
        """,
        action_name="VOLUME_SLIDER_POS",
        wrap=False,
        log_result=False,
    )
    if not slider_raw or str(slider_raw) == "null":
        return False, f"VOL_SLIDER_NOT_FOUND before={before}"

    try:
        c = json.loads(str(slider_raw))
        await cdp_click(tab, float(c["x"]), float(c["y"]))
        await asyncio.sleep(0.5)
    except Exception as exc:
        return False, f"VOL_CLICK_FAIL:{exc} before={before}"

    after = await read_volume_slider_pct(tab)
    ok = after is not None and abs(after - percent) <= 10
    return ok, f"slider {before}%->{after}% target={percent}% {'OK' if ok else 'FAIL'}"


async def _read_visible_autoplay_state(tab: Any) -> dict:
    """
    Delhi UI: aria-checked lives on inner .ytp-autonav-toggle-button div,
    NOT on button.ytp-autonav-toggle. aria-label says 'Autoplay is on/off'.
    """
    raw = await safe_eval_js(
        tab,
        """
        var btn = document.querySelector(
            'button.ytp-autonav-toggle, button[data-tooltip-target-id="ytp-autonav-toggle-button"]'
        );
        if (!btn || !btn.offsetParent) return JSON.stringify({found: false});
        var r = btn.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return JSON.stringify({found: false});
        var inner = btn.querySelector('.ytp-autonav-toggle-button');
        var label = (btn.getAttribute('aria-label') || btn.getAttribute('data-tooltip-title') || '').toLowerCase();
        var on = (inner && inner.getAttribute('aria-checked') === 'true')
            || label.indexOf('is on') >= 0
            || (inner && inner.classList.contains('ytp-autonav-toggle-button-enabled'));
        return JSON.stringify({
            found: true, on: on,
            label: btn.getAttribute('aria-label') || '',
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2)
        });
        """,
        action_name="AUTOPLAY_READ_VISIBLE",
        wrap=False,
        log_result=False,
    )
    try:
        return json.loads(str(raw)) if raw else {}
    except json.JSONDecodeError:
        return {}


async def set_autoplay_off_visible(tab: Any) -> tuple[bool, str]:
    """Toggle autoplay using VISIBLE control bar button + UI verify."""
    from server_python.cdp_mouse import cdp_click

    await focus_player(tab)
    await reveal_controls(tab)
    await asyncio.sleep(0.5)

    info = await _read_visible_autoplay_state(tab)
    if not info.get("found"):
        return False, "AUTOPLAY_TOGGLE_NOT_VISIBLE"

    if not info.get("on"):
        from behavior.youtube.verify_actions import verify_autoplay_off
        if await verify_autoplay_off(tab):
            return True, f"AUTOPLAY_ALREADY_OFF UI_VERIFIED ({info.get('label', '')})"
        return False, f"AUTOPLAY_STATE_MISMATCH label={info.get('label', '')}"

    try:
        await cdp_click(tab, float(info["x"]), float(info["y"]))
    except Exception as exc:
        return False, f"AUTOPLAY_CDP_CLICK_FAIL:{exc}"

    await asyncio.sleep(0.6)
    from behavior.youtube.verify_actions import verify_autoplay_off
    ok = await verify_autoplay_off(tab)
    return ok, f"AUTOPLAY_OFF={'UI_VERIFIED' if ok else 'FAIL'}"
