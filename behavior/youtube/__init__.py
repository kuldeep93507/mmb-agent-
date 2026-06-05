"""
YouTube automation — V2 selectors, safe actions, state detection.

Single source of truth: behavior.youtube.selectors (670 permanent selectors).
"""

from behavior.youtube.selectors import DESKTOP, MOBILE, ANDROID_APP, JS_API

__all__ = [
    "DESKTOP", "MOBILE", "ANDROID_APP", "JS_API",
    "safe_actions", "state", "desktop", "mobile",
    "anti_detect", "human_engine", "notification_path",
]
