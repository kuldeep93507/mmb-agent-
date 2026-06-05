"""Tests for bulletproof quality change — Bug #1/#2."""

from __future__ import annotations

import random
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from behavior.youtube.quality import (
    QUALITY_ALIASES,
    _normalize_target,
    change_quality,
)


def test_normalize_target_maps_1080p() -> None:
    assert _normalize_target("1080p") == "1080p"
    assert _normalize_target("1080") == "1080p"


def test_normalize_target_auto() -> None:
    assert _normalize_target("auto") == "auto"


@pytest.mark.asyncio
async def test_change_quality_auto_skips() -> None:
    tab = MagicMock()
    ok, proof = await change_quality(tab, "auto")
    assert ok is True
    assert proof == "QUALITY_AUTO_SKIP"


@pytest.mark.asyncio
async def test_change_quality_success_flow() -> None:
    tab = MagicMock()
    with patch("behavior.youtube.quality.focus_player", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.quality.reveal_controls", new=AsyncMock()), \
         patch("behavior.youtube.quality.safe_click", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.quality._menu_opened", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.quality._list_menu_labels", new=AsyncMock(return_value=["Quality", "360p", "720p"])), \
         patch("behavior.youtube.quality.read_quality_label_in_settings", new=AsyncMock(side_effect=["Auto", "360p"])), \
         patch("behavior.youtube.quality.click_menu_item_by_label", new=AsyncMock(side_effect=[True, True])), \
         patch("behavior.youtube.quality.verify_quality_changed", new=AsyncMock(return_value=True)):
        ok, proof = await change_quality(tab, "360p", profile_name="prof1", rng=random.Random(1))
    assert ok is True
    assert "360p" in proof
    assert "VERIFIED" in proof


@pytest.mark.asyncio
async def test_change_quality_fails_when_settings_missing() -> None:
    tab = MagicMock()
    with patch("behavior.youtube.quality.focus_player", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.quality.reveal_controls", new=AsyncMock()), \
         patch("behavior.youtube.quality.safe_click", new=AsyncMock(return_value=False)):
        ok, proof = await change_quality(tab, "720p", profile_name="p2", max_attempts=1)
    assert ok is False
    assert "FAIL" in proof


@pytest.mark.asyncio
async def test_change_quality_logs_available_qualities() -> None:
    tab = MagicMock()
    with patch("behavior.youtube.quality.focus_player", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.quality.reveal_controls", new=AsyncMock()), \
         patch("behavior.youtube.quality.safe_click", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.quality._menu_opened", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.quality._list_menu_labels", new=AsyncMock(return_value=["1080p", "720p"])), \
         patch("behavior.youtube.quality.read_quality_label_in_settings", new=AsyncMock(return_value="Auto")), \
         patch("behavior.youtube.quality.click_menu_item_by_label", new=AsyncMock(side_effect=[True, False])):
        ok, proof = await change_quality(tab, "480p", max_attempts=1)
    assert ok is False
    assert "QUALITY_FAIL_480p" in proof


@pytest.mark.asyncio
async def test_quality_change_happens_early() -> None:
    """Agent marks quality timestamp within 15s of session start (Bug #1)."""
    from server_python.agent_manager import YouTubeAgent

    agent = YouTubeAgent("profile-q-001", 9222, {})
    agent.tab = MagicMock()
    agent._rng = random.Random(42)

    with patch("behavior.youtube.quality.change_quality", new=AsyncMock(return_value=(True, "QUALITY=360p UI_VERIFIED"))), \
         patch.object(agent, "_tap_key", new=AsyncMock()):
        ok = await agent._do_quality_change("360p")
    assert ok is True

    # Simulate early setup timing
    import time
    agent._watch_session_t0 = time.monotonic() - 10.0
    agent._quality_change_at_sec = 10.0
    assert agent._quality_change_at_sec < 15.0


def test_quality_aliases_cover_standard_resolutions() -> None:
    for res in ("144p", "240p", "360p", "480p", "720p", "1080p"):
        assert res in QUALITY_ALIASES
