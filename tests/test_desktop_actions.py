"""Tests for desktop action module exports."""

from __future__ import annotations

import inspect

import behavior.youtube.desktop as desktop


def test_critical_actions_exported() -> None:
    required = [
        "play", "pause", "skip_ad", "like", "dislike", "subscribe",
        "mute", "unmute", "toggle_bell", "set_bell_level",
        "join_channel", "share", "download", "save_to_playlist",
        "expand_description", "jump_to_chapter", "post_comment",
        "reply_to_comment", "heart_comment", "toggle_captions",
        "set_playback_speed", "set_quality", "toggle_fullscreen",
        "toggle_theater", "toggle_pip", "click_related_video",
        "click_endscreen_video", "engagement_bundle", "search", "clear_search",
    ]
    for name in required:
        assert hasattr(desktop, name), f"Missing desktop.{name}"
        assert inspect.iscoroutinefunction(getattr(desktop, name))
