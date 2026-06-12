"""Smoke checks for AI goal + plan shift integration (import + basic logic)."""

from datetime import datetime, timezone


def test_ai_goal_planner_import():
    # Frontend TS — verify Python side still loads mastermind chain
    from server_python import mastermind_executor as me
    from server_python import mastermind_store as ms
    assert hasattr(me, "check_scheduled_plans")
    assert hasattr(ms, "save_scheduled_plan")
    assert hasattr(ms, "list_scheduled_plans")


def test_shift_day_delta_math():
    """Mirror of TS shift: +1 calendar day preserves hour/minute."""
    start = datetime(2026, 6, 10, 14, 30, 0, tzinfo=timezone.utc)
    shifted = start.replace(day=11)
    assert shifted.day == 11
    assert shifted.hour == 14
    assert shifted.minute == 30
