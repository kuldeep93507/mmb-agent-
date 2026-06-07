"""Tests for verify_actions and ad skip timing fixes."""

from __future__ import annotations

import pytest

from behavior.youtube.selectors import DESKTOP


def test_search_results_selectors_in_v2() -> None:
    sels = DESKTOP.get("search_results_video", ())
    assert "ytd-video-renderer" in sels
    assert len(sels) >= 4


def test_search_input_selectors_in_v2() -> None:
    sels = DESKTOP.get("search_input", ())
    assert any("search" in s.lower() for s in sels)


def test_account_avatar_includes_modern_shape() -> None:
    sels = DESKTOP.get("account_avatar_button", ())
    assert any("yt-spec-avatar" in s for s in sels)


@pytest.mark.asyncio
async def test_verify_seeked_backward() -> None:
    from behavior.youtube.verify_actions import verify_seeked

    class FakeTab:
        pass

    async def fake_eval(tab, code, **kwargs):
        return 40.0

    import behavior.youtube.verify_actions as va

    original = va.safe_eval_js
    va.safe_eval_js = fake_eval
    try:
        ok = await verify_seeked(FakeTab(), 55.0, 14, direction="backward")
        assert ok is True
        bad = await verify_seeked(FakeTab(), 55.0, 14, direction="forward")
        assert bad is False
    finally:
        va.safe_eval_js = original


@pytest.mark.asyncio
async def test_verify_seeked_forward() -> None:
    from behavior.youtube.verify_actions import verify_seeked

    class FakeTab:
        pass

    async def fake_eval(tab, code, **kwargs):
        return 70.0

    import behavior.youtube.verify_actions as va

    original = va.safe_eval_js
    va.safe_eval_js = fake_eval
    try:
        ok = await verify_seeked(FakeTab(), 55.0, 14, direction="forward")
        assert ok is True
    finally:
        va.safe_eval_js = original
