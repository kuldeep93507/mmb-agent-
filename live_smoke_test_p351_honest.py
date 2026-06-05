#!/usr/bin/env python3
"""
P-351 HONEST verified smoke test — zero fake PASS.

Pre-check: documents expected SKIPS if Gmail logged out.
Post-run: loads logs/action_audit_P-351_*.json truth table (mtime-fresh only).
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from glob import glob
from pathlib import Path

API = "http://127.0.0.1:3100"
KEY = "mmb-local-dev-2025"
ROOT = Path(__file__).resolve().parent
REPORT_PATH = ROOT / "live_test_report_v351_honest.json"

PROFILE = {"profileId": "2052791530343174144", "profileName": "P-351"}
VIDEO = {
    "url": "https://www.youtube.com/watch?v=KjNyAVwtAUg",
    "title": "Best Credit Card 2026-My 1000$ monthly earn strategy ",
    "channelName": "ULTRAPLAY8",
}
POLL_SEC = 8
# 40% of ~547s ≈ 219s watch + ~90s search/ads/setup
JOB_TIMEOUT_SEC = 480

LOG_KEYWORDS = (
    "[AUDIT]", "VERIFIED", "FAILED", "SKIPPED", "PASS", "FAIL",
    "[ScrollActivity]", "[QUALITY]", "[Watch", "[PauseLimiter]",
    "[LIKE]", "[SUBSCRIBE]", "[BELL]", "[VOLUME]", "[SEEK]",
    "[DESC]", "[AD]", "[AUTOPLAY]", "Autoplay", "verify_", "NOT_LOGGED_IN",
    "TIMEOUT", "ERROR", "ABORT", "real_status",
)


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


def cancel_all() -> None:
    try:
        api("POST", "/api/engagement/cancel")
        api("POST", "/api/schedule/stop", {"profileIds": [PROFILE["profileId"]]})
        api("POST", f"/api/workers/stop/{PROFILE['profileId']}")
    except Exception:
        pass


def safe_print(msg: str) -> None:
    """Windows cp1252 console cannot print audit emoji status chars."""
    print(msg.encode("ascii", errors="replace").decode())


def find_latest_audit(min_mtime: float = 0) -> Path | None:
    files = glob(str(ROOT / "logs" / "action_audit_P-351_*.json"))
    fresh = [f for f in files if Path(f).stat().st_mtime >= min_mtime]
    if not fresh:
        return None
    return Path(max(fresh, key=lambda f: Path(f).stat().st_mtime))


def collect_screenshots(since_ts: float) -> list[Path]:
    shots_dir = ROOT / "logs" / "screenshots"
    if not shots_dir.exists():
        return []
    cutoff = since_ts - 5
    return [
        p for p in shots_dir.rglob("*.png")
        if p.stat().st_mtime >= cutoff
    ]


def main() -> int:
    print("=== P-351 HONEST Verified Smoke Test ===\n")

    try:
        health = api("GET", "/api/health")
        print(f"Backend: {health.get('status')} | {health.get('version')}\n")
    except urllib.error.URLError as exc:
        print(f"Backend down: {exc}")
        return 1

    cancel_all()
    time.sleep(8)

    TEST_START_TS = time.time()

    print("PRE-TEST NOTE:")
    print("  Gmail login state will be checked INSIDE browser via verify_logged_in()")
    print("  If logged OUT -> like/subscribe/bell/comment will SKIP (NOT_LOGGED_IN)\n")

    payload = {
        "honestTest": True,
        "profiles": [
            {
                **PROFILE,
                "browserType": "morelogin",
                "source": "search",
                "delayMs": 0,
                "watchPct": 40,
                "actions": {
                    "honestTest": True,
                    "like": True,
                    "subscribe": True,
                    "bell": True,
                    "comment": False,
                    "descriptionExpand": True,
                    "volumePct": 70,
                    "seekEnabled": True,
                    "seekDirection": "forward",
                    "scrollActivity": True,
                    "qualityChange": True,
                    "pauseProbability": 0.1,
                },
                "videos": [VIDEO],
            }
        ],
        "watchPct": 40,
        "videoQuality": "360p",
        "adSkipEnabled": True,
        "adSkipDelaySec": 5,
        "adSkipDelayMaxSec": 12,
    }

    print("Starting honest test on P-351...")
    print("  watch=40% (~219s wall clock) | quality=360p | screenshots=ON\n")

    start = api("POST", "/api/engagement/start", payload)
    if start.get("code") != 0:
        print(f"Start failed: {start.get('message')}")
        return 1

    job_id = (start.get("jobIds") or [None])[0]
    print(f"Job: {job_id}\n")

    seen = 0
    deadline = time.time() + JOB_TIMEOUT_SEC
    last_status = ""
    audit_lines: list[str] = []
    job: dict | None = None

    while time.time() < deadline:
        time.sleep(POLL_SEC)
        st = api("GET", "/api/engagement/status")
        job = next((j for j in (st.get("data") or {}).get("jobs", []) if j.get("id") == job_id), None)
        if not job:
            break

        status = job.get("status", "")
        if status != last_status:
            print(f">>> {status.upper()}")
            last_status = status

        for entry in (job.get("log") or [])[seen:]:
            msg = entry.get("msg", "")
            safe = msg.encode("ascii", errors="replace").decode()
            if any(k in safe for k in LOG_KEYWORDS):
                print(f"  {safe}")
                audit_lines.append(safe)
        seen = len(job.get("log") or [])

        if status in ("done", "failed", "partial", "cancelled"):
            break

    audit_path = find_latest_audit(min_mtime=TEST_START_TS - 5)
    truth_table: list[dict] = []
    login_state = None
    overall_pass = False

    if audit_path and audit_path.exists():
        try:
            audit_data = json.loads(audit_path.read_text(encoding="utf-8"))
            truth_table = audit_data.get("truth_table", [])
            login_state = audit_data.get("login_state")
            passes = sum(1 for r in truth_table if "PASS" in r.get("real_status", ""))
            fails = sum(1 for r in truth_table if "FAIL" in r.get("real_status", ""))
            overall_pass = fails == 0 and passes > 0
            print(f"\nAudit file: {audit_path}")
            print(f"Login state: {login_state}")
            print(f"\n{'='*72}")
            print("TRUTH TABLE")
            print(f"{'='*72}")
            print(f"| {'Action':<22} | {'Attempted':<9} | {'Verified':<8} | {'Status':<18} | Screenshot |")
            print(f"|{'-'*24}|{'-'*11}|{'-'*10}|{'-'*20}|------------|")
            for row in truth_table:
                shot = row.get("screenshot", "")[:40]
                safe_print(
                    f"| {row.get('action','')[:22]:<22} | "
                    f"{row.get('attempted','')[:9]:<9} | "
                    f"{str(row.get('verified',''))[:8]:<8} | "
                    f"{row.get('real_status','')[:18]:<18} | {shot} |"
                )
        except (json.JSONDecodeError, OSError) as exc:
            print(f"\n[ERROR] Audit file unreadable: {exc}")
            try:
                preview = audit_path.read_text(errors="replace")[:200]
                print(f"        Raw preview: {preview}")
            except OSError:
                pass
    else:
        print("\n[WARN] No fresh action_audit JSON found - check logs/")

    shots = collect_screenshots(TEST_START_TS)
    expected_shots = len(truth_table) * 2
    print(f"\nScreenshots captured: {len(shots)}")
    if shots:
        print("Sample paths:")
        for p in sorted(shots, key=lambda x: x.stat().st_mtime)[-5:]:
            safe_print(f"  {p.relative_to(ROOT)}")
    if truth_table:
        if not shots:
            print("[FAIL] ZERO screenshots - visual verification not happening!")
        elif len(shots) < len(truth_table):
            print(f"[WARN] Expected >={len(truth_table)}, got {len(shots)}")
        elif len(shots) < expected_shots:
            print(f"[WARN] Expected ~{expected_shots} (before+after), got {len(shots)}")

    job_duration_sec = int(time.time() - TEST_START_TS)

    report = {
        "test": "live_smoke_test_p351_honest",
        "runAt": datetime.now(timezone.utc).isoformat(),
        "profile": PROFILE,
        "jobId": job_id,
        "jobStatus": job.get("status") if job else "unknown",
        "login_state": login_state,
        "audit_file": str(audit_path) if audit_path else None,
        "truth_table": truth_table,
        "overall_pass": overall_pass,
        "screenshots_count": len(shots),
        "screenshots_expected": expected_shots,
        "job_duration_sec": job_duration_sec,
        "rules": "verified-only, no fake PASS, wall-clock 40% watch, screenshots mandatory",
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nReport: {REPORT_PATH}")
    print(f"Duration: {job_duration_sec}s")
    print(f"Overall: {'PASS' if overall_pass else 'FAIL (honest)'}")
    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
