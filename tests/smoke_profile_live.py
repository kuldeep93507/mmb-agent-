"""
Live smoke test — one profile, all engagement actions, audit-verified.

Usage:
  python tests/smoke_profile_live.py
  python tests/smoke_profile_live.py --profile-id c58a40dc-d6ff-4234-8d26-a592804d32ea
  python tests/smoke_profile_live.py --video-id dQw4w9WgXcQ
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGS_DIR = ROOT / "logs"

DEFAULT_PROFILE = "c58a40dc-d6ff-4234-8d26-a592804d32ea"
# ~4:23 video — enough length for like (10%+), subscribe (20%+), comment (65%+)
# NOT a 19s clip — engagement triggers need real watch time
DEFAULT_VIDEO_ID = "2Vv-BfVoq4g"
DEFAULT_VIDEO_TITLE = "Perfect (Ed Sheeran)"
DEFAULT_VIDEO_DURATION_SEC = 263

BASE_URL = os.getenv("MMB_BACKEND_URL", "http://127.0.0.1:3100")
API_KEY = os.getenv("BACKEND_API_KEY", "mmb-local-dev-2025")
POLL_SEC = 5
# launch + ads + ~4min watch + engagement buffer
MAX_WAIT_SEC = 480


def _req(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{BASE_URL.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "x-api-key": API_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {path}: {detail}") from exc


def _fetch_profile(profile_id: str) -> dict:
    data = _req("POST", "/api/profiles/list-all", {})
    profiles = (data.get("data") or {}).get("profiles") or []
    for p in profiles:
        pid = str(p.get("id") or p.get("profileId") or "")
        if pid == profile_id:
            return {**p, "id": pid}
    # Multilogin profile may not appear when BROWSER_PROVIDER=morelogin
    fallback = os.getenv("SMOKE_BROWSER_TYPE", "multilogin")
    print(f"[WARN] Profile not in list-all ({len(profiles)} rows) — using fallback browserType={fallback}")
    return {
        "id": profile_id,
        "name": f"Profile-{profile_id[-4:]}",
        "browserType": fallback,
    }


def _build_schedule(profile_id: str, profile: dict, video_id: str, video_title: str) -> dict:
    browser = profile.get("browserType") or "multilogin"
    name = profile.get("name") or f"Profile-{profile_id[-4:]}"
    sid = f"smoke_{int(time.time())}"

    pc = {
        "profileId": profile_id,
        "browserType": browser,
        # watchTimeMin/Max = PERCENT of video (not seconds!)
        # 75–90% of ~4:23 → comment trigger @65%+ WILL fire
        "watchTimeMin":          75,
        "watchTimeMax":          90,
        "likeEnabled": True,
        "subscribeEnabled": True,
        "bellEnabled": True,
        "commentEnabled": True,
        "dislikeEnabled": False,
        "descriptionExpand": True,
        "descriptionLinks": False,
        "commentText": "Great video! Very informative.",
        "videoQuality": "360p",
        "volumePct": 70,
        "adSkipEnabled": True,
        "adSkipAfterSec": 10,
        "midRollAdWaitSec": 8,
        "seekEnabled": True,
        "seekDirection": "forward",
        "pauseProbability": 0.10,
        "pauseHoldSec": 3,
        "uniqueTypingPersonality": True,
        "naturalScrollCurves": True,
        "scrollActivity": True,
        "qualityChange": True,
        "qualityChangeEnabled": True,
        "captionsEnabled": False,
        "captionsToggle": False,
        "playbackSpeed": "1x",
        "speedChange": False,
        "trafficSource": "direct",
        "humanEngagementEnabled": True,
        "honestTest": True,
        "profileName": name,
    }

    video = {
        "mode": "url",
        "value": f"https://www.youtube.com/watch?v={video_id}",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": video_title,
        "videoId": video_id,
    }

    return {
        "id": sid,
        "name": f"SMOKE {name}",
        "selectedProfiles": [profile_id],
        "selectedChannels": [1],
        "assignmentMode": "same-all",
        "sameForAll": [{"channelId": 1, "channelName": "Smoke", "videos": [video]}],
        "perProfile": [],
        "profileConfigs": [pc],
        "profileDelayMin": 0,
        "profileDelayMax": 1,
        "tabDelayMin": 0,
        "tabDelayMax": 1,
        "runMode": "manual",
        "countdownMinutes": 0,
        "scheduledTime": 0,
        "repeatEnabled": False,
        "status": "idle",
        "createdAt": int(time.time() * 1000),
        "progress": {"total": 1, "done": 0, "failed": 0},
    }


def _worker_for_profile(workers: list, profile_id: str) -> dict | None:
    for w in workers:
        if w.get("profileId") == profile_id:
            return w
    return None


def _latest_audit(profile_id: str) -> dict | None:
    if not LOGS_DIR.is_dir():
        return None
    files = sorted(
        LOGS_DIR.glob("action_audit_*.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for f in files[:30]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("profile_id") == profile_id:
                return data
        except Exception:
            continue
    return None


def _print_audit(audit: dict | None) -> tuple[int, int]:
    if not audit:
        print("  [INFO] No audit file — honestTest may not have run")
        return 0, 0

    login = audit.get("login_state")
    print(f"  login_state : {'logged in' if login else 'NOT logged in'}")
    if not login:
        print("  WARNING: Profile not logged into YouTube — like/comment will fail")

    rows = audit.get("truth_table") or []
    ok_count = 0
    for row in rows:
        action = str(row.get("action", "")).upper()
        passed = bool(row.get("pass", row.get("verified", False)))
        reason = row.get("reason") or ""
        marker = "PASS" if passed else "FAIL"
        print(f"  [{marker}] {action:<20} {reason}")
        if passed:
            ok_count += 1
    return ok_count, len(rows)


def _print_worker_summary(worker: dict | None) -> None:
    if not worker:
        print("  [INFO] No worker record")
        return
    results = worker.get("results") or {}
    print(
        f"  status  : {worker.get('status', '?')}\n"
        f"  results : {results}"
    )
    logs = worker.get("logs") or []
    for key in ("Liked", "Subscribed", "Comment", "Bell", "AdSkip", "Like FAILED", "Subscribe"):
        hits = []
        for ln in logs:
            msg = ln.get("message", ln) if isinstance(ln, dict) else str(ln)
            if key.lower() in str(msg).lower():
                hits.append(str(msg))
        if hits:
            print(f"  log -> {hits[-1][:120]}")


def main() -> int:
    parser = argparse.ArgumentParser(description="MMB live smoke test")
    parser.add_argument("--profile-id", default=DEFAULT_PROFILE)
    parser.add_argument("--video-id", default=DEFAULT_VIDEO_ID)
    parser.add_argument("--video-title", default=DEFAULT_VIDEO_TITLE)
    args = parser.parse_args()

    profile_id = args.profile_id
    video_id = args.video_id

    print("\n=== MMB Smoke Test (FRESH) ===")
    print(f"Profile : {profile_id}")
    print(f"Video   : {video_id} ({args.video_title}) ~{DEFAULT_VIDEO_DURATION_SEC}s")
    print(f"Backend : {BASE_URL}")
    print(f"Max wait: {MAX_WAIT_SEC}s\n")

    health = _req("GET", "/api/health")
    print(f"[OK] Backend: {health.get('status', health)}")

    profile = _fetch_profile(profile_id)
    print(f"[OK] Profile: {profile.get('name')} ({profile.get('browserType')})")

    try:
        _req("DELETE", f"/api/watch-history/{profile_id}")
        print("[OK] Watch history cleared")
    except Exception as exc:
        print(f"[WARN] Watch history clear failed: {exc}")

    schedule = _build_schedule(profile_id, profile, video_id, args.video_title)
    print("[..] Starting schedule — like/subscribe/bell/comment ON, honestTest=True")

    run = _req("POST", "/api/schedule/run", {"schedule": schedule})
    spawned = run.get("workersSpawned", 0)
    print(f"[OK] Worker spawned: {spawned}")
    if not spawned:
        print(f"[FAIL] No worker: {run}")
        return 1

    deadline = time.time() + MAX_WAIT_SEC
    worker = None
    while time.time() < deadline:
        data = _req("GET", "/api/workers")
        workers = data.get("workers") or []
        worker = _worker_for_profile(workers, profile_id)
        status = (worker or {}).get("status", "waiting")
        results = (worker or {}).get("results") or {}
        watched = int(results.get("watched") or 0)
        failed = int(results.get("failed") or 0)
        elapsed = MAX_WAIT_SEC - int(deadline - time.time())
        print(f"  [{elapsed}s] {status} | watched={watched} failed={failed}")

        if status in ("done", "idle", "stopped", "error", "failed"):
            break
        if watched > 0 and status not in ("watching", "connecting", "starting"):
            break
        time.sleep(POLL_SEC)

    elapsed_total = MAX_WAIT_SEC - int(max(0, deadline - time.time()))
    print(f"\n--- Results ({elapsed_total}s) ---")
    _print_worker_summary(worker)

    audit = _latest_audit(profile_id)
    if audit:
        print("\n--- Action Audit (truth table) ---")
    ok, total = _print_audit(audit)

    results = (worker or {}).get("results") or {}
    watched = int(results.get("watched") or 0)
    skipped = int(results.get("skipped") or 0)
    status = (worker or {}).get("status", "?")

    if skipped > 0 and watched == 0:
        print("\n[FAIL] Video skipped (watch history?)")
        return 1
    if watched == 0 and status == "watching":
        print("\n[FAIL] Timed out while still watching")
        return 1
    if audit and total > 0 and ok == 0:
        print("\n[FAIL] Audit: no actions verified")
        return 1
    if audit and total > 0:
        print(f"\n[OK] Audit: {ok}/{total} actions verified")
        return 0 if ok >= 2 else 1

    print("\n[WARN] No audit file — check worker logs manually")
    return 0 if watched > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
