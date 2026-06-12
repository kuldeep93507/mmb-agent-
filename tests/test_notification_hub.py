"""Notification Hub plan builder and slot logic."""
from __future__ import annotations

from server_python.notification_hub import (
    _normalize_time,
    hub_status,
    plan_to_schedule,
)


def test_normalize_time():
    assert _normalize_time("9:5") == "09:05"
    assert _normalize_time("18:30") == "18:30"
    assert _normalize_time("bad") == ""


def test_plan_to_schedule_notification_traffic():
    plan = {
        "id": "p1",
        "name": "Upload plan",
        "profileIds": ["prof-a", "prof-b"],
        "videos": [{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "title": "Test"}],
        "runSettings": {"likeEnabled": True, "trafficSource": "notification"},
        "gapMin": 5,
        "gapMax": 15,
    }
    sched = plan_to_schedule(plan)
    assert sched["selectedProfiles"] == ["prof-a", "prof-b"]
    assert sched["sameForAll"][0]["videos"]
    assert sched["profileConfigs"][0]["trafficSource"] == "notification"
    assert sched["profileConfigs"][0]["likeEnabled"] is True


def test_hub_status_next_slot():
    plans = [{
        "id": "x",
        "name": "T",
        "enabled": True,
        "dailyTimes": ["08:00", "20:00"],
        "profileIds": ["p1"],
        "videos": [],
        "firedToday": {},
    }]
    st = hub_status(plans)
    assert st["serverTime"]
    assert len(st["plans"]) == 1
