"""
Player focus utilities — ensure player visible, controls revealed, focus restored.

Video actions se pehle player area ko focus karna zaroori hai.
"""

from __future__ import annotations

import asyncio
from typing import Any

from behavior.youtube.safe_actions import safe_eval_js, safe_click
from behavior.youtube.selectors import DESKTOP


async def scroll_player_into_view(tab: Any) -> None:
    """Scroll #movie_player into center of viewport."""
    await safe_eval_js(
        tab,
        """
        var p = document.querySelector('#movie_player, .html5-video-player');
        if (p) p.scrollIntoView({ block: 'center', behavior: 'instant' });
        """,
        action_name="PLAYER_SCROLL",
        wrap=False,
    )
    await asyncio.sleep(0.2)


async def reveal_controls(tab: Any) -> None:
    """Reveal ytp-autohide controls — CDP mouse + strip autohide class."""
    from behavior.youtube.anti_detect import get_rng
    from server_python.cdp_mouse import cdp_move_bezier

    # Delhi/modern player keeps controls in ytp-autohide until hover
    await safe_eval_js(
        tab,
        """
        var p = document.querySelector('#movie_player, .html5-video-player');
        if (p) {
            p.classList.remove('ytp-autohide');
            p.classList.add('ytp-mouseover');
        }
        """,
        action_name="PLAYER_UNHIDE_CONTROLS",
        wrap=False,
        log_result=False,
    )

    raw = await safe_eval_js(
        tab,
        """
        var p = document.querySelector('#movie_player, .html5-video-player');
        if (!p) return null;
        var r = p.getBoundingClientRect();
        return JSON.stringify({
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.bottom - 28)
        });
        """,
        action_name="PLAYER_REVEAL_POS",
        wrap=False,
        log_result=False,
    )
    if raw and str(raw) != "null":
        try:
            import json
            c = json.loads(str(raw))
            r = get_rng()
            await cdp_move_bezier(tab, c["x"] - 80, c["y"] + 40, c["x"], c["y"], r)
        except Exception:
            pass
    await asyncio.sleep(0.45)


async def focus_player(tab: Any) -> bool:
    """
    Full player focus sequence — scroll + reveal controls.

    Returns:
        True if player element exists.
    """
    exists = await safe_eval_js(
        tab,
        "!!document.querySelector('#movie_player, .html5-video-player')",
        action_name="PLAYER_EXISTS",
        log_result=False,
    )
    if not exists:
        return False
    await scroll_player_into_view(tab)
    await reveal_controls(tab)
    return True


async def click_player_center(tab: Any) -> bool:
    """Click center of player — play/pause toggle area."""
    await focus_player(tab)
    result = await safe_eval_js(
        tab,
        """
        var p = document.querySelector('#movie_player video, video.html5-main-video');
        if (!p) return false;
        var r = p.getBoundingClientRect();
        var x = r.left + r.width/2, y = r.top + r.height/2;
        var el = document.elementFromPoint(x, y);
        if (el) { el.click(); return true; }
        return false;
        """,
        action_name="PLAYER_CENTER_CLICK",
        wrap=False,
    )
    return bool(result)


async def ensure_unmuted(tab: Any) -> bool:
    """Dismiss tap-to-unmute and unmute video if needed."""
    from behavior.youtube.state import is_tap_to_unmute_showing

    if await is_tap_to_unmute_showing(tab):
        await safe_click(tab, DESKTOP["tap_to_unmute_prompt"], action_name="UNMUTE_PROMPT")

    muted = await safe_eval_js(tab, "document.querySelector('video')?.muted ?? false", log_result=False)
    if muted:
        await safe_click(tab, DESKTOP["mute_button"], action_name="UNMUTE")
        await safe_eval_js(tab, "var v=document.querySelector('video'); if(v) v.muted=false;", action_name="UNMUTE_JS", wrap=False)
    return True
