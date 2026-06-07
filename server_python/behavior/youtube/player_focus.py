"""
behavior.youtube.player_focus — Focus the YouTube video player.
"""
from __future__ import annotations
import asyncio
import logging
from typing import Any

log = logging.getLogger("mmb.yt_focus")


async def focus_player(tab: Any) -> bool:
    """Click/focus the player so keyboard shortcuts (k/j/l/m) work."""
    try:
        result = await tab.evaluate("""
        (() => {
            var p = document.querySelector('#movie_player')
                 || document.querySelector('.html5-video-player');
            if (!p) return false;
            var vc = p.querySelector('.html5-video-container') || p;
            vc.focus();
            vc.click();
            return true;
        })()
        """, return_by_value=True)
        val = getattr(result, "value", result)
        return bool(val)
    except Exception as e:
        log.debug("focus_player error: %s", e)
        return False
