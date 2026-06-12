"""Mastermind campaign + plan persistence — isolated from scheduler/worker runs."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
MASTERMIND_FILE = ROOT / "mastermind_data.json"
MAX_PLAN_HISTORY = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_raw() -> dict[str, Any]:
    try:
        data = json.loads(MASTERMIND_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_raw(data: dict[str, Any]) -> None:
    tmp = MASTERMIND_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(MASTERMIND_FILE)


def get_state() -> dict[str, Any]:
    raw = _load_raw()
    return {
        "campaign": raw.get("campaign"),
        "latestPlan": raw.get("latestPlan"),
        "planHistory": raw.get("planHistory") if isinstance(raw.get("planHistory"), list) else [],
        "scheduledPlans": raw.get("scheduledPlans") if isinstance(raw.get("scheduledPlans"), list) else [],
        "updatedAt": raw.get("updatedAt"),
    }


def save_campaign(body: dict[str, Any]) -> dict[str, Any]:
    goals = body.get("goals")
    defaults = body.get("defaults")
    videos = body.get("videos")
    overrides = body.get("overrides")
    if not isinstance(goals, dict) or not isinstance(defaults, dict):
        return {"success": False, "error": "goals and defaults required"}

    selected_profile_ids = body.get("selectedProfileIds")

    raw = _load_raw()
    raw["campaign"] = {
        "goals": goals,
        "defaults": defaults,
        "videos": videos if isinstance(videos, list) else [],
        "overrides": overrides if isinstance(overrides, dict) else {},
        # None = sab profiles selected; list = sirf ye profiles
        "selectedProfileIds": selected_profile_ids if isinstance(selected_profile_ids, list) else None,
        "updatedAt": _now_iso(),
    }
    raw["updatedAt"] = _now_iso()
    _save_raw(raw)
    return {"success": True, "updatedAt": raw["updatedAt"]}


def save_plan(body: dict[str, Any]) -> dict[str, Any]:
    plan = body.get("plan")
    if not isinstance(plan, dict):
        return {"success": False, "error": "plan object required"}

    name = str(body.get("name") or plan.get("dayKey") or "Mastermind plan").strip()
    plan_id = str(body.get("id") or uuid.uuid4())
    saved_at = _now_iso()

    entry = {
        "id": plan_id,
        "name": name,
        "dayKey": plan.get("dayKey"),
        "totalSlots": plan.get("totalSlots", 0),
        "savedAt": saved_at,
        "plan": plan,
    }

    raw = _load_raw()
    raw["latestPlan"] = entry
    history = raw.get("planHistory")
    if not isinstance(history, list):
        history = []
    history = [h for h in history if h.get("id") != plan_id]
    history.insert(0, entry)
    raw["planHistory"] = history[:MAX_PLAN_HISTORY]
    raw["updatedAt"] = saved_at
    _save_raw(raw)
    return {"success": True, "planId": plan_id, "savedAt": saved_at}


def list_scheduled_plans() -> list[dict[str, Any]]:
    raw = _load_raw()
    items = raw.get("scheduledPlans")
    return items if isinstance(items, list) else []


def save_scheduled_plan(body: dict[str, Any]) -> dict[str, Any]:
    plan = body.get("plan")
    if not isinstance(plan, dict):
        return {"success": False, "error": "plan required"}
    target_date = str(body.get("targetDate") or plan.get("dayKey") or "").strip()
    if not target_date:
        return {"success": False, "error": "targetDate required (YYYY-MM-DD)"}

    entry_id = str(body.get("id") or uuid.uuid4())
    name = str(body.get("name") or f"Scheduled · {target_date}").strip()
    auto_start = bool(body.get("autoStart", True))

    entry = {
        "id": entry_id,
        "name": name,
        "targetDate": target_date,
        "autoStart": auto_start,
        "status": "pending",
        "totalSlots": plan.get("totalSlots", 0),
        "savedAt": _now_iso(),
        "plan": plan,
    }

    raw = _load_raw()
    items = raw.get("scheduledPlans")
    if not isinstance(items, list):
        items = []
    items = [x for x in items if x.get("id") != entry_id]
    items.insert(0, entry)
    raw["scheduledPlans"] = items[:50]
    raw["updatedAt"] = _now_iso()
    _save_raw(raw)
    return {"success": True, "id": entry_id, "savedAt": entry["savedAt"]}


def delete_scheduled_plan(plan_id: str) -> dict[str, Any]:
    raw = _load_raw()
    items = raw.get("scheduledPlans")
    if not isinstance(items, list):
        items = []
    before = len(items)
    items = [x for x in items if str(x.get("id")) != str(plan_id)]
    raw["scheduledPlans"] = items
    raw["updatedAt"] = _now_iso()
    _save_raw(raw)
    return {"success": True, "removed": before - len(items)}


def update_scheduled_plan_status(plan_id: str, status: str) -> None:
    raw = _load_raw()
    items = raw.get("scheduledPlans")
    if not isinstance(items, list):
        return
    for item in items:
        if str(item.get("id")) == str(plan_id):
            item["status"] = status
            if status == "done":
                item["completedAt"] = _now_iso()
            break
    raw["scheduledPlans"] = items
    raw["updatedAt"] = _now_iso()
    _save_raw(raw)


def mark_scheduled_done_by_execution_day(day_key: str) -> None:
    if not day_key:
        return
    raw = _load_raw()
    items = raw.get("scheduledPlans")
    if not isinstance(items, list):
        return
    changed = False
    for item in items:
        if item.get("status") == "active" and str(item.get("targetDate")) == str(day_key):
            item["status"] = "done"
            item["completedAt"] = _now_iso()
            changed = True
    if changed:
        raw["scheduledPlans"] = items
        raw["updatedAt"] = _now_iso()
        _save_raw(raw)
