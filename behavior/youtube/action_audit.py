"""
Session action audit — honest truth table for live verification runs.

Enable via agent settings: honestTest=True
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
AUDIT_DIR = ROOT / "logs" / "screenshots"
AUDIT_JSON_DIR = ROOT / "logs"


@dataclass
class AuditRow:
    action: str
    attempted: str  # yes | SKIPPED
    selector_used: str
    click_registered: str  # yes | no | —
    verified: str  # True | False | —
    screenshot: str
    real_status: str  # ✅ PASS | ❌ FAIL | ⏭️ NOT_LOGGED_IN | ⏭️ SKIPPED
    reason: str = ""
    dom_before: dict = field(default_factory=dict)
    dom_after: dict = field(default_factory=dict)


class ActionAudit:
    """Per-session collector for verified action outcomes."""

    _active: Optional["ActionAudit"] = None

    def __init__(self, profile_id: str, profile_name: str = "") -> None:
        self.profile_id = profile_id
        self.profile_name = profile_name or profile_id[:8]
        self.session_id = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        self.login_state: Optional[bool] = None
        self.login_checked_at: str = ""
        self.rows: list[AuditRow] = []
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.finished_at: str = ""

    @classmethod
    def enable(cls, profile_id: str, profile_name: str = "") -> "ActionAudit":
        inst = cls(profile_id, profile_name)
        cls._active = inst
        AUDIT_DIR.mkdir(parents=True, exist_ok=True)
        return inst

    @classmethod
    def current(cls) -> Optional["ActionAudit"]:
        return cls._active

    @classmethod
    def disable(cls) -> Optional["ActionAudit"]:
        inst = cls._active
        cls._active = None
        return inst

    def set_login_state(self, logged_in: bool) -> None:
        self.login_state = logged_in
        self.login_checked_at = datetime.now(timezone.utc).isoformat()
        status = "✅ LOGGED_IN" if logged_in else "⏭️ NOT_LOGGED_IN"
        self.rows.append(
            AuditRow(
                action="login_check",
                attempted="yes",
                selector_used="verify_logged_in()",
                click_registered="—",
                verified=str(logged_in),
                screenshot="",
                real_status=status,
                reason="Pre-watch Gmail state",
            )
        )

    def record(
        self,
        action: str,
        *,
        attempted: bool = True,
        skipped: bool = False,
        skip_reason: str = "",
        selector_used: str = "",
        click_registered: bool = False,
        verified: Optional[bool] = None,
        screenshot_before: str = "",
        screenshot_after: str = "",
        reason: str = "",
        dom_before: Optional[dict] = None,
        dom_after: Optional[dict] = None,
    ) -> None:
        shot = screenshot_after or screenshot_before or ""
        if shot:
            try:
                shot = str(Path(shot).relative_to(ROOT))
            except ValueError:
                pass

        if skipped:
            real = f"⏭️ {skip_reason or 'SKIPPED'}"
            self.rows.append(
                AuditRow(
                    action=action,
                    attempted="SKIPPED",
                    selector_used="—",
                    click_registered="—",
                    verified="—",
                    screenshot=shot,
                    real_status=real,
                    reason=reason or skip_reason,
                )
            )
            return

        if verified is True:
            real = "✅ PASS"
        elif verified is False:
            real = "❌ FAIL"
        elif click_registered and verified is None:
            real = "❌ FAIL"
            reason = reason or "no verify_fn"
        else:
            real = "❌ FAIL"
            reason = reason or "click not registered"

        self.rows.append(
            AuditRow(
                action=action,
                attempted="yes" if attempted else "no",
                selector_used=selector_used or "—",
                click_registered="yes" if click_registered else "no",
                verified=str(verified) if verified is not None else "—",
                screenshot=shot,
                real_status=real,
                reason=reason,
                dom_before=dom_before or {},
                dom_after=dom_after or {},
            )
        )

    def truth_table(self) -> list[dict]:
        return [
            {
                "action": r.action,
                "attempted": r.attempted,
                "selector_used": r.selector_used,
                "click_registered": r.click_registered,
                "verified": r.verified,
                "screenshot": r.screenshot,
                "real_status": r.real_status,
                "reason": r.reason,
            }
            for r in self.rows
        ]

    def save(self) -> Path:
        self.finished_at = datetime.now(timezone.utc).isoformat()
        payload = {
            "profile_id": self.profile_id,
            "profile_name": self.profile_name,
            "session_id": self.session_id,
            "login_state": self.login_state,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "truth_table": self.truth_table(),
            "rows_full": [asdict(r) for r in self.rows],
        }
        AUDIT_JSON_DIR.mkdir(parents=True, exist_ok=True)
        path = AUDIT_JSON_DIR / f"action_audit_{self.profile_name}_{self.session_id}.json"
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return path
