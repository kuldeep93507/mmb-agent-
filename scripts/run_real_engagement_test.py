#!/usr/bin/env python3
"""
Real engagement E2E test — one profile, one video, full actions, source=search.
Polls job logs until done/failed/partial/cancelled.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:3100"
KEY = "mmb-local-dev-2025"

PROFILE_ID = "c58a40dc-d6ff-4234-8d26-a592804d32ea"
PROFILE_NAME = "MMB test"

VIDEO = {
    "url": "https://www.youtube.com/watch?v=h77qw1DKndA",
    "title": "FRANKLIN BECOM A BODYBUILDER ???? IN INDIAN BIKES DRIVING 3D@HeligamerSSS ",
    "channelName": "Ultra gta play ",
}


def api(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={"x-api-key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def main() -> int:
    print("=== MMB Real Engagement Test ===\n")

    try:
        health = api("GET", "/api/health")
        print(f"Backend OK: {health.get('status', health)}\n")
    except urllib.error.URLError as e:
        print(f"Backend not running on {API}: {e}")
        return 1

    payload = {
        "profiles": [
            {
                "profileId": PROFILE_ID,
                "profileName": PROFILE_NAME,
                "browserType": "multilogin",
                "source": "search",
                "delayMs": 0,
                "watchPct": 100,
                "actions": {
                    "like": True,
                    "dislike": False,
                    "subscribe": True,
                    "bell": True,
                    "comment": True,
                    "commentText": "Great video! Really helpful content.",
                    "descriptionExpand": True,
                    "descriptionLinks": False,
                    "volumePct": 75,
                    "commentLikePct": 100,
                    "seekEnabled": True,
                    "seekDirection": "backward",
                    "pauseProbability": 0.5,
                    "pauseHoldSec": 20,
                },
                "videos": [VIDEO],
            }
        ],
        "watchPct": 100,
        "adSkipEnabled": True,
        "adSkipDelaySec": 5,
        "adSkipDelayMaxSec": 12,
        "videoQuality": "144p",
        "maxConcurrent": 1,
    }

    print("Starting engagement job…")
    print(f"  Profile: {PROFILE_NAME} ({PROFILE_ID[:8]}…)")
    print(f"  Video:   {VIDEO['title'][:60]}…")
    print(f"  Source:  search | Quality: 144p | Watch: 100%\n")

    try:
        start = api("POST", "/api/engagement/start", payload)
    except Exception as e:
        print(f"Start failed: {e}")
        return 1

    if start.get("code") != 0:
        print(f"Start error: {start.get('message')}")
        return 1

    job_ids = start.get("jobIds") or []
    if not job_ids:
        print("No job IDs returned")
        return 1

    job_id = job_ids[0]
    print(f"Job queued: {job_id}\n")
    print("--- Live log (polling every 12s) ---\n")

    seen = 0
    checklist = {
        "search": False,
        "Path A": False,
        "Player ready": False,
        "Autoplay": False,
        "Quality": False,
        "Volume": False,
        "Seek": False,
        "Pause": False,
        "Liked": False,
        "Subscribed": False,
        "Bell": False,
        "desc": False,
        "Comment": False,
        "comment_liked": False,
        "watched": False,
    }

    def mark(msg: str) -> None:
        m = msg.lower()
        if "path a" in m or "keyword" in m or "source=search" in m:
            checklist["search"] = True
            checklist["Path A"] = True
        if "player ready: true" in m:
            checklist["Player ready"] = True
        if "autoplay" in m:
            checklist["Autoplay"] = True
        if "quality 144p: ok" in m or "quality changed to 144p" in m:
            checklist["Quality"] = True
        if "volume" in m:
            checklist["Volume"] = True
        if "seek backward" in m:
            checklist["Seek"] = True
        if "pause (human)" in m:
            checklist["Pause"] = True
        if "liked" in m:
            checklist["Liked"] = True
        if "subscribed" in m:
            checklist["Subscribed"] = True
        if "bell" in m:
            checklist["Bell"] = True
        if "desc" in m or "description" in m:
            checklist["desc"] = True
        if "comment posted" in m:
            checklist["Comment"] = True
        if "comment_liked" in m or "comment like" in m:
            checklist["comment_liked"] = True
        if "video watched" in m or "watched successfully" in m:
            checklist["watched"] = True

    deadline = time.time() + 900  # 15 min max
    last_status = ""

    while time.time() < deadline:
        time.sleep(12)
        try:
            st = api("GET", "/api/engagement/status")
        except Exception as e:
            print(f"Poll error: {e}")
            continue

        jobs = (st.get("data") or {}).get("jobs") or []
        job = next((j for j in jobs if j.get("id") == job_id), None)
        if not job:
            print("Job not found in queue")
            break

        status = job.get("status", "")
        if status != last_status:
            print(f"\n>>> STATUS: {status.upper()} <<<")
            if job.get("error"):
                print(f"    error: {job['error']}")
            if job.get("videosOk") is not None:
                print(f"    videos: {job.get('videosOk')} ok / {job.get('videosFailed')} fail")
            last_status = status

        logs = job.get("log") or []
        for entry in logs[seen:]:
            msg = entry.get("msg", "")
            safe = msg.encode("ascii", errors="replace").decode("ascii")
            print(f"  {safe}")
            mark(msg)
        seen = len(logs)

        if status in ("done", "failed", "partial", "cancelled"):
            break

    print("\n--- Action checklist ---")
    for k, v in checklist.items():
        print(f"  {'✓' if v else '✗'} {k}")

    print("\n--- Done ---")
    return 0 if checklist.get("watched") else 1


if __name__ == "__main__":
    sys.exit(main())
