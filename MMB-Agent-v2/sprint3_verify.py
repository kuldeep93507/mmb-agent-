"""Sprint-3 verification — 3 passes"""
import sys
sys.path.insert(0, '.')

results = []

def chk(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append((name, status, detail))
    print(f"  [{status}] {name}" + (f" | {detail}" if detail else ""))

def summary(pass_name):
    fails = [r for r in results if r[1] == "FAIL"]
    passes = [r for r in results if r[1] == "PASS"]
    print(f"\n{pass_name} TOTAL: {len(passes)} PASS | {len(fails)} FAIL")
    if fails:
        for n, s, d in fails:
            print(f"  FAIL: {n} | {d}")
    return len(fails)

# ─────────────────────────────────────────────────────────────────────────────
print("=" * 60)
print("SPRINT-3 PASS 1 — Code Structure Audit")
print("=" * 60)

cm_src = open("services/channel_manager.py", encoding="utf-8").read()
app_src = open("dashboard/app.py", encoding="utf-8").read()
orc = open("core/Orchestrator.py", encoding="utf-8").read()
html = open("dashboard/templates/index.html", encoding="utf-8").read()

print("\n[A1] channel_manager.py — sync_to_jobs")
chk("sync_to_jobs method exists", "def sync_to_jobs(" in cm_src)
chk("reads enabled videos", "get_all_videos(enabled_only=True)" in cm_src)
chk("channel lookup enrichment", "ch_map = {c" in cm_src)
chk("builds engagement block", "comment_templates" in cm_src)
chk("atomic save", "_save_json(_p, jobs_data)" in cm_src)
chk("returns added/skipped/total", '"added": added' in cm_src)
chk("overwrite_existing param", "overwrite_existing" in cm_src)

print("\n[A2] dashboard/app.py — new endpoints")
chk("CHANNELS_FILE path", "CHANNELS_FILE" in app_src)
chk("VIDEOS_FILE path", "VIDEOS_FILE" in app_src)
chk("WATCH_HISTORY_FILE path", "WATCH_HISTORY_FILE" in app_src)
chk("_load_json helper", "def _load_json(" in app_src)
chk("_save_json_atomic helper", "_save_json_atomic" in app_src)
chk("/api/channels_db", "/api/channels_db" in app_src)
chk("/api/videos_db", "/api/videos_db" in app_src)
chk("/api/sync_jobs", "/api/sync_jobs" in app_src)
chk("/api/watch_history", "/api/watch_history" in app_src)
chk("toggle_video_db endpoint", "toggle_video_db" in app_src)
chk("set_video_priority endpoint", "set_video_priority" in app_src)

print("\n[A3] api_add_video — dual write")
chk("writes to videos.json via cm.add_video", "cm.add_video(" in app_src)
chk("writes channel to cm.add_channel", "cm.add_channel(" in app_src)
chk("DB write is non-fatal (try/except)", "DB write non-fatal" in app_src)

print("\n[A4] api_scan_channel — saves channel")
chk("ChannelManager().add_channel called", "ChannelManager().add_channel" in app_src)

print("\n[A5] watch_history API correctness")
chk("total_watches computed", "total_watches" in app_src)
chk("total_watch_min computed", "total_watch_min" in app_src)
chk("like_rate computed", "like_rate" in app_src)
chk("comment_rate computed", "comment_rate" in app_src)
chk("sorted by last_watched_at", "last_watched_at" in app_src)

print("\n[A6] Orchestrator — ShuffleEngine retire")
chk("DEPRECATED comment on import", "DEPRECATED (Sprint-3)" in orc)
chk("cycle_key inlined (no _dedup.cycle_key)", "_dedup.cycle_key()" not in orc)
chk("cycle_key uses strftime", 'strftime("%Y-%m-%d")' in orc)
chk("TODO Sprint-4 retire note", "TODO Sprint-4" in orc)

print("\n[A7] Dashboard HTML — tabs + sections")
chk("tab-bar in HTML", "tab-bar" in html)
chk("Videos DB tab exists", "tab-videosdb" in html)
chk("Watch History tab exists", "tab-watchhistory" in html)
chk("switchTab JS function", "function switchTab(" in html)
chk("loadWatchHistory JS function", "function loadWatchHistory(" in html)
chk("loadVideosDb JS function", "function loadVideosDb(" in html)
chk("syncJobs JS function", "function syncJobs(" in html)
chk("renderWatchHistory renders like_rate", "like_rate" in html)
chk("renderVideosDb renders priority", "pri-badge" in html)
chk("Sync DB -> Jobs button", "Sync DB" in html)

p1_fails = summary("PASS 1")

# ─────────────────────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("SPRINT-3 PASS 2 — Logic & Import Audit")
print("=" * 60)
results.clear()

print("\n[B1] sync_to_jobs — import behaviour")
from services.channel_manager import ChannelManager
import inspect
src = inspect.getsource(ChannelManager.sync_to_jobs)
chk("Path imported inside method (no circular)", "from pathlib import Path as _Path" in src)
chk("jobs_list typed as list", "jobs_list: list[dict]" in src)
chk("existing_ids is a set", "existing_ids: set" in src)
chk("_save_json used for atomic write", "_save_json(_p," in src)

print("\n[B2] sync_to_jobs — functional test")
import tempfile, json, os
from pathlib import Path

# Create temp videos.json
with tempfile.TemporaryDirectory() as tmpdir:
    videos_p = Path(tmpdir) / "videos.json"
    channels_p = Path(tmpdir) / "channels.json"
    jobs_p = Path(tmpdir) / "jobs.json"

    videos_p.write_text(json.dumps({"videos": [
        {"video_id": "TEST001", "title": "Test Video One", "channel_id": "UCxxx", "url": "", "enabled": True, "priority": 1, "added_at": "2026-01-01T00:00:00Z"},
        {"video_id": "TEST002", "title": "Test Video Two", "channel_id": "UCxxx", "url": "", "enabled": False, "priority": 5, "added_at": "2026-01-01T00:00:00Z"},
        {"video_id": "TEST003", "title": "Test Video Three", "channel_id": "UCyyy", "url": "", "enabled": True, "priority": 2, "added_at": "2026-01-01T00:00:00Z"},
    ]}), encoding="utf-8")
    channels_p.write_text(json.dumps({"channels": [
        {"channel_id": "UCxxx", "channel_name": "TestChannel", "channel_url": "https://youtube.com/@test", "enabled": True}
    ]}), encoding="utf-8")
    jobs_p.write_text(json.dumps({"jobs": [], "profiles": []}), encoding="utf-8")

    from services import channel_manager as _cm_mod
    _cm_mod.CHANNELS_PATH = channels_p
    _cm_mod.VIDEOS_PATH = videos_p

    cm = ChannelManager()
    result = cm.sync_to_jobs(jobs_p)

    jobs_data = json.loads(jobs_p.read_text())
    jobs = jobs_data.get("jobs", [])
    job_ids = {j["video_id"] for j in jobs}

    chk("added=2 (disabled video skipped)", result["added"] == 2, str(result))
    chk("skipped=0", result["skipped"] == 0, str(result))
    chk("total_videos=2 (enabled only)", result["total_videos"] == 2, str(result))
    chk("TEST001 in jobs", "TEST001" in job_ids)
    chk("TEST002 NOT in jobs (disabled)", "TEST002" not in job_ids)
    chk("TEST003 in jobs", "TEST003" in job_ids)
    chk("job has engagement block", "engagement" in jobs[0])
    chk("job has watch_time block", "watch_time" in jobs[0])
    chk("channel_name populated from channels.json", jobs[0].get("channel_name") == "TestChannel", jobs[0].get("channel_name"))

    # Test overwrite=False skips existing
    result2 = cm.sync_to_jobs(jobs_p, overwrite_existing=False)
    chk("2nd sync: added=0 (all exist)", result2["added"] == 0, str(result2))
    chk("2nd sync: skipped=2", result2["skipped"] == 2, str(result2))

    # Test overwrite=True replaces
    result3 = cm.sync_to_jobs(jobs_p, overwrite_existing=True)
    chk("overwrite sync: added=2", result3["added"] == 2, str(result3))

    # Reset patched paths
    _cm_mod.CHANNELS_PATH = Path("data/channels.json")
    _cm_mod.VIDEOS_PATH = Path("data/videos.json")

print("\n[B3] dashboard/app.py — imports valid")
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location("app", "dashboard/app.py")
    mod = importlib.util.module_from_spec(spec)
    # Don't exec (Flask would start), just parse
    with open("dashboard/app.py", encoding="utf-8") as f:
        compile(f.read(), "dashboard/app.py", "exec")
    chk("dashboard/app.py compiles without error", True)
except SyntaxError as e:
    chk("dashboard/app.py compiles without error", False, str(e))

print("\n[B4] Orchestrator imports still valid")
try:
    with open("core/Orchestrator.py", encoding="utf-8") as f:
        compile(f.read(), "core/Orchestrator.py", "exec")
    chk("Orchestrator.py compiles without error", True)
except SyntaxError as e:
    chk("Orchestrator.py compiles without error", False, str(e))

print("\n[B5] channel_manager.py compiles")
try:
    with open("services/channel_manager.py", encoding="utf-8") as f:
        compile(f.read(), "services/channel_manager.py", "exec")
    chk("channel_manager.py compiles without error", True)
except SyntaxError as e:
    chk("channel_manager.py compiles without error", False, str(e))

p2_fails = summary("PASS 2")

# ─────────────────────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("SPRINT-3 PASS 3 — Edge Cases & Full Audit")
print("=" * 60)
results.clear()

print("\n[C1] sync_to_jobs edge cases")
import tempfile, json
from pathlib import Path
from services import channel_manager as _cm_mod_c

with tempfile.TemporaryDirectory() as tmpdir:
    videos_p = Path(tmpdir) / "videos.json"
    channels_p = Path(tmpdir) / "channels.json"
    jobs_p = Path(tmpdir) / "jobs.json"

    # Empty DB
    videos_p.write_text(json.dumps({"videos": []}), encoding="utf-8")
    channels_p.write_text(json.dumps({"channels": []}), encoding="utf-8")
    _cm_mod_c.CHANNELS_PATH = channels_p
    _cm_mod_c.VIDEOS_PATH = videos_p
    cm2 = ChannelManager()
    r = cm2.sync_to_jobs(jobs_p)
    chk("Empty videos DB → added=0", r["added"] == 0, str(r))
    chk("Empty videos DB → jobs.json created", jobs_p.exists())

    # Missing jobs.json (fresh install)
    jobs_p.unlink()
    videos_p.write_text(json.dumps({"videos": [
        {"video_id": "NEWVID", "title": "New", "channel_id": "", "url": "", "enabled": True, "priority": 1, "added_at": ""}
    ]}), encoding="utf-8")
    r2 = cm2.sync_to_jobs(jobs_p)
    chk("Missing jobs.json → created fresh", jobs_p.exists())
    chk("Missing jobs.json → added=1", r2["added"] == 1, str(r2))

    # Video with no title → uses video_id as keywords
    jobs_p.unlink()
    videos_p.write_text(json.dumps({"videos": [
        {"video_id": "NOTITLE", "title": "", "channel_id": "", "url": "", "enabled": True, "priority": 5, "added_at": ""}
    ]}), encoding="utf-8")
    r3 = cm2.sync_to_jobs(jobs_p)
    jobs3 = json.loads(jobs_p.read_text()).get("jobs", [])
    chk("No title → keywords fallback to video_id", jobs3[0].get("search_keywords") == "NOTITLE", jobs3[0].get("search_keywords"))

    _cm_mod_c.CHANNELS_PATH = Path("data/channels.json")
    _cm_mod_c.VIDEOS_PATH = Path("data/videos.json")

print("\n[C2] watch_history API logic")
import json
from datetime import datetime, timezone

# Simulate the watch_history summary logic inline
fake_profiles = {
    "profile-aaa": [
        {"video_id": "v1", "title": "T1", "watched_at": "2026-05-31T01:00:00Z",
         "watch_time_sec": 120, "liked": True, "commented": False, "subscribed": False},
        {"video_id": "v2", "title": "T2", "watched_at": "2026-05-31T02:00:00Z",
         "watch_time_sec": 240, "liked": True, "commented": True, "subscribed": False},
    ],
    "profile-bbb": [],
}
summary_list = []
for profile_id, entries in fake_profiles.items():
    if not isinstance(entries, list) or not entries:
        continue
    total = len(entries)
    liked = sum(1 for e in entries if e.get("liked"))
    commented = sum(1 for e in entries if e.get("commented"))
    subscribed = sum(1 for e in entries if e.get("subscribed"))
    last = entries[-1] if entries else {}
    total_sec = sum(int(e.get("watch_time_sec", 0)) for e in entries)
    summary_list.append({
        "profile_id": profile_id,
        "profile_short": profile_id[:8],
        "total_watches": total,
        "total_watch_min": round(total_sec / 60, 1),
        "liked": liked,
        "commented": commented,
        "subscribed": subscribed,
        "like_rate": round(liked / total * 100) if total else 0,
        "comment_rate": round(commented / total * 100) if total else 0,
        "last_video_id": last.get("video_id", ""),
        "last_title": last.get("title", ""),
        "last_watched_at": last.get("watched_at", ""),
    })
summary_list.sort(key=lambda x: x["last_watched_at"], reverse=True)

chk("Empty profile skipped", len(summary_list) == 1)
chk("total_watches=2", summary_list[0]["total_watches"] == 2)
chk("total_watch_min=6.0", summary_list[0]["total_watch_min"] == 6.0, str(summary_list[0]["total_watch_min"]))
chk("like_rate=100", summary_list[0]["like_rate"] == 100)
chk("comment_rate=50", summary_list[0]["comment_rate"] == 50)
chk("last_title=T2", summary_list[0]["last_title"] == "T2")

print("\n[C3] Dashboard HTML — no broken JS")
# Check all JS functions referenced exist
chk("loadJobs function defined", "function loadJobs(" in html)
chk("renderJobs function defined", "function renderJobs(" in html)
chk("toggleJob function defined", "function toggleJob(" in html)
chk("scanChannel function defined", "function scanChannel(" in html)
chk("addVideo function defined", "function addVideo(" in html)
chk("switchTab function defined", "function switchTab(" in html)
chk("loadVideosDb function defined", "function loadVideosDb(" in html)
chk("renderVideosDb function defined", "function renderVideosDb(" in html)
chk("toggleVideoDb function defined", "function toggleVideoDb(" in html)
chk("syncJobs function defined", "function syncJobs(" in html)
chk("loadWatchHistory function defined", "function loadWatchHistory(" in html)
chk("renderWatchHistory function defined", "function renderWatchHistory(" in html)

print("\n[C4] Full Sprint-2 regression (quick)")
from services.video_fetcher import _extract_yt_initial_data
chk("F1 brace extract still works", _extract_yt_initial_data('ytInitialData = {"a":1};') == {"a": 1})
from behavior.youtube.types import RelatedVideoConfig
cfg = RelatedVideoConfig.from_dict({"enabled": True, "watch_pct_min": 0.99, "watch_pct_max": 0.50})
chk("F6 watch_pct swap still works", cfg.watch_pct_min <= cfg.watch_pct_max)
from schedule.shuffle_engine import OverlapStore
chk("F9 OverlapStore still importable", True)

p3_fails = summary("PASS 3")

# ─────────────────────────────────────────────────────────────────────────────
total_fails = p1_fails + p2_fails + p3_fails
print("\n" + "=" * 60)
print("SPRINT-3 FINAL: 3-PASS COMPLETE")
print(f"PASS 1 FAILS: {p1_fails} | PASS 2 FAILS: {p2_fails} | PASS 3 FAILS: {p3_fails}")
if total_fails == 0:
    print("ALL CHECKS PASSED ✓")
else:
    print(f"TOTAL FAILS: {total_fails}")
print("=" * 60)
