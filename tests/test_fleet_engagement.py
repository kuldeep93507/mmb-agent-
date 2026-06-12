"""Tests for fleet engagement payload mapping."""
from __future__ import annotations

import json
from pathlib import Path

from server_python.fleet_engagement import (
    assign_profile_videos,
    fleet_keys_to_actions,
    resolve_video_pool,
    traffic_to_source,
)


def test_fleet_keys_to_actions_maps_all_selected():
    keys = {"like", "sub", "bell", "comment", "adskip", "seek", "quality", "captions", "desc", "dislike"}
    acts = fleet_keys_to_actions(keys, quality="360p", vol_min=40, vol_max=60, smart_comment=True)
    assert acts["like"] is True
    assert acts["subscribe"] is True
    assert acts["bell"] is True
    assert acts["comment"] is True
    assert acts["seekEnabled"] is True
    assert acts["captionsEnabled"] is True
    assert acts["descriptionExpand"] is True
    assert acts["dislike"] is True
    assert acts["adSkipEnabled"] is True
    assert acts["qualityChange"] is True
    assert acts["videoQuality"] == "360p"
    assert 40 <= acts["volumePct"] <= 60
    assert acts["useAiComment"] is True


def test_fleet_keys_templates_only_when_smart_off():
    acts = fleet_keys_to_actions(
        {"comment"},
        comment_text="Nice video!",
        smart_comment=False,
    )
    assert acts["commentText"] == "Nice video!"
    assert acts["useAiComment"] is False


def test_traffic_random():
    import random
    rng = random.Random(42)
    src = traffic_to_source("🎲 Random (per profile)", rng)
    assert src in ("search", "direct", "google", "bing", "notification", "homepage", "channel_discovery")


def test_assign_profile_videos_shuffle():
    pool = [{"url": "https://youtu.be/a"}, {"url": "https://youtu.be/b"}]
    out = assign_profile_videos(["p1", "p2"], pool, "shuffle", __import__("random").Random(1))
    assert len(out["p1"]) == 1
    assert len(out["p2"]) == 1


def test_resolve_video_pool_manual_and_channels(tmp_path: Path):
    channels = tmp_path / "channels.json"
    channels.write_text(json.dumps({
        "channels": [{"id": "c1", "name": "TestCh"}],
        "videos": [
            {"channel_id": "c1", "url": "https://youtu.be/abc", "title": "T1"},
            {"channel_id": "c2", "url": "https://youtu.be/xyz", "title": "T2"},
        ],
    }), encoding="utf-8")
    pool = resolve_video_pool(["https://youtu.be/manual"], ["c1"], channels)
    urls = {v["url"] for v in pool}
    assert "https://youtu.be/manual" in urls
    assert "https://youtu.be/abc" in urls
    assert "https://youtu.be/xyz" not in urls
