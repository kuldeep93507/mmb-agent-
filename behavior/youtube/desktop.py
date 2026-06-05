"""
Desktop YouTube actions — V2 selectors + safe_click fallback chains.

www.youtube.com desktop web ke liye sab critical actions yahan.
"""

from __future__ import annotations

import asyncio
import json
import random
from typing import Any, Tuple

import logging

from behavior.youtube.anti_detect import human_delay, should_do_action, get_rng

log = logging.getLogger("mmb.desktop")
from behavior.youtube.safe_actions import safe_click, safe_click_verified, safe_type, safe_eval_js, safe_wait
from behavior.youtube.verify_actions import (
    verify_logged_in,
    verify_liked,
    verify_subscribed,
    verify_quality_changed,
    verify_volume,
    verify_description_expanded,
    verify_autoplay_off,
    verify_ad_skipped,
)
from behavior.youtube.state import (
    is_liked,
    is_disliked,
    is_subscribed,
    is_ad_playing,
    is_tap_to_unmute_showing,
    get_video_duration,
    get_current_time,
    get_all_chapters,
    jump_to_chapter_by_title,
)
from behavior.youtube.selectors import DESKTOP, JS_API


async def dismiss_tap_to_unmute(tab: Any) -> bool:
    """Dismiss autoplay muted prompt if visible."""
    if await is_tap_to_unmute_showing(tab):
        return await safe_click(tab, DESKTOP["tap_to_unmute_prompt"], action_name="TAP_TO_UNMUTE")
    return True


async def play(tab: Any) -> Tuple[bool, str]:
    """Start video playback — JS API first, then play button fallback."""
    paused = await safe_eval_js(tab, "document.querySelector('video')?.paused ?? true", log_result=False)
    if not paused:
        return True, "ALREADY_PLAYING"

    ok = await safe_eval_js(
        tab,
        JS_API.get("play", "document.querySelector('video')?.play()"),
        action_name="PLAY_JS",
    )
    await asyncio.sleep(1.0)
    still_paused = await safe_eval_js(tab, "document.querySelector('video')?.paused ?? true", log_result=False)
    if not still_paused:
        return True, "PLAY_JS"

    clicked = await safe_click(tab, DESKTOP["play_button"], action_name="PLAY")
    if not clicked:
        clicked = await safe_click(tab, DESKTOP["large_play_button_center"], action_name="PLAY_LARGE")
    await asyncio.sleep(1.0)
    return clicked, "PLAY_CLICK" if clicked else "PLAY_FAIL"


async def pause(tab: Any) -> Tuple[bool, str]:
    """Pause video — JS API first."""
    await safe_eval_js(tab, JS_API.get("pause", "document.querySelector('video')?.pause()"), action_name="PAUSE_JS")
    await asyncio.sleep(0.8)
    paused = await safe_eval_js(tab, "document.querySelector('video')?.paused ?? false", log_result=False)
    if paused:
        return True, "PAUSE_JS"
    return await safe_click(tab, DESKTOP["pause_button"], action_name="PAUSE"), "PAUSE_CLICK"


async def skip_ad(tab: Any) -> bool:
    """Click skip ad button if ad is playing — verify ad overlay gone."""
    if not await is_ad_playing(tab):
        return True
    clicked = await safe_click(tab, DESKTOP["ad_skip_button"], action_name="SKIP_AD", use_cdp=True)
    if not clicked:
        return False
    await asyncio.sleep(1.0)
    return await verify_ad_skipped(tab)


async def like(tab: Any, want: bool = True) -> Tuple[bool, str]:
    """Like/unlike — login check + verified click (single attempt, no retry)."""
    from behavior.youtube.action_audit import ActionAudit

    if want and not await verify_logged_in(tab):
        audit = ActionAudit.current()
        if audit:
            audit.record("like", skipped=True, skip_reason="NOT_LOGGED_IN", reason="Gmail not signed in")
        return False, "LIKE_SKIP_NOT_LOGGED_IN"

    liked = await is_liked(tab)
    if want and liked:
        return True, "ALREADY_LIKED"
    if not want and not liked:
        return True, "ALREADY_NOT_LIKED"

    if want and await is_disliked(tab):
        await safe_click(tab, DESKTOP["dislike_button"], action_name="UNDO_DISLIKE")

    async def _verify_unliked(t: Any) -> bool:
        return not await is_liked(t)

    result = await safe_click_verified(
        tab,
        DESKTOP["like_button"],
        action_name="LIKE" if want else "UNLIKE",
        verify_fn=verify_liked if want else _verify_unliked,
    )
    final = await is_liked(tab)
    if result.get("success") and result.get("verified"):
        return (final == want), f"LIKE={final} VERIFIED"
    return (final == want), f"LIKE={final} UNVERIFIED"


async def dislike(tab: Any, want: bool = True) -> Tuple[bool, str]:
    """Dislike/un-dislike with state detection."""
    disliked = await is_disliked(tab)
    if want and disliked:
        return True, "ALREADY_DISLIKED"
    if not want and not disliked:
        return True, "ALREADY_NOT_DISLIKED"

    if want and await is_liked(tab):
        await safe_click(tab, DESKTOP["like_button"], action_name="UNDO_LIKE")

    ok = await safe_click(tab, DESKTOP["dislike_button"], action_name="DISLIKE" if want else "UNDISLIKE")
    await asyncio.sleep(0.8)
    final = await is_disliked(tab)
    return (final == want), f"DISLIKE={final}"


async def subscribe(tab: Any, want: bool = True) -> Tuple[bool, str]:
    """Subscribe/unsubscribe — login check + verified click."""
    from behavior.youtube.action_audit import ActionAudit

    if want and not await verify_logged_in(tab):
        audit = ActionAudit.current()
        if audit:
            audit.record("subscribe", skipped=True, skip_reason="NOT_LOGGED_IN")
        return False, "SUB_SKIP_NOT_LOGGED_IN"

    subbed = await is_subscribed(tab)
    if want and subbed:
        return True, "ALREADY_SUBSCRIBED"
    if not want and not subbed:
        return True, "ALREADY_NOT_SUBSCRIBED"

    async def _verify_unsubbed(t: Any) -> bool:
        return not await is_subscribed(t)

    result = await safe_click_verified(
        tab,
        DESKTOP["subscribe_button"],
        action_name="SUBSCRIBE" if want else "UNSUBSCRIBE",
        verify_fn=verify_subscribed if want else _verify_unsubbed,
    )
    final = await is_subscribed(tab)
    tag = "VERIFIED" if result.get("verified") else "UNVERIFIED"
    return (final == want), f"SUB={final} {tag}"


async def toggle_bell(tab: Any) -> bool:
    """Open bell notification settings."""
    from behavior.youtube.action_audit import ActionAudit

    if not await verify_logged_in(tab):
        audit = ActionAudit.current()
        if audit:
            audit.record("bell", skipped=True, skip_reason="NOT_LOGGED_IN")
        return False
    return await safe_click(tab, DESKTOP["bell_notification_button"], action_name="BELL")


async def set_volume(tab: Any, percent: int) -> Tuple[bool, str]:
    """Set volume via VISIBLE slider CDP click — NOT internal API."""
    from behavior.youtube.player_controls import set_volume_via_slider

    ok, proof = await set_volume_via_slider(tab, percent)
    tag = "UI_VERIFIED" if ok else "UI_FAIL"
    return ok, f"{proof} {tag}"


async def seek_to_percent(tab: Any, percent: float) -> Tuple[bool, str]:
    """Seek to percentage of video duration."""
    dur = await get_video_duration(tab)
    if dur < 1:
        return False, "NO_DURATION"
    target = max(0, min(dur - 1, dur * (percent / 100)))
    await safe_eval_js(tab, f"document.querySelector('video').currentTime={target}", action_name="SEEK")
    await asyncio.sleep(0.5)
    cur = await get_current_time(tab)
    return abs(cur - target) < 3, f"SEEK={cur:.1f}s"


async def search(tab: Any, query: str) -> Tuple[bool, str]:
    """Type query and submit search."""
    typed = await safe_type(tab, DESKTOP["search_input"], query, action_name="SEARCH_TYPE")
    if not typed:
        return False, "SEARCH_INPUT_FAIL"
    clicked = await safe_click(tab, DESKTOP["search_submit_button"], action_name="SEARCH_SUBMIT")
    return clicked, "SEARCH_OK" if clicked else "SEARCH_SUBMIT_FAIL"


async def clear_search(tab: Any) -> bool:
    """Clear search box via X button."""
    return await safe_click(tab, DESKTOP["search_clear_button"], action_name="SEARCH_CLEAR")


async def post_comment(tab: Any, text: str) -> Tuple[bool, str]:
    """Open comment box, type, and submit."""
    from behavior.youtube.action_audit import ActionAudit

    if not await verify_logged_in(tab):
        audit = ActionAudit.current()
        if audit:
            audit.record("comment", skipped=True, skip_reason="NOT_LOGGED_IN")
        return False, "COMMENT_SKIP_NOT_LOGGED_IN"

    opened = await safe_click(tab, DESKTOP["comment_input_placeholder_click"], action_name="COMMENT_OPEN")
    if not opened:
        return False, "COMMENT_OPEN_FAIL"
    await asyncio.sleep(0.5)
    typed = await safe_type(tab, DESKTOP["comment_input_active_typing"], text, action_name="COMMENT_TYPE")
    if not typed:
        return False, "COMMENT_TYPE_FAIL"
    submitted = await safe_click(tab, DESKTOP["comment_submit_button"], action_name="COMMENT_SUBMIT")
    return submitted, "COMMENT_OK" if submitted else "COMMENT_SUBMIT_FAIL"


async def toggle_fullscreen(tab: Any) -> bool:
    """Toggle fullscreen mode."""
    return await safe_click(tab, DESKTOP["fullscreen_button"], action_name="FULLSCREEN")


async def toggle_theater(tab: Any) -> bool:
    """Toggle cinema/theater mode."""
    return await safe_click(tab, DESKTOP["cinema_theater_button"], action_name="THEATER")


async def toggle_pip(tab: Any) -> bool:
    """Toggle picture-in-picture."""
    return await safe_click(tab, DESKTOP["picture_in_picture_button"], action_name="PIP")


async def mute(tab: Any) -> bool:
    """Mute video via player mute button."""
    return await safe_click(tab, DESKTOP["mute_button"], action_name="MUTE")


async def unmute(tab: Any) -> bool:
    """Unmute — click mute button if muted, or tap-to-unmute prompt."""
    await dismiss_tap_to_unmute(tab)
    return await safe_click(tab, DESKTOP["mute_button"], action_name="UNMUTE")


async def join_channel(tab: Any) -> bool:
    """Click Join membership button if available."""
    return await safe_click(tab, DESKTOP["join_channel_button"], action_name="JOIN_CHANNEL", timeout=3)


async def share(tab: Any) -> bool:
    """Open share panel."""
    return await safe_click(tab, DESKTOP["share_button"], action_name="SHARE")


async def download(tab: Any) -> bool:
    """Click download button if available."""
    return await safe_click(tab, DESKTOP["download_button"], action_name="DOWNLOAD", timeout=3)


async def save_to_playlist(tab: Any) -> bool:
    """Open save to playlist dialog."""
    return await safe_click(tab, DESKTOP["save_to_playlist_button"], action_name="SAVE_PLAYLIST")


async def expand_description(tab: Any) -> bool:
    """Expand video description — verified."""
    if await verify_description_expanded(tab):
        return True
    result = await safe_click_verified(
        tab,
        DESKTOP["description_more_button"],
        action_name="DESC_EXPAND",
        timeout=3,
        verify_fn=verify_description_expanded,
    )
    return bool(result.get("success") and result.get("verified"))


async def click_hashtag(tab: Any, index: int = 0) -> bool:
    """Click hashtag link by index."""
    links = DESKTOP.get("hashtag_links", ())
    if not links:
        return False
    # Use safe_click on first visible hashtag via nth query in human click chain
    sel = links[0] if links else ""
    all_links = await safe_eval_js(
        tab,
        f"""Array.from(document.querySelectorAll({json.dumps(sel)})).slice(0,10).map((el,i) => i)""",
        log_result=False,
    )
    if not all_links or index >= len(all_links):
        return await safe_click(tab, links, action_name="HASHTAG")
    return await safe_click(tab, links, action_name=f"HASHTAG_{index}")


async def set_bell_level(tab: Any, level: str = "All") -> Tuple[bool, str]:
    """
    Set bell notification level: All / Personalised / None.

    Args:
        tab: nodriver Tab.
        level: One of 'All', 'Personalised', 'None'.

    Returns:
        (success, proof_string)
    """
    opened = await safe_click(tab, DESKTOP["bell_notification_button"], action_name="BELL_OPEN")
    if not opened:
        return False, "BELL_OPEN_FAIL"
    await asyncio.sleep(1.0)
    level_lower = level.lower()
    clicked = await safe_eval_js(
        tab,
        f"""(() => {{
            var want = {json.dumps(level_lower)};
            var items = document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item, [role="menuitem"]');
            for (var i = 0; i < items.length; i++) {{
                var t = (items[i].textContent || '').toLowerCase();
                if (want === 'all' && t.includes('all')) {{ items[i].click(); return true; }}
                if (want === 'personalised' && t.includes('personal')) {{ items[i].click(); return true; }}
                if (want === 'none' && t.includes('none')) {{ items[i].click(); return true; }}
            }}
            return false;
        }})()""",
        action_name="BELL_LEVEL",
        wrap=False,
    )
    return bool(clicked), f"BELL_{level.upper()}"


async def jump_to_chapter(tab: Any, title_or_index: str | int) -> Tuple[bool, str]:
    """
    Jump to chapter by title substring or zero-based index.

    Args:
        tab: nodriver Tab.
        title_or_index: Chapter title substring or index number.

    Returns:
        (success, proof_string)
    """
    if isinstance(title_or_index, int):
        chapters = await get_all_chapters(tab)
        if title_or_index < len(chapters):
            title = chapters[title_or_index].get("title", "")
            ok = await jump_to_chapter_by_title(tab, title)
            return ok, f"CHAPTER_IDX={title_or_index}"
        return False, "CHAPTER_IDX_OUT_OF_RANGE"

    ok = await jump_to_chapter_by_title(tab, str(title_or_index))
    return ok, f"CHAPTER_TITLE={title_or_index}"


async def reply_to_comment(tab: Any, reply_text: str, index: int = 0) -> Tuple[bool, str]:
    """Reply to comment thread at index."""
    await safe_click(tab, DESKTOP.get("comment_replies_show_button", ()), action_name="SHOW_REPLIES", timeout=2)
    await asyncio.sleep(0.5)
    opened = await safe_click(tab, DESKTOP["comment_reply_button"], action_name="COMMENT_REPLY")
    if not opened:
        return False, "REPLY_OPEN_FAIL"
    typed = await safe_type(tab, DESKTOP["comment_input_active_typing"], reply_text, action_name="REPLY_TYPE")
    if not typed:
        return False, "REPLY_TYPE_FAIL"
    ok = await safe_click(tab, DESKTOP["comment_submit_button"], action_name="REPLY_SUBMIT")
    return ok, "REPLY_OK" if ok else "REPLY_SUBMIT_FAIL"


async def heart_comment(tab: Any, index: int = 0) -> bool:
    """Heart a comment (creator action) — index-based."""
    return await safe_click(tab, DESKTOP["comment_heart_creator"], action_name="COMMENT_HEART", timeout=3)


async def toggle_captions(tab: Any) -> bool:
    """Toggle captions/subtitles."""
    return await safe_click(tab, DESKTOP["captions_subtitles_button"], action_name="CAPTIONS")


async def open_settings(tab: Any) -> bool:
    """Open player settings gear menu."""
    return await safe_click(tab, DESKTOP["settings_gear_button"], action_name="SETTINGS")


async def set_playback_speed(tab: Any, rate: float = 1.25) -> Tuple[bool, str]:
    """
    Set playback speed via settings menu (DOM only — Rule I).

    Args:
        tab: nodriver Tab.
        rate: Speed multiplier e.g. 1.25, 1.5, 2.0.

    Returns:
        (success, proof_string)
    """
    if not await open_settings(tab):
        return False, "SETTINGS_OPEN_FAIL"
    await asyncio.sleep(0.6)
    # Click "Playback speed" menu item then target rate
    rate_label = f"{rate}".rstrip("0").rstrip(".")
    ok = await safe_eval_js(
        tab,
        f"""(() => {{
            var items = document.querySelectorAll('.ytp-menuitem, .ytp-panel-menu .ytp-menuitem');
            for (var i = 0; i < items.length; i++) {{
                var t = (items[i].textContent || '').toLowerCase();
                if (t.includes('playback speed') || t.includes('speed')) {{ items[i].click(); return 'opened'; }}
            }}
            return false;
        }})()""",
        action_name="SPEED_MENU",
        wrap=False,
    )
    if not ok:
        return False, "SPEED_MENU_FAIL"
    await asyncio.sleep(0.5)
    clicked = await safe_eval_js(
        tab,
        f"""(() => {{
            var items = document.querySelectorAll('.ytp-menuitem');
            for (var i = 0; i < items.length; i++) {{
                if ((items[i].textContent || '').includes({json.dumps(rate_label)})) {{
                    items[i].click(); return true;
                }}
            }}
            return false;
        }})()""",
        action_name="SPEED_SET",
        wrap=False,
    )
    return bool(clicked), f"SPEED={rate_label}"


async def set_quality(tab: Any, quality: str = "480p", *, profile_name: str = "") -> Tuple[bool, str]:
    """Set video quality — delegates to bulletproof change_quality (Bug #2)."""
    from behavior.youtube.quality import change_quality

    return await change_quality(tab, quality, profile_name=profile_name)


async def click_related_video(tab: Any, index: int = 0) -> bool:
    """Click related sidebar video — DOM safe_click, no JS API (Rule I)."""
    links = DESKTOP.get("related_video_link", DESKTOP.get("related_video_item", ()))
    await human_delay(1.0, 2.5)
    # Scroll sidebar into view first
    await safe_eval_js(
        tab,
        "document.querySelector('#secondary, #related')?.scrollIntoView({block:'nearest'})",
        action_name="SIDEBAR_SCROLL",
        wrap=False,
    )
    await asyncio.sleep(0.5)
    return await safe_click(tab, links, action_name=f"RELATED_VIDEO_{index}")


async def click_endscreen_video(tab: Any, index: int = 0) -> bool:
    """Click endscreen suggestion by index (0-11) — human click."""
    cards = DESKTOP.get("endscreen_video_card", ())
    if cards:
        found = await safe_wait(tab, cards, timeout=3, action_name="ENDSCREEN_WAIT")
        if not found:
            return False
    await human_delay(0.8, 2.0)
    thumbs = DESKTOP.get("endscreen_video_thumbnail", (".ytp-modern-videowall-still",))
    return await safe_click(tab, thumbs, action_name=f"ENDSCREEN_{index}")


async def scroll_to_comments(tab: Any) -> None:
    """Scroll comment section into view."""
    await safe_eval_js(
        tab,
        """
        var section = document.querySelector('ytd-comments, #comments');
        if (section) section.scrollIntoView({behavior: 'smooth', block: 'center'});
        """,
        action_name="SCROLL_COMMENTS",
        wrap=False,
    )
    await human_delay(1.5, 3.0)


async def scroll_to_top(tab: Any) -> None:
    """Scroll page to top so player buttons are visible."""
    await safe_eval_js(tab, "window.scrollTo({top: 0, behavior: 'smooth'})", action_name="SCROLL_TOP", wrap=False)
    await asyncio.sleep(0.5)


async def disable_autoplay(tab: Any) -> bool:
    """Toggle VISIBLE autoplay button OFF — localStorage/API alone is NOT success."""
    from behavior.youtube.player_controls import set_autoplay_off_visible

    ok, proof = await set_autoplay_off_visible(tab)
    if not ok:
        log.warning("Autoplay OFF failed: %s", proof)
    return ok


async def click_description_link(tab: Any, *, rng: random.Random | None = None) -> bool:
    """Click a random link inside expanded description."""
    r = rng or get_rng()
    idx = r.randint(0, 2)
    result = await safe_eval_js(
        tab,
        f"""
        var desc = document.querySelector('ytd-text-inline-expander, #description-inline-expander');
        if (!desc) return false;
        var links = Array.from(desc.querySelectorAll('a[href^="http"]')).filter(a => a.offsetParent);
        var el = links[{idx}];
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', {{bubbles: true}}));
        return true;
        """,
        action_name="DESC_LINK",
        wrap=False,
    )
    return bool(result)


async def like_comment_first(tab: Any) -> bool:
    """Like the first visible comment."""
    return await safe_click(tab, DESKTOP["comment_like_button"], action_name="COMMENT_LIKE")


async def engagement_bundle(
    tab: Any,
    *,
    like_prob: float = 0.7,
    subscribe_prob: float = 0.3,
    comment_prob: float = 0.15,
    comment_text: str = "",
    rng: random.Random | None = None,
) -> dict:
    """
    Randomized engagement actions (Rule F) — not same order every time.

    Watch pehle, phir shuffled like/subscribe/comment.

    Returns:
        Dict of action → result.
    """
    r = rng or get_rng()
    await human_delay(2.5, 5.0)
    results: dict = {}

    actions = []
    if should_do_action(like_prob, rng=r):
        actions.append(("like", lambda: like(tab, want=True)))
    if should_do_action(subscribe_prob, rng=r):
        actions.append(("subscribe", lambda: subscribe(tab, want=True)))
    if comment_text and should_do_action(comment_prob, rng=r):
        actions.append(("comment", lambda: post_comment(tab, comment_text)))

    r.shuffle(actions)
    for name, fn in actions:
        await human_delay(2.5, 7.0)
        try:
            result = await fn()
            results[name] = result
        except Exception as exc:
            results[name] = (False, str(exc))

    return results
