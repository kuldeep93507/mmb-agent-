"""
Central analytics event store — writes to analytics_data.json.
Used by workers, engagement agent, and HTTP record endpoints.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Iterable

log = logging.getLogger("mmb.analytics")

ROOT = Path(__file__).resolve().parent.parent
ANALYTICS_FILE = ROOT / "analytics_data.json"
MAX_EVENTS = 50_000

_ACTION_MAP = {
    "like": "like",
    "dislike": "dislike",
    "subscribe": "subscribe",
    "bell": "bell",
    "comment": "comment",
    "comment_like": "comment_like",
    "comment_liked": "comment_like",
    "pause": "pause",
    "seek": "seek",
}


def record_events(events: list[dict]) -> None:
    """Append analytics events atomically."""
    if not events:
        return
    try:
        try:
            raw = json.loads(ANALYTICS_FILE.read_text(encoding="utf-8"))
        except Exception:
            raw = {"events": []}

        stored = raw.get("events", [])
        if not isinstance(stored, list):
            stored = []
        stored.extend(events)
        if len(stored) > MAX_EVENTS:
            stored = stored[-MAX_EVENTS:]
        raw["events"] = stored

        tmp = ANALYTICS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        tmp.replace(ANALYTICS_FILE)
    except Exception as e:
        log.warning("Analytics record failed: %s", e)


def record_watch_session(
    profile_id: str,
    watch_secs: float,
    traffic_source: str = "",
    completed_actions: Iterable[str] | None = None,
    ads_total: int = 0,
    ads_skipped: int = 0,
) -> None:
    """Record one video watch + optional engagement actions."""
    now_ms = int(time.time() * 1000)
    events: list[dict] = [
        {"time": now_ms, "profileId": profile_id, "action": "view", "value": 1},
        {
            "time": now_ms,
            "profileId": profile_id,
            "action": "watchTime",
            "value": round(float(watch_secs), 1),
        },
    ]

    src = (traffic_source or "").strip().lower().replace(" ", "-")
    if src:
        events.append(
            {"time": now_ms, "profileId": profile_id, "action": f"traffic_{src}", "value": 1}
        )

    for action in completed_actions or []:
        mapped = _ACTION_MAP.get(action)
        if mapped:
            events.append(
                {"time": now_ms, "profileId": profile_id, "action": mapped, "value": 1}
            )

    if ads_total > 0:
        events.append(
            {"time": now_ms, "profileId": profile_id, "action": "ads_total", "value": ads_total}
        )
    if ads_skipped > 0:
        events.append(
            {"time": now_ms, "profileId": profile_id, "action": "ads_skipped", "value": ads_skipped}
        )

    record_events(events)
