"""Tests for human scroll activity planner — Bug #4."""

from __future__ import annotations

import random
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from behavior.youtube.scroll_activity import (
    ScrollActivityPlanner,
    human_scroll_activity_plan,
    scroll_back_to_player,
    small_idle_scroll,
)


def test_human_scroll_activity_plan_always_1_to_3() -> None:
    for seed in range(50):
        plan = human_scroll_activity_plan(300.0, random.Random(seed))
        assert 1 <= len(plan) <= 3
        times = [a.at_time for a in plan]
        assert times == sorted(times)
        assert all(15 <= t <= 300 for t in times)


def test_plan_disabled_returns_empty() -> None:
    assert human_scroll_activity_plan(300.0, random.Random(1), enabled=False) == []


def test_plan_short_video_returns_empty() -> None:
    assert human_scroll_activity_plan(10.0, random.Random(1)) == []


@pytest.mark.asyncio
async def test_planner_tick_runs_at_most_one_per_call() -> None:
    rng = random.Random(99)
    planner = ScrollActivityPlanner(200.0, rng, enabled=True)
    tab = MagicMock()
    guardian = MagicMock()
    runs = 0
    with patch.dict(
        "behavior.youtube.scroll_activity._ACTION_RUNNERS",
        {name: AsyncMock() for name in ("read_description", "read_comments", "check_chapters", "idle_scroll")},
    ), patch(
        "behavior.youtube.scroll_activity.get_all_chapters",
        new=AsyncMock(return_value=[{"title": "Intro"}]),
    ):
        for elapsed in range(0, 250, 3):
            if await planner.tick_and_run(tab, float(elapsed), guardian):
                runs += 1
    assert runs == len(planner.activities)


@pytest.mark.asyncio
async def test_human_scroll_activity_triggers() -> None:
    """Planner fires due activity exactly once when elapsed passes at_time."""
    rng = random.Random(7)
    planner = ScrollActivityPlanner(200.0, rng, enabled=True)
    first_act = planner.activities[0]
    first_act.at_time = 30.0

    tab = MagicMock()
    guardian = MagicMock()

    mock_runner = AsyncMock()
    with patch.dict(
        "behavior.youtube.scroll_activity._ACTION_RUNNERS",
        {first_act.name: mock_runner},
    ), patch(
        "behavior.youtube.scroll_activity.get_all_chapters",
        new=AsyncMock(return_value=[{"title": "A"}] if first_act.requires_chapters else []),
    ):
        assert await planner.tick_and_run(tab, 25.0, guardian) is False
        assert await planner.tick_and_run(tab, 35.0, guardian) is True
        assert first_act.done is True
        mock_runner.assert_called_once()
        assert await planner.tick_and_run(tab, 40.0, guardian) is False


@pytest.mark.asyncio
async def test_check_chapters_skipped_without_chapters() -> None:
    rng = random.Random(3)
    planner = ScrollActivityPlanner(200.0, rng, enabled=True)
    for act in planner.activities:
        if act.name == "check_chapters":
            act.at_time = 25.0
            tab = MagicMock()
            guardian = MagicMock()
            with patch(
                "behavior.youtube.scroll_activity.get_all_chapters",
                new=AsyncMock(return_value=[]),
            ), patch(
                "behavior.youtube.scroll_activity.scroll_to_chapters_and_hover",
                new=AsyncMock(),
            ) as mock_chapters:
                ok = await planner.tick_and_run(tab, 30.0, guardian)
                assert ok is True
                mock_chapters.assert_not_called()
            return
    pytest.skip("check_chapters not in plan for seed 3")


@pytest.mark.asyncio
async def test_scroll_back_to_player_uses_safe_eval() -> None:
    tab = MagicMock()
    with patch(
        "behavior.youtube.scroll_activity.safe_eval_js",
        new=AsyncMock(),
    ) as mock_js:
        await scroll_back_to_player(tab)
    mock_js.assert_called_once()
    assert mock_js.call_args.kwargs.get("action_name") == "SCROLL_BACK_PLAYER"


@pytest.mark.asyncio
async def test_small_idle_scroll_smooth_steps() -> None:
    tab = MagicMock()
    rng = random.Random(42)
    with patch(
        "behavior.youtube.scroll_activity._smooth_scroll_by",
        new=AsyncMock(),
    ) as mock_scroll, patch(
        "behavior.youtube.scroll_activity.scroll_back_to_player",
        new=AsyncMock(),
    ):
        await small_idle_scroll(tab, rng=rng)
    assert mock_scroll.call_count >= 2


def test_planner_respects_activity_time_windows() -> None:
    found = {"read_description": False, "read_comments": False, "check_chapters": False}
    for seed in range(100):
        plan = human_scroll_activity_plan(600.0, random.Random(seed))
        for act in plan:
            if act.name == "read_description":
                found["read_description"] = True
                assert 15 <= act.at_time <= 45
            elif act.name == "read_comments":
                found["read_comments"] = True
                assert 60 <= act.at_time <= 180
            elif act.name == "check_chapters":
                found["check_chapters"] = True
                assert 20 <= act.at_time <= 60
    assert all(found.values()), "expected all activity types across seeds"
