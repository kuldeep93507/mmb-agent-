"""
behavior.youtube.state — Video/player state helpers using V2 selectors and JS.
All functions are pure JS-eval via nodriver tab.evaluate().

FIXED:
  ✅ _eval() wrapped with asyncio.wait_for timeout=8s (no infinite hang)
  ✅ get_video_duration_when_ready() uses asyncio.get_running_loop()
     (asyncio.get_event_loop() is deprecated in Python 3.10+)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger("mmb.yt_state")


# ── JS eval helper ────────────────────────────────────────────────────────────

async def _eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """Evaluate JS with timeout — never hangs on unresponsive tab."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        log.debug("eval timeout after %.1fs", timeout)
        return None
    except Exception as e:
        log.debug("eval error: %s", e)
        return None


# ── State checks ──────────────────────────────────────────────────────────────

async def is_liked(tab: Any) -> bool:
    """Returns True if the video like button is already pressed."""
    val = await _eval(tab, """
    (() => {
        var btn = document.querySelector('like-button-view-model button')
               || document.querySelector('button[aria-label*="like this video" i]');
        return btn ? btn.getAttribute('aria-pressed') === 'true' : false;
    })()
    """)
    return bool(val)


async def is_disliked(tab: Any) -> bool:
    """Returns True if the video dislike button is already pressed."""
    val = await _eval(tab, """
    (() => {
        var btn = document.querySelector('dislike-button-view-model button')
               || document.querySelector('button[aria-label*="Dislike this video" i]');
        return btn ? btn.getAttribute('aria-pressed') === 'true' : false;
    })()
    """)
    return bool(val)


async def is_subscribed(tab: Any) -> bool:
    """
    Returns True if already subscribed.
    Checks 3 methods: visible bell, Unsubscribe button, or button text.
    """
    val = await _eval(tab, """
    (() => {
        // Method 1: Bell button VISIBLE (parent must NOT have 'invisible' attr)
        var bellSelectors = [
            'button[aria-label*="notification setting" i]',
            'ytd-subscription-notification-toggle-button-renderer-next button',
            'ytd-subscription-notification-toggle-button-renderer button'
        ];
        for (var sel of bellSelectors) {
            var el = document.querySelector(sel);
            if (!el) continue;
            var parent = el.closest('#notification-preference-button, [id*="notification"]');
            if (parent && parent.hasAttribute('invisible')) continue;
            var r = el.getBoundingClientRect();
            if (r.width > 4 && r.height > 4) return true;
        }
        // Method 2: Any button aria-label starts with "Unsubscribe"
        var buttons = document.querySelectorAll('button');
        for (var b of buttons) {
            var al = (b.getAttribute('aria-label') || '').toLowerCase();
            if (al.startsWith('unsubscribe')) return true;
        }
        // Method 3: Subscribe button text = "Subscribed"
        var sub = document.querySelector(
            'ytd-subscribe-button-renderer button, #subscribe-button button, subscribe-button-view-model button'
        );
        if (sub) {
            var txt = (sub.innerText || sub.textContent || '').toLowerCase().trim();
            if (txt === 'subscribed' || txt.includes('subscribed')) return true;
            var al2 = (sub.getAttribute('aria-label') || '').toLowerCase();
            if (al2.startsWith('unsubscribe')) return true;
        }
        return false;
    })()
    """)
    return bool(val)


async def is_ad_playing(tab: Any) -> bool:
    """Returns True if an ad is currently playing."""
    val = await _eval(tab, """
    (() => {
        var p = document.querySelector('#movie_player');
        if (!p) return false;
        return p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
    })()
    """)
    return bool(val)


async def get_volume_percent(tab: Any) -> int:
    """Returns current volume as 0-100 integer."""
    val = await _eval(tab, """
    (() => {
        var v = document.querySelector('video');
        if (!v) return 80;
        return Math.round(v.volume * 100);
    })()
    """)
    try:
        return int(val) if val is not None else 80
    except Exception:
        return 80


async def get_current_time(tab: Any) -> float:
    """Returns current video playback time in seconds. -1.0 = video element not found."""
    val = await _eval(tab, """
    (() => {
        var v = document.querySelector('#movie_player video')
             || document.querySelector('ytd-player video')
             || document.querySelector('video');
        return v ? v.currentTime : null;
    })()
    """)
    try:
        return float(val) if val is not None else -1.0
    except Exception:
        return -1.0


async def get_video_duration_when_ready(tab: Any, timeout: float = 30.0) -> float:
    """
    Wait for video duration to be available, return duration in seconds.

    FIX: asyncio.get_event_loop() is deprecated in Python 3.10+ inside coroutines.
         Use asyncio.get_running_loop() which is the correct modern API.
    """
    # FIX: get_running_loop() instead of deprecated get_event_loop()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout

    while loop.time() < deadline:
        val = await _eval(tab, """
        (() => {
            var v = document.querySelector('video');
            if (!v) return 0;
            var dur = v.duration;
            return (dur && isFinite(dur) && dur > 0) ? dur : 0;
        })()
        """)
        try:
            dur = float(val) if val else 0.0
            if dur > 0:
                return dur
        except Exception:
            pass
        await asyncio.sleep(1.0)

    return 0.0
