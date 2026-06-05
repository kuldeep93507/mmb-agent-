"""
YouTube page state detection — JS_API + DOM selectors (V2).

Sab is_* / get_* functions yahan — engagement logic inhe use karega.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from behavior.youtube.safe_actions import safe_eval_js
from behavior.youtube.selectors import DESKTOP, JS_API


async def _eval_bool(tab: Any, js_key: str) -> bool:
    """Evaluate JS_API key that returns boolean."""
    code = JS_API.get(js_key, "")
    if not code:
        return False
    result = await safe_eval_js(tab, code, action_name=f"STATE_{js_key}", log_result=False)
    return bool(result)


async def _eval_value(tab: Any, js_key: str) -> Any:
    """Evaluate JS_API key and return raw value."""
    code = JS_API.get(js_key, "")
    if not code:
        return None
    return await safe_eval_js(tab, code, action_name=f"STATE_{js_key}", log_result=False)


async def is_subscribed(tab: Any) -> bool:
    """Check if user is subscribed to current channel."""
    return await _eval_bool(tab, "is_subscribed")


async def is_liked(tab: Any) -> bool:
    """Check if current video is liked."""
    return await _eval_bool(tab, "is_liked")


async def is_disliked(tab: Any) -> bool:
    """Check if current video is disliked."""
    return await _eval_bool(tab, "is_disliked")


async def is_ad_playing(tab: Any) -> bool:
    """Detect if an ad is currently playing."""
    result = await safe_eval_js(
        tab,
        """
        var p = document.querySelector('#movie_player, .html5-video-player');
        if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')))
            return true;
        var badge = document.querySelector('.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining');
        if (badge && badge.offsetParent !== null) return true;
        return false;
        """,
        action_name="STATE_is_ad_playing",
        log_result=False,
        wrap=False,
    )
    return bool(result)


async def is_tap_to_unmute_showing(tab: Any) -> bool:
    """Check if 'Tap to unmute' prompt is visible."""
    return await _eval_bool(tab, "is_tap_to_unmute_showing")


async def is_endscreen_showing(tab: Any) -> bool:
    """Check if endscreen videowall is visible (video ended)."""
    return await _eval_bool(tab, "is_endscreen_showing")


async def is_playing(tab: Any) -> bool:
    """Check if video is currently playing."""
    result = await safe_eval_js(
        tab,
        "document.querySelector('video') && !document.querySelector('video').paused",
        action_name="STATE_is_playing",
        log_result=False,
    )
    return bool(result)


async def is_paused(tab: Any) -> bool:
    """Check if video is paused."""
    result = await safe_eval_js(
        tab,
        "document.querySelector('video')?.paused ?? true",
        action_name="STATE_is_paused",
        log_result=False,
    )
    return bool(result)


async def get_current_chapter(tab: Any) -> dict:
    """
    Get current chapter info.

    Returns:
        Dict with title key, or empty dict.
    """
    title = await _eval_value(tab, "get_current_chapter")
    if title:
        return {"title": str(title).strip()}
    return {}


async def get_all_chapters(tab: Any) -> list:
    """
    Get all video chapters as list of dicts.

    Returns:
        List of {title, time, href} dicts.
    """
    raw = await _eval_value(tab, "get_all_chapters")
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


async def get_video_duration(tab: Any) -> float:
    """Get video duration in seconds."""
    result = await safe_eval_js(
        tab,
        "document.querySelector('video')?.duration || 0",
        action_name="STATE_get_video_duration",
        log_result=False,
    )
    try:
        return float(result or 0)
    except (TypeError, ValueError):
        return 0.0


async def get_current_time(tab: Any) -> float:
    """Get current playback position in seconds."""
    result = await safe_eval_js(
        tab,
        "document.querySelector('video')?.currentTime || 0",
        action_name="STATE_get_current_time",
        log_result=False,
    )
    try:
        return float(result or 0)
    except (TypeError, ValueError):
        return 0.0


async def get_video_id(tab: Any) -> str:
    """Extract video ID from current URL."""
    result = await safe_eval_js(
        tab,
        JS_API.get("get_video_id_from_url", "new URL(window.location.href).searchParams.get('v')"),
        action_name="STATE_get_video_id",
        log_result=False,
    )
    return str(result or "").strip()


async def get_volume_percent(tab: Any) -> int:
    """Get current volume 0-100."""
    result = await safe_eval_js(
        tab,
        "Math.round((document.querySelector('video')?.volume || 0) * 100)",
        action_name="STATE_get_volume",
        log_result=False,
    )
    try:
        return int(result or 0)
    except (TypeError, ValueError):
        return 0


async def get_like_dislike_state(tab: Any) -> dict:
    """
    Combined like/dislike state.

    Returns:
        Dict with liked (bool) and disliked (bool).
    """
    liked = await is_liked(tab)
    disliked = await is_disliked(tab)
    return {"liked": liked, "disliked": disliked}


async def get_player_state(tab: Any) -> dict:
    """
    Full player snapshot — duration, time, volume, ad, chapter.

    Returns:
        Dict with playback metadata.
    """
    return {
        "video_id": await get_video_id(tab),
        "duration": await get_video_duration(tab),
        "current_time": await get_current_time(tab),
        "volume": await get_volume_percent(tab),
        "playing": await is_playing(tab),
        "ad_playing": await is_ad_playing(tab),
        "subscribed": await is_subscribed(tab),
        "liked": await is_liked(tab),
        "disliked": await is_disliked(tab),
        "chapter": await get_current_chapter(tab),
        "endscreen": await is_endscreen_showing(tab),
        "tap_to_unmute": await is_tap_to_unmute_showing(tab),
    }


async def get_video_duration_when_ready(
    tab: Any,
    *,
    min_duration: float = 30.0,
    max_attempts: int = 10,
    interval: float = 2.0,
) -> float | None:
    """
    Poll until video duration exceeds min_duration (filters ad stubs).

    Args:
        tab: nodriver Tab.
        min_duration: Minimum seconds to accept.
        max_attempts: Retry count.
        interval: Seconds between attempts.

    Returns:
        Duration in seconds or None.
    """
    import asyncio

    for attempt in range(max_attempts):
        dur = await get_video_duration(tab)
        if dur > min_duration:
            return dur
        if attempt < max_attempts - 1:
            await asyncio.sleep(interval)
    return None


async def jump_to_chapter_by_title(tab: Any, title_substring: str) -> bool:
    """
    Click chapter link matching title substring (case-insensitive).

    Args:
        tab: nodriver Tab.
        title_substring: Partial chapter title to match.

    Returns:
        True if chapter was clicked.
    """
    from behavior.youtube.safe_actions import safe_click

    chapters = await get_all_chapters(tab)
    target = title_substring.lower()
    for ch in chapters:
        if target in str(ch.get("title", "")).lower():
            href = ch.get("href", "")
            if href:
                await safe_eval_js(tab, f"window.location.href = {json.dumps(href)}", action_name="CHAPTER_JUMP")
                return True

    return await safe_click(tab, DESKTOP.get("chapter_item_link", ()), action_name="CHAPTER_CLICK")
