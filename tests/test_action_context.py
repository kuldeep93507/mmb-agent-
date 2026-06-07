"""Tests for action_context trust-gmail-login bypass."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from behavior.youtube.action_context import reset_action_context, set_trust_gmail_login, trust_gmail_login


@pytest.fixture(autouse=True)
def _reset_context() -> None:
    reset_action_context()
    yield
    reset_action_context()


def test_trust_gmail_login_flag() -> None:
    assert trust_gmail_login() is False
    set_trust_gmail_login(True)
    assert trust_gmail_login() is True
    reset_action_context()
    assert trust_gmail_login() is False


@pytest.mark.asyncio
async def test_like_skips_login_check_when_trusted() -> None:
    from behavior.youtube import desktop

    tab = object()
    set_trust_gmail_login(True)

    with patch.object(desktop, "verify_logged_in", new_callable=AsyncMock) as mock_verify:
        with patch.object(desktop, "is_liked", new_callable=AsyncMock, return_value=True):
            ok, proof = await desktop.like(tab, want=True)
            mock_verify.assert_not_called()
            assert ok is True
            assert proof == "ALREADY_LIKED"


@pytest.mark.asyncio
async def test_like_checks_login_when_not_trusted() -> None:
    from behavior.youtube import desktop

    tab = object()
    set_trust_gmail_login(False)

    with patch.object(desktop, "verify_logged_in", new_callable=AsyncMock, return_value=False):
        with patch("behavior.youtube.action_audit.ActionAudit") as mock_audit_cls:
            mock_audit_cls.current.return_value = None
            ok, proof = await desktop.like(tab, want=True)
            assert ok is False
            assert proof == "LIKE_SKIP_NOT_LOGGED_IN"
