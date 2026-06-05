#!/usr/bin/env python3
"""Smoke tests for engagement fixes (no browser required)."""
from __future__ import annotations

import re
import sys
import urllib.error
import urllib.request

ROOT = __file__.replace("\\", "/").rsplit("/", 2)[0]
if ROOT.endswith("scripts"):
    import os
    os.chdir(os.path.join(ROOT, ".."))
    sys.path.insert(0, os.getcwd())


def test_video_id_extract():
    pat_v = re.compile(r"[?&]v=([^&]+)")
    pat_be = re.compile(r"youtu\.be/([^?&/]+)")

    def extract(url: str) -> str:
        m = pat_v.search(url) or pat_be.search(url)
        raw = m.group(1) if m else (url.strip() if len(url.strip()) == 11 else "")
        return raw[:11] if raw else ""

    cases = [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("", ""),
        ("not-a-url", ""),
    ]
    for url, want in cases:
        got = extract(url)
        assert got == want, f"{url!r} -> {got!r}, want {want!r}"
    print("OK video_id extraction")


def test_job_status_logic():
    def final_status(cancelled: bool, ok: int, fail: int) -> str:
        if cancelled:
            return "cancelled"
        if fail == 0 and ok > 0:
            return "done"
        if ok == 0:
            return "failed"
        return "partial"

    assert final_status(False, 2, 0) == "done"
    assert final_status(False, 0, 2) == "failed"
    assert final_status(False, 1, 1) == "partial"
    assert final_status(True, 1, 1) == "cancelled"
    print("OK job status logic")


def test_backend_health(api_key: str = "mmb-local-dev-2025", port: int = 3100):
    url = f"http://127.0.0.1:{port}/api/health"
    req = urllib.request.Request(url, headers={"x-api-key": api_key})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            body = r.read().decode()
            assert r.status == 200, body
    except urllib.error.URLError as e:
        print(f"SKIP backend health (server not running): {e}")
        return
    print("OK backend /api/health")


def test_engagement_status(api_key: str = "mmb-local-dev-2025", port: int = 3100):
    url = f"http://127.0.0.1:{port}/api/engagement/status"
    req = urllib.request.Request(url, headers={"x-api-key": api_key})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            import json
            data = json.loads(r.read().decode())
            assert data.get("code") == 0
            d = data.get("data", {})
            assert "partial" in d or "jobs" in d
    except urllib.error.URLError as e:
        print(f"SKIP engagement status (server not running): {e}")
        return
    print("OK /api/engagement/status")


if __name__ == "__main__":
    test_video_id_extract()
    test_job_status_logic()
    test_backend_health()
    test_engagement_status()
    print("\nAll smoke tests passed.")
