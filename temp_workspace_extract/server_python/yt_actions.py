"""
yt_actions — Seek forward/backward via JS currentTime manipulation.
Fallback when keyboard shortcuts don't work.

FIXED:
  ✅ Bug #1: _eval() wrapped with asyncio.wait_for timeout=8s (no infinite hang)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger("mmb.yt_actions")


async def _eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """
    FIX #1: asyncio.wait_for prevents infinite hang on unresponsive tab.
    """
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout,
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        log.debug("_eval timeout after %.1fs", timeout)
        return None
    except Exception as e:
        log.debug("eval error: %s", e)
        return None


async def seek_forward(tab: Any, seconds: int = 10) -> tuple[bool, str]:
    """Seek video forward by N seconds via JS currentTime."""
    try:
        result = await _eval(tab, f"""
        (() => {{
            var v = document.querySelector('#movie_player video')
                 || document.querySelector('ytd-player video')
                 || document.querySelector('video');
            if (!v || !isFinite(v.duration) || v.duration <= 0) return null;
            var before = v.currentTime;
            v.currentTime = Math.min(v.duration - 1, v.currentTime + {int(seconds)});
            return {{ before: before, after: v.currentTime }};
        }})()
        """)
        if result and isinstance(result, dict):
            before = float(result.get("before", 0))
            after  = float(result.get("after", 0))
            ok     = after > before
            return ok, f"JS_SEEK_FWD before={before:.1f} after={after:.1f} delta={after-before:.1f}s"
        return False, "video_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def seek_backward(tab: Any, seconds: int = 10) -> tuple[bool, str]:
    """Seek video backward by N seconds via JS currentTime."""
    try:
        result = await _eval(tab, f"""
        (() => {{
            var v = document.querySelector('#movie_player video')
                 || document.querySelector('ytd-player video')
                 || document.querySelector('video');
            if (!v || !isFinite(v.duration) || v.duration <= 0) return null;
            var before = v.currentTime;
            v.currentTime = Math.max(0, v.currentTime - {int(seconds)});
            return {{ before: before, after: v.currentTime }};
        }})()
        """)
        if result and isinstance(result, dict):
            before = float(result.get("before", 0))
            after  = float(result.get("after", 0))
            ok     = after < before
            return ok, f"JS_SEEK_BWD before={before:.1f} after={after:.1f} delta={before-after:.1f}s"
        return False, "video_not_found"
    except Exception as e:
        return False, f"error:{e}"
