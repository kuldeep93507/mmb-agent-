"""Tests for state detection functions — mock tab.evaluate."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from behavior.youtube.state import (
    is_liked,
    is_subscribed,
    is_ad_playing,
    get_video_duration,
    get_all_chapters,
)


def _mock_tab(value):
    tab = MagicMock()
    result = MagicMock()
    result.value = value
    tab.evaluate = AsyncMock(return_value=result)
    return tab


@pytest.mark.asyncio
async def test_is_liked_true() -> None:
    tab = _mock_tab(True)
    assert await is_liked(tab) is True


@pytest.mark.asyncio
async def test_is_subscribed_false() -> None:
    tab = _mock_tab(False)
    assert await is_subscribed(tab) is False


@pytest.mark.asyncio
async def test_is_ad_playing() -> None:
    tab = _mock_tab(True)
    assert await is_ad_playing(tab) is True


@pytest.mark.asyncio
async def test_get_video_duration() -> None:
    tab = _mock_tab(125.5)
    assert await get_video_duration(tab) == 125.5


@pytest.mark.asyncio
async def test_get_all_chapters_list() -> None:
    chapters = [{"title": "Intro", "time": "0:00", "href": "/watch?v=x&t=0"}]
    tab = _mock_tab(chapters)
    result = await get_all_chapters(tab)
    assert len(result) == 1
    assert result[0]["title"] == "Intro"
