"""Mastermind executor — start, config merge, live shift, crash retry."""
from server_python import mastermind_executor as me


def test_normalize_slots_from_plan():
    plan = {
        "dayKey": "2026-06-07",
        "slots": [{
            "id": "s1",
            "profileId": "p1",
            "profileName": "Test",
            "scheduledAt": "2026-06-07T09:23:00.000Z",
            "scheduledEndAt": "2026-06-07T09:29:00.000Z",
            "videoId": "abc12345678",
            "videoTitle": "Demo",
            "videoUrl": "https://www.youtube.com/watch?v=abc12345678",
            "trafficSource": "search",
            "settings": {"watchTimeMin": 80, "watchTimeMax": 95},
        }],
    }
    slots = me._normalize_slots(plan)
    assert len(slots) == 1
    assert slots[0]["profileId"] == "p1"
    assert slots[0]["status"] == "pending"
    assert slots[0]["scheduledAtMs"] > 0


def test_normalize_slots_preserves_profile_action():
    plan = {
        "dayKey": "2026-06-07",
        "campaignDefaults": {"adSkipDelayMinSec": 8, "adSkipDelayMaxSec": 14},
        "slots": [{
            "id": "s1",
            "profileId": "p1",
            "videoId": "abc12345678",
            "scheduledAt": "2026-06-07T10:00:00.000Z",
            "scheduledEndAt": "2026-06-07T10:10:00.000Z",
            "profileAction": "keep_open",
            "trafficSource": "search",
            "settings": {"watchTimeMin": 80, "adSkipEnabled": True},
        }],
    }
    slots = me._normalize_slots(plan)
    assert slots[0]["profileAction"] == "keep_open"
    cfg = me._slot_worker_config(slots[0], {}, plan["campaignDefaults"], False)
    assert cfg["adSkipDelaySec"] == 8
    assert cfg["adSkipDelayMaxSec"] == 14
    assert cfg["trafficSource"] == "search"


def test_live_shift_pending_slots():
    slots = [
        {"id": "a", "profileId": "p1", "status": "done", "scheduledAtMs": 1000, "scheduledEndMs": 5000,
         "spawnedAtMs": 1000, "completedAtMs": 7000, "profileAction": "keep_open"},
        {"id": "b", "profileId": "p1", "status": "pending", "scheduledAtMs": 6000, "scheduledEndMs": 12000},
        {"id": "c", "profileId": "p1", "status": "pending", "scheduledAtMs": 13000, "scheduledEndMs": 19000},
    ]
    changed = me._apply_live_reschedule(slots[0], slots, {"keepProfileOpenIfGapUnderMin": 3}, None)
    assert changed is True
    assert slots[1]["scheduledAtMs"] == 8000
    assert slots[2]["scheduledAtMs"] == 15000


def test_crash_retry_queues_at_end():
    now = 50000
    slots = [
        {"id": "s1", "profileId": "p1", "status": "error", "workerStatus": "crashed",
         "scheduledEndMs": 40000, "sessionSec": 300, "videoTitle": "Test", "profileName": "P1",
         "settings": {}, "trafficSource": "search", "videoId": "x", "retryQueued": False},
    ]
    ok = me._queue_crash_retry(slots[0], slots, now, None)
    assert ok is True
    assert len(slots) == 2
    assert slots[1]["isRetry"] is True
    assert slots[1]["status"] == "pending"
    assert slots[1]["scheduledAtMs"] >= now


def test_start_execution_persists(tmp_path, monkeypatch):
    monkeypatch.setattr(me, "EXECUTION_FILE", tmp_path / "exec.json")
    plan = {
        "dayKey": "2026-06-07",
        "campaignDefaults": {"noRepeatSameVideo": True, "adSkipDelayMinSec": 9},
        "slots": [{
            "id": "s1",
            "profileId": "p1",
            "videoId": "abc12345678",
            "scheduledAt": "2026-06-07T10:00:00.000Z",
            "scheduledEndAt": "2026-06-07T10:10:00.000Z",
        }],
    }
    res = me.start_execution(plan, "Test plan")
    assert res["success"] is True
    assert res["totalSlots"] == 1
    state = me._load_execution()
    assert state["campaignDefaults"]["adSkipDelayMinSec"] == 9
    status = me.get_execution_status()
    assert status["active"] is True
    assert status["stats"]["total"] == 1
    me.stop_execution()
    assert me.get_execution_status()["active"] is False


def test_start_execution_stores_scheduled_plan_id(tmp_path, monkeypatch):
    monkeypatch.setattr(me, "EXECUTION_FILE", tmp_path / "exec2.json")
    plan = {
        "dayKey": "2026-06-12",
        "_scheduledPlanId": "sched-abc",
        "campaignDefaults": {},
        "slots": [{
            "id": "s1",
            "profileId": "p1",
            "videoId": "abc12345678",
            "scheduledAt": "2026-06-12T10:00:00.000Z",
            "scheduledEndAt": "2026-06-12T10:10:00.000Z",
        }],
    }
    me.start_execution(plan, "Scheduled test")
    state = me._load_execution()
    assert state["scheduledPlanId"] == "sched-abc"


def test_check_scheduled_plans_starts_due_plan(tmp_path, monkeypatch):
    exec_file = tmp_path / "exec3.json"
    data_file = tmp_path / "mm_data.json"
    monkeypatch.setattr(me, "EXECUTION_FILE", exec_file)
    from server_python import mastermind_store as ms
    monkeypatch.setattr(ms, "MASTERMIND_FILE", data_file)

    past_ms = int(__import__("time").time() * 1000) - 60000
    from datetime import datetime, timezone
    past_iso = datetime.fromtimestamp(past_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    plan = {
        "dayKey": "2026-06-12",
        "totalSlots": 1,
        "slots": [{
            "id": "s1",
            "profileId": "p1",
            "videoId": "abc12345678",
            "scheduledAt": past_iso,
            "scheduledEndAt": past_iso,
        }],
    }
    ms.save_scheduled_plan({
        "plan": plan,
        "targetDate": "2026-06-12",
        "name": "Auto start test",
        "autoStart": True,
    })
    started = me.check_scheduled_plans()
    assert started is True
    assert me.get_execution_status()["active"] is True
    items = ms.list_scheduled_plans()
    assert items[0]["status"] == "active"
