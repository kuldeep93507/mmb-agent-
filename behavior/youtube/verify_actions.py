"""
Post-action verification — every stateful YouTube action must prove it worked.

No verify_fn → log must NOT claim success.
"""

from __future__ import annotations

from typing import Any

from behavior.youtube.safe_actions import safe_eval_js
from behavior.youtube.selectors import JS_API


async def verify_logged_in(tab: Any) -> bool:
    """YouTube account signed in (not guest / sign-in popup state)."""
    result = await safe_eval_js(
        tab,
        """
        !!document.querySelector(
            'button#avatar-btn, ytd-topbar-menu-button-renderer#avatar-btn, '
            + 'button[aria-label*="Account menu" i], img.yt-img-shadow.ytd-active-account-header-renderer'
        )
        """,
        action_name="VERIFY_LOGGED_IN",
        wrap=False,
        log_result=False,
    )
    return bool(result)


async def verify_liked(tab: Any) -> bool:
    code = JS_API.get("is_liked", "")
    if not code:
        return False
    return bool(await safe_eval_js(tab, code, action_name="VERIFY_LIKED", log_result=False))


async def verify_subscribed(tab: Any) -> bool:
    code = JS_API.get("is_subscribed", "")
    if not code:
        return False
    return bool(await safe_eval_js(tab, code, action_name="VERIFY_SUBSCRIBED", log_result=False))


async def verify_quality_changed(tab: Any, target: str) -> bool:
    """
    Verify via VISIBLE settings menu label (what user sees).
    getPlaybackQuality() is NOT used — ABR can be 360p while UI shows Auto.
    """
    from behavior.youtube.player_controls import read_quality_label_in_settings

    label = await read_quality_label_in_settings(tab, open_menu=True)
    if not label:
        return False
    cur = label.lower()
    t = target.replace("p", "").strip().lower()
    # Delhi UI shows "Auto (360p)" while streaming 360p — only primary label counts
    primary = cur.split("(")[0].strip()
    if t != "auto" and primary == "auto":
        return False
    if t in primary or f"{t}p" in primary:
        return True
    if f"{t}p" in cur and primary != "auto":
        return True
    return False


async def verify_volume(tab: Any, target_pct: int, tolerance: int = 10) -> bool:
    """Verify VISIBLE volume slider aria-valuenow — NOT getVolume() API."""
    from behavior.youtube.player_controls import read_volume_slider_pct

    cur = await read_volume_slider_pct(tab)
    if cur is None:
        return False
    return abs(cur - target_pct) <= tolerance


async def verify_seeked(tab: Any, before_time: float, expected_delta: float) -> bool:
    after = await safe_eval_js(
        tab,
        JS_API.get("get_current_time_api", "document.querySelector('#movie_player')?.getCurrentTime?.()"),
        action_name="VERIFY_SEEK",
        log_result=False,
    )
    try:
        return (float(after) - before_time) >= (expected_delta - 3)
    except (TypeError, ValueError):
        return False


async def verify_paused(tab: Any) -> bool:
    result = await safe_eval_js(
        tab,
        """
        var v = document.querySelector('video');
        if (v) return v.paused;
        var p = document.querySelector('#movie_player');
        return p && p.getPlayerState && p.getPlayerState() === 2;
        """,
        action_name="VERIFY_PAUSED",
        wrap=False,
        log_result=False,
    )
    return bool(result)


async def verify_description_expanded(tab: Any) -> bool:
    result = await safe_eval_js(
        tab,
        """
        var exp = document.querySelector(
            '#description-inline-expander[expanded], ytd-text-inline-expander[expanded]'
        );
        if (exp) return true;
        var more = document.querySelector(
            'tp-yt-paper-button#expand, #expand, button[aria-label*="more" i]'
        );
        if (more && more.getAttribute('aria-expanded') === 'true') return true;
        var snippet = document.querySelector('#description-inline-expander .ytd-watch-metadata');
        if (snippet) {
            var style = window.getComputedStyle(snippet);
            if (snippet.scrollHeight > 80 && style.webkitLineClamp === 'none') return true;
        }
        return false;
        """,
        action_name="VERIFY_DESC_EXPANDED",
        wrap=False,
        log_result=False,
    )
    return bool(result)


async def verify_autoplay_off(tab: Any) -> bool:
    """Visible autoplay toggle must exist and show OFF."""
    result = await safe_eval_js(
        tab,
        """
        var btn = document.querySelector(
            'button.ytp-autonav-toggle, button[data-tooltip-target-id="ytp-autonav-toggle-button"]'
        );
        if (!btn || !btn.offsetParent) return JSON.stringify({found: false});
        var inner = btn.querySelector('.ytp-autonav-toggle-button');
        var label = (btn.getAttribute('aria-label') || '').toLowerCase();
        var on = (inner && inner.getAttribute('aria-checked') === 'true')
            || label.indexOf('is on') >= 0
            || (inner && inner.classList.contains('ytp-autonav-toggle-button-enabled'));
        return JSON.stringify({found: true, off: !on});
        """,
        action_name="VERIFY_AUTOPLAY_OFF",
        wrap=False,
        log_result=False,
    )
    try:
        import json
        info = json.loads(str(result)) if result else {}
        return bool(info.get("found") and info.get("off"))
    except Exception:
        return False


async def verify_ad_skipped(tab: Any) -> bool:
    """True if no ad overlay is showing."""
    result = await safe_eval_js(
        tab,
        """
        var p = document.querySelector('#movie_player, .html5-video-player');
        if (!p) return true;
        return !(p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
        """,
        action_name="VERIFY_AD_GONE",
        wrap=False,
        log_result=False,
    )
    return bool(result)


async def capture_dom_state(tab: Any, action_name: str) -> dict:
    """Lightweight DOM snapshot for action audit trail."""
    raw = await safe_eval_js(
        tab,
        """
        return {
            url: location.href,
            liked: document.querySelector('like-button-view-model button')
                ?.getAttribute('aria-pressed') === 'true',
            quality: document.querySelector('#movie_player')?.getPlaybackQuality?.() || null,
            volume: document.querySelector('#movie_player')?.getVolume?.() || null,
            paused: document.querySelector('video')?.paused ?? null,
            time: document.querySelector('#movie_player')?.getCurrentTime?.() || null,
        };
        """,
        action_name=f"DOM_STATE_{action_name}",
        wrap=False,
        log_result=False,
    )
    return raw if isinstance(raw, dict) else {}
