"""
Mobile web YouTube actions — V2 MOBILE selectors + safe_click fallback.

m.youtube.com ke liye — desktop se alag DOM structure.
"""

from __future__ import annotations

import asyncio
from typing import Any, Tuple

from behavior.youtube.safe_actions import safe_click, safe_type, safe_eval_js
from behavior.youtube.selectors import MOBILE, JS_API


async def play(tab: Any) -> Tuple[bool, str]:
    """Mobile play — JS first, button fallback."""
    paused = await safe_eval_js(tab, "document.querySelector('video')?.paused ?? true", log_result=False)
    if not paused:
        return True, "ALREADY_PLAYING"
    await safe_eval_js(tab, JS_API.get("play", "document.querySelector('video')?.play()"), action_name="MOBILE_PLAY_JS")
    await asyncio.sleep(0.8)
    if not await safe_eval_js(tab, "document.querySelector('video')?.paused ?? true", log_result=False):
        return True, "MOBILE_PLAY_JS"
    ok = await safe_click(tab, MOBILE.get("play_button", ()), action_name="MOBILE_PLAY", platform="mobile")
    return ok, "MOBILE_PLAY_CLICK" if ok else "MOBILE_PLAY_FAIL"


async def like(tab: Any) -> bool:
    """Mobile like button."""
    return await safe_click(tab, MOBILE.get("like_button", ()), action_name="MOBILE_LIKE")


async def subscribe(tab: Any) -> bool:
    """Mobile subscribe."""
    return await safe_click(tab, MOBILE.get("subscribe_button", ()), action_name="MOBILE_SUBSCRIBE")


async def search(tab: Any, query: str) -> Tuple[bool, str]:
    """Mobile search flow — open search, type, submit."""
    opened = await safe_click(tab, MOBILE.get("search_open_button", ()), action_name="MOBILE_SEARCH_OPEN")
    if opened:
        await asyncio.sleep(0.5)
    typed = await safe_type(tab, MOBILE.get("search_input", ()), query, action_name="MOBILE_SEARCH_TYPE")
    if not typed:
        return False, "MOBILE_SEARCH_TYPE_FAIL"
    submitted = await safe_click(tab, MOBILE.get("search_submit_button", ()), action_name="MOBILE_SEARCH_SUBMIT")
    return submitted, "MOBILE_SEARCH_OK" if submitted else "MOBILE_SEARCH_FAIL"


async def skip_ad(tab: Any) -> bool:
    """Mobile ad skip."""
    return await safe_click(tab, MOBILE.get("skip_ad_button", ()), action_name="MOBILE_SKIP_AD", use_cdp=True)


async def open_comments(tab: Any) -> bool:
    """Open mobile comments section."""
    return await safe_click(tab, MOBILE.get("comments_entry_teaser", ()), action_name="MOBILE_COMMENTS")
