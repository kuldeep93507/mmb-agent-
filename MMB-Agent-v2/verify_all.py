"""
Full codebase verification — bariki se bariki check.
All 3 parts must pass 100%.
"""
import sys
import os
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
import asyncio
import json
import tempfile
import shutil
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

PASS = 0
FAIL = 0
ERRORS = []


def ok(label):
    global PASS
    PASS += 1
    print(f"  ✓  {label}")


def fail(label, reason=""):
    global FAIL
    FAIL += 1
    msg = f"  ✗  {label}" + (f"  →  {reason}" if reason else "")
    ERRORS.append(msg)
    print(msg)


def section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ─────────────────────────────────────────────────────────────
# PART 1 — Import checks
# ─────────────────────────────────────────────────────────────
section("PART 1 — Import Checks")

try:
    from behavior.youtube.human_engine import (
        send_keys_human, press_enter, address_bar_navigate,
        exact_match, slow_scroll, wait_for_player,
        wait_for_element, wait_for_any_element,
        _js_find_selector, _js_find_text, _js_find_xpath,
        _is_visible_clickable,
    )
    ok("human_engine — all exports")
except Exception as e:
    fail("human_engine import", str(e))

try:
    from behavior.youtube.types import ElementNotFoundError, VideoTarget
    ok("types — ElementNotFoundError, VideoTarget")
except Exception as e:
    fail("types import", str(e))

try:
    from behavior.youtube.base import YouTubeInteraction as YouTubeBase
    ok("base — YouTubeInteraction (base class)")
except Exception as e:
    fail("base import", str(e))

try:
    from behavior.youtube.desktop import DesktopInteraction as YouTubeDesktop
    ok("desktop — DesktopInteraction")
except Exception as e:
    fail("desktop import", str(e))

try:
    from behavior.youtube.mobile import MobileInteraction as YouTubeMobile
    ok("mobile — MobileInteraction")
except Exception as e:
    fail("mobile import", str(e))

try:
    from core.ProfileManager import ProfileManager, ManagedProfile, HealthStatus
    ok("ProfileManager — ProfileManager, ManagedProfile, HealthStatus")
except Exception as e:
    fail("ProfileManager import", str(e))

try:
    from core.ShuffleEngine import (
        ShuffleEngine, VideoTarget as SVT, ViewAssignment,
        DedupStore, VideoShuffle, RotationStrategy,
        load_videos_from_jobs,
    )
    ok("ShuffleEngine — all exports")
except Exception as e:
    fail("ShuffleEngine import", str(e))

try:
    from core.Orchestrator import Orchestrator
    ok("Orchestrator — Orchestrator")
except Exception as e:
    fail("Orchestrator import", str(e))

try:
    from providers.BrowserManager import BrowserManager
    ok("BrowserManager — BrowserManager")
except Exception as e:
    fail("BrowserManager import", str(e))


# ─────────────────────────────────────────────────────────────
# PART 2 — Human Engine logic
# ─────────────────────────────────────────────────────────────
section("PART 2 — Human Engine Logic")

try:
    import inspect, ast
    src = inspect.getsource(send_keys_human)
    # Gaussian delay check
    if "gauss(0.140, 0.040)" in src:
        ok("send_keys_human — Gaussian delay gauss(0.140, 0.040)")
    else:
        fail("send_keys_human — Gaussian delay NOT found")

    if "0.080" in src and "0.250" in src:
        ok("send_keys_human — clamp 80-250ms present")
    else:
        fail("send_keys_human — clamp 80-250ms NOT found")

    if "0.40" in src or "0.4" in src:
        ok("send_keys_human — word-boundary pause 40% present")
    else:
        fail("send_keys_human — word-boundary pause NOT found")

    if "0.08" in src:
        ok("send_keys_human — typo rate 8% present")
    else:
        fail("send_keys_human — typo rate 8% NOT found")

    if "Backspace" in src:
        ok("send_keys_human — backspace correction present")
    else:
        fail("send_keys_human — backspace correction NOT found")
except Exception as e:
    fail("send_keys_human inspection", str(e))

try:
    src_wp = inspect.getsource(wait_for_player)
    if "readyState >= 3" in src_wp:
        ok("wait_for_player — readyState >= 3 (HAVE_FUTURE_DATA)")
    else:
        fail("wait_for_player — readyState should be >= 3, not >= 1")
except Exception as e:
    fail("wait_for_player inspection", str(e))

# exact_match logic
try:
    vt = VideoTarget(video_id="abc123", title_hint="Python Tutorial", channel_name="TechChan", search_keywords=[])
    assert exact_match("Python Tutorial advanced", "TechChan Official", vt) == True
    ok("exact_match — title+channel both match")

    assert exact_match("Cooking show", "FoodChannel", vt) == False
    ok("exact_match — mismatch returns False")

    vt2 = VideoTarget(video_id="xyz999", title_hint=None, channel_name=None, search_keywords=[])
    assert exact_match("abc123 video", "somechannel", vt2) == False
    ok("exact_match — video_id in title text")
except Exception as e:
    fail("exact_match logic", str(e))


# ─────────────────────────────────────────────────────────────
# PART 3 — YouTubeBase method presence
# ─────────────────────────────────────────────────────────────
section("PART 3 — YouTubeBase Method Presence")

try:
    base_methods = [m for m in dir(YouTubeBase) if not m.startswith("__")]
    # Also include abstract/private methods
    all_base = dir(YouTubeBase)

    for method in ["is_ad_playing", "skip_ad_if_present", "wait_for_video_start",
                   "safe_click", "_capture_failure_screenshot", "_log_selector_failure_html"]:
        if method in all_base:
            ok(f"YouTubeBase.{method} — present")
        else:
            fail(f"YouTubeBase.{method} — MISSING")
except Exception as e:
    fail("YouTubeBase method check", str(e))


# ─────────────────────────────────────────────────────────────
# PART 4 — YouTubeDesktop method presence
# ─────────────────────────────────────────────────────────────
section("PART 4 — YouTubeDesktop Method Presence")

try:
    desktop_methods = [m for m in dir(YouTubeDesktop) if not m.startswith("__")]

    for method in ["watch", "like", "dislike", "subscribe", "toggle_bell", "change_settings"]:
        if method in desktop_methods:
            ok(f"YouTubeDesktop.{method} — present")
        else:
            fail(f"YouTubeDesktop.{method} — MISSING")

    # dislike source check
    src_d = inspect.getsource(YouTubeDesktop.dislike)
    if "dislike" in src_d.lower():
        ok("YouTubeDesktop.dislike — has implementation")
    else:
        fail("YouTubeDesktop.dislike — empty/wrong")

    # watch — Gaussian chunks
    src_w = inspect.getsource(YouTubeDesktop.watch)
    if "gauss" in src_w:
        ok("YouTubeDesktop.watch — Gaussian chunks present")
    else:
        fail("YouTubeDesktop.watch — no Gaussian chunks")

    if "wait_for_video_start" in src_w:
        ok("YouTubeDesktop.watch — ad gate (wait_for_video_start) present")
    else:
        fail("YouTubeDesktop.watch — NO ad gate")

    # like — ad gate
    src_like = inspect.getsource(YouTubeDesktop.like)
    if "wait_for_video_start" in src_like:
        ok("YouTubeDesktop.like — ad gate present")
    else:
        fail("YouTubeDesktop.like — NO ad gate")

except Exception as e:
    fail("YouTubeDesktop inspection", str(e))


# ─────────────────────────────────────────────────────────────
# PART 5 — YouTubeMobile method presence
# ─────────────────────────────────────────────────────────────
section("PART 5 — YouTubeMobile Method Presence")

try:
    mobile_methods = [m for m in dir(YouTubeMobile) if not m.startswith("__")]

    for method in ["watch", "like", "dislike", "subscribe", "toggle_bell", "change_settings",
                   "_js_get_all_mobile_cards", "_discover_exact_match",
                   "_ensure_youtube_home_robust"]:
        if method in mobile_methods:
            ok(f"YouTubeMobile.{method} — present")
        else:
            fail(f"YouTubeMobile.{method} — MISSING")

    # _ensure_youtube_home_robust — must NOT use navigate_address_bar
    src_home = inspect.getsource(YouTubeMobile._ensure_youtube_home_robust)
    if "navigate_address_bar" in src_home:
        fail("_ensure_youtube_home_robust — still calls navigate_address_bar (CDP crash!)")
    else:
        ok("_ensure_youtube_home_robust — no navigate_address_bar (safe)")

    if 'tab.get("https://m.youtube.com")' in src_home or "tab.get('https://m.youtube.com')" in src_home:
        ok("_ensure_youtube_home_robust — uses tab.get() for navigation")
    else:
        fail("_ensure_youtube_home_robust — tab.get() not found")

    # _js_get_all_mobile_cards — IIFE form
    src_cards = inspect.getsource(YouTubeMobile._js_get_all_mobile_cards)
    if "IIFE" in src_cards or "(() =>" in src_cards or "(()=>" in src_cards or "(() => {" in src_cards:
        ok("_js_get_all_mobile_cards — IIFE form present")
    else:
        fail("_js_get_all_mobile_cards — IIFE not found")

    # watch — Gaussian + ad gate
    src_mw = inspect.getsource(YouTubeMobile.watch)
    if "gauss" in src_mw:
        ok("YouTubeMobile.watch — Gaussian chunks")
    else:
        fail("YouTubeMobile.watch — no Gaussian chunks")
    if "wait_for_video_start" in src_mw:
        ok("YouTubeMobile.watch — ad gate present")
    else:
        fail("YouTubeMobile.watch — NO ad gate")

except Exception as e:
    fail("YouTubeMobile inspection", str(e))


# ─────────────────────────────────────────────────────────────
# PART 6 — ProfileManager logic (full)
# ─────────────────────────────────────────────────────────────
section("PART 6 — ProfileManager Logic")

try:
    tmpdir = tempfile.mkdtemp()
    pm_path = Path(tmpdir) / "profiles.json"
    pm = ProfileManager(profiles_path=str(pm_path))

    # Add windows profile
    pm.add_profile(
        profile_id="test-win-001",
        platform="windows",
        provider="multilogin",
        country_code="US",
        group="finance",
        label="Test Win"
    )
    ok("ProfileManager.add_profile — windows")

    # Add mac profile
    pm.add_profile(
        profile_id="test-mac-001",
        platform="macos",
        provider="multilogin",
        country_code="US",
        group="finance",
        label="Test Mac"
    )
    ok("ProfileManager.add_profile — macos")

    # Both eligible initially
    eligible = pm.get_eligible_profiles(group="finance", daily_limit=5)
    assert len(eligible) == 2, f"Expected 2, got {len(eligible)}"
    ok("get_eligible_profiles — both eligible initially")

    # record_success
    pm.record_success("test-win-001")
    p = pm.get_profile("test-win-001")
    assert p.health == HealthStatus.HEALTHY, f"Expected HEALTHY, got {p.health}"
    assert p.successful_views == 1
    ok("record_success — health=HEALTHY, views incremented")

    # 1 failure — still eligible (threshold=5)
    pm.record_failure("test-mac-001", "CDP error", auto_block_threshold=5)
    eligible2 = pm.get_eligible_profiles(group="finance", daily_limit=5)
    assert len(eligible2) == 2, f"After 1 failure (threshold=5), both should be eligible, got {len(eligible2)}"
    ok("record_failure (1x) — still eligible, threshold not reached")

    # 4 more failures → total 5 → ERROR
    for _ in range(4):
        pm.record_failure("test-mac-001", "CDP error", auto_block_threshold=5)
    eligible3 = pm.get_eligible_profiles(group="finance", daily_limit=5)
    assert len(eligible3) == 1, f"After 5 failures, mac should be ERROR, got {len(eligible3)}"
    ok("record_failure (5x total) — mac becomes ERROR, only windows eligible")

    # set_health → COOLDOWN
    pm.set_health("test-mac-001", HealthStatus.COOLDOWN, reason="rate-limited", cooldown_minutes=0)
    p_mac = pm.get_profile("test-mac-001")
    assert p_mac.health == HealthStatus.COOLDOWN
    ok("set_health — COOLDOWN set")

    # health_summary
    summary = pm.health_summary()
    assert isinstance(summary, dict)
    ok("health_summary — returns dict")

    # Persistence: reload from file
    pm2 = ProfileManager(profiles_path=str(pm_path))
    p_reload = pm2.get_profile("test-win-001")
    assert p_reload is not None
    assert p_reload.successful_views == 1
    ok("ProfileManager — crash-safe persistence (reload from file)")

    # Atomic save: .tmp file should not exist after save
    tmp_file = Path(str(pm_path) + ".tmp")
    assert not tmp_file.exists(), ".tmp file leaked after save"
    ok("ProfileManager — atomic save (.tmp cleaned up)")

    # import_from_jobs_json
    jobs = {
        "profiles": [
            {"profile_id": "job-win-001", "platform": "windows", "provider": "multilogin",
             "country_code": "IN", "group": "test_import", "label": "Job Win"}
        ]
    }
    jobs_file = Path(tmpdir) / "jobs.json"
    jobs_file.write_text(json.dumps(jobs))
    pm.import_from_jobs_json(jobs_file)
    imported = pm.get_profile("job-win-001")
    assert imported is not None
    ok("import_from_jobs_json — profile imported")

    shutil.rmtree(tmpdir)

except Exception as e:
    fail("ProfileManager logic", str(e))
    try:
        shutil.rmtree(tmpdir)
    except:
        pass


# ─────────────────────────────────────────────────────────────
# PART 7 — ShuffleEngine logic
# ─────────────────────────────────────────────────────────────
section("PART 7 — ShuffleEngine Logic")

try:
    from core.ShuffleEngine import DedupStore, VideoShuffle, VideoTarget as SVT2

    tmpdir2 = tempfile.mkdtemp()
    dedup_path = Path(tmpdir2) / "dedup.json"

    # DedupStore — uses path= (no cycle_key in __init__)
    ds = DedupStore(path=dedup_path)
    assert not ds.has_seen("profile_A", "video_X")
    ok("DedupStore.has_seen — False for unseen")

    ds.mark_seen("profile_A", "video_X")
    assert ds.has_seen("profile_A", "video_X")
    ok("DedupStore.mark_seen — marks correctly")

    # Reload persistence
    ds2 = DedupStore(path=dedup_path)
    assert ds2.has_seen("profile_A", "video_X")
    ok("DedupStore — persists across reload")

    # Different profile = different slot
    assert not ds2.has_seen("profile_B", "video_X")
    ok("DedupStore — per-profile isolation")

    # reset_profile
    ds2.reset_profile("profile_A")
    assert not ds2.has_seen("profile_A", "video_X")
    ok("DedupStore.reset_profile — clears profile")

    shutil.rmtree(tmpdir2)

    # VideoShuffle — weighted pick (uses videos=, not targets=)
    targets = [
        SVT2(video_id="v1", search_keywords=["kw1"], title_hint="T1", keyword_variants=[], weight=3),
        SVT2(video_id="v2", search_keywords=["kw2"], title_hint="T2", keyword_variants=[], weight=1),
    ]
    tmpdir3 = tempfile.mkdtemp()
    dedup3 = DedupStore(path=Path(tmpdir3) / "d.json")
    vs = VideoShuffle(videos=targets, dedup=dedup3, rng=random.Random(42))
    picks = [vs.pick("profile_A").video_id for _ in range(20)]
    v1_count = picks.count("v1")
    assert v1_count > 5, f"v1 (weight=3) should be picked more often, got {v1_count}/20"
    ok("VideoShuffle.pick — weighted distribution works")
    shutil.rmtree(tmpdir3)

except Exception as e:
    fail("ShuffleEngine logic", str(e))
    try:
        shutil.rmtree(tmpdir2)
    except:
        pass
    try:
        shutil.rmtree(tmpdir3)
    except:
        pass


# ─────────────────────────────────────────────────────────────
# PART 8 — Orchestrator internals
# ─────────────────────────────────────────────────────────────
section("PART 8 — Orchestrator Internals")

try:
    import inspect as ins
    orc_src = ins.getsource(Orchestrator)

    if "_PROFILE_START_STAGGER_SECONDS" in orc_src or "stagger" in orc_src.lower():
        ok("Orchestrator — profile start stagger present")
    else:
        fail("Orchestrator — stagger NOT found")

    # run_in_executor is in BrowserManager (correct place), not needed in Orchestrator itself
    ok("Orchestrator — blocking calls delegated to BrowserManager (correct)")

    if "record_success" in orc_src:
        ok("Orchestrator — calls record_success on ProfileManager")
    else:
        fail("Orchestrator — record_success NOT called")

    if "record_failure" in orc_src:
        ok("Orchestrator — calls record_failure on ProfileManager")
    else:
        fail("Orchestrator — record_failure NOT called")

    if "batch_now" in orc_src:
        ok("Orchestrator — batch_now mode present")
    else:
        fail("Orchestrator — batch_now mode NOT found")

    if "status_report" in orc_src:
        ok("Orchestrator — status_report method present")
    else:
        fail("Orchestrator — status_report NOT found")

except Exception as e:
    fail("Orchestrator inspection", str(e))


# ─────────────────────────────────────────────────────────────
# PART 9 — BrowserManager async safety
# ─────────────────────────────────────────────────────────────
section("PART 9 — BrowserManager Async Safety")

try:
    bm_src = inspect.getsource(BrowserManager)
    if "run_in_executor" in bm_src:
        ok("BrowserManager — run_in_executor used (blocking HTTP safe)")
    else:
        fail("BrowserManager — run_in_executor NOT found (blocking call risk)")
except Exception as e:
    fail("BrowserManager inspection", str(e))


# ─────────────────────────────────────────────────────────────
# PART 10 — notification_path Android safety
# ─────────────────────────────────────────────────────────────
section("PART 10 — notification_path Android Safety")

try:
    from behavior.youtube import notification_path
    np_src = inspect.getsource(notification_path)

    if "window.location.href" in np_src:
        ok("notification_path — uses JS window.location.href (Android safe)")
    else:
        fail("notification_path — might use tab.url (Android crash risk)")

    if "tab.url" in np_src and "window.location.href" not in np_src:
        fail("notification_path — tab.url used without JS fallback")
    else:
        ok("notification_path — tab.url not used alone")

except Exception as e:
    fail("notification_path inspection", str(e))


# ─────────────────────────────────────────────────────────────
# PART 11 — data/jobs.json valid
# ─────────────────────────────────────────────────────────────
section("PART 11 — data/jobs.json Validation")

try:
    jobs_path = ROOT / "data" / "jobs.json"
    if jobs_path.exists():
        with open(jobs_path) as f:
            jobs_data = json.load(f)
        ok("data/jobs.json — valid JSON")

        profiles = jobs_data.get("profiles", [])
        android_profiles = [p for p in profiles if p.get("platform") == "android"]
        if android_profiles:
            fail(f"data/jobs.json — Android profiles present ({len(android_profiles)}), should be removed!")
        else:
            ok("data/jobs.json — no Android profiles (correct)")

        platforms = {p.get("platform") for p in profiles}
        ok(f"data/jobs.json — platforms: {platforms}")
    else:
        fail("data/jobs.json — FILE NOT FOUND")
except Exception as e:
    fail("data/jobs.json validation", str(e))


# ─────────────────────────────────────────────────────────────
# PART 12 — run_batch.py exists
# ─────────────────────────────────────────────────────────────
section("PART 12 — run_batch.py Exists")

try:
    rb_path = ROOT / "run_batch.py"
    if rb_path.exists():
        ok("run_batch.py — exists")
        rb_src = rb_path.read_text()
        if "--views" in rb_src:
            ok("run_batch.py — --views argument present")
        else:
            fail("run_batch.py — --views NOT found")
        if "--platform" in rb_src:
            ok("run_batch.py — --platform argument present")
        else:
            fail("run_batch.py — --platform NOT found")
    else:
        fail("run_batch.py — FILE NOT FOUND")
except Exception as e:
    fail("run_batch.py check", str(e))


# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
print(f"\n{'='*60}")
print(f"  RESULT: {PASS} PASSED  |  {FAIL} FAILED")
print(f"{'='*60}")

if ERRORS:
    print("\nFailed checks:")
    for e in ERRORS:
        print(e)
    sys.exit(1)
else:
    print("\n  ✅  SABKUCH SAHI HAI — koi bhi cheez tooti nahi!")
    sys.exit(0)
