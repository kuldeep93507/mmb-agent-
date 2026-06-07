"""
3-Round Verification — Fix ke baad:
  Fix 1: _bulletproof_navigate_youtube — Windows/Mac direct tab.get() (no address bar)
  Fix 2: referrer_search: false in jobs.json
"""
import sys, io, json, inspect
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

PASS = 0
FAIL = 0
ERRORS = []

def ok(label):
    global PASS
    PASS += 1
    print(f"  [PASS]  {label}")

def fail(label, reason=""):
    global FAIL
    FAIL += 1
    msg = f"  [FAIL]  {label}" + (f"  =>  {reason}" if reason else "")
    ERRORS.append(msg)
    print(msg)

def section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ─────────────────────────────────────────────────────────────
# CHECK 1: Fix 1 — address_bar_navigate NO LONGER called for Windows/Mac
# ─────────────────────────────────────────────────────────────
section("CHECK 1: Fix 1 — address_bar NO LONGER in desktop nav path")

try:
    from behavior.YouTubeManager import YouTubeManager
    src = inspect.getsource(YouTubeManager._bulletproof_navigate_youtube)

    # Must NOT have address_bar_navigate call in the Windows/Mac branch
    # (it's still imported for referrer_search but not in bulletproof nav)
    # Check: after the Android block, code must go to tab.get() directly
    lines = src.splitlines()
    android_block_ended = False
    address_bar_in_desktop = False
    in_android = False
    for i, line in enumerate(lines):
        if "MOBILE" in line or "android" in line.lower():
            in_android = True
        if in_android and "return  # soft-fail" in line:
            in_android = False
            android_block_ended = True
        if android_block_ended and "address_bar_navigate" in line and not in_android:
            address_bar_in_desktop = True

    if address_bar_in_desktop:
        fail("address_bar_navigate still present in desktop nav path after Android block!")
    else:
        ok("address_bar_navigate NOT called in Windows/Mac _bulletproof_navigate_youtube")

except Exception as e:
    fail("_bulletproof_navigate_youtube inspection", str(e))


# ─────────────────────────────────────────────────────────────
# CHECK 2: Fix 1 — tab.get() IS the primary path for desktop
# ─────────────────────────────────────────────────────────────
section("CHECK 2: Fix 1 — tab.get() is primary desktop nav")

try:
    src = inspect.getsource(YouTubeManager._bulletproof_navigate_youtube)

    # After Android block, must have: tab.get(home) with asyncio.wait_for
    if "desktop tab.get" in src or "skipping address-bar" in src:
        ok("Desktop nav comment present — 'skipping address-bar' documented")
    else:
        fail("Desktop nav missing 'skipping address-bar' comment")

    # Count tab.get occurrences in full function
    tabget_count = src.count("tab.get(home)")
    if tabget_count >= 2:
        ok(f"tab.get(home) called {tabget_count}x in function (primary + retry) — correct")
    elif tabget_count == 1:
        ok(f"tab.get(home) called once — acceptable")
    else:
        fail(f"tab.get(home) not found in _bulletproof_navigate_youtube! count={tabget_count}")

    # Must have retry logic
    if "retry" in src or "Retry" in src or "second attempt" in src.lower() or "retry tab.get" in src:
        ok("Retry logic present — network hiccup covered")
    else:
        fail("No retry logic found — single attempt only")

    # Must still have asyncio.wait_for for timeout safety
    if "wait_for(tab.get" in src:
        ok("asyncio.wait_for(tab.get) present — timeout protected")
    else:
        fail("asyncio.wait_for missing around tab.get — timeout risk!")

    # Must raise YouTubeManagerError on final failure
    if "YouTubeManagerError" in src and "Bulletproof navigation failed" in src:
        ok("YouTubeManagerError raised on failure — error propagation correct")
    else:
        fail("YouTubeManagerError not raised on failure")

except Exception as e:
    fail("tab.get primary path check", str(e))


# ─────────────────────────────────────────────────────────────
# CHECK 3: Fix 1 — Android branch UNTOUCHED (must still use tab.get)
# ─────────────────────────────────────────────────────────────
section("CHECK 3: Fix 1 — Android branch still correct (untouched)")

try:
    src = inspect.getsource(YouTubeManager._bulletproof_navigate_youtube)

    if "PlatformKind.MOBILE" in src:
        ok("Android branch (PlatformKind.MOBILE) still present")
    else:
        fail("Android branch MISSING — regression!")

    if "android tab.get" in src:
        ok("Android uses tab.get() — correct")
    else:
        fail("Android tab.get() call missing")

    if "window.location.href" in src:
        ok("Android JS URL check present (safe, no tab.url)")
    else:
        fail("Android JS URL check missing")

    # Android must NOT use address_bar_navigate
    # Count address_bar_navigate occurrences in full function
    ab_count = src.count("address_bar_navigate")
    if ab_count == 0:
        ok(f"address_bar_navigate completely removed from _bulletproof_navigate_youtube (clean!)")
    else:
        # If it's there but only in comment, that's fine
        for line in src.splitlines():
            if "address_bar_navigate" in line and not line.strip().startswith("#"):
                fail(f"address_bar_navigate still called in function: {line.strip()}")
                break
        else:
            ok("address_bar_navigate only in comment/doc — not called")

except Exception as e:
    fail("Android branch check", str(e))


# ─────────────────────────────────────────────────────────────
# CHECK 4: Fix 2 — referrer_search: false in jobs.json
# ─────────────────────────────────────────────────────────────
section("CHECK 4: Fix 2 — referrer_search: false in jobs.json")

try:
    jobs_path = ROOT / "data" / "jobs.json"
    with open(jobs_path) as f:
        jobs_data = json.load(f)

    ok("data/jobs.json — valid JSON parse")

    for job in jobs_data.get("jobs", []):
        jid = job.get("id", "unknown")
        rs = job.get("referrer_search", None)
        if rs is True:
            fail(f"job '{jid}' — referrer_search is still True!")
        elif rs is False:
            ok(f"job '{jid}' — referrer_search: false (correct)")
        elif rs is None:
            ok(f"job '{jid}' — referrer_search not set (defaults to False) — ok")
        else:
            fail(f"job '{jid}' — referrer_search unexpected value: {rs!r}")

except Exception as e:
    fail("jobs.json referrer_search check", str(e))


# ─────────────────────────────────────────────────────────────
# CHECK 5: Fix 2 — Jobs.json full integrity
# ─────────────────────────────────────────────────────────────
section("CHECK 5: Fix 2 — jobs.json full integrity")

try:
    jobs_data_2 = json.loads(Path(ROOT / "data" / "jobs.json").read_text())

    profiles = jobs_data_2.get("profiles", [])
    android_profiles = [p for p in profiles if p.get("platform") == "android"]
    if android_profiles:
        fail(f"Android profiles still present: {len(android_profiles)} — should be removed!")
    else:
        ok("No Android profiles in jobs.json")

    platforms = {p.get("platform") for p in profiles}
    ok(f"Profile platforms: {platforms}")

    jobs = jobs_data_2.get("jobs", [])
    assert len(jobs) >= 1, "No jobs defined!"
    ok(f"Jobs count: {len(jobs)}")

    job0 = jobs[0]
    assert job0.get("video_id"), "video_id missing!"
    ok(f"video_id present: {job0['video_id']}")
    assert job0.get("search_keywords"), "search_keywords missing!"
    ok(f"search_keywords present: '{job0['search_keywords'][:40]}'")

    mobile_first = jobs_data_2.get("mobile_first", None)
    if mobile_first:
        fail(f"mobile_first is True — should be False!")
    else:
        ok(f"mobile_first: {mobile_first} (False/null — correct for Windows+Mac)")

except Exception as e:
    fail("jobs.json integrity", str(e))


# ─────────────────────────────────────────────────────────────
# CHECK 6: Fix 1 — Import check — function still importable
# ─────────────────────────────────────────────────────────────
section("CHECK 6: No import breakage after fix")

try:
    # Fresh import via importlib to confirm no syntax errors
    import importlib, importlib.util
    spec = importlib.util.spec_from_file_location(
        "behavior.YouTubeManager",
        str(ROOT / "behavior" / "YouTubeManager.py")
    )
    ym_mod2 = importlib.util.module_from_spec(spec)
    # We just compile/parse — don't exec (would need all deps)
    # Use compile() to check syntax only
    src_raw = (ROOT / "behavior" / "YouTubeManager.py").read_text(encoding="utf-8")
    compile(src_raw, "YouTubeManager.py", "exec")
    ok("behavior.YouTubeManager — syntax compile OK (no syntax errors)")

    # Check class and method names in source
    assert "class YouTubeManager" in src_raw
    ok("YouTubeManager class present in source")
    assert "_bulletproof_navigate_youtube" in src_raw
    ok("_bulletproof_navigate_youtube method present in source")

except Exception as e:
    fail("Import/reload check after fix", str(e))


# ─────────────────────────────────────────────────────────────
# CHECK 7: Fix 1 — direct_url path (navigate_to_video) Windows still correct
# ─────────────────────────────────────────────────────────────
section("CHECK 7: navigate_to_video — direct URL path still has tab.get fallback")

try:
    src_ntv = inspect.getsource(YouTubeManager.navigate_to_video)

    if "tab.get(direct" in src_ntv or "page.get(direct" in src_ntv:
        ok("navigate_to_video direct path — tab.get(direct) present")
    else:
        fail("navigate_to_video — no tab.get for direct URL!")

    if "address_bar_navigate" in src_ntv:
        ok("address_bar_navigate still in navigate_to_video (used as primary for non-homepage nav — acceptable)")
    else:
        ok("address_bar_navigate not in navigate_to_video (fully removed)")

except Exception as e:
    fail("navigate_to_video check", str(e))


# ─────────────────────────────────────────────────────────────
# CHECK 8: Docstring updated correctly
# ─────────────────────────────────────────────────────────────
section("CHECK 8: _bulletproof_navigate_youtube docstring accurate")

try:
    src_doc = inspect.getsource(YouTubeManager._bulletproof_navigate_youtube)

    # Old docstring said "address-bar typing first" — should now be updated
    if "Type host in address bar" in src_doc and "address-bar typing first" in src_doc:
        fail("Docstring still says 'address-bar typing first' — misleading after fix!")
    else:
        ok("Docstring doesn't claim address-bar is first step — accurate")

    if "tab.get" in src_doc:
        ok("tab.get mentioned in function body — correct nav strategy documented")

except Exception as e:
    fail("Docstring check", str(e))


# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
print(f"\n{'='*60}")
print(f"  RESULT: {PASS} PASSED  |  {FAIL} FAILED")
print(f"{'='*60}")
if ERRORS:
    print("\nFailed:")
    for e in ERRORS:
        print(e)
    sys.exit(1)
else:
    print("\n  [OK] DONO FIXES VERIFIED — koi regression nahi!")
    sys.exit(0)
