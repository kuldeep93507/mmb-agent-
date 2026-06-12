"""
Mastermind plan executor — scheduled slots → real worker_manager runs.

Isolated from scheduler: reads saved plan, spawns workers at slot times.
Supports live slot shifting, crash retry-last, full merged settings pass-through.
"""

from __future__ import annotations

import copy
import json
import logging
import random
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("mmb.mastermind_executor")

ROOT = Path(__file__).resolve().parent.parent
EXECUTION_FILE = ROOT / "mastermind_execution.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ms(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).strip()
    if not s:
        return 0
    if s.isdigit():
        return int(s)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def _load_execution() -> dict[str, Any]:
    try:
        data = json.loads(EXECUTION_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_execution(data: dict[str, Any]) -> None:
    tmp = EXECUTION_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(EXECUTION_FILE)


def _campaign_defaults(state_or_plan: dict[str, Any]) -> dict[str, Any]:
    cd = state_or_plan.get("campaignDefaults")
    return cd if isinstance(cd, dict) else {}


def _int(val: Any, default: int) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _slot_worker_config(
    slot: dict[str, Any],
    app_settings: dict[str, Any],
    campaign_defaults: dict[str, Any],
    allow_same_day_repeat: bool,
) -> dict[str, Any]:
    s = slot.get("settings") if isinstance(slot.get("settings"), dict) else {}
    cd = campaign_defaults
    from server_python.traffic_source_control import disabled_from_settings, resolve_source
    import random as _rand_mod

    traffic_raw = str(
        slot.get("trafficSource") or s.get("trafficPreference") or "search"
    )
    disabled = disabled_from_settings(app_settings)
    traffic, t_note = resolve_source(
        traffic_raw, disabled, _rand_mod.Random(hash(str(slot.get("profileId", ""))) % 2**31),
    )
    if t_note:
        log.info("[Mastermind] %s", t_note)
    traffic = traffic.lower()

    ad_min = _int(
        s.get("adSkipDelayMinSec"),
        _int(cd.get("adSkipDelayMinSec"), _int(app_settings.get("adSkipAfterSec"), 8)),
    )
    ad_max = _int(
        s.get("adSkipDelayMaxSec"),
        _int(cd.get("adSkipDelayMaxSec"), _int(app_settings.get("adSkipDelayMaxSec"), 14)),
    )
    if ad_max < ad_min:
        ad_max = ad_min

    vol_min = _int(s.get("volumeMin"), _int(cd.get("volumeMin"), 60))
    vol_max = _int(s.get("volumeMax"), _int(cd.get("volumeMax"), 80))

    from server_python.action_registry import sanitize_config

    return sanitize_config({
        "browserType": app_settings.get("browserProvider", "multilogin"),
        "watchTimeMin": _int(s.get("watchTimeMin"), _int(cd.get("watchTimeMin"), _int(app_settings.get("ytWatchTimeMin"), 40))),
        "watchTimeMax": _int(s.get("watchTimeMax"), _int(cd.get("watchTimeMax"), _int(app_settings.get("ytWatchTimeMax"), 100))),
        "tabDelayMin": _int(app_settings.get("tabDelayMin"), 30),
        "tabDelayMax": _int(app_settings.get("tabDelayMax"), 120),
        "trafficPreference": traffic,
        "trafficSource": traffic,
        "likeEnabled": bool(s.get("likeEnabled", False)),
        "subscribeEnabled": bool(s.get("subscribeEnabled", False)),
        "commentEnabled": bool(s.get("commentEnabled", False)),
        "bellEnabled": bool(s.get("bellEnabled", False)),
        "dislikeEnabled": bool(s.get("dislikeEnabled", False)),
        "commentText": str(s.get("commentText") or ""),
        "videoQuality": str(s.get("videoQuality") or app_settings.get("ytVideoQuality", "auto")),
        # volumePct intentionally NOT set — agent picks random in volumeMin..volumeMax
        # (min == max → exact value)
        "volumeMin": vol_min,
        "volumeMax": vol_max,
        "adSkipEnabled": bool(s.get("adSkipEnabled", cd.get("adSkipEnabled", True))),
        "adSkipDelaySec": ad_min,
        "adSkipDelayMaxSec": ad_max,
        "adSkipMaxSec": _int(s.get("adSkipMaxSec"), ad_max),
        "adSkipAfterSec": _int(s.get("adSkipMaxSec"), ad_max),
        "adClickEnabled": bool(s.get("adClickEnabled", cd.get("adClickEnabled", False))),
        "adClickDelayMinSec": _int(s.get("adClickDelayMinSec"), _int(cd.get("adClickDelayMinSec"), 10)),
        "adClickDelayMaxSec": _int(s.get("adClickDelayMaxSec"), _int(cd.get("adClickDelayMaxSec"), 15)),
        "adClickVisitSec": _int(s.get("adClickVisitSec"), _int(cd.get("adClickVisitSec"), 20)),
        "videosPerProfile": _int(s.get("videosPerProfile"), _int(cd.get("tabsPerProfile"), 1)),
        "seekEnabled": bool(s.get("seekEnabled", True)),
        "scrollActivity": bool(s.get("scrollEnabled", cd.get("scrollEnabled", True))),
        "scrollNoClick": bool(cd.get("scrollNoClick", True)),
        "commentLikeEnabled": bool(s.get("commentLikeEnabled", cd.get("commentLikeEnabled", False))),
        "commentLikePct": 100 if bool(s.get("commentLikeEnabled", cd.get("commentLikeEnabled", False))) else 0,
        "descriptionLinks": bool(s.get("descriptionLinks", cd.get("descriptionLinks", False))),
        "descriptionLinkUrl": str(s.get("descriptionLinkUrl") or cd.get("descriptionLinkUrl") or ""),
        "descriptionLinkVisitSec": _int(s.get("descriptionLinkVisitSec"), _int(cd.get("descriptionLinkVisitSec"), 120)),
        "qualityChange": bool(s.get("qualityChangeEnabled", cd.get("qualityChangeEnabled", True))),
        "qualityChangeEnabled": bool(s.get("qualityChangeEnabled", cd.get("qualityChangeEnabled", True))),
        "playbackSpeed": str(s.get("playbackSpeed") or cd.get("playbackSpeed") or "1x"),
        "speedChange": str(s.get("playbackSpeed") or cd.get("playbackSpeed") or "1x") not in ("1x", "1", ""),
        "speedChangeEnabled": str(s.get("playbackSpeed") or cd.get("playbackSpeed") or "1x") not in ("1x", "1", ""),
        "captionsEnabled": bool(s.get("captionsEnabled", cd.get("captionsEnabled", False))),
        "descriptionExpand": bool(s.get("descriptionExpand", True)),
        "allowSameDayRepeat": allow_same_day_repeat,
        "startDelayMin": _int(s.get("startDelayMin"), 10),
        "startDelayMax": _int(s.get("startDelayMax"), 25),
    })


def _slot_video_payload(slot: dict[str, Any]) -> dict[str, Any]:
    url = str(slot.get("videoUrl") or "")
    if not url and slot.get("videoId"):
        url = f"https://www.youtube.com/watch?v={slot['videoId']}"
    out = {
        "mode": "url",
        "value": url,
        "url": url,
        "title": str(slot.get("videoTitle") or slot.get("videoId") or "Video"),
        "videoId": str(slot.get("videoId") or ""),
        "channelName": str(slot.get("channelName") or ""),
    }
    ts = str(slot.get("trafficSource") or "").strip()
    if ts:
        out["trafficSource"] = ts
    return out


def _normalize_slots(plan: dict[str, Any]) -> list[dict[str, Any]]:
    raw = plan.get("slots") if isinstance(plan.get("slots"), list) else []
    out: list[dict[str, Any]] = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or "")
        pid = str(s.get("profileId") or "")
        vid = str(s.get("videoId") or "")
        if not sid or not pid or not vid:
            continue
        start_ms = _parse_ms(s.get("scheduledAt"))
        end_ms = _parse_ms(s.get("scheduledEndAt"))
        out.append({
            "id": sid,
            "profileId": pid,
            "profileName": str(s.get("profileName") or f"Profile-{pid[-4:]}"),
            "scheduledAtMs": start_ms,
            "scheduledEndMs": end_ms,
            "sessionSec": _int(s.get("sessionSec"), max(60, (end_ms - start_ms) // 1000)),
            "videoId": vid,
            "videoTitle": str(s.get("videoTitle") or ""),
            "videoUrl": str(s.get("videoUrl") or ""),
            "channelName": str(s.get("channelName") or ""),
            "trafficSource": str(s.get("trafficSource") or "search"),
            "profileAction": str(s.get("profileAction") or ""),
            "settings": s.get("settings") if isinstance(s.get("settings"), dict) else {},
            "status": "pending",
            "workerStatus": "",
            "spawnedAtMs": 0,
            "completedAtMs": 0,
            "actualDurationMs": 0,
            "error": "",
            "retryQueued": False,
            "isRetry": bool(s.get("isRetry")),
        })
    out.sort(key=lambda x: x["scheduledAtMs"])
    return out


def _shift_pending_for_profile(
    slots: list[dict[str, Any]],
    profile_id: str,
    after_ms: int,
    delta_ms: int,
) -> int:
    if not delta_ms:
        return 0
    count = 0
    for slot in slots:
        if slot.get("status") != "pending":
            continue
        if slot.get("profileId") != profile_id:
            continue
        if slot.get("scheduledAtMs", 0) <= after_ms:
            continue
        slot["scheduledAtMs"] = max(0, slot["scheduledAtMs"] + delta_ms)
        slot["scheduledEndMs"] = max(
            slot["scheduledAtMs"] + 60000,
            slot.get("scheduledEndMs", 0) + delta_ms,
        )
        count += 1
    return count


def _apply_live_reschedule(
    slot: dict[str, Any],
    slots: list[dict[str, Any]],
    campaign_defaults: dict[str, Any],
    log_fn: Optional[Callable[..., None]],
) -> bool:
    completed_at = _int(slot.get("completedAtMs"), 0)
    planned_end = _int(slot.get("scheduledEndMs"), completed_at)
    spawned_at = _int(slot.get("spawnedAtMs"), 0)
    if not completed_at or not spawned_at:
        return False

    slot["actualDurationMs"] = completed_at - spawned_at
    delta_ms = completed_at - planned_end

    profile_action = str(slot.get("profileAction") or "")
    keep_under = _int(campaign_defaults.get("keepProfileOpenIfGapUnderMin"), 3)
    close_over = _int(campaign_defaults.get("closeProfileIfGapOverMin"), 3)
    reopen_min = _int(campaign_defaults.get("profileReopenMin"), 2) * 60000
    reopen_max = _int(campaign_defaults.get("profileReopenMax"), 4) * 60000

    if profile_action == "close_reopen" and delta_ms < 0:
        gap_min = abs(delta_ms) / 60000
        if gap_min > close_over:
            delta_ms += random.randint(reopen_min, reopen_max)
    elif profile_action == "keep_open" and delta_ms > 0:
        delta_ms = min(delta_ms, keep_under * 60000)

    shifted = _shift_pending_for_profile(
        slots,
        slot["profileId"],
        slot.get("scheduledAtMs", 0),
        delta_ms,
    )
    if shifted and log_fn:
        sign = "late" if delta_ms > 0 else "early"
        log_fn(
            "info",
            "mastermind",
            f"Live adjust: {slot.get('profileName')} {sign} by {abs(delta_ms) // 1000}s → {shifted} slot(s) shifted",
            profile_id=slot.get("profileId"),
            profile_name=slot.get("profileName"),
        )
    return shifted > 0


def _pull_forward_keep_open(
    slots: list[dict[str, Any]],
    profile_id: str,
    now_ms: int,
    campaign_defaults: dict[str, Any],
) -> bool:
    keep_under = _int(campaign_defaults.get("keepProfileOpenIfGapUnderMin"), 3) * 60000
    pending = [
        s for s in slots
        if s.get("profileId") == profile_id and s.get("status") == "pending"
    ]
    if not pending:
        return False
    pending.sort(key=lambda x: x.get("scheduledAtMs", 0))
    nxt = pending[0]
    action = str(nxt.get("profileAction") or "")
    if action not in ("keep_open", "parallel_tab", ""):
        return False
    sched = _int(nxt.get("scheduledAtMs"), 0)
    if sched <= now_ms:
        return False
    if sched - now_ms <= keep_under:
        nxt["scheduledAtMs"] = now_ms
        return True
    return False


def _queue_crash_retry(
    slot: dict[str, Any],
    slots: list[dict[str, Any]],
    now_ms: int,
    log_fn: Optional[Callable[..., None]],
) -> bool:
    if slot.get("retryQueued") or slot.get("isRetry"):
        return False
    if slot.get("status") != "error":
        return False
    if slot.get("workerStatus") not in ("error", "crashed", "stopped"):
        return False

    slot["retryQueued"] = True
    last_end = max((s.get("scheduledEndMs", 0) for s in slots), default=now_ms)
    retry_at = max(now_ms, last_end) + random.randint(30, 90) * 1000
    session_sec = _int(slot.get("sessionSec"), 600)
    retry = copy.deepcopy(slot)
    retry.update({
        "id": f"{slot['id']}-retry-{uuid.uuid4().hex[:6]}",
        "status": "pending",
        "workerStatus": "",
        "spawnedAtMs": 0,
        "completedAtMs": 0,
        "actualDurationMs": 0,
        "error": "",
        "retryQueued": False,
        "isRetry": True,
        "scheduledAtMs": retry_at,
        "scheduledEndMs": retry_at + session_sec * 1000,
    })
    slots.append(retry)
    slots.sort(key=lambda x: x.get("scheduledAtMs", 0))
    if log_fn:
        log_fn(
            "warn",
            "mastermind",
            f"Crash retry queued (end of queue): {slot.get('profileName')} → {slot.get('videoTitle', '')[:40]}",
            profile_id=slot.get("profileId"),
            profile_name=slot.get("profileName"),
        )
    return True


def get_execution_status() -> dict[str, Any]:
    state = _load_execution()
    slots = state.get("slots") if isinstance(state.get("slots"), list) else []
    pending = sum(1 for s in slots if s.get("status") == "pending")
    spawned = sum(1 for s in slots if s.get("status") == "spawned")
    done = sum(1 for s in slots if s.get("status") == "done")
    skipped = sum(1 for s in slots if s.get("status") == "skipped")
    errors = sum(1 for s in slots if s.get("status") == "error")
    retries = sum(1 for s in slots if s.get("isRetry"))
    return {
        "active": bool(state.get("active")),
        "planDayKey": state.get("planDayKey", ""),
        "planName": state.get("planName", ""),
        "startedAt": state.get("startedAt"),
        "stoppedAt": state.get("stoppedAt"),
        "completedAt": state.get("completedAt"),
        "allowSameDayRepeat": bool(state.get("allowSameDayRepeat")),
        "stats": {
            "total": len(slots),
            "pending": pending,
            "spawned": spawned,
            "done": done,
            "skipped": skipped,
            "error": errors,
            "retries": retries,
        },
        "slots": [
            {
                "id": s.get("id"),
                "profileId": s.get("profileId"),
                "status": s.get("status"),
                "workerStatus": s.get("workerStatus", ""),
                "error": s.get("error", ""),
                "isRetry": bool(s.get("isRetry")),
                "scheduledAtMs": s.get("scheduledAtMs"),
            }
            for s in slots
        ],
    }


def start_execution(plan: dict[str, Any], plan_name: str = "") -> dict[str, Any]:
    slots = _normalize_slots(plan)
    if not slots:
        return {"success": False, "error": "Plan me koi valid slot nahi"}

    defaults = _campaign_defaults(plan)
    no_repeat = defaults.get("noRepeatSameVideo", True)
    allow_same_day = not bool(no_repeat)

    state = {
        "active": True,
        "planDayKey": str(plan.get("dayKey") or ""),
        "planName": plan_name or str(plan.get("dayKey") or "Mastermind plan"),
        "startedAt": _now_iso(),
        "stoppedAt": None,
        "allowSameDayRepeat": allow_same_day,
        "campaignDefaults": defaults,
        "scheduledPlanId": str(plan.get("_scheduledPlanId") or ""),
        "slots": slots,
    }
    _save_execution(state)

    log.info(
        "[Mastermind] Execution started — %d slots, day=%s",
        len(slots),
        state["planDayKey"],
    )
    return {
        "success": True,
        "totalSlots": len(slots),
        "planDayKey": state["planDayKey"],
        "allowSameDayRepeat": allow_same_day,
    }


def stop_execution() -> dict[str, Any]:
    state = _load_execution()
    if not state:
        return {"success": True, "message": "No active execution"}
    state["active"] = False
    state["stoppedAt"] = _now_iso()
    _save_execution(state)
    return {"success": True}


def _profile_worker_busy(worker_manager: Any, profile_id: str) -> bool:
    w = worker_manager.workers.get(profile_id)
    if not w:
        return False
    return w.status not in ("done", "error", "stopped", "crashed")


async def tick_execution(
    worker_manager: Any,
    app_settings: dict[str, Any],
    spawn_fn: Callable[..., Any],
    log_fn: Optional[Callable[..., None]] = None,
) -> None:
    state = _load_execution()
    if not state.get("active"):
        return

    slots: list[dict[str, Any]] = state.get("slots") or []
    if not slots:
        state["active"] = False
        _save_execution(state)
        return

    now_ms = int(time.time() * 1000)
    allow_same_day = bool(state.get("allowSameDayRepeat"))
    campaign_defaults = _campaign_defaults(state)
    changed = False

    from server_python.watch_history import should_skip_video
    from server_python.worker_manager import _extract_video_id

    for slot in slots:
        if slot.get("status") != "spawned":
            continue
        pid = slot["profileId"]
        w = worker_manager.workers.get(pid)
        if not w:
            slot["status"] = "done"
            slot["completedAtMs"] = now_ms
            if _apply_live_reschedule(slot, slots, campaign_defaults, log_fn):
                changed = True
            changed = True
            continue
        slot["workerStatus"] = w.status
        if w.status == "done":
            slot["status"] = "done"
            slot["completedAtMs"] = now_ms
            if _apply_live_reschedule(slot, slots, campaign_defaults, log_fn):
                changed = True
            changed = True
            if log_fn:
                log_fn(
                    "success",
                    "mastermind",
                    f"Slot done: {slot.get('profileName')} → {slot.get('videoTitle', '')[:48]}",
                    profile_id=pid,
                    profile_name=slot.get("profileName"),
                )
        elif w.status in ("error", "crashed", "stopped"):
            slot["status"] = "error"
            slot["error"] = w.status
            slot["completedAtMs"] = now_ms
            if _queue_crash_retry(slot, slots, now_ms, log_fn):
                changed = True
            changed = True
            if log_fn:
                log_fn(
                    "error",
                    "mastermind",
                    f"Slot failed ({w.status}): {slot.get('profileName')} → {slot.get('videoTitle', '')[:48]}",
                    profile_id=pid,
                    profile_name=slot.get("profileName"),
                )

    seen_profiles: set[str] = set()
    for slot in slots:
        pid = slot.get("profileId", "")
        if not pid or pid in seen_profiles:
            continue
        seen_profiles.add(pid)
        if _profile_worker_busy(worker_manager, pid):
            continue
        if _pull_forward_keep_open(slots, pid, now_ms, campaign_defaults):
            changed = True

    spawned_profiles: set[str] = set()
    for slot in slots:
        if slot.get("status") != "pending":
            continue
        if slot.get("scheduledAtMs", 0) > now_ms:
            continue

        pid = slot["profileId"]
        if pid in spawned_profiles or _profile_worker_busy(worker_manager, pid):
            continue

        video = _slot_video_payload(slot)
        vid = _extract_video_id(video)
        if vid and should_skip_video(pid, vid, allow_same_day):
            slot["status"] = "skipped"
            slot["error"] = "aaj watched"
            slot["completedAtMs"] = now_ms
            changed = True
            if log_fn:
                log_fn(
                    "warn",
                    "mastermind",
                    f"Slot skip (watched today): {slot.get('videoTitle', vid)[:40]}",
                    profile_id=pid,
                    profile_name=slot.get("profileName"),
                )
            continue

        config = _slot_worker_config(slot, app_settings, campaign_defaults, allow_same_day)
        delay = random.randint(2, 8)
        spawn_fn(
            pid,
            slot.get("profileName") or f"Profile-{pid[-4:]}",
            [video],
            config,
            delay,
        )
        slot["status"] = "spawned"
        slot["spawnedAtMs"] = now_ms
        slot["workerStatus"] = "waiting"
        spawned_profiles.add(pid)
        changed = True
        if log_fn:
            log_fn(
                "success",
                "mastermind",
                f"Slot started: {slot.get('profileName')} → {slot.get('videoTitle', '')[:48]} "
                f"({slot.get('trafficSource', 'search')} · ad skip {config.get('adSkipDelaySec')}-{config.get('adSkipDelayMaxSec')}s)",
                profile_id=pid,
                profile_name=slot.get("profileName"),
            )

    pending_or_spawned = any(s.get("status") in ("pending", "spawned") for s in slots)
    if not pending_or_spawned:
        state["active"] = False
        state["completedAt"] = _now_iso()
        changed = True
        sched_id = str(state.get("scheduledPlanId") or "")
        day_key = str(state.get("planDayKey") or "")
        if sched_id or day_key:
            try:
                try:
                    from mastermind_store import update_scheduled_plan_status, mark_scheduled_done_by_execution_day
                except ImportError:
                    from server_python.mastermind_store import (
                        update_scheduled_plan_status,
                        mark_scheduled_done_by_execution_day,
                    )
                if sched_id:
                    update_scheduled_plan_status(sched_id, "done")
                elif day_key:
                    mark_scheduled_done_by_execution_day(day_key)
            except Exception:
                pass
        if log_fn:
            log_fn("success", "mastermind", "Plan execution complete — sab slots process ho gaye")

    if changed:
        state["slots"] = slots
        _save_execution(state)


def check_scheduled_plans(
    log_fn: Optional[Callable[..., None]] = None,
) -> bool:
    """Pending scheduled plan jiska pehla slot due ho — auto start execution."""
    state = _load_execution()
    if state.get("active"):
        return False

    try:
        try:
            from mastermind_store import list_scheduled_plans, update_scheduled_plan_status
        except ImportError:
            from server_python.mastermind_store import list_scheduled_plans, update_scheduled_plan_status
    except Exception:
        return False

    now_ms = int(time.time() * 1000)
    grace_ms = 5 * 60 * 1000
    items = list_scheduled_plans()
    pending = [
        x for x in items
        if x.get("status") == "pending" and x.get("autoStart", True)
    ]
    pending.sort(key=lambda x: str(x.get("targetDate") or ""))

    for entry in pending:
        plan = entry.get("plan")
        if not isinstance(plan, dict):
            continue
        slots_raw = plan.get("slots") if isinstance(plan.get("slots"), list) else []
        if not slots_raw:
            continue
        first_ms = min(_parse_ms(s.get("scheduledAt")) for s in slots_raw if isinstance(s, dict))
        if first_ms <= 0:
            continue
        if first_ms > now_ms + grace_ms:
            continue

        plan_copy = copy.deepcopy(plan)
        plan_copy["_scheduledPlanId"] = str(entry.get("id") or "")
        name = str(entry.get("name") or plan_copy.get("dayKey") or "Scheduled plan")
        result = start_execution(plan_copy, name)
        if result.get("success"):
            update_scheduled_plan_status(str(entry.get("id")), "active")
            if log_fn:
                log_fn(
                    "success",
                    "mastermind",
                    f'Auto-started scheduled plan: {name} ({result.get("totalSlots", 0)} slots)',
                )
            return True
    return False
