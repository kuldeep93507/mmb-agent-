#!/usr/bin/env python3
"""
MMB Agent V2 — Live smoke test (STEP B).

Runs 2 MoreLogin profiles sequentially against the live backend on :3100.
Target: ULTRAPLAY8 — "Best Credit Card 2026" (video KjNyAVwtAUg).

Outputs:
  - live_test_report_v2.json
  - screenshots/  (copies any PNGs saved during runs)
"""
from __future__ import annotations

import glob
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "http://127.0.0.1:3100"
KEY = "mmb-local-dev-2025"
ROOT = Path(__file__).resolve().parent
SCREENSHOTS_DIR = ROOT / "screenshots"
REPORT_PATH = ROOT / "live_test_report_v2.json"

VIDEO_ID = "KjNyAVwtAUg"
VIDEO = {
    "url": f"https://www.youtube.com/watch?v={VIDEO_ID}",
    "title": "Best Credit Card 2026-My 1000$ monthly earn strategy ",
    "channelName": "ULTRAPLAY8",
}

PROFILES = [
    {"profileId": "2052791530343174144", "profileName": "P-351"},
    {"profileId": "2052697500397670400", "profileName": "P-348"},
]

POLL_SEC = 10
JOB_TIMEOUT_SEC = 1200  # 20 min per profile (like retries extend watch loop)


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


def fetch_morelogin_profiles() -> list[dict]:
    try:
        res = api("GET", "/api/profiles/list?provider=morelogin")
        return (res.get("data") or {}).get("profiles") or []
    except Exception:
        return []


def cancel_engagement_jobs() -> int:
    try:
        res = api("POST", "/api/engagement/cancel")
        return int(res.get("cancelled") or 0)
    except Exception:
        return 0


def stop_worker(profile_id: str) -> None:
    try:
        api("POST", f"/api/workers/stop/{profile_id}")
    except Exception:
        pass


def stop_schedule_workers(profile_ids: list[str]) -> None:
    try:
        api("POST", "/api/schedule/stop", {"profileIds": profile_ids})
    except Exception:
        pass


def build_actions() -> dict:
    return {
        "like": True,
        "dislike": False,
        "subscribe": False,
        "bell": False,
        "comment": False,
        "descriptionExpand": True,
        "descriptionLinks": False,
        "volumePct": 70,
        "seekEnabled": True,
        "seekDirection": "forward",
        "scrollActivity": True,
        "qualityChange": True,
        "playbackSpeed": "1x",
        "captionsToggle": False,
    }


def new_checklist() -> dict:
    return {
        "player_ready": False,
        "quality_at_early_window": False,
        "quality_profile_tag": False,
        "scroll_activity_planned": False,
        "scroll_activity_executed": False,
        "pause_limiter_init": False,
        "pause_human": False,
        "video_watched": False,
        "search_or_organic_entry": False,
    }


def analyze_logs(logs: list[dict], checklist: dict) -> list[str]:
    markers: list[str] = []
    for entry in logs:
        msg = entry.get("msg", "")
        m = msg.lower()

        if "player ready" in m:
            checklist["player_ready"] = True
        if re.search(r"\[quality\]\s*@\s*[\d.]+s", msg, re.I):
            checklist["quality_at_early_window"] = True
            markers.append(msg)
        if re.search(r"\[quality\]\[", msg, re.I):
            checklist["quality_profile_tag"] = True
            markers.append(msg)
        if "[scrollactivity] planned" in m:
            checklist["scroll_activity_planned"] = True
            markers.append(msg)
        if "[scrollactivity] completed" in m or (
            "[scrollactivity]" in m and "planned" not in m and "skip" not in m
        ):
            checklist["scroll_activity_executed"] = True
        if "[pauselimiter]" in m:
            checklist["pause_limiter_init"] = True
            markers.append(msg)
        if "pause (human)" in m or "pause/resume" in m:
            checklist["pause_human"] = True
        if "watched successfully" in m or "video watched" in m:
            checklist["video_watched"] = True
        if "path a" in m or "source=search" in m or "keyword" in m or "entropy" in m:
            checklist["search_or_organic_entry"] = True

    return markers


def collect_screenshots(profile_name: str, before: set[str]) -> list[str]:
    SCREENSHOTS_DIR.mkdir(exist_ok=True)
    saved: list[str] = []
    for path_str in glob.glob(str(ROOT / "screenshot*.png")):
        if path_str in before:
            continue
        src = Path(path_str)
        dest = SCREENSHOTS_DIR / f"{profile_name}_{src.name}"
        try:
            shutil.copy2(src, dest)
            saved.append(str(dest.relative_to(ROOT)))
        except Exception:
            pass
    return saved


def run_profile(profile: dict, index: int, total: int) -> dict:
    profile_id = profile["profileId"]
    profile_name = profile["profileName"]
    print(f"\n{'=' * 60}")
    print(f"Profile {index + 1}/{total}: {profile_name} ({profile_id})")
    print(f"{'=' * 60}")

    stop_worker(profile_id)
    time.sleep(5)
    before_shots = set(glob.glob(str(ROOT / "screenshot*.png")))

    payload = {
        "profiles": [
            {
                **profile,
                "browserType": "morelogin",
                "source": "search",
                "delayMs": 0,
                "watchPct": 40,
                "actions": build_actions(),
                "videos": [VIDEO],
            }
        ],
        "watchPct": 40,
        "adSkipEnabled": True,
        "adSkipDelaySec": 5,
        "adSkipDelayMaxSec": 12,
        "videoQuality": "360p",
    }

    checklist = new_checklist()
    result = {
        "profileId": profile_id,
        "profileName": profile_name,
        "jobId": None,
        "status": "unknown",
        "error": None,
        "videosOk": 0,
        "videosFailed": 0,
        "checklist": checklist,
        "bug_markers": [],
        "log_excerpt": [],
        "screenshots": [],
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "finishedAt": None,
        "durationSec": None,
    }

    t0 = time.time()
    try:
        start = api("POST", "/api/engagement/start", payload)
    except Exception as exc:
        result["status"] = "start_failed"
        result["error"] = str(exc)
        result["finishedAt"] = datetime.now(timezone.utc).isoformat()
        result["durationSec"] = round(time.time() - t0, 1)
        return result

    if start.get("code") != 0:
        result["status"] = "start_failed"
        result["error"] = start.get("message", "unknown start error")
        result["finishedAt"] = datetime.now(timezone.utc).isoformat()
        result["durationSec"] = round(time.time() - t0, 1)
        return result

    job_ids = start.get("jobIds") or []
    if not job_ids:
        result["status"] = "start_failed"
        result["error"] = "no jobIds returned"
        result["finishedAt"] = datetime.now(timezone.utc).isoformat()
        result["durationSec"] = round(time.time() - t0, 1)
        return result

    job_id = job_ids[0]
    result["jobId"] = job_id
    print(f"Job queued: {job_id}")

    seen = 0
    deadline = time.time() + JOB_TIMEOUT_SEC
    last_status = ""

    while time.time() < deadline:
        time.sleep(POLL_SEC)
        try:
            st = api("GET", "/api/engagement/status")
        except Exception as exc:
            print(f"  poll error: {exc}")
            continue

        jobs = (st.get("data") or {}).get("jobs") or []
        job = next((j for j in jobs if j.get("id") == job_id), None)
        if not job:
            result["status"] = "lost"
            result["error"] = "job not found in queue"
            break

        status = job.get("status", "")
        if status != last_status:
            print(f"  >>> status: {status}")
            if job.get("error"):
                print(f"      error: {job['error']}")
            last_status = status

        logs = job.get("log") or []
        for entry in logs[seen:]:
            msg = entry.get("msg", "")
            safe = msg.encode("ascii", errors="replace").decode("ascii")
            print(f"    {safe}")
            result["log_excerpt"].append(safe)
        seen = len(logs)

        markers = analyze_logs(logs, checklist)
        for m in markers:
            if m not in result["bug_markers"]:
                result["bug_markers"].append(m)

        if status in ("done", "failed", "partial", "cancelled"):
            result["status"] = status
            result["error"] = job.get("error")
            result["videosOk"] = job.get("videosOk", 0)
            result["videosFailed"] = job.get("videosFailed", 0)
            break
    else:
        result["status"] = "timeout"
        result["error"] = f"exceeded {JOB_TIMEOUT_SEC}s"

    result["screenshots"] = collect_screenshots(profile_name, before_shots)
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    result["durationSec"] = round(time.time() - t0, 1)

    passed = sum(1 for v in checklist.values() if v)
    print(f"\n  checklist: {passed}/{len(checklist)} passed")
    for k, v in checklist.items():
        print(f"    {'OK' if v else '--'} {k}")

    return result


def main() -> int:
    print("=== MMB Agent V2 Live Smoke Test (STEP B) ===\n")

    SCREENSHOTS_DIR.mkdir(exist_ok=True)

    try:
        health = api("GET", "/api/health")
        print(f"Backend: {health.get('status', health)} | version={health.get('version')}")
    except urllib.error.URLError as exc:
        print(f"Backend not reachable at {API}: {exc}")
        return 1

    available = fetch_morelogin_profiles()
    available_ids = {p.get("id") for p in available}
    profiles = [p for p in PROFILES if p["profileId"] in available_ids]
    if not profiles:
        profiles = PROFILES
        print("Warning: configured profiles not in API list; using hardcoded IDs")

    profile_ids = [p["profileId"] for p in profiles]
    stop_schedule_workers(profile_ids)
    for pid in profile_ids:
        stop_worker(pid)
    print("Stopped scheduler workers on target profiles, waiting 10s for browser release…")
    time.sleep(10)

    cancelled = cancel_engagement_jobs()
    if cancelled:
        print(f"Cancelled {cancelled} prior engagement job(s)")

    print(f"\nTarget video: {VIDEO['title'].strip()}")
    print(f"Video ID: {VIDEO_ID} | Channel: {VIDEO['channelName']}")
    print(f"Profiles: {', '.join(p['profileName'] for p in profiles)}")
    print(f"Settings: source=search, quality=360p, watch=40%, scroll+quality ON\n")

    report = {
        "test": "live_smoke_test_v2",
        "version": "2.0.0",
        "runAt": datetime.now(timezone.utc).isoformat(),
        "api": API,
        "video": VIDEO,
        "profiles_tested": len(profiles),
        "results": [],
        "summary": {},
    }

    for i, profile in enumerate(profiles):
        report["results"].append(run_profile(profile, i, len(profiles)))
        if i < len(profiles) - 1:
            gap = 15
            print(f"\nCool-down {gap}s before next profile…")
            time.sleep(gap)

    total = len(report["results"])
    done = sum(1 for r in report["results"] if r["status"] == "done")
    failed = sum(1 for r in report["results"] if r["status"] not in ("done", "partial"))

    bug_checks = [
        "quality_at_early_window",
        "scroll_activity_planned",
        "pause_limiter_init",
        "quality_profile_tag",
    ]
    bug_pass = {}
    for key in bug_checks:
        bug_pass[key] = sum(
            1 for r in report["results"] if r["checklist"].get(key)
        )

    report["summary"] = {
        "profiles_total": total,
        "profiles_done": done,
        "profiles_failed": failed,
        "bug_verification": bug_pass,
        "all_profiles_watched": all(
            r["checklist"].get("video_watched") for r in report["results"]
        ),
        "overall_pass": done == total and bug_pass.get("quality_at_early_window", 0) >= 1,
    }

    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"\n{'=' * 60}")
    print("SMOKE TEST SUMMARY")
    print(f"{'=' * 60}")
    print(f"Profiles done: {done}/{total}")
    print(f"Bug markers:")
    for k, v in bug_pass.items():
        print(f"  {k}: {v}/{total} profiles")
    print(f"\nReport: {REPORT_PATH}")
    print(f"Screenshots: {SCREENSHOTS_DIR}/")
    print(f"Overall: {'PASS' if report['summary']['overall_pass'] else 'FAIL'}")

    return 0 if report["summary"]["overall_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
