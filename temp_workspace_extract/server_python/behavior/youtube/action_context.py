"""
behavior.youtube.action_context — Session trust/context management.

STATUS: ✅ No critical bugs — global state acceptable in single-threaded asyncio.
"""
from __future__ import annotations

_trust_gmail = False


def set_trust_gmail_login(value: bool) -> None:
    """Set whether to trust Gmail login flows."""
    global _trust_gmail
    _trust_gmail = value


def trust_gmail_login() -> bool:
    """Returns True if Gmail login trust is enabled."""
    return _trust_gmail
