"""
full_test.py — FULL YouTube Bot Test
Exact timing:
  T+0s   : Navigate to video
  T+8s   : Page loaded, mouse move
  T+8-45s: Ad skip phase (wait up to 35s — skip btn appears ~5-10s after ad)
  T+45s  : Autoplay OFF (player API, no scroll)
  T+47s  : Play video
  T+51s  : Pause (4s into video)
  T+53s  : Resume
  T+57s  : Volume UP 80
  T+59s  : Volume DOWN 25
  T+61s  : Seek +30s
  T+63s  : Seek -30s
  T+65s  : Quality 360p (player API)
  T+67s  : Like (DOM, scroll into view)
  T+69s  : Dislike (DOM)
  T+71s  : Restore Like
  T+73s  : Subscribe (DOM)
  T+75s  : Bell ALL (DOM)
  T+77s  : Sidebar scroll (only #secondary, NOT window)
  T+95s  : Related video play
  T+105s : Comment post
"""
import asyncio, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")

_env = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(_env):
    with open(_env) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

import nodriver as uc
from server_python.providers.multilogin import MultiloginProvider
from server_python.innertube import InnertubeClient
import yt_actions as A
from yt_helpers import log, js, human_pause, human_mouse_move

PROFILE_ID   = "c58a40dc-d6ff-4234-8d26-a592804d32ea"
VIDEO_ID     = "C64hwS63yIc"
VIDEO_URL    = f"https://www.youtube.com/watch?v={VIDEO_ID}"
COMMENT_TEXT = "Amazing video! Very helpful content."


async def run_step(results, name, coro):
    try:
        ok, proof = await coro
    except Exception as e:
        ok, proof = False, f"EXCEPTION: {str(e)[:120]}"
    log(name, proof, ok=ok)
    results[name] = ok
    return ok


async def wait_ad_done(tab, label=""):
    """Block until no ad is showing. Call before ANY player action."""
    for _ in range(40):
        ad = await js(tab, """
            return document.querySelector('#movie_player')?.classList.contains('ad-showing') || false;
        """)
        if not ad:
            return
        await asyncio.sleep(1)


async def main():
    results = {}
    t0 = time.monotonic()

    def elapsed():
        return f"T+{round(time.monotonic()-t0)}s"

    # ── 1. Profile ────────────────────────────────────────────────────
    print("\n[1] MLX profile start...")
    provider = MultiloginProvider()
    res = await provider.start_profile(PROFILE_ID)
    try:
        cdp_port = res["data"]["cdpPort"]
    except (KeyError, TypeError):
        print(f"    FATAL: {res}"); return

    browser = await uc.start(host="127.0.0.1", port=cdp_port, headless=False)
    tab = browser.tabs[0] if browser.tabs else await browser.get("about:blank")
    log("PROFILE", f"CDP {cdp_port} | tabs={len(browser.tabs)}", ok=True)
    results["profile"] = True

    # ── 2. Navigate ──────────────────────────────────────────────── T+0s
    print(f"\n[2] Open {VIDEO_URL}  {elapsed()}")
    try:
        await tab.get(VIDEO_URL)
    except Exception as e:
        print(f"    warn: {e}")
    await asyncio.sleep(8)
    try:
        tab = browser.tabs[0]
    except Exception:
        pass
    await human_mouse_move(tab, 3)
    await run_step(results, "navigate", A.verify_navigated(tab, VIDEO_ID))

    # ── Login check ───────────────────────────────────────────────────
    yt = InnertubeClient(tab)
    login_status = await yt.check_login()
    log("LOGIN", login_status, ok=login_status == "LOGGED_IN")

    # ── 3. Ad skip ──────────────────────────────────────────────────────────
    # skip_ads will NOT return until ad-showing is fully gone (max 90s)
    print(f"\n[3] Ad skip  {elapsed()}")
    await run_step(results, "ad_skip", A.skip_ads(tab, max_wait=90))
    print(f"    Ads fully done at {elapsed()}")

    # ── 4. Autoplay OFF ─────────────────────────────────────────── T+45s
    # NO scroll needed — player API call only
    print(f"\n[4] Autoplay OFF  {elapsed()}")
    await run_step(results, "autoplay_off", A.set_autoplay(tab, want_on=False))

    # ── 5. Play ─────────────────────────────────────────────────── T+47s
    # Wait for video to be fully loaded (duration > 0)
    print(f"\n[5] Play  {elapsed()}")
    # Ensure video is loaded
    for _ in range(10):
        dur = await js(tab, "return document.querySelector('video')?.duration || 0;")
        if dur and float(str(dur)) > 5:
            break
        await asyncio.sleep(1)
    print(f"    Video duration: {dur}s at {elapsed()}")
    await run_step(results, "play", A.play_video(tab))

    # Let video play 4 seconds
    await asyncio.sleep(4)
    cur_t = await js(tab, "return document.querySelector('video')?.currentTime || 0;")
    try:
        cur_t_f = round(float(str(cur_t)), 1)
    except Exception:
        cur_t_f = 0.0
    print(f"    Video playing at {elapsed()}, currentTime={cur_t_f}s")

    # ── 6. Pause ────────────────────────────────────────────────── T+51s
    print(f"\n[6] Pause  {elapsed()}")
    await run_step(results, "pause", A.pause_video(tab))
    await asyncio.sleep(1)

    # ── 7. Resume ───────────────────────────────────────────────── T+53s
    print(f"\n[7] Resume  {elapsed()}")
    await run_step(results, "resume", A.play_video(tab))
    await asyncio.sleep(2)

    # ── 8. Volume ───────────────────────────────────────────────── T+57s
    print(f"\n[8] Volume UP -> 80  {elapsed()}")
    await run_step(results, "volume_up", A.set_volume(tab, 80))
    await asyncio.sleep(2)
    print(f"    Volume DOWN -> 25  {elapsed()}")
    await run_step(results, "volume_down", A.set_volume(tab, 25))
    await asyncio.sleep(1)

    # ── 9. Seek ─────────────────────────────────────────────────── T+61s
    # Check duration first — seek only if video is long enough
    dur_now = await js(tab, "return document.querySelector('video')?.duration || 0;")
    print(f"\n[9] Seek +30s  {elapsed()}  (video dur={round(float(str(dur_now)),1)}s)")
    await run_step(results, "seek_forward", A.seek_by(tab, 30))
    await asyncio.sleep(2)
    print(f"    Seek -30s  {elapsed()}")
    await run_step(results, "seek_back", A.seek_by(tab, -30))
    await asyncio.sleep(1)

    # ── 10. Quality ─────────────────────────────────────────────── T+65s
    # Player API — no scroll, no UI interaction
    print(f"\n[10] Quality 360p  {elapsed()}")
    await run_step(results, "quality_360", A.set_quality(tab, "360p"))
    await asyncio.sleep(1)

    # ── 11. Like ────────────────────────────────────────────────── T+67s
    # Scroll like button into view (just the button, not the whole page)
    print(f"\n[11] Like  {elapsed()}")
    await run_step(results, "like", A.set_like(tab, want=True))
    await asyncio.sleep(2)

    # ── 12. Dislike ─────────────────────────────────────────────── T+69s
    print(f"\n[12] Dislike (test)  {elapsed()}")
    await run_step(results, "dislike", A.set_dislike(tab, want=True))
    await asyncio.sleep(2)
    print(f"    Restore -> Like  {elapsed()}")
    await A.set_like(tab, want=True)
    await asyncio.sleep(1)

    # ── 13. Subscribe ───────────────────────────────────────────── T+73s
    print(f"\n[13] Subscribe  {elapsed()}")
    await run_step(results, "subscribe", A.subscribe(tab, want=True))
    await asyncio.sleep(2)

    # ── 14. Bell ────────────────────────────────────────────────── T+75s
    print(f"\n[14] Bell -> All  {elapsed()}")
    await run_step(results, "bell_all", A.set_bell(tab, level="All"))
    await asyncio.sleep(2)

    # ── 15. Sidebar scroll ──────────────────────────────────────── T+77s
    # Scrolls ONLY #secondary element, not the window
    print(f"\n[15] Sidebar scroll  {elapsed()}")
    await run_step(results, "sidebar_scroll", A.scroll_sidebar(tab, 600))
    await asyncio.sleep(2)

    # ── 16. Related video ───────────────────────────────────────── T+95s
    print(f"\n[16] Play different related video  {elapsed()}")
    played = await run_step(results, "related_play", A.play_unwatched_related(tab))
    if played:
        print(f"    Related video playing at {elapsed()}, waiting for ads...")
        await A.skip_ads(tab, max_wait=25)
        await A.play_video(tab)
        await asyncio.sleep(3)
        # Go back to original video for comment
        print(f"    Back to original video  {elapsed()}")
        try:
            await tab.get(VIDEO_URL)
        except Exception:
            pass
        await asyncio.sleep(6)
        try:
            tab = browser.tabs[0]
        except Exception:
            pass

    # ── 17. Comment ─────────────────────────────────────────────── T+105s
    print(f"\n[17] Comment: '{COMMENT_TEXT}'  {elapsed()}")
    await run_step(results, "comment", A.post_comment(tab, COMMENT_TEXT))

    # ── Final Report ──────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("=" * 60)
    passed = sum(1 for v in results.values() if v)
    for k, v in results.items():
        print(f"  {'PASS' if v else 'FAIL'}  {k}")
    print("=" * 60)
    print(f"SCORE: {passed}/{len(results)}")
    if passed == len(results):
        print("ALL PASSED ✅")
    else:
        print(f"FAILED: {[k for k,v in results.items() if not v]}")
    print("=" * 60)
    print(f"Total time: {elapsed()}")
    print("Browser open.")


if __name__ == "__main__":
    asyncio.run(main())
