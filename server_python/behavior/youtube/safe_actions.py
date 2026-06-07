"""
behavior.youtube.safe_actions — Safe JS evaluation wrapper.
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
) -> Any:
    """Evaluate JS in browser tab, return value or None on error."""
    if not tab:
        return None
    try:
        js = f"(()=>{{ {code} }})()" if wrap else code
        result = await tab.evaluate(js, return_by_value=True)
        val = getattr(result, "value", result)
        if log_result:
            log.debug("[%s] → %r", action_name, val)
        return val
    except Exception as e:
        log.debug("[%s] eval error: %s", action_name, e)
        return None
