"""
behavior.youtube.action_context — Session trust/context management.

Per-asyncio-task via ContextVar (same pattern as ActionAudit).
20 profiles parallel = har task ka apna gmail-trust flag, koi mix nahi.
"""
from __future__ import annotations

import contextvars

_trust_gmail_var: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "trust_gmail_login", default=False
)


def set_trust_gmail_login(value: bool) -> None:
    """Set whether to trust Gmail login flows for the current asyncio task."""
    _trust_gmail_var.set(bool(value))


def trust_gmail_login() -> bool:
    """Returns True if Gmail login trust is enabled for the current asyncio task."""
    return bool(_trust_gmail_var.get())
