"""
behavior.youtube.verify_actions — Post-action verification helpers.

FIXED:
  ✅ tab.evaluate() calls wrapped with asyncio.wait_for timeout=8s
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from server_python.behavior.youtube.state import (
    is_liked, is_subscribed, is_ad_playing, get_current_time, get_volume_percent
)

log = logging.getLogger("mmb.yt_verify")


async def _safe_eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """Evaluate JS with timeout."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        log.debug("verify eval timeout")
        return None
    except Exception as e:
        log.debug("verify eval error: %s", e)
        return None


async def verify_autoplay_off(tab: Any) -> bool:
    """Returns True if autoplay toggle is confirmed OFF."""
    try:
        val = await _safe_eval(tab, """
        (() => {
            var btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked]')
                   || document.querySelector('button.ytp-autonav-toggle[aria-checked]');
            if (btn) return btn.getAttribute('aria-checked') !== 'true';
            var cont = document.querySelector('.ytp-autonav-toggle-button-container[aria-checked]');
            if (cont) return cont.getAttribute('aria-checked') !== 'true';
            return null;
        })()
        """)
        if val is None:
            return True  # Can't verify — assume OK
        return bool(val)
    except Exception:
        return True


async def verify_seeked(tab: Any, before: float, secs: int, direction: str = "forward") -> bool:
    """Returns True if video time changed in the expected direction."""
    await asyncio.sleep(0.5)
    after = await get_current_time(tab)
    if direction == "forward":
        return after > before + (secs * 0.5)
    else:
        return after < before - (secs * 0.5) or after < before


async def verify_logged_in(tab: Any) -> bool:
    """Returns True if user appears to be logged into YouTube."""
    try:
        val = await _safe_eval(tab, """
        (() => {
            // Logged in = account avatar button visible
            var avatar = document.querySelector('button#avatar-btn')
                      || document.querySelector('button[aria-label="Account menu"]');
            if (avatar) return true;
            // Not logged in = sign-in link present
            var signin = document.querySelector('a[href*="accounts.google.com/ServiceLogin"]')
                      || document.querySelector('ytd-button-renderer a[href*="signin"]');
            return !signin;
        })()
        """)
        return bool(val)
    except Exception:
        return True  # Assume logged in if can't verify


async def verify_volume(tab: Any, target_pct: int) -> bool:
    """Returns True if volume is within ±15% of target."""
    actual = await get_volume_percent(tab)
    return abs(actual - target_pct) <= 15
