"""
Live test — REMAINING actions only (does NOT touch locked working actions).

Tests: dislike, comment like, desc link, scroll, quality, speed, autoplay off, desc collapse
Locks OFF: like, subscribe, bell, comment post, seek, volume, captions

Usage:
  python tests/smoke_remaining_actions.py
  python tests/smoke_remaining_actions.py --profile-id c58a40dc-d6ff-4234-8d26-a592804d32ea
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
# Popular ~4:23 — has comments + description links
DEFAULT_VIDEO_ID = "2Vv-BfVoq4g"
DEFAULT_VIDEO_TITLE = "Perfect (Ed Sheeran)"

BASE_URL = os.getenv("MMB_BACKEND_URL", "http://127.0.0.1:3100")
API_KEY = os.getenv("BACKEND_API_KEY", "mmb-local-dev-2025")
POLL_SEC = 5
MAX_WAIT_SEC = 480

WATCH_FOR = [
    "Dislike", "dislike", "Comment liked", "comment_like", "comment liked",
    "Description link", "desc_link", "ScrollActivity", "idle_scroll",
    "Quality changed", "QUALITY", "Speed]", "Autoplay OFF",
    "Description collapsed", "desc_collapsed", "Description expanded",
]


def _req(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{BASE_URL.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", "x-api-key": API_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} {path}: {exc.read().decode()}") from exc


def _fetch_profile(profile_id: str) -> dict:
    data = _req("POST", "/api/profiles/list-all", {})
    for p in (data.get("data") or {}).get("profiles") or []:
        pid = str(p.get("id") or p.get("profileId") or "")
        if pid == profile_id:
            return {**p, "id": pid}
    fallback = os.getenv("SMOKE_BROWSER_TYPE", "multilogin")
    print(f"[WARN] Profile not in list — fallback browserType={fallback}")
    return {"id": profile_id, "name": f"Profile-{profile_id[-4:]}", "browserType": fallback}


def _build_schedule(profile_id: str, profile: dict, video_id: str, title: str) -> dict:
    name = profile.get("name") or f"Profile-{profile_id[-4:]}"
    sid = f"remain_{int(time.time())}"
    pc = {
        "profileId": profile_id,
        "browserType": profile.get("browserType") or "multilogin",
        "watchTimeMin": 75,
        "watchTimeMax": 88,
        # LOCKED actions OFF — do not re-test working ones
        "likeEnabled": False,
        "subscribeEnabled": False,
        "bellEnabled": False,
        "commentEnabled": False,
        "seekEnabled": False,
        "captionsToggle": False,
        "volumePct": 50,
        # REMAINING actions ON
        "dislikeEnabled": True,
        "commentLikeEnabled": True,
        "commentLikePct": 100,
        "descriptionExpand": True,
        "descriptionCollapse": True,
        "descriptionLinks": True,
        "scrollActivity": True,
        "qualityChange": True,
        "qualityChangeEnabled": True,
        "videoQuality": "480p",
        "speedChange": True,
        "speedChangeEnabled": True,
        "playbackSpeed": "1.25x",
        "adSkipEnabled": True,
        "adSkipAfterSec": 10,
        "pauseProbability": 0.0,
        "honestTest": True,
        "profileName": name,
        "trafficSource": "direct",
    }
    video = {
        "mode": "url",
        "value": f"https://www.youtube.com/watch?v={video_id}",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": title,
        "videoId": video_id,
    }
    return {
        "id": sid,
        "name": f"REMAINING {name}",
        "selectedProfiles": [profile_id],
        "selectedChannels": [1],
        "assignmentMode": "same-all",
        "sameForAll": [{"channelId": 1, "channelName": "Remaining", "videos": [video]}],
        "perProfile": [],
        "profileConfigs": [pc],
        "profileDelayMin": 0, "profileDelayMax": 1,
        "tabDelayMin": 0, "tabDelayMax": 1,
        "runMode": "manual", "countdownMinutes": 0, "scheduledTime": 0,
        "repeatEnabled": False, "status": "idle",
        "createdAt": int(time.time() * 1000),
        "progress": {"total": 1, "done": 0, "failed": 0},
    }


def _worker_for_profile(workers: list, profile_id: str) -> dict | None:
    for w in workers:
        if w.get("profileId") == profile_id:
            return w
    return None


def _log_messages(worker: dict | None) -> list[str]:
    if not worker:
        return []
    out = []
    for ln in worker.get("logs") or []:
        if isinstance(ln, dict):
            out.append(str(ln.get("message", "")))
        else:
            out.append(str(ln))
    return out


def _latest_audit(profile_id: str) -> dict | None:
    if not LOGS_DIR.is_dir():
        return None
    for f in sorted(LOGS_DIR.glob("action_audit_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("profile_id") == profile_id:
                return data
        except Exception:
            continue
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile-id", default=DEFAULT_PROFILE)
    parser.add_argument("--video-id", default=DEFAULT_VIDEO_ID)
    parser.add_argument("--video-title", default=DEFAULT_VIDEO_TITLE)
    args = parser.parse_args()

    print("\n=== MMB Remaining Actions Test ===")
    print(f"Profile: {args.profile_id}")
    print(f"Video  : {args.video_id} ({args.video_title})")
    print("Locked OFF: like/subscribe/bell/comment/seek/volume/captions\n")

    _req("GET", "/api/health")
    profile = _fetch_profile(args.profile_id)
    try:
        _req("DELETE", f"/api/watch-history/{args.profile_id}")
        print("[OK] Watch history cleared")
    except Exception as exc:
        print(f"[WARN] history clear: {exc}")

    run = _req("POST", "/api/schedule/run", {"schedule": _build_schedule(
        args.profile_id, profile, args.video_id, args.video_title,
    )})
    if not run.get("workersSpawned"):
        print(f"[FAIL] No worker: {run}")
        return 1
    print(f"[OK] Worker spawned: {run['workersSpawned']}")

    deadline = time.time() + MAX_WAIT_SEC
    worker = None
    while time.time() < deadline:
        worker = _worker_for_profile((_req("GET", "/api/workers").get("workers") or []), args.profile_id)
        status = (worker or {}).get("status", "?")
        watched = int(((worker or {}).get("results") or {}).get("watched") or 0)
        print(f"  [{MAX_WAIT_SEC - int(deadline - time.time())}s] {status} watched={watched}")
        if status in ("done", "idle", "stopped", "error", "failed"):
            break
        if watched > 0 and status not in ("watching", "connecting", "starting"):
            break
        time.sleep(POLL_SEC)

    msgs = _log_messages(worker)
    print("\n--- Log hits (remaining actions) ---")
    hits = 0
    for needle in WATCH_FOR:
        found = [m for m in msgs if needle.lower() in m.lower()]
        if found:
            hits += 1
            print(f"  [HIT] {needle}: {found[-1][:100].encode('ascii', 'replace').decode()}")

    audit = _latest_audit(args.profile_id)
    if audit:
        print("\n--- Audit truth table ---")
        for row in audit.get("truth_table") or []:
            action = row.get("action", "?")
            passed = row.get("pass", row.get("verified", False))
            print(f"  [{'PASS' if passed else 'FAIL'}] {action}: {row.get('reason','')[:80]}")

    watched = int(((worker or {}).get("results") or {}).get("watched") or 0)
    if watched == 0:
        print("\n[FAIL] Video not completed")
        return 1
    print(f"\n[OK] watched=1 log_hits={hits}")
    return 0 if hits >= 3 else 1


if __name__ == "__main__":
    sys.exit(main())
