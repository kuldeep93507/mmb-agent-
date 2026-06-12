"""
behavior.youtube.action_audit — Honest engagement audit trail (JSON on disk).

FIXED:
  ✅ threading.local() asyncio mismatch fix:
     threading.local() data is per-OS-thread, NOT per-asyncio-task.
     In asyncio, all coroutines run on the same thread, so all profiles
     would share the SAME audit object — wrong.
     Fix: Use contextvars.ContextVar which is per-asyncio-Task (correct).
"""
from __future__ import annotations

import contextvars
import json
import logging
import time
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("mmb.action_audit")

# FIX: ContextVar is per-asyncio-Task — different profiles get different audits
_audit_var: contextvars.ContextVar[Optional["ActionAudit"]] = contextvars.ContextVar(
    "action_audit", default=None
)

_LOGS_DIR = Path(__file__).resolve().parents[3] / "logs"


class ActionAudit:
    """Records engagement action attempts and outcomes for honest test reports."""

    def __init__(self, profile_id: str, profile_name: str = "") -> None:
        self.profile_id = profile_id
        self.profile_name = profile_name or profile_id[:8]
        self.login_state: bool | None = None
        self._entries: list[dict[str, Any]] = []

    @property
    def rows(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def set_login_state(self, logged_in: bool) -> None:
        self.login_state = logged_in
        self._entries.append({
            "action": "LOGIN_STATE",
            "verified": logged_in,
            "reason": "logged_in" if logged_in else "not_logged_in",
            "ts": time.time(),
        })

    def record(
        self,
        action: str,
        *,
        selector_used: str = "",
        click_registered: bool = False,
        verified: bool = False,
        reason: str = "",
    ) -> None:
        self._entries.append({
            "action": action,
            "selector": selector_used,
            "clicked": click_registered,
            "verified": verified,
            "reason": reason,
            "ts": time.time(),
        })

    def entries(self) -> list[dict]:
        return self.rows

    def truth_table(self) -> list[dict[str, Any]]:
        return [
            {
                "action": e.get("action"),
                "pass": bool(e.get("verified")),
                "clicked": bool(e.get("clicked")),
                "reason": e.get("reason", ""),
            }
            for e in self._entries
            if e.get("action") != "LOGIN_STATE"
        ]

    def save(self) -> str:
        _LOGS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        safe = "".join(c for c in self.profile_name if c.isalnum() or c in "-_")[:32]
        path = _LOGS_DIR / f"action_audit_{safe}_{stamp}.json"
        payload = {
            "profile_id": self.profile_id,
            "profile_name": self.profile_name,
            "login_state": self.login_state,
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "truth_table": self.truth_table(),
            "entries": self._entries,
        }
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        log.info("[AUDIT] saved %s (%d rows)", path.name, len(self._entries))
        return str(path)

    # ── ContextVar-based class methods (replaces threading.local) ─────────────

    @classmethod
    def current(cls) -> Optional["ActionAudit"]:
        """Get the audit for the CURRENT asyncio task (not thread-local)."""
        return _audit_var.get()

    @classmethod
    def set_current(cls, audit: Optional["ActionAudit"]) -> None:
        """Set the audit for the current asyncio task."""
        _audit_var.set(audit)

    @classmethod
    def enable(cls, profile_id: str, profile_name: str = "") -> "ActionAudit":
        """Create and activate a new audit for the current task."""
        audit = ActionAudit(profile_id, profile_name)
        cls.set_current(audit)
        return audit

    @classmethod
    def disable(cls) -> None:
        """Clear audit for current task."""
        cls.set_current(None)
