"""
Notification Hub — daily multi-time plans, notification traffic, optional fleet broadcast.

Each plan:
  - profileIds, videos (url/title/channel)
  - dailyTimes: ["09:00", "12:30", "18:00"] local server time
  - runSettings merged into profileConfigs
  - useFleet + fleetMachineIds for remote laptops
"""
from __future__ import annotations

import logging
import random
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("mmb.notification_hub")

_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


def _normalize_time(t: str) -> str:
    raw = (t or "").strip()
    m = re.match(r"^(\d{1,2}):(\d{1,2})$", raw)
    if not m:
        return ""
    h, mi = int(m.group(1)), int(m.group(2))
    if h < 0 or h > 23 or mi < 0 or mi > 59:
        return ""
    return f"{h:02d}:{mi:02d}"


def load_plans(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        import json
        data = json.loads(path.read_text(encoding="utf-8"))
        plans = data.get("plans") if isinstance(data, dict) else data
        return list(plans or []) if isinstance(plans, list) else []
    except Exception as e:
        log.warning("load_plans failed: %s", e)
        return []


def save_plans(path: Path, plans: list[dict[str, Any]]) -> None:
    import json
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"plans": plans}, indent=2), encoding="utf-8")


def plan_to_schedule(plan: dict[str, Any]) -> dict[str, Any]:
    """Convert hub plan → schedule payload for _trigger_schedule_run_logic."""
    videos_in = plan.get("videos") or []
    profile_ids = [str(x) for x in (plan.get("profileIds") or []) if str(x).strip()]
    rs = dict(plan.get("runSettings") or {})

    video_rows: list[dict[str, str]] = []
    for v in videos_in:
        if isinstance(v, str):
            v = {"url": v, "title": "", "channelName": ""}
        url = str(v.get("url") or v.get("value") or "").strip()
        if not url:
            continue
        video_rows.append({
            "mode": "url",
            "value": url,
            "url": url,
            "title": str(v.get("title") or ""),
            "channelName": str(v.get("channelName") or v.get("channel") or ""),
        })

    channel_name = ""
    if video_rows and videos_in:
        first = videos_in[0] if isinstance(videos_in[0], dict) else {}
        channel_name = str(first.get("channelName") or first.get("channel") or "")

    profile_configs: list[dict[str, Any]] = []
    for pid in profile_ids:
        pc: dict[str, Any] = {"profileId": pid, **rs}
        pc.setdefault("trafficSource", "notification")
        profile_configs.append(pc)

    return {
        "id": str(plan.get("id") or ""),
        "name": str(plan.get("name") or "Notification Hub"),
        "selectedProfiles": profile_ids,
        "assignmentMode": "same-all",
        "sameForAll": [{
            "channelId": 0,
            "channelName": channel_name,
            "videos": video_rows,
        }] if video_rows else [],
        "perProfile": [],
        "profileConfigs": profile_configs,
        "profileDelayMin": int(plan.get("gapMin", rs.get("profileDelayMin", 5))),
        "profileDelayMax": int(plan.get("gapMax", rs.get("profileDelayMax", 20))),
        "tabDelayMin": int(plan.get("tabDelayMin", 30)),
        "tabDelayMax": int(plan.get("tabDelayMax", 120)),
    }


def _fleet_payload_from_plan(plan: dict[str, Any], channels_path: Path | None = None) -> dict[str, Any]:
    videos = plan.get("videos") or []
    links = []
    channel_db_ids: list[str] = []
    for v in videos:
        if isinstance(v, str):
            links.append(v)
            continue
        u = str(v.get("url") or v.get("value") or "").strip()
        if u:
            links.append(u)
        cid = v.get("channelId")
        if cid is not None:
            channel_db_ids.append(str(cid))

    for cid in plan.get("channelIds") or []:
        channel_db_ids.append(str(cid))

    rs = dict(plan.get("runSettings") or {})
    actions = []
    if rs.get("likeEnabled"):
        actions.append("like")
    if rs.get("subscribeEnabled"):
        actions.append("subscribe")
    if rs.get("bellEnabled"):
        actions.append("bell")
    if rs.get("commentEnabled"):
        actions.append("comment")

    return {
        "kind": "engagement",
        "videos": links,
        "channelIds": list(dict.fromkeys(channel_db_ids)),
        "traffic": "notification",
        "watchMin": int(rs.get("watchTimeMin", 80)),
        "watchMax": int(rs.get("watchTimeMax", 100)),
        "volMin": int(rs.get("volumeMin", 60)),
        "volMax": int(rs.get("volumeMax", 80)),
        "gapMin": int(plan.get("gapMin", 10)),
        "gapMax": int(plan.get("gapMax", 25)),
        "quality": str(rs.get("videoQuality", "auto")),
        "actions": actions,
        "selectedProfileIds": list(plan.get("profileIds") or []),
        "runAllIfEmpty": False,
        "smartComment": bool(rs.get("commentEnabled", False)),
    }


def run_plan_now(
    plan: dict[str, Any],
    *,
    trigger_schedule_fn: Callable[[dict], dict],
    fleet_broadcast_fn: Callable[[list[str], str, dict], dict] | None = None,
    log_fn: Callable[[str, str, str], None] | None = None,
) -> dict[str, Any]:
    """Execute plan immediately — local schedule or fleet broadcast."""
    name = str(plan.get("name") or plan.get("id") or "plan")
    use_fleet = bool(plan.get("useFleet"))
    machine_ids = [str(x) for x in (plan.get("fleetMachineIds") or []) if str(x).strip()]

    if use_fleet and machine_ids and fleet_broadcast_fn:
        payload = _fleet_payload_from_plan(plan)
        result = fleet_broadcast_fn(machine_ids, "/api/agent/run-engagement", payload)
        if log_fn:
            log_fn("info", "notification_hub", f'Fleet run "{name}" — ok={result.get("ok", 0)}')
        return {"mode": "fleet", "result": result}

    schedule = plan_to_schedule(plan)
    if not schedule.get("selectedProfiles"):
        return {"error": "No profiles selected"}
    if not schedule.get("sameForAll") or not schedule["sameForAll"][0].get("videos"):
        return {"error": "No videos in plan"}

    result = trigger_schedule_fn(schedule)
    if log_fn:
        if result.get("error"):
            log_fn("error", "notification_hub", f'Run "{name}" failed: {result["error"]}')
        else:
            log_fn("success", "notification_hub", f'Run "{name}" — {result.get("spawned", 0)} worker(s)')
    return {"mode": "local", "result": result}


def check_due_plans(
    plans: list[dict[str, Any]],
    *,
    trigger_schedule_fn: Callable[[dict], dict],
    fleet_broadcast_fn: Callable[[list[str], str, dict], dict] | None = None,
    log_fn: Callable[[str, str, str], None] | None = None,
    save_fn: Callable[[list[dict[str, Any]]], None] | None = None,
) -> int:
    """
    Fire plans whose dailyTimes match current HH:MM (once per slot per day).
    Returns count of plans fired.
    """
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    current_slot = now.strftime("%H:%M")
    fired_count = 0
    changed = False

    for plan in plans:
        if not plan.get("enabled", True):
            continue
        times = [_normalize_time(t) for t in (plan.get("dailyTimes") or [])]
        times = [t for t in times if t]
        if current_slot not in times:
            continue

        fired_today: dict[str, list[str]] = dict(plan.get("firedToday") or {})
        already = set(fired_today.get(today) or [])
        if current_slot in already:
            continue

        # Small jitter so all profiles don't hit at exact second
        time.sleep(random.uniform(0.2, 1.5))

        try:
            run_plan_now(
                plan,
                trigger_schedule_fn=trigger_schedule_fn,
                fleet_broadcast_fn=fleet_broadcast_fn,
                log_fn=log_fn,
            )
            already.add(current_slot)
            fired_today[today] = sorted(already)
            plan["firedToday"] = fired_today
            plan["lastRunAt"] = int(time.time() * 1000)
            plan["lastRunSlot"] = current_slot
            fired_count += 1
            changed = True
        except Exception as e:
            log.exception("notification hub slot fire failed: %s", e)
            if log_fn:
                log_fn("error", "notification_hub", f'Slot {current_slot} failed: {e}')

        # Prune old fired days (keep 7 days)
        if len(fired_today) > 7:
            keys = sorted(fired_today.keys())[:-7]
            for k in keys:
                del fired_today[k]
            plan["firedToday"] = fired_today

    if changed and save_fn:
        save_fn(plans)

    return fired_count


def hub_status(plans: list[dict[str, Any]]) -> dict[str, Any]:
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    current = now.strftime("%H:%M")
    upcoming: list[dict[str, Any]] = []

    for plan in plans:
        if not plan.get("enabled", True):
            continue
        times = sorted({_normalize_time(t) for t in (plan.get("dailyTimes") or []) if _normalize_time(t)})
        fired = set((plan.get("firedToday") or {}).get(today) or [])
        next_slots = [t for t in times if t >= current and t not in fired]
        if not next_slots and times:
            next_slots = [t for t in times if t not in fired]
        upcoming.append({
            "id": plan.get("id"),
            "name": plan.get("name"),
            "enabled": plan.get("enabled", True),
            "dailyTimes": times,
            "firedToday": sorted(fired),
            "nextSlot": next_slots[0] if next_slots else None,
            "lastRunAt": plan.get("lastRunAt"),
            "useFleet": bool(plan.get("useFleet")),
            "profileCount": len(plan.get("profileIds") or []),
            "videoCount": len(plan.get("videos") or []),
        })

    return {
        "serverTime": current,
        "serverDate": today,
        "plans": upcoming,
    }
