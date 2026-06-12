"""
Final 3 actions live test:
  1. comment_like  — Perfect video (comments)
  2. desc_link     — Credit cards video (description links)
  3. sidebar       — USA INSURANCE own-channel sidebar click

Usage:
  python tests/smoke_final3.py --mode comment_like
  python tests/smoke_final3.py --mode desc_link
  python tests/smoke_final3.py --mode sidebar
  python tests/smoke_final3.py --mode all
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
DEFAULT_PROFILE = "c58a40dc-d6ff-4234-8d26-a592804d32ea"
BASE_URL = os.getenv("MMB_BACKEND_URL", "http://127.0.0.1:3100")
API_KEY = os.getenv("BACKEND_API_KEY", "mmb-local-dev-2025")

MODES = {
    "comment_like": {
        "video_id": "2Vv-BfVoq4g",
        "title": "Perfect (Ed Sheeran)",
        "channel": "Ed Sheeran",
        "watch_min": 70, "watch_max": 78,
        "flags": {"commentLikeEnabled": True, "commentLikePct": 100, "descriptionExpand": False},
        "needles": ["PostWatch", "Comment like", "comment_liked", "VERIFIED comment"],
    },
    "desc_link": {
        "video_id": "uFy7lhTpVXI",
        "title": "Best Credit Cards 2026",
        "channel": "USA INSURANCE",
        "watch_min": 35, "watch_max": 42,
        "flags": {
            "descriptionLinks": True,
            "descriptionExpand": True,
            "descriptionLinkUrl": "https://hamstercombocard.com",
            "descriptionLinkVisitSec": 45,
            "descriptionCollapse": False,
        },
        "needles": ["VERIFIED desc_click", "VERIFIED direct_new_tab", "Opened in new tab", "External site visit"],
    },
    "sidebar": {
        "video_id": "615YoF6TKi8",
        "title": "Idle Bank Tycoon USA",
        "channel": "USA INSURANCE",
        "watch_min": 70, "watch_max": 80,
        "flags": {"relatedVideoEnabled": True},
        "needles": ["Sidebar", "Related video clicked", "related_video"],
    },
}


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


def _own_channels(include_all: bool = False) -> list[str]:
    try:
        data = _req("GET", "/api/channels-data")
        names = []
        for ch in data.get("channels") or []:
            if not include_all and str(ch.get("status", "")).lower() != "active":
                continue
            for k in ("channel_name", "channel_handle"):
                v = str(ch.get(k) or "").strip()
                if v and v not in names:
                    names.append(v)
        if names:
            return names
    except Exception:
        pass
    return ["USA INSURANCE", "@usainsurance", "Ultra gta play", "@ultragta"]


def _schedule(profile_id: str, mode: str) -> dict:
    m = MODES[mode]
    own = _own_channels(include_all=(mode == "sidebar"))
    flags = dict(m["flags"])
    pc = {
        "profileId": profile_id,
        "browserType": "multilogin",
        "watchTimeMin": m["watch_min"],
        "watchTimeMax": m["watch_max"],
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
        "ownChannelNames": own if mode == "sidebar" else [],
        **flags,
    }
    video = {
        "videoId": m["video_id"],
        "url": f"https://www.youtube.com/watch?v={m['video_id']}",
        "value": f"https://www.youtube.com/watch?v={m['video_id']}",
        "title": m["title"],
        "channelName": m["channel"],
    }
    return {
        "id": f"final3_{mode}_{int(time.time())}",
        "name": f"FINAL3-{mode}",
        "selectedProfiles": [profile_id],
        "assignmentMode": "same-all",
        "sameForAll": [{"channelId": 1, "channelName": m["channel"], "videos": [video]}],
        "profileConfigs": [pc],
        "ownChannelNames": own if mode == "sidebar" else [],
        "relatedVideoEnabled": mode == "sidebar",
        "profileDelayMin": 0, "profileDelayMax": 1,
        "tabDelayMin": 0, "tabDelayMax": 1,
    }


def _logs(profile_id: str) -> list[str]:
    workers = _req("GET", "/api/workers").get("workers") or []
    w = next((x for x in workers if x.get("profileId") == profile_id), None)
    if not w:
        return []
    out = []
    for ln in w.get("logs") or []:
        out.append(str(ln.get("message", ln) if isinstance(ln, dict) else ln))
    return out


def run_mode(profile_id: str, mode: str) -> bool:
    print(f"\n--- {mode.upper()} --- video={MODES[mode]['video_id']}")
    try:
        _req("DELETE", f"/api/watch-history/{profile_id}")
    except Exception:
        pass
    run = _req("POST", "/api/schedule/run", {"schedule": _schedule(profile_id, mode)})
    if not run.get("workersSpawned"):
        print(f"FAIL spawn: {run}")
        return False

    deadline = time.time() + (360 if mode == "desc_link" else 420)
    last_print = 0.0
    while time.time() < deadline:
        workers = _req("GET", "/api/workers").get("workers") or []
        w = next((x for x in workers if x.get("profileId") == profile_id), None)
        st = (w or {}).get("status", "?")
        watched = int(((w or {}).get("results") or {}).get("watched") or 0)
        now = time.time()
        if now - last_print >= 20:
            print(f"  ... status={st} watched={watched} ({int(deadline - now)}s left)")
            last_print = now
        if st in ("done", "error", "stopped"):
            break
        time.sleep(5)

    msgs = _logs(profile_id)
    # Ignore generic engagement banner — need real action proof
    action_msgs = [m for m in msgs if "[Engagement]" not in m]
    hit = any(any(n.lower() in m.lower() for m in action_msgs) for n in MODES[mode]["needles"])
    for n in MODES[mode]["needles"]:
        found = [m for m in action_msgs if n.lower() in m.lower()]
        if found:
            print(f"  LOG: {found[-1][:120].encode('ascii', 'replace').decode()}")
    w = next((x for x in (_req("GET", "/api/workers").get("workers") or [])
              if x.get("profileId") == profile_id), {})
    watched = int((w.get("results") or {}).get("watched") or 0)
    ok = watched > 0 and hit
    print(f"  => {'PASS' if ok else 'FAIL'} watched={watched} hit={hit}")
    return ok


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--profile-id", default=DEFAULT_PROFILE)
    p.add_argument("--mode", default="all", choices=["all", *MODES])
    args = p.parse_args()
    _req("GET", "/api/health")
    modes = list(MODES) if args.mode == "all" else [args.mode]
    results = {m: run_mode(args.profile_id, m) for m in modes}
    print("\n=== SUMMARY ===")
    for m, ok in results.items():
        print(f"  {m}: {'PASS' if ok else 'FAIL'}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
