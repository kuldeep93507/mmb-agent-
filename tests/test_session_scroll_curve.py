"""Session scroll curve — SHA-256 per profile/session."""
from __future__ import annotations

from server_python.session_behavior import (
    SessionBehaviorPlan,
    ensure_session_nonce,
    _build_scroll_curve,
)


def test_ensure_session_nonce_unique():
    a = ensure_session_nonce(None)
    b = ensure_session_nonce(None)
    assert a != b
    assert ensure_session_nonce("job-1") == "job-1"


def test_scroll_curve_count_0_to_4():
    counts: set[int] = set()
    for i in range(40):
        seed = f"{i:064x}"
        _, events = _build_scroll_curve(seed)
        counts.add(len(events))
        assert len(events) <= 4
    assert counts  # at least one variant seen


def test_different_sessions_different_plans():
    p1 = SessionBehaviorPlan.create("prof-a", "vid1", session_nonce="run-1")
    p2 = SessionBehaviorPlan.create("prof-a", "vid1", session_nonce="run-2")
    assert p1.seed_hex != p2.seed_hex
    assert p1.like_at_pct != p2.like_at_pct or p1.scroll_curve_id != p2.scroll_curve_id


def test_same_profile_different_profiles_differ():
    p1 = SessionBehaviorPlan.create("prof-a", "vid1", session_nonce="x")
    p2 = SessionBehaviorPlan.create("prof-b", "vid1", session_nonce="x")
    assert p1.seed_hex != p2.seed_hex


def test_auto_nonce_makes_unique_runs():
    p1 = SessionBehaviorPlan.create("prof-a", "vid1")
    p2 = SessionBehaviorPlan.create("prof-a", "vid1")
    assert p1.session_nonce != p2.session_nonce
    assert p1.seed_hex != p2.seed_hex
