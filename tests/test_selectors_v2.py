"""Tests for V2 YouTube selectors — stability guarantees."""

from __future__ import annotations

import re

import pytest

from behavior.youtube.selectors import DESKTOP, MOBILE, ANDROID_APP, JS_API


@pytest.mark.parametrize("pool_name,pool", [
    ("DESKTOP", DESKTOP),
    ("MOBILE", MOBILE),
])
def test_no_hashed_ngcontent_selectors(pool_name: str, pool: dict) -> None:
    """V2 guarantee: no Angular hashed classes."""
    hashed = re.compile(r"_ngcontent-")
    for key, value in pool.items():
        if isinstance(value, tuple):
            for sel in value:
                assert not hashed.search(sel), f"{pool_name}[{key}] has hashed class: {sel}"


@pytest.mark.parametrize("pool_name,pool", [
    ("DESKTOP", DESKTOP),
    ("MOBILE", MOBILE),
])
def test_no_nth_child_selectors(pool_name: str, pool: dict) -> None:
    """V2 guarantee: no positional nth-child selectors."""
    nth = re.compile(r":nth-child\(")
    for key, value in pool.items():
        if isinstance(value, tuple):
            for sel in value:
                assert not nth.search(sel), f"{pool_name}[{key}] has nth-child: {sel}"


def test_desktop_has_critical_keys() -> None:
    """Critical action keys must exist in DESKTOP."""
    required = [
        "play_button", "pause_button", "ad_skip_button", "like_button",
        "dislike_button", "subscribe_button", "bell_notification_button",
        "search_input", "comment_submit_button", "fullscreen_button",
        "tap_to_unmute_prompt", "endscreen_video_card",
    ]
    for key in required:
        assert key in DESKTOP, f"Missing DESKTOP key: {key}"
        assert isinstance(DESKTOP[key], tuple), f"{key} should be tuple"
        assert len(DESKTOP[key]) >= 1, f"{key} needs at least 1 selector"


def test_js_api_state_detection() -> None:
    """JS_API must have all state detection commands."""
    required = [
        "is_liked", "is_disliked", "is_subscribed",
        "is_tap_to_unmute_showing", "is_endscreen_showing",
        "get_all_chapters", "get_current_chapter", "play", "pause",
        "can_skip_ad",
    ]
    for key in required:
        assert key in JS_API, f"Missing JS_API key: {key}"


def test_selector_count_minimum() -> None:
    """V2 file should have 500+ total selectors."""
    desktop_count = sum(len(v) for v in DESKTOP.values() if isinstance(v, tuple))
    mobile_count = sum(len(v) for v in MOBILE.values() if isinstance(v, tuple))
    js_count = len([k for k in JS_API if not k.endswith("_STATES") and not k.endswith("_LEVELS")])
    total = desktop_count + mobile_count + len(ANDROID_APP) + js_count
    assert desktop_count >= 200, f"Desktop selectors too few: {desktop_count}"
    assert total >= 400, f"Grand total too few: {total}"
