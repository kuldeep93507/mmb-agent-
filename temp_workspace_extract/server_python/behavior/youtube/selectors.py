"""
behavior.youtube.selectors — Re-exports DESKTOP/MOBILE/JS_API from V2 master file.
All modules that do `from behavior.youtube.selectors import DESKTOP` get real V2 selectors.

FIXED:
  ✅ Added explicit warning log when V2 file not found (was silently falling back)
     so developer knows selectors may be outdated.
"""
from __future__ import annotations

import logging
import os
import sys

log = logging.getLogger("mmb.yt_selectors")

# V2 master file is in project root
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
_V2 = os.path.join(_ROOT, "MMB_YOUTUBE_SELECTORS_FINAL_V2.py")

if os.path.exists(_V2):
    import importlib.util
    _spec = importlib.util.spec_from_file_location("_yt_sel_v2", _V2)
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    DESKTOP          = getattr(_mod, "DESKTOP", {})
    MOBILE           = getattr(_mod, "MOBILE", {})
    ANDROID_APP      = getattr(_mod, "ANDROID_APP", {})
    JS_API           = getattr(_mod, "JS_API", {})
    FOURTEEN_ACTIONS = getattr(_mod, "FOURTEEN_ACTIONS", {})
    log.debug("V2 selectors loaded from %s", _V2)
else:
    # FIX: Explicit warning — developer should know fallback is active
    log.warning(
        "MMB_YOUTUBE_SELECTORS_FINAL_V2.py not found at %s — "
        "using inline fallback selectors (may be outdated). "
        "Place V2 file in project root to use latest selectors.",
        _V2
    )
    DESKTOP = {
        "ad_skip_button": (
            'button.ytp-skip-ad-button', '.ytp-skip-ad-button',
            '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button',
            'button[id^="skip-button"]', '#skip-button',
            'button[aria-label*="Skip Ad" i]', 'button[aria-label*="Skip" i]',
            '.ytp-skip-ad button', '.ytp-skip-ad', 'div[id^="skip-ad"] button',
            'div[id^="skip-ad"]',
        ),
        "ad_detection_combined": (
            '.html5-video-player.ad-showing',
            '.html5-video-player.ad-interrupting',
        ),
        "ad_overlay_close": (
            '.ytp-ad-overlay-close-button',
            'button[aria-label*="Close ad" i]',
        ),
        "like_button": (
            'button[aria-label*="like this video" i]',
            'like-button-view-model button',
            'segmented-like-dislike-button-view-model like-button-view-model button',
        ),
        "dislike_button": (
            'button[aria-label*="Dislike this video" i]',
            'dislike-button-view-model button',
        ),
        "subscribe_button": (
            'button[aria-label^="Subscribe to" i]',
            'ytd-subscribe-button-renderer button',
            'subscribe-button-view-model button',
        ),
        "bell_notification_button": (
            'button[aria-label*="notification setting" i]',
            'ytd-subscription-notification-toggle-button-renderer-next button',
        ),
        "bell_menu_items_dropdown": ('tp-yt-paper-item[role="menuitem"]',),
        "comment_input_placeholder_click": ('#simplebox-placeholder',),
        "comment_input_active_typing": ('#contenteditable-root[contenteditable="true"]',),
        "comment_submit_button": ('#submit-button button',),
        "autoplay_toggle_button": (
            'button.ytp-autonav-toggle',
            '.ytp-autonav-toggle-button',
            'button[aria-label*="Auto-play" i]',
        ),
        "description_more_button": (
            'tp-yt-paper-button#expand',
            '#description-inline-expander #expand',
        ),
        "player_root": ('#movie_player', '.html5-video-player'),
        "volume_panel": (
            '.ytp-volume-panel[role="slider"]',
            '.ytp-volume-panel',
        ),
    }
    MOBILE           = {}
    ANDROID_APP      = {}
    JS_API           = {
        "is_liked":       "document.querySelector('like-button-view-model button')?.getAttribute('aria-pressed') === 'true'",
        "is_subscribed":  "!!document.querySelector('button[aria-label*=\"notification setting\" i]')",
        "is_disliked":    "document.querySelector('dislike-button-view-model button')?.getAttribute('aria-pressed') === 'true'",
        "is_ad_playing":  "!!(document.querySelector('#movie_player.ad-showing') || document.querySelector('#movie_player.ad-interrupting'))",
        "can_skip_ad":    "!!document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, button[id^=\"skip-button\"]')",
        "get_volume":     "Math.round((document.querySelector('video')?.volume ?? 1) * 100)",
        "get_current_time": "(document.querySelector('video')?.currentTime ?? 0)",
        "get_duration":   "(document.querySelector('video')?.duration ?? 0)",
        "autoplay_is_on": "document.querySelector('.ytp-autonav-toggle-button')?.getAttribute('aria-checked') === 'true'",
    }
    FOURTEEN_ACTIONS = {}
