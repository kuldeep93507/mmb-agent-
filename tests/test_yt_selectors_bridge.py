"""Tests for yt_selectors.py V2 bridge — SemanticResolver compatibility."""

from __future__ import annotations

from server_python.yt_selectors import SELECTOR_MAP, get, all_css, v2_selectors


def test_selector_map_populated() -> None:
    assert len(SELECTOR_MAP) >= 200


def test_legacy_aliases_exist() -> None:
    """Old resolver keys still resolve."""
    aliases = [
        "skip_ad_button", "like_button", "subscribe_button",
        "search_box", "bell_button", "comment_box",
    ]
    for key in aliases:
        entry = get(key)
        assert entry.get("css"), f"Alias {key} has no CSS selectors"


def test_skip_ad_matches_v2() -> None:
    skip_css = all_css("skip_ad_button")
    v2_css = list(v2_selectors("ad_skip_button"))
    assert skip_css == v2_css


def test_like_button_has_aria_first() -> None:
    css = all_css("like_button")
    assert any("aria-label" in s for s in css)
