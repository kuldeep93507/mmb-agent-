"""
LIVE ad-skip test — tu apni aankhon se dekhega skip hota hai ya nahi.

Kya karta hai:
  1. Profile kholta hai (backend /api/schedule/run se — real worker path)
  2. Video chalata hai jisme ads aati hain
  3. Tera set kiya skip delay use hota hai (--skip-min / --skip-max)
  4. Saare [AdSkip] logs LIVE terminal pe print karta hai
  5. PASS/FAIL verdict deta hai proof ke saath

Usage:
  python tests/smoke_ad_skip.py
  python tests/smoke_ad_skip.py --skip-min 9 --skip-max 13
  python tests/smoke_ad_skip.py --video dQw4w9WgXcQ --skip-min 10 --skip-max 15

Pehle MoreLogin/Multilogin + backend (START.bat) chalu rakho.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = "c58a40dc-d6ff-4234-8d26-a592804d32ea"
# Popular music video — high ad fill rate (pre-roll almost guaranteed)
DEFAULT_VIDEO = "2Vv-BfVoq4g"
BASE_URL = os.getenv("MMB_BACKEND_URL", "http://127.0.0.1:3100")
API_KEY = os.getenv("BACKEND_API_KEY", "mmb-local-dev-2025")

# Proof markers from ad_skip_engine
PASS_MARKERS = ("SKIP VERIFIED",)
INFO_MARKERS = ("NO_AD", "No ad detected")
FAIL_MARKERS = ("SKIP FAILED", "SKIP_UI_BUT_NOT_VERIFIED", "Skip click FAILED")


def _req(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{BASE_URL.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", "x-api-key": API_KEY},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def _schedule(profile_id: str, video_id: str, skip_min: int, skip_max: int) -> dict:
    pc = {
        "profileId": profile_id,
        "browserType": "multilogin",
        # Short watch — ad skip is the only thing under test
        "watchTimeMin": 12,
        "watchTimeMax": 18,
        "adSkipEnabled": True,
        "adSkipDelaySec": skip_min,
        "adSkipDelayMaxSec": skip_max,
        "likeEnabled": False,
        "subscribeEnabled": False,
        "bellEnabled": False,
        "commentEnabled": False,
        "seekEnabled": False,
        "scrollActivity": False,
        "qualityChange": False,
        "speedChange": False,
        "pauseProbability": 0.0,
        "honestTest": True,
        "profileName": f"Profile-{profile_id[-4:]}",
        "trafficSource": "direct",
    }
    video = {
        "videoId": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "value": f"https://www.youtube.com/watch?v={video_id}",
        "title": "AdSkip live test",
        "channelName": "test",
    }
    return {
        "id": f"adskip_{int(time.time())}",
        "name": "ADSKIP-LIVE",
        "selectedProfiles": [profile_id],
        "assignmentMode": "same-all",
        "sameForAll": [{"channelId": 1, "channelName": "test", "videos": [video]}],
        "profileConfigs": [pc],
        "profileDelayMin": 0, "profileDelayMax": 1,
        "tabDelayMin": 0, "tabDelayMax": 1,
    }


def _worker(profile_id: str) -> dict:
    workers = _req("GET", "/api/workers").get("workers") or []
    return next((w for w in workers if w.get("profileId") == profile_id), {})


def _worker_logs(profile_id: str) -> list[str]:
    out = []
    for ln in _worker(profile_id).get("logs") or []:
        out.append(str(ln.get("message", ln) if isinstance(ln, dict) else ln))
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="Live ad-skip test — apni aankhon se dekho")
    p.add_argument("--profile-id", default=DEFAULT_PROFILE)
    p.add_argument("--video", default=DEFAULT_VIDEO, help="Video ID jisme ads aati hain")
    p.add_argument("--skip-min", type=int, default=10, help="Ad kitne sec dekhne ke BAAD skip (min)")
    p.add_argument("--skip-max", type=int, default=14, help="Ad kitne sec dekhne ke BAAD skip (max)")
    p.add_argument("--timeout", type=int, default=420, help="Total test timeout (sec)")
    args = p.parse_args()

    if args.skip_max < args.skip_min:
        args.skip_max = args.skip_min

    print("=" * 64)
    print("  AD SKIP LIVE TEST")
    print(f"  profile  : {args.profile_id}")
    print(f"  video    : https://www.youtube.com/watch?v={args.video}")
    print(f"  skip wait: {args.skip_min}-{args.skip_max}s (ad dekhne ke baad skip)")
    print("  >>> Browser khud khulega — SCREEN DEKHTE RAHO <<<")
    print("=" * 64)

    try:
        _req("GET", "/api/health")
    except Exception as e:
        print(f"\nFAIL: Backend reachable nahi ({e}) — START.bat chalao pehle")
        return 1

    # Watch history clear — same-day skip test block na kare
    try:
        _req("DELETE", f"/api/watch-history/{args.profile_id}")
    except Exception:
        pass

    run = _req("POST", "/api/schedule/run", {
        "schedule": _schedule(args.profile_id, args.video, args.skip_min, args.skip_max),
    })
    if not run.get("workersSpawned"):
        print(f"\nFAIL spawn: {run}")
        return 1
    print("\nWorker spawn ho gaya — profile khul raha hai...\n")

    deadline = time.time() + args.timeout
    printed: set[str] = set()
    proof_pass = False
    proof_fail = False
    no_ad = False
    final_status = "?"

    while time.time() < deadline:
        w = _worker(args.profile_id)
        final_status = w.get("status", "?")

        # Naye [AdSkip] logs LIVE print karo
        for msg in _worker_logs(args.profile_id):
            if msg in printed:
                continue
            printed.add(msg)
            if "[AdSkip]" in msg:
                safe = msg.encode("ascii", "replace").decode()
                print(f"  {safe}")
                if any(m in msg for m in PASS_MARKERS):
                    proof_pass = True
                if any(m in msg for m in FAIL_MARKERS):
                    proof_fail = True
                if any(m in msg for m in INFO_MARKERS):
                    no_ad = True

        if final_status in ("done", "error", "stopped", "crashed"):
            break
        time.sleep(3)

    # Final logs sweep
    for msg in _worker_logs(args.profile_id):
        if msg in printed or "[AdSkip]" not in msg:
            continue
        printed.add(msg)
        print(f"  {msg.encode('ascii', 'replace').decode()}")
        if any(m in msg for m in PASS_MARKERS):
            proof_pass = True
        if any(m in msg for m in FAIL_MARKERS):
            proof_fail = True
        if any(m in msg for m in INFO_MARKERS):
            no_ad = True

    print("\n" + "=" * 64)
    if proof_pass:
        print("  RESULT: PASS — SKIP VERIFIED (ad skip ho gayi, click registered)")
        rc = 0
    elif no_ad and not proof_fail:
        print("  RESULT: NO_AD — is run me ad aayi hi nahi.")
        print("  Dubara chalao (ads har baar nahi aati): python tests/smoke_ad_skip.py")
        rc = 2
    elif proof_fail:
        print("  RESULT: FAIL — skip button dikha but click verify NahI hua")
        print("  >> Iska matlab selector/click issue — mujhe logs bhej, fix karunga")
        rc = 1
    else:
        print(f"  RESULT: INCONCLUSIVE — worker status={final_status}, koi AdSkip proof nahi")
        rc = 1
    print("=" * 64)
    return rc


if __name__ == "__main__":
    sys.exit(main())
