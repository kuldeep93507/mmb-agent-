"""Tests for safe_actions helpers — mock tab, no browser needed."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from behavior.youtube.safe_actions import (
    _normalize_selectors,
    safe_click,
    safe_find,
    safe_wait,
)


def test_normalize_selectors_string() -> None:
    assert _normalize_selectors("button.foo") == ["button.foo"]


def test_normalize_selectors_tuple() -> None:
    t = ("a", "b", "c")
    assert _normalize_selectors(t) == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_safe_click_first_selector_wins() -> None:
    tab = MagicMock()
    el = AsyncMock()
    tab.select = AsyncMock(return_value=el)

    with patch("behavior.youtube.safe_actions.page_is_safe", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.safe_actions.human_click_element", new=AsyncMock(return_value=True)):
        ok = await safe_click(tab, ["sel1", "sel2"], action_name="TEST", check_page_safe=True)
    assert ok is True
    tab.select.assert_called_once_with("sel1", timeout=5)


@pytest.mark.asyncio
async def test_safe_click_fallback_chain() -> None:
    tab = MagicMock()
    el = AsyncMock()
    tab.select = AsyncMock(side_effect=[Exception("miss"), el])

    with patch("behavior.youtube.safe_actions.page_is_safe", new=AsyncMock(return_value=True)), \
         patch("behavior.youtube.safe_actions.human_click_element", new=AsyncMock(return_value=True)):
        ok = await safe_click(tab, ["bad", "good"], action_name="FALLBACK")
    assert ok is True
    assert tab.select.call_count == 2


@pytest.mark.asyncio
async def test_safe_click_all_fail() -> None:
    tab = MagicMock()
    tab.select = AsyncMock(side_effect=Exception("not found"))

    ok = await safe_click(tab, ["a", "b"], action_name="FAIL", check_page_safe=False)
    assert ok is False


@pytest.mark.asyncio
async def test_safe_find_returns_index() -> None:
    tab = MagicMock()
    el = MagicMock()
    tab.select = AsyncMock(side_effect=[Exception(), el])

    found, idx, sel = await safe_find(tab, ["x", "y"], action_name="FIND")
    assert found is el
    assert idx == 1
    assert sel == "y"


@pytest.mark.asyncio
async def test_safe_wait_timeout() -> None:
    tab = MagicMock()
    tab.select = AsyncMock(side_effect=Exception("nope"))

    ok = await safe_wait(tab, ["missing"], timeout=0.6, poll_interval=0.2)
    assert ok is False
