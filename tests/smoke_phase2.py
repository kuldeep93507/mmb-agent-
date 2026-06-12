"""
Phase-2 live tests (ad skip EXCLUDED from focus):
  - comment_like  : commentLikeEnabled=true on comment-rich video
  - desc_link     : descriptionLinks=true on video with external links
  - sidebar       : relatedVideoEnabled + ownChannelNames (own channel, unwatched only)

Usage:
  python tests/smoke_phase2.py --mode comment_like
  python tests/smoke_phase2.py --mode desc_link
  python tests/smoke_phase2.py --mode sidebar
  python tests/smoke_phase2.py --mode all
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
BASE_URL = os.getenv("MMB_BACKEND_URL", "http://127.0.0.1:3100")
API_KEY = os.getenv("BACKEND_API_KEY", "mmb-local-dev-2025")
POLL_SEC = 5
MAX_WAIT_SEC = 540

SCENARIOS = {
    "comment_like": {
        "video_id": "2Vv-BfVoq4g",
        "title": "Perfect (Ed Sheeran)",
        "channel": "Ed Sheeran",
        "watch_min": 78,
        "watch_max": 88,
        "needles": ["Comment liked", "comment_liked", "comment like", "COMMENT_LIKE", "Comment like was due"],
        "audit_actions": ["COMMENT_LIKE", "comment_like"],
    },
    "desc_link": {
        "video_id": "uFy7lhTpVXI",
        "title": "Best Credit Cards 2026",
        "channel": "USA INSURANCE",
        "watch_min": 75,
        "watch_max": 85,
        "needles": ["Description link", "desc_link", "DESC_LINK", "Description link was due"],
        "audit_actions": ["DESC_LINK", "desc_link"],
    },
    "sidebar": {
        "video_id": "615YoF6TKi8",
        "title": "Idle Bank Tycoon USA",
        "channel": "USA INSURANCE",
        "watch_min": 80,
        "watch_max": 92,
        "needles": ["Related video clicked", "[Sidebar]", "sidebar"],
        "audit_actions": ["RELATED_VIDEO", "sidebar"],
    },
}


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


def _fetch_own_channel_names() -> list[str]:
    try:
        data = _req("GET", "/api/channels-data")
        names: list[str] = []
        for ch in data.get("channels") or []:
            if str(ch.get("status", "")).lower() != "active":
                continue
            for key in ("channel_name", "channel_handle", "name"):
                val = str(ch.get(key) or "").strip()
                if val and val not in names:
                    names.append(val)
        if names:
            return names
    except Exception as exc:
        print(f"[WARN] channels-data: {exc}")
    return ["USA INSURANCE", "@usainsurance", "Ultra gta play", "@ultragta"]


def _build_schedule(profile_id: str, profile: dict, mode: str) -> dict:
    sc = SCENARIOS[mode]
    name = profile.get("name") or f"Profile-{profile_id[-4:]}"
    sid = f"phase2_{mode}_{int(time.time())}"
    own_names = _fetch_own_channel_names()

    pc = {
        "profileId": profile_id,
        "browserType": profile.get("browserType") or "multilogin",
        "watchTimeMin": sc["watch_min"],
        "watchTimeMax": sc["watch_max"],
        "likeEnabled": False,
        "subscribeEnabled": False,
        "bellEnabled": False,
        "commentEnabled": False,
        "seekEnabled": False,
        "dislikeEnabled": False,
        "scrollActivity": False,
        "qualityChange": False,
        "speedChange": False,
        "descriptionExpand": mode in ("desc_link",),
        "descriptionCollapse": False,
        "descriptionLinks": mode == "desc_link",
        "commentLikeEnabled": mode == "comment_like",
        "commentLikePct": 100 if mode == "comment_like" else 0,
        "relatedVideoEnabled": mode == "sidebar",
        "ownChannelNames": own_names if mode == "sidebar" else [],
        "adSkipEnabled": True,
        "pauseProbability": 0.0,
        "honestTest": True,
        "profileName": name,
        "trafficSource": "direct",
    }
    video = {
        "mode": "url",
        "value": f"https://www.youtube.com/watch?v={sc['video_id']}",
        "url": f"https://www.youtube.com/watch?v={sc['video_id']}",
        "title": sc["title"],
        "videoId": sc["video_id"],
        "channelName": sc.get("channel", ""),
    }
    return {
        "id": sid,
        "name": f"PHASE2-{mode.upper()} {name}",
        "selectedProfiles": [profile_id],
        "selectedChannels": [1],
        "assignmentMode": "same-all",
        "sameForAll": [{"channelId": 1, "channelName": sc.get("channel", "Test"), "videos": [video]}],
        "perProfile": [],
        "profileConfigs": [pc],
        "ownChannelNames": own_names if mode == "sidebar" else [],
        "relatedVideoEnabled": mode == "sidebar",
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
    for f in sorted(LOGS_DIR.glob("action_audit_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:40]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("profile_id") == profile_id:
                return data
        except Exception:
            continue
    return None


def run_one(profile_id: str, mode: str) -> bool:
    sc = SCENARIOS[mode]
    print(f"\n=== Phase2 [{mode}] ===")
    print(f"Video: {sc['video_id']} — {sc['title']}")

    profile = _fetch_profile(profile_id)
    try:
        _req("DELETE", f"/api/watch-history/{profile_id}")
        print("[OK] Watch history cleared")
    except Exception as exc:
        print(f"[WARN] history clear: {exc}")

    run = _req("POST", "/api/schedule/run", {"schedule": _build_schedule(profile_id, profile, mode)})
    if not run.get("workersSpawned"):
        print(f"[FAIL] No worker: {run}")
        return False
    print(f"[OK] Worker spawned: {run['workersSpawned']}")

    deadline = time.time() + MAX_WAIT_SEC
    worker = None
    while time.time() < deadline:
        worker = _worker_for_profile((_req("GET", "/api/workers").get("workers") or []), profile_id)
        status = (worker or {}).get("status", "?")
        watched = int(((worker or {}).get("results") or {}).get("watched") or 0)
        elapsed = MAX_WAIT_SEC - int(deadline - time.time())
        print(f"  [{elapsed}s] {status} watched={watched}")
        if status in ("done", "idle", "stopped", "error", "failed"):
            break
        if watched > 0 and status not in ("watching", "connecting", "starting"):
            break
        time.sleep(POLL_SEC)

    msgs = _log_messages(worker)
    hit = False
    for needle in sc["needles"]:
        found = [m for m in msgs if needle.lower() in m.lower()]
        if found:
            hit = True
            print(f"  [LOG HIT] {needle}: {found[-1][:120].encode('ascii', 'replace').decode()}")

    audit = _latest_audit(profile_id)
    audit_hit = False
    if audit:
        print("  --- Audit truth table ---")
        for row in audit.get("truth_table") or []:
            action = str(row.get("action", ""))
            passed = row.get("pass", row.get("verified", False))
            mark = "PASS" if passed else "FAIL"
            print(f"    [{mark}] {action}: {str(row.get('reason', ''))[:80]}")
            if any(a.lower() in action.lower() for a in sc["audit_actions"]) and passed:
                audit_hit = True
        saved = audit.get("saved_at", "")
        if saved:
            print(f"  [AUDIT FILE] saved_at={saved}")
    else:
        print("  [WARN] No audit JSON found for profile")

    watched = int(((worker or {}).get("results") or {}).get("watched") or 0)
    ok = watched > 0 and (hit or audit_hit)
    print(f"  => {'PASS' if ok else 'FAIL'} watched={watched} log_hit={hit} audit_hit={audit_hit}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile-id", default=DEFAULT_PROFILE)
    parser.add_argument(
        "--mode",
        choices=["comment_like", "desc_link", "sidebar", "all"],
        default="all",
    )
    args = parser.parse_args()

    print("\n=== MMB Phase-2 Live Tests (no ad-skip focus) ===")
    print(f"Profile: {args.profile_id}")
    _req("GET", "/api/health")
    print("[OK] Backend health")

    modes = list(SCENARIOS) if args.mode == "all" else [args.mode]
    results = {m: run_one(args.profile_id, m) for m in modes}

    print("\n=== Summary ===")
    for m, ok in results.items():
        print(f"  {m}: {'PASS' if ok else 'FAIL'}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
