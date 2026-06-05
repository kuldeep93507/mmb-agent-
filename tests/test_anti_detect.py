"""Tests for anti-detection primitives."""

from __future__ import annotations

import random

import pytest

from behavior.youtube.anti_detect import (
    shuffle_actions,
    should_do_action,
    random_watch_percent,
    DAILY_CAPS,
)


def test_shuffle_actions_changes_order() -> None:
    r = random.Random(42)
    actions = ["like", "subscribe", "comment"]
    shuffled = shuffle_actions(actions, rng=r)
    assert sorted(shuffled) == sorted(actions)
    assert len(shuffled) == 3


def test_should_do_action_always_true() -> None:
    r = random.Random(1)
    assert should_do_action(1.0, rng=r) is True


def test_should_do_action_always_false() -> None:
    r = random.Random(1)
    assert should_do_action(0.0, rng=r) is False


def test_random_watch_percent_in_range() -> None:
    r = random.Random(99)
    for _ in range(20):
        p = random_watch_percent(0.4, 0.95, rng=r)
        assert 0.4 <= p <= 0.95


def test_daily_caps_defined() -> None:
    assert "likes" in DAILY_CAPS
    assert DAILY_CAPS["likes"][0] < DAILY_CAPS["likes"][1]


@pytest.mark.asyncio
async def test_page_is_safe_ok() -> None:
    from behavior.youtube.anti_detect import page_is_safe
    from unittest.mock import AsyncMock, MagicMock

    tab = MagicMock()
    result = MagicMock()
    result.value = "ok"
    tab.evaluate = AsyncMock(return_value=result)
    assert await page_is_safe(tab) is True


@pytest.mark.asyncio
async def test_page_is_safe_captcha() -> None:
    from behavior.youtube.anti_detect import page_is_safe
    from unittest.mock import AsyncMock, MagicMock

    tab = MagicMock()
    result = MagicMock()
    result.value = "captcha"
    tab.evaluate = AsyncMock(return_value=result)
    assert await page_is_safe(tab) is False
