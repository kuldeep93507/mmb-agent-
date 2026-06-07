"""
Sprint-1 Live Smoke Test
========================
Profile : c58a40dc-d6ff-4234-8d26-a592804d32ea  (Windows)
Video   : KjNyAVwtAUg  (best credit cards 2026)

Step 0  : Proxy REMOVE karo Multilogin API se (No proxy mode)
Step A  : Browser open — new tab fallback if main tab stuck
Step B  : YouTube load verify
Step C  : Video navigate
Step D  : WatchTimeConfig.resolve() test
Step E-H: watch_video() Sprint-1 path (60s smoke)
Step I  : Close session cleanly
"""

import asyncio, sys, io, json, logging, time, os, requests
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

# ── Config ───────────────────────────────────────────────────────────────────
PROFILE_ID   = "c58a40dc-d6ff-4234-8d26-a592804d32ea"
PROFILE_PLAT = "windows"
VIDEO_ID     = "KjNyAVwtAUg"
CHANNEL_NAME = "ULTRAPLAY8"
CHANNEL_ID   = "UCNxO4SBckt-vI9VPazA_4Iw"
# Exact title from RSS — sabse reliable search keyword
KEYWORDS     = "Best Credit Card 2026 My 1000 monthly earn strategy"
TITLE_HINT   = "Best Credit Card 2026-My 1000$ monthly earn strategy"
SMOKE_WATCH  = 60.0   # sirf 60s watch for test

ML_TOKEN     = os.getenv("MULTILOGIN_TOKEN", "")
ML_FOLDER    = os.getenv("MULTILOGIN_FOLDER_ID", "")
ML_BASE      = "https://launcher.mlx.yt:45001"
ML_API_BASE  = "https://api.multilogin.com"

# ── Result tracking ───────────────────────────────────────────────────────────
PASS = 0; FAIL = 0; log_lines = []

def tick(name, ok, detail=""):
    global PASS, FAIL
    sym = "✅" if ok else "❌"
    if ok: PASS += 1
    else:
        FAIL += 1
        log_lines.append(f"FAIL: {name}" + (f" → {detail}" if detail else ""))
    print(f"  {sym} {name}" + (f"  [{detail}]" if detail else ""))

def sep(title):
    print(f"\n{'='*62}")
    print(f"  {title}")
    print(f"{'='*62}")

# Patch YTM logger to stdout
yt_logger = logging.getLogger("mmb.youtube_universal")
yt_logger.setLevel(logging.DEBUG)
if not any(isinstance(h, logging.StreamHandler) for h in yt_logger.handlers):
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(logging.Formatter("  [YTM] %(message)s"))
    yt_logger.addHandler(ch)

# ── Step 0: Remove Proxy via Multilogin API ───────────────────────────────────
def remove_proxy_from_profile(profile_id: str) -> bool:
    """
    Multilogin X API: profile ki proxy ko 'No proxy' pe set karo.
    Endpoint: PUT https://api.multilogin.com/profile/custom
    Body: { "browser_profile_id": "...", "proxy": { "type": "No proxy" } }
    """
    # Try the newer cloud API first
    url = f"{ML_API_BASE}/profile/custom"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ML_TOKEN}",
    }
    payload = {
        "browser_profile_id": profile_id,
        "proxy": {
            "type": "No proxy",
        }
    }
    try:
        resp = requests.put(url, headers=headers, json=payload, timeout=15)
        print(f"  [Proxy API] status={resp.status_code}  body={resp.text[:200]}")
        if resp.status_code in (200, 204):
            return True
    except Exception as e:
        print(f"  [Proxy API] cloud PUT failed: {e}")

    # Try launcher API (local MLX agent)
    url2 = f"{ML_BASE}/api/v1/profile/{profile_id}"
    payload2 = {
        "parameters": {
            "proxy": {
                "type": "No proxy"
            }
        }
    }
    try:
        headers2 = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ML_TOKEN}",
        }
        resp2 = requests.patch(url2, headers=headers2, json=payload2, timeout=15)
        print(f"  [Proxy API launcher] status={resp2.status_code}  body={resp2.text[:200]}")
        if resp2.status_code in (200, 204):
            return True
    except Exception as e:
        print(f"  [Proxy API launcher] failed: {e}")

    return False


# ── Main async test ────────────────────────────────────────────────────────────
async def run_smoke_test():
    from behavior.YouTubeManager import YouTubeManager
    from behavior.youtube.types  import (
        VideoTarget, WatchTimeConfig, EngagementConfig, WatchTimeMode
    )

    # Load Sprint-1 config
    jobs_cfg   = json.load(open(ROOT / "data" / "jobs.json", encoding="utf-8"))
    job_raw    = jobs_cfg["jobs"][0]
    eng_config = EngagementConfig.from_dict(job_raw["engagement"])
    wt_config  = WatchTimeConfig.from_dict(job_raw["watch_time"])
    smoke_wt   = WatchTimeConfig(mode="fixed", fixed_seconds=SMOKE_WATCH)

    print("=" * 62)
    print("  MMB Sprint-1 LIVE SMOKE TEST")
    print(f"  Profile : {PROFILE_ID[:8]}...  ({PROFILE_PLAT})")
    print(f"  Video   : {VIDEO_ID}")
    print(f"  Watch   : {SMOKE_WATCH:.0f}s (smoke override, real mode={wt_config.mode})")
    print(f"  Templates: {len(eng_config.comment_templates)} loaded")
    print("=" * 62)

    # ── Step 0: Remove proxy ─────────────────────────────────────────────────
    sep("STEP 0: Remove Proxy from Profile (No Proxy mode)")
    proxy_removed = remove_proxy_from_profile(PROFILE_ID)
    tick("Proxy set to 'No proxy' via Multilogin API", proxy_removed,
         "API call failed — may still work if profile already has no proxy")
    if not proxy_removed:
        print("  ⚠️  Proxy removal API failed — continuing anyway.")
        print("  ⚠️  Please manually set proxy=None in Multilogin UI if test fails.")

    await asyncio.sleep(2.0)  # let Multilogin save the change

    # ── Step A: Open session ─────────────────────────────────────────────────
    sep("STEP A: Open Browser Session")
    manager = None
    tab     = None
    t0      = time.monotonic()

    try:
        manager = YouTubeManager(
            profile_id=PROFILE_ID,
            profile_platform=PROFILE_PLAT,
        )
        tab = await manager.open_session()
        elapsed = time.monotonic() - t0
        tick("Session opened (main tab)", tab is not None, f"{elapsed:.1f}s")
    except Exception as e:
        tick("Session opened", False, str(e)[:120])
        print("\n  ❌ Browser failed to open. Aborting.")
        return

    # ── New Tab Fallback: agar main tab stuck hai to new tab kholo ───────────
    sep("STEP A2: Tab Health Check + New Tab Fallback")
    try:
        url_check, _ = await manager._read_page_state(tab)
        is_stuck = not url_check or url_check in ("about:blank", "chrome://newtab/")
        print(f"  Current tab URL: {url_check!r}")

        if is_stuck:
            print("  ⚠️  Main tab stuck/blank — opening new tab...")
            try:
                # nodriver: new tab via browser.get() on new tab
                new_tab = await manager._browser.get("about:blank")
                await asyncio.sleep(1.5)
                tab = new_tab
                manager._tab = new_tab
                # Rebuild strategy context with new tab
                print("  ✅ New tab opened — switching to it")
                tick("New tab fallback worked", True)
            except Exception as te:
                tick("New tab fallback", False, str(te)[:80])
        else:
            tick("Main tab healthy (no fallback needed)", True, f"url={url_check[:50]!r}")
    except Exception as e:
        tick("Tab health check", False, str(e)[:80])

    # ── Step B: YouTube homepage ──────────────────────────────────────────────
    sep("STEP B: YouTube Homepage Load")
    try:
        url, _ = await manager._read_page_state(tab)
        on_yt  = "youtube.com" in (url or "")
        tick("On youtube.com", on_yt, f"url={url[:60]!r}")

        has_bar = await manager._has_search_bar(tab)
        tick("Search bar visible", has_bar)

        if not on_yt or not has_bar:
            print("  ⚠️  Not on YouTube — forcing navigation...")
            await manager._bulletproof_navigate_youtube(tab, context="smoke_step_b")
            await manager._require_youtube_homepage(tab, context="smoke_step_b")
            url2, _ = await manager._read_page_state(tab)
            tick("YouTube loaded after force nav", "youtube.com" in url2, url2[:50])
    except Exception as e:
        tick("YouTube homepage", False, str(e)[:80])

    # ── Step C: Navigate to video ─────────────────────────────────────────────
    sep("STEP C: Navigate to Target Video")
    route = None
    try:
        target = VideoTarget(
            video_id=VIDEO_ID,
            channel_name=CHANNEL_NAME,
            search_keywords=KEYWORDS,
            title_hint=TITLE_HINT,
        )
        t1    = time.monotonic()
        route = await manager.navigate_to_video(tab, target)
        nav_t = time.monotonic() - t1

        url_after, _ = await manager._read_page_state(tab)
        on_watch   = "/watch" in (url_after or "")
        vid_in_url = VIDEO_ID in (url_after or "")

        tick(f"Route = {route!r}", bool(route))
        tick("Landed on /watch", on_watch, f"url={url_after[:70]!r}")
        tick(f"video_id={VIDEO_ID} in URL", vid_in_url)
        tick(f"Nav < 120s", nav_t < 120, f"{nav_t:.1f}s")
    except Exception as e:
        tick("Navigate to video", False, str(e)[:120])
        print("\n  ❌ Navigation failed — skipping watch test.")
        try:
            await manager.close_session()
        except Exception:
            pass
        return

    # ── Step D: WatchTimeConfig ────────────────────────────────────────────────
    sep("STEP D: Sprint-1 WatchTimeConfig.resolve()")
    try:
        import random
        dur = await manager._strategy.get_video_duration(tab)
        planned_smart = wt_config.resolve(dur, random.Random(42))
        planned_smoke = smoke_wt.resolve(dur, random.Random(42))

        tick("Video duration > 0", dur > 0, f"{dur:.0f}s")
        tick("Smart resolve in 40-60% range",
             0.38 <= (planned_smart / max(dur, 1)) <= 0.62,
             f"planned={planned_smart:.0f}s = {100*planned_smart/max(dur,1):.0f}%")
        tick("Smoke fixed = 60.0s", planned_smoke == 60.0, f"got {planned_smoke:.1f}s")

        print(f"\n  📌 If real run: would watch {planned_smart:.0f}s of {dur:.0f}s"
              f" ({100*planned_smart/max(dur,1):.0f}%)")
        print(f"  📌 Smoke test watches: {planned_smoke:.0f}s only")
    except Exception as e:
        tick("WatchTimeConfig test", False, str(e)[:80])

    # ── Step E-H: watch_video() Sprint-1 ──────────────────────────────────────
    sep("STEP E-H: watch_video() Sprint-1 (60s)")
    print("  [autoplay OFF + quality 360p → before watch starts]")
    print("  [ads_skip @ 5s, like/sub/bell/comment → during watch]")
    print()

    result = None
    try:
        result = await manager.watch_video(
            tab,
            engagement=eng_config,
            watch_time=smoke_wt,
        )

        tick("[E] WatchSessionResult returned",   result is not None)
        tick("[F] actual_watch > 10s",
             result.actual_watch_seconds > 10, f"{result.actual_watch_seconds:.1f}s")
        tick("[G] platform = desktop",
             result.platform == "desktop", f"got {result.platform!r}")
        tick("[H] no crash during engagement",    True)

        print(f"\n  📊 Watch Result:")
        print(f"     platform      : {result.platform}")
        print(f"     route         : {result.route}")
        print(f"     video_id      : {result.video_id}")
        print(f"     planned       : {result.planned_watch_seconds:.1f}s")
        print(f"     actual        : {result.actual_watch_seconds:.1f}s")
        print(f"     watch_fraction: {result.watch_fraction:.1%}")
        print(f"     liked         : {result.liked}")
        print(f"     subscribed    : {result.subscribed}")
        print(f"     commented     : {result.commented}")
        print(f"     events        : {result.engagement_events}")

    except Exception as e:
        import traceback
        tick("watch_video() Sprint-1 path", False, str(e)[:120])
        print("\n  ── Full Traceback ──")
        traceback.print_exc()

    # ── Step I: Close session ──────────────────────────────────────────────────
    sep("STEP I: Close Session")
    try:
        await manager.close_session()
        tick("Session closed cleanly", True)
    except Exception as e:
        tick("Session close", False, str(e)[:80])

    # ── Final ──────────────────────────────────────────────────────────────────
    print()
    print("=" * 62)
    print(f"  SMOKE TEST RESULT:  ✅ {PASS} PASS  |  ❌ {FAIL} FAIL")
    print("=" * 62)
    if FAIL == 0:
        print("  🎉 ALL LIVE CHECKS PASSED — Sprint-1 PRODUCTION READY!")
        print("     Ab Sprint-2 pe ja sakte hain. 100% santust. ✅")
    else:
        print(f"  ❌ {FAIL} failures found:")
        for line in log_lines:
            print(f"     {line}")
    print()


if __name__ == "__main__":
    import nodriver as uc
    uc.loop().run_until_complete(run_smoke_test())
