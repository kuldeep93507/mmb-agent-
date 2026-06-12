"""
behavior.youtube.safe_actions — Safe JS evaluation wrapper.

FIXED:
  ✅ tab.evaluate() wrapped with asyncio.wait_for timeout (no infinite hang)
  ✅ Default timeout=10s, configurable per-call
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger("mmb.yt_safe")


async def safe_eval_js(
    tab: Any,
    code: str,
    *,
    action_name: str = "JS",
    wrap: bool = True,
    log_result: bool = False,
    timeout: float = 10.0,
) -> Any:
    """
    Evaluate JS in browser tab safely.
    Returns value or None on error/timeout.

    FIX: asyncio.wait_for(timeout) prevents infinite hang when tab is
    unresponsive (e.g. after long ad, WS drop, or page crash).
    """
    if not tab:
        return None
    try:
        js = f"(()=>{{ {code} }})()" if wrap else code
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout
        )
        val = getattr(result, "value", result)
        if log_result:
            log.debug("[%s] → %r", action_name, val)
        return val
    except asyncio.TimeoutError:
        log.debug("[%s] eval timeout after %.1fs", action_name, timeout)
        return None
    except Exception as e:
        log.debug("[%s] eval error: %s", action_name, e)
        return None
