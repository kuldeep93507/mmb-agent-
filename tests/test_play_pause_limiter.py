"""Tests for PlayPauseLimiter — anti-detection pause rate limiting."""

from __future__ import annotations

import random

import pytest

from behavior.youtube.play_pause_limiter import PlayPauseLimiter


def test_zero_max_never_allows_pause() -> None:
    lim = PlayPauseLimiter(rng=random.Random(1))
    lim.max_pauses = 0
    assert lim.can_pause(100.0) is False
    assert lim.pauses_remaining == 0


def test_max_pauses_enforced() -> None:
    lim = PlayPauseLimiter(rng=random.Random(99))
    lim.max_pauses = 2
    assert lim.can_pause(40.0) is True
    lim.record_pause(40.0)
    assert lim.pauses_in_session == 1
    assert lim.can_pause(55.0) is False  # gap < 30s
    assert lim.can_pause(75.0) is True
    lim.record_pause(75.0)
    assert lim.can_pause(120.0) is False  # max reached


def test_min_gap_between_pauses() -> None:
    lim = PlayPauseLimiter(rng=random.Random(7))
    lim.max_pauses = 2
    lim.record_pause(60.0)
    assert lim.can_pause(85.0) is False
    assert lim.can_pause(89.9) is False
    assert lim.can_pause(90.0) is True


def test_play_pause_limited_per_session() -> None:
    """Simulate watch ticks — pause count never exceeds limiter max."""
    r = random.Random(42)
    lim = PlayPauseLimiter(rng=r)
    lim.max_pauses = 2
    pause_count = 0
    for t in range(30, 600, 12):
        if lim.can_pause(float(t)) and r.random() < 0.05:
            lim.record_pause(float(t))
            pause_count += 1
    assert pause_count <= 2
    assert pause_count <= lim.max_pauses


def test_half_sessions_have_zero_pauses_budget() -> None:
    """~50% of sessions should get max_pauses=0 (weighted distribution)."""
    zeros = sum(
        1 for i in range(300)
        if PlayPauseLimiter(rng=random.Random(i)).max_pauses == 0
    )
    assert zeros >= 100  # at least 33%; target ~50% (150)
