"""Tests for global traffic-source enable/disable."""
from __future__ import annotations

import random

from server_python.traffic_source_control import (
    ALL_SOURCE_IDS,
    disabled_from_settings,
    is_source_enabled,
    normalize_source_id,
    pick_from_mix_percentages,
    resolve_source,
)


def test_normalize_fleet_labels():
    assert normalize_source_id("Google") == "google"
    assert normalize_source_id("YouTube Search") == "search"
    assert normalize_source_id("Channel Page") == "channel_discovery"
    assert normalize_source_id("🎲 Random (per profile)") == "random"


def test_disabled_from_settings_filters_unknown():
    disabled = disabled_from_settings({"disabledTrafficSources": ["google", "bing", "bogus"]})
    assert disabled == {"google", "bing"}


def test_resolve_disabled_explicit_falls_back():
    rng = random.Random(1)
    resolved, note = resolve_source("google", {"google", "bing"}, rng)
    assert resolved not in {"google", "bing"}
    assert note is not None
    assert "disabled" in note.lower()


def test_resolve_random_skips_disabled_pool():
    rng = random.Random(99)
    disabled = {"google", "bing", "channel_discovery"}
    for _ in range(20):
        resolved, _ = resolve_source("random", disabled, rng)
        assert resolved not in disabled


def test_pick_from_mix_skips_disabled():
    rng = random.Random(7)
    config = {
        "srcNotificationPct": 0,
        "srcSearchPct": 50,
        "srcHomepagePct": 0,
        "srcGooglePct": 50,
        "srcBingPct": 50,
        "srcChannelDiscPct": 0,
    }
    disabled = {"google", "bing"}
    for _ in range(30):
        picked = pick_from_mix_percentages(config, disabled, rng)
        assert picked == "search"


def test_pick_from_mix_all_disabled_uses_fallback():
    rng = random.Random(3)
    config = {
        "srcNotificationPct": 10,
        "srcSearchPct": 10,
        "srcHomepagePct": 10,
        "srcGooglePct": 10,
        "srcBingPct": 10,
        "srcChannelDiscPct": 10,
    }
    picked = pick_from_mix_percentages(config, set(ALL_SOURCE_IDS), rng)
    assert picked == "direct"


def test_is_source_enabled():
    assert is_source_enabled("google", {"google"}) is False
    assert is_source_enabled("search", {"google"}) is True
