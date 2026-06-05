"""
yt_actions.py — YouTube Bot Actions (All 20 Features)
======================================================
PERMANENT SELECTORS (WCAG / HTML5 / Custom Elements — never change):

  Ad skip      → [id^="skip-button"]
  Play/Pause   → video.play() / video.pause()          HTML5 API
  Volume       → video.volume (0.0–1.0)                HTML5 API
  Seek         → video.currentTime                     HTML5 API
  Quality      → #movie_player.setPlaybackQuality()    Player API
  Autoplay     → button[aria-label*="Autoplay"]        aria-label (WCAG)
  Like         → button[aria-label="like this video"]  aria-label (WCAG)
  Dislike      → button[aria-label="Dislike this video"] aria-label (WCAG)
  Subscribe    → button[aria-label*="Subscribe"]       aria-label (WCAG)
  Sub Bell     → button[aria-label*="notification setting"]
  Header Bell  → ytd-notification-topbar-button-renderer button  (custom element)
  Comment box  → #simplebox-placeholder
  Comment sub  → button[aria-label="Comment"]
  Comment like → ytd-comment-renderer button[aria-label="like"]
  Description  → ytd-text-inline-expander tp-yt-paper-button#expand
  Sidebar      → ytd-compact-video-renderer a#thumbnail

STATE RULES:
  - autoplay    : once OFF, never auto-ON again
  - like/dislike: mutually exclusive — undo one before doing other
  - comment     : always human typing (insert_text), never clipboard
  - volume      : clamp 0–100
  - seek        : clamp min=0, max=duration

Each action returns Tuple[bool, str] → (ok, proof_string)
"""
import asyncio, json, random, time, urllib.parse
from typing import Tuple, List

from nodriver import cdp
from yt_helpers import js, jsjson, human_pause, type_human, wait_for_video_loaded, log
from server_python.innertube import InnertubeClient
from behavior.youtube.selectors import DESKTOP, JS_API
from behavior.youtube.safe_actions import safe_click, safe_eval_js
from behavior.youtube.state import (
    is_liked,
    is_disliked,
    is_subscribed,
    is_ad_playing,
    get_video_id as state_get_video_id,
)

_rng = random.Random()


# ═══════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════

async def _cdp_click(tab, selector: str) -> bool:
    """Real CDP mouse click at element center — bypasses JS .click() blocks."""
    try:
        rect = await js(tab, f"""
            var el = document.querySelector({json.dumps(selector)});
            if (!el) return null;
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return JSON.stringify({{x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}});
        """)
        if not rect or str(rect) == "null":
            return False
        coords = json.loads(str(rect))
        x, y = float(coords["x"]), float(coords["y"])
        await tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
        await asyncio.sleep(0.08)
        await tab.send(cdp.input_.dispatch_mouse_event(
            type_="mousePressed", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
        await asyncio.sleep(0.08)
        await tab.send(cdp.input_.dispatch_mouse_event(
            type_="mouseReleased", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
        return True
    except Exception:
        return False


async def _get_video_id(tab) -> str:
    vid = await js(tab, "return new URLSearchParams(location.search).get('v') || '';")
    return str(vid).strip()


async def _video_state(tab) -> dict:
    return await jsjson(tab, """
        var v = document.querySelector('video');
        if (!v) return JSON.stringify({error:'no_video'});
        return JSON.stringify({
            paused:   v.paused,
            time:     Math.round(v.currentTime * 10) / 10,
            duration: Math.round((v.duration || 0) * 10) / 10,
            volume:   Math.round(v.volume * 100)
        });
    """) or {}


# ═══════════════════════════════════════════════════════════════════
# 1. NAVIGATION VERIFY
# ═══════════════════════════════════════════════════════════════════

async def verify_navigated(tab, video_id: str) -> Tuple[bool, str]:
    title = await js(tab, "return document.title;")
    url   = await js(tab, "return location.href;")
    ok = video_id in str(url)
    return ok, str(title)[:80]


# ═══════════════════════════════════════════════════════════════════
# 2. AD SKIP  — permanent: [id^="skip-button"]
# ═══════════════════════════════════════════════════════════════════

async def smart_ad_skip(tab, max_wait: int = 30) -> Tuple[bool, str]:
    """
    Wait up to max_wait seconds for skip button.
    V2 fallback chain: DESKTOP['ad_skip_button'] (12 selectors).
    Handles back-to-back ads.
    After max_wait, keeps waiting until ad naturally ends (never fails mid-ad).
    """
    if not await is_ad_playing(tab):
        return True, "NO_AD"

    skipped = 0
    start   = time.monotonic()
    skip_sels_json = json.dumps(list(DESKTOP["ad_skip_button"]))

    async def _try_skip():
        nonlocal skipped
        state = await js(tab, f"""
            var p = document.querySelector('#movie_player');
            if (!p || !p.classList.contains('ad-showing')) return 'AD_DONE';
            var sels = {skip_sels_json};
            for (var i = 0; i < sels.length; i++) {{
                var btn = document.querySelector(sels[i]);
                if (btn && btn.offsetWidth > 0 && btn.offsetHeight > 0) {{
                    var r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {{
                        return 'SKIP_READY:' + Math.round(r.left+r.width/2) + ':' + Math.round(r.top+r.height/2);
                    }}
                }}
            }}
            var cd = document.querySelector('.ytp-ad-duration-remaining, .ytp-ad-preview-text');
            return 'WAITING:' + (cd ? cd.textContent.trim().substring(0,20) : 'ad_loading');
        """)
        if state == "AD_DONE":
            return "DONE"
        if str(state).startswith("SKIP_READY:"):
            parts = str(state).split(":")
            try:
                x, y = float(parts[1]), float(parts[2])
                await tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
                await asyncio.sleep(0.1)
                await tab.send(cdp.input_.dispatch_mouse_event(
                    type_="mousePressed", x=x, y=y,
                    button=cdp.input_.MouseButton.LEFT, click_count=1))
                await asyncio.sleep(0.1)
                await tab.send(cdp.input_.dispatch_mouse_event(
                    type_="mouseReleased", x=x, y=y,
                    button=cdp.input_.MouseButton.LEFT, click_count=1))
                skipped += 1
                print(f"    [ad] CDP skip click ({x},{y}) #{skipped}")
            except Exception as e:
                print(f"    [ad] click err: {e}")
            await asyncio.sleep(2)
        else:
            print(f"    [ad] {state}")
            await asyncio.sleep(1)
        return "WAITING"

    # Phase 1: max_wait loop
    deadline = start + max_wait
    while time.monotonic() < deadline:
        r = await _try_skip()
        if r == "DONE":
            return True, f"AD_SKIPPED skipped={skipped}"

    # Phase 2: overtime — keep waiting until ad truly ends
    print(f"    [ad] max_wait={max_wait}s done, waiting for ad to end naturally...")
    for _ in range(180):  # up to 3 more minutes
        r = await _try_skip()
        if r == "DONE":
            elapsed = round(time.monotonic() - start)
            return True, f"AD_DONE after {elapsed}s skipped={skipped}"

    return False, f"AD_TIMEOUT skipped={skipped}"


# Alias for full_test.py compatibility
async def skip_ads(tab, max_wait: int = 90) -> Tuple[bool, str]:
    return await smart_ad_skip(tab, max_wait=max_wait)


# ═══════════════════════════════════════════════════════════════════
# 3. PLAY  — permanent: video.play() HTML5 API
# ═══════════════════════════════════════════════════════════════════

async def play_video(tab) -> Tuple[bool, str]:
    """Play via video.play() — HTML5, permanent. Checks video.paused first."""
    for _ in range(8):
        if await js(tab, "return !!document.querySelector('video');"):
            break
        await asyncio.sleep(1)

    is_paused = await js(tab, "return document.querySelector('video')?.paused ?? true;")
    if is_paused:
        await js(tab, "document.querySelector('video').play();")
        await asyncio.sleep(1.5)
    await asyncio.sleep(1)
    state = await _video_state(tab)
    playing = isinstance(state, dict) and not state.get("paused", True)
    return playing, f"play state={state}"


# ═══════════════════════════════════════════════════════════════════
# 4. PAUSE  — permanent: video.pause() HTML5 API
# ═══════════════════════════════════════════════════════════════════

async def pause_video(tab) -> Tuple[bool, str]:
    """Pause via video.pause() — HTML5, permanent. Waits for duration > 0."""
    await wait_for_video_loaded(tab, timeout=12)
    is_paused = await js(tab, "return document.querySelector('video')?.paused ?? null;")
    if not is_paused:
        await js(tab, "document.querySelector('video').pause();")
        await asyncio.sleep(1.5)
    state = await _video_state(tab)
    ok = isinstance(state, dict) and state.get("paused", False)
    return ok, f"pause state={state}"


# ═══════════════════════════════════════════════════════════════════
# 5. VOLUME  — permanent: video.volume HTML5 API
# ═══════════════════════════════════════════════════════════════════

async def set_volume(tab, percent: int) -> Tuple[bool, str]:
    """Set volume via video.volume — HTML5 API, permanent. Clamps 0–100."""
    percent = max(0, min(100, int(percent)))
    cur = await js(tab, "return Math.round((document.querySelector('video')?.volume||0)*100);")
    await js(tab, f"""
        var v = document.querySelector('video');
        if (v) {{ v.volume = {percent/100}; v.muted = false; }}
    """)
    await asyncio.sleep(0.5)
    final = await js(tab, "return Math.round((document.querySelector('video')?.volume||0)*100);")
    try:
        final_i = int(str(final))
    except Exception:
        final_i = -1
    ok = abs(final_i - percent) <= 3
    return ok, f"VOL_SET:{final_i} (wanted={percent} from={cur})"


async def volume_up(tab, amount: int = 10) -> Tuple[bool, str]:
    cur = await js(tab, "return Math.round((document.querySelector('video')?.volume||0)*100);")
    try:
        new_vol = min(100, int(str(cur)) + amount)
    except Exception:
        new_vol = 50
    return await set_volume(tab, new_vol)


async def volume_down(tab, amount: int = 10) -> Tuple[bool, str]:
    cur = await js(tab, "return Math.round((document.querySelector('video')?.volume||0)*100);")
    try:
        new_vol = max(0, int(str(cur)) - amount)
    except Exception:
        new_vol = 40
    return await set_volume(tab, new_vol)


# ═══════════════════════════════════════════════════════════════════
# 6. SEEK  — permanent: video.currentTime HTML5 API
# ═══════════════════════════════════════════════════════════════════

async def seek_forward(tab, seconds: int = 10) -> Tuple[bool, str]:
    """Seek forward via video.currentTime — HTML5, permanent. Clamps to duration."""
    state = await _video_state(tab)
    if not isinstance(state, dict) or state.get("error"):
        return False, "VIDEO_NOT_FOUND"
    cur = float(state.get("time", 0))
    dur = float(state.get("duration", 0))
    if dur < 15:
        return False, f"VIDEO_TOO_SHORT dur={dur}s"
    new_t = min(cur + seconds, dur - 2)
    await js(tab, f"document.querySelector('video').currentTime = {new_t};")
    await asyncio.sleep(1.2)
    after = await js(tab, "return document.querySelector('video')?.currentTime || 0;")
    diff = float(str(after)) - cur
    return diff > 0, f"SEEK_FORWARD:+{round(diff,1)}s now={round(float(str(after)),1)}s"


async def seek_backward(tab, seconds: int = 10) -> Tuple[bool, str]:
    """Seek backward via video.currentTime — HTML5, permanent. Clamps to 0."""
    state = await _video_state(tab)
    if not isinstance(state, dict) or state.get("error"):
        return False, "VIDEO_NOT_FOUND"
    cur = float(state.get("time", 0))
    dur = float(state.get("duration", 0))
    if dur < 15:
        return False, f"VIDEO_TOO_SHORT dur={dur}s"
    new_t = max(cur - seconds, 0)
    await js(tab, f"document.querySelector('video').currentTime = {new_t};")
    await asyncio.sleep(1.2)
    after = await js(tab, "return document.querySelector('video')?.currentTime || 0;")
    diff = float(str(after)) - cur
    return diff < 0, f"SEEK_BACK:{round(diff,1)}s now={round(float(str(after)),1)}s"


# Alias for full_test.py (seek_by uses +/- seconds)
async def seek_by(tab, seconds: int) -> Tuple[bool, str]:
    if seconds >= 0:
        return await seek_forward(tab, abs(seconds))
    else:
        return await seek_backward(tab, abs(seconds))


# ═══════════════════════════════════════════════════════════════════
# 7. QUALITY  — permanent: #movie_player.setPlaybackQuality()
# ═══════════════════════════════════════════════════════════════════

async def set_quality(tab, quality: str = "360p") -> Tuple[bool, str]:
    """Set quality via #movie_player.setPlaybackQuality() — Player API, permanent."""
    q_map = {
        "144p": "tiny", "240p": "small", "360p": "medium",
        "480p": "large", "720p": "hd720", "1080p": "hd1080", "auto": "auto"
    }
    q_key = q_map.get(quality.lower(), "medium")
    result = await js(tab, f"""
        var p = document.querySelector('#movie_player');
        if (!p) p = document.querySelector('ytd-player')?.querySelector('#movie_player');
        if (p && p.setPlaybackQuality) {{
            p.setPlaybackQuality('{q_key}');
            var got = p.getPlaybackQuality ? p.getPlaybackQuality() : 'unknown';
            return 'QUALITY_SET:' + got;
        }}
        return 'PLAYER_NOT_FOUND';
    """)
    ok = result and "QUALITY_SET" in str(result)
    return ok, str(result)


# ═══════════════════════════════════════════════════════════════════
# 8. AUTOPLAY OFF  — permanent: button[aria-label*="Autoplay"]
# ═══════════════════════════════════════════════════════════════════

async def set_autoplay(tab, want_on: bool = False) -> Tuple[bool, str]:
    """
    State-aware autoplay toggle.
    Permanent: button[aria-label*="Autoplay"] — WCAG aria-label law.
    Reads "is on"/"is off" from aria-label text. Clicks only if needed.
    """
    want_str = "on" if want_on else "off"
    cur = await js(tab, """
        var btn = document.querySelector('button[aria-label*="Autoplay"]');
        if (!btn) return 'NOT_FOUND';
        var lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
        return lbl.includes('is on') ? 'on' : (lbl.includes('is off') ? 'off' : 'unknown:' + lbl.substring(0,40));
    """)
    if str(cur) == want_str:
        return True, f"AUTOPLAY_ALREADY_{want_str.upper()}"
    clicked = await _cdp_click(tab, 'button[aria-label*="Autoplay"]')
    await asyncio.sleep(0.8)
    new_state = await js(tab, """
        var btn = document.querySelector('button[aria-label*="Autoplay"]');
        if (!btn) return 'NOT_FOUND';
        var lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
        return lbl.includes('is on') ? 'on' : (lbl.includes('is off') ? 'off' : 'unknown');
    """)
    ok = str(new_state) == want_str
    return ok, f"AUTOPLAY:{cur}->{new_state} (wanted={want_str}) clicked={clicked}"


# ═══════════════════════════════════════════════════════════════════
# 9. LIKE  — permanent: button[aria-label="like this video"]
# ═══════════════════════════════════════════════════════════════════

async def set_like(tab, want: bool = True) -> Tuple[bool, str]:
    """
    Like video — state-consistent.
    Permanent: button[aria-label="like this video"] (WCAG).
    If disliked → undo dislike first. Like and dislike never coexist.
    Tries Innertube API first, DOM fallback.
    """
    video_id = await _get_video_id(tab)

    liked = await is_liked(tab)
    disliked = await is_disliked(tab)

    if want and liked:
        return True, "ALREADY_LIKED"
    if not want and not liked:
        return True, "ALREADY_NOT_LIKED"

    # State rule: undo dislike first if we want to like
    if want and disliked:
        await safe_click(tab, DESKTOP["dislike_button"], action_name="UNDO_DISLIKE")
        await asyncio.sleep(0.8)

    # Try Innertube API
    if video_id:
        try:
            yt = InnertubeClient(tab)
            r = await yt.like(video_id) if want else await yt.remove_like(video_id)
            if r and "error" not in str(r).lower():
                return True, f"LIKED_VIA_API:{r}"
        except Exception:
            pass

    # DOM fallback — V2 selector chain
    clicked = await safe_click(tab, DESKTOP["like_button"], action_name="LIKE" if want else "UNLIKE")
    await asyncio.sleep(1)
    final_liked = await is_liked(tab)
    ok = (final_liked == want)
    return ok, f"LIKED_VIA_DOM clicked={clicked} final={final_liked}"


# ═══════════════════════════════════════════════════════════════════
# 10. DISLIKE  — permanent: button[aria-label="Dislike this video"]
# ═══════════════════════════════════════════════════════════════════

async def set_dislike(tab, want: bool = True) -> Tuple[bool, str]:
    """
    Dislike video — state-consistent.
    Permanent: button[aria-label="Dislike this video"] (WCAG).
    If liked → undo like first.
    """
    video_id = await _get_video_id(tab)

    liked = await is_liked(tab)
    disliked = await is_disliked(tab)

    if want and disliked:
        return True, "ALREADY_DISLIKED"
    if not want and not disliked:
        return True, "ALREADY_NOT_DISLIKED"

    # State rule: undo like first if we want to dislike
    if want and liked:
        await safe_click(tab, DESKTOP["like_button"], action_name="UNDO_LIKE")
        await asyncio.sleep(0.8)

    # Try Innertube API
    if video_id:
        try:
            yt = InnertubeClient(tab)
            r = await yt.dislike(video_id) if want else await yt.remove_like(video_id)
            if r and "error" not in str(r).lower():
                return True, f"DISLIKED_VIA_API:{r}"
        except Exception:
            pass

    clicked = await safe_click(tab, DESKTOP["dislike_button"], action_name="DISLIKE" if want else "UNDISLIKE")
    await asyncio.sleep(1)
    final_disliked = await is_disliked(tab)
    ok = (final_disliked == want)
    return ok, f"DISLIKED_VIA_DOM clicked={clicked} final={final_disliked}"


# ═══════════════════════════════════════════════════════════════════
# 11. SUBSCRIBE + SUBSCRIPTION BELL
#     permanent: button[aria-label*="Subscribe"] / button[aria-label*="notification setting"]
# ═══════════════════════════════════════════════════════════════════

async def subscribe(tab, want: bool = True) -> Tuple[bool, str]:
    """
    Subscribe/unsubscribe — state-consistent.
    Permanent: button[aria-label*="Subscribe"] / button[aria-label*="Unsubscribe"] (WCAG).
    After subscribing, opens bell dropdown and selects 'All'.
    """
    is_subbed = await is_subscribed(tab)

    if want and is_subbed:
        return True, "ALREADY_SUBSCRIBED"
    if not want and not is_subbed:
        return True, "ALREADY_NOT_SUBSCRIBED"

    # Try Innertube API
    video_id = await _get_video_id(tab)
    if video_id:
        try:
            yt = InnertubeClient(tab)
            channel_id = await js(tab, """
                var meta = document.querySelector('ytd-video-owner-renderer a');
                if (meta) {
                    var href = meta.getAttribute('href') || '';
                    var m = href.match(/\\/(channel|c|@)?\\/?(UC[\\w-]{22})/);
                    return m ? m[2] : href;
                }
                return '';
            """)
            if channel_id:
                r = await yt.subscribe(str(channel_id)) if want else await yt.unsubscribe(str(channel_id))
                if r and "error" not in str(r).lower():
                    # Also set bell to ALL after subscribing
                    await asyncio.sleep(1)
                    await set_bell(tab, "All")
                    return True, f"SUBSCRIBED_VIA_API bell=ALL"
        except Exception:
            pass

    clicked = await safe_click(
        tab, DESKTOP["subscribe_button"],
        action_name="SUBSCRIBE" if want else "UNSUBSCRIBE",
    )
    if not want:
        await asyncio.sleep(1.5)
        await safe_click(tab, DESKTOP.get("unsubscribe_confirm_button", ()), action_name="UNSUB_CONFIRM", timeout=3)

    await asyncio.sleep(1.5)
    final_subbed = await is_subscribed(tab)
    ok = (final_subbed == want)
    action = "CLICKED" if clicked else "NOT_FOUND"
    if ok and want:
        await set_bell(tab, "All")
    return ok, f"SUBSCRIBED_VIA_DOM action={action} final={final_subbed}"


async def set_bell(tab, level: str = "All") -> Tuple[bool, str]:
    """
    Set subscription notification level.
    Permanent: button[aria-label*="notification setting"] (WCAG).
    Opens dropdown, selects 'All notifications'.
    """
    bell_clicked = await safe_click(tab, DESKTOP["bell_notification_button"], action_name="BELL")
    if not bell_clicked:
        return False, "BELL_BTN_NOT_FOUND"
    await asyncio.sleep(1.2)

    # Select option from dropdown
    level_lower = level.lower()
    option = await js(tab, f"""
        var want = {json.dumps(level_lower)};
        // Try menu items
        var selectors = [
            'ytd-menu-service-item-renderer',
            'tp-yt-paper-item',
            '[role="menuitem"]',
            '[role="option"]'
        ];
        for (var sel of selectors) {{
            var items = document.querySelectorAll(sel);
            for (var item of items) {{
                var txt = (item.textContent || '').toLowerCase().trim();
                if (want === 'all' && (txt === 'all' || txt.includes('all notification'))) {{
                    item.click();
                    return 'OPTION_CLICKED:' + txt.substring(0,30);
                }}
                if (want !== 'all' && txt.includes(want)) {{
                    item.click();
                    return 'OPTION_CLICKED:' + txt.substring(0,30);
                }}
            }}
        }}
        return 'OPTION_NOT_FOUND (want=' + want + ')';
    """)
    ok = "CLICKED" in str(option)
    return ok, f"BELL_SET_{level.upper()}_VIA_DOM option={option}"


# ═══════════════════════════════════════════════════════════════════
# 12. HEADER NOTIFICATION BELL
#     permanent: ytd-notification-topbar-button-renderer button (custom element)
# ═══════════════════════════════════════════════════════════════════

async def click_header_notification_bell(tab) -> Tuple[bool, str]:
    """
    Click YouTube header notification bell (top-right of page).
    Permanent: ytd-notification-topbar-button-renderer button — custom element tag, never changes.
    Opens notification panel.
    """
    clicked_ok = await safe_click(tab, DESKTOP["notifications_topbar_bell"], action_name="HEADER_BELL")
    clicked = "CLICKED" if clicked_ok else "NOT_FOUND"
    if not clicked_ok:
        return False, "HEADER_BELL_NOT_FOUND"

    await asyncio.sleep(1.5)

    # Verify panel opened — check for notification items
    panel_open = await js(tab, """
        var panel = document.querySelector(
            'ytd-popup-container ytd-notification-renderer, ' +
            'tp-yt-iron-dropdown ytd-notification-renderer, ' +
            '#notification-panel ytd-notification-renderer'
        );
        return panel ? 'PANEL_OPEN' : 'PANEL_NOT_VISIBLE';
    """)

    # Close panel by clicking elsewhere (don't leave it open)
    await tab.send(cdp.input_.dispatch_key_event(
        type_="keyDown", key="Escape", code="Escape", windows_virtual_key_code=27))
    await asyncio.sleep(0.3)
    await tab.send(cdp.input_.dispatch_key_event(
        type_="keyUp", key="Escape", code="Escape", windows_virtual_key_code=27))

    ok = "NOT_FOUND" not in str(clicked)
    return ok, f"HEADER_BELL_{clicked} panel={panel_open}"


# ═══════════════════════════════════════════════════════════════════
# 13. POST COMMENT  — human typing, permanent selectors
# ═══════════════════════════════════════════════════════════════════

async def post_comment(tab, text: str) -> Tuple[bool, str]:
    """
    Post comment — human typing always (insert_text char by char, NEVER clipboard).
    Permanent: #simplebox-placeholder → button[aria-label="Comment"].
    Tries Innertube API first, DOM fallback with human typing.
    """
    video_id = await _get_video_id(tab)

    # Try Innertube API
    if video_id:
        try:
            yt = InnertubeClient(tab)
            r = await yt.post_comment(video_id, text)
            if r and "error" not in str(r).lower():
                return True, f"COMMENT_VIA_API:{str(r)[:60]}"
        except Exception:
            pass

    # DOM fallback — scroll to comment section
    for _ in range(8):
        await js(tab, "window.scrollBy(0, 350);")
        await asyncio.sleep(0.5)
        found = await js(tab, """
            return !!document.querySelector('#simplebox-placeholder, [aria-label*="comment"][contenteditable]');
        """)
        if found:
            break

    # Wait for comment box
    for _ in range(15):
        found = await js(tab, "return !!document.querySelector('#simplebox-placeholder');")
        if found:
            break
        await js(tab, "window.scrollBy(0, 200);")
        await asyncio.sleep(0.8)

    # Click placeholder to activate editor
    await js(tab, """
        var box = document.querySelector('#simplebox-placeholder');
        if (box) { box.scrollIntoView({block:'center'}); box.click(); }
    """)
    await asyncio.sleep(1.5)

    # Focus contenteditable editor
    editor = await js(tab, """
        var el = document.querySelector('#contenteditable-root, [contenteditable="true"]');
        if (el) { el.focus(); el.click(); return 'FOUND'; }
        return 'NOT_FOUND';
    """)
    if "NOT_FOUND" in str(editor):
        return False, "COMMENT_BOX_NOT_FOUND"

    # HUMAN TYPING — char by char via insert_text (never clipboard)
    await type_human(tab, text)
    await asyncio.sleep(1)

    # Submit: button[aria-label="Comment"] — permanent WCAG selector
    submit = await js(tab, """
        var btns = document.querySelectorAll('button[aria-label="Comment"]');
        for (var b of btns) {
            if (!b.disabled && b.offsetParent !== null) {
                b.click();
                return 'SUBMITTED';
            }
        }
        // Fallback: #submit-button
        var sb = document.querySelector('#submit-button button:not([disabled])');
        if (sb) { sb.click(); return 'SUBMITTED_FALLBACK'; }
        return 'SUBMIT_NOT_FOUND';
    """)
    ok = "SUBMITTED" in str(submit)
    return ok, f"COMMENT_SUBMITTED typed='{text[:30]}' submit={submit}"


# ═══════════════════════════════════════════════════════════════════
# 14. LIKE OTHER PEOPLE'S COMMENTS
#     permanent: ytd-comment-renderer button[aria-label="like"]
# ═══════════════════════════════════════════════════════════════════

async def like_comments(tab, top_n: int = 3) -> Tuple[bool, str]:
    """
    Like top N comments from other people.
    Permanent: ytd-comment-renderer button[aria-label="like"] — custom element + aria-label.
    Checks aria-pressed — skips already liked.
    """
    # Scroll to comments section
    for _ in range(6):
        await js(tab, "window.scrollBy(0, 400);")
        await asyncio.sleep(0.6)
        count = await js(tab, "return document.querySelectorAll('ytd-comment-renderer').length;")
        if count and int(str(count)) > 0:
            break

    liked_count = 0
    result = await js(tab, f"""
        var comments = document.querySelectorAll('ytd-comment-renderer');
        var liked = 0;
        var topN = {top_n};
        for (var c of comments) {{
            if (liked >= topN) break;
            var btn = c.querySelector('button[aria-label="like"]');
            if (!btn) continue;
            var pressed = btn.getAttribute('aria-pressed');
            if (pressed === 'true') continue;  // already liked
            btn.scrollIntoView({{block:'nearest'}});
            btn.click();
            liked++;
        }}
        return 'LIKED_' + liked + '_COMMENTS of ' + comments.length + ' found';
    """)
    liked_count = 0
    try:
        liked_count = int(str(result).split("LIKED_")[1].split("_")[0])
    except Exception:
        pass
    return liked_count > 0 or top_n == 0, str(result)


# ═══════════════════════════════════════════════════════════════════
# 15. DESCRIPTION EXPAND + OPEN LINKS
#     permanent: ytd-text-inline-expander tp-yt-paper-button#expand
# ═══════════════════════════════════════════════════════════════════

async def expand_description_links(tab, open_links: bool = False) -> Tuple[bool, str]:
    """
    Expand description and extract links.
    Permanent: ytd-text-inline-expander tp-yt-paper-button#expand (custom element).
    Parses YouTube redirect URLs: youtube.com/redirect?q=REAL_URL.
    Optionally opens links in same tab then returns to video.
    """
    current_url = await js(tab, "return location.href;")

    # Click expand button
    expanded = await js(tab, """
        var btn = document.querySelector('ytd-text-inline-expander tp-yt-paper-button#expand');
        if (!btn) btn = document.querySelector('#expand[role="button"]');
        if (!btn) return 'EXPAND_NOT_FOUND';
        btn.click();
        return 'EXPANDED';
    """)
    if "NOT_FOUND" in str(expanded):
        return False, f"DESC_EXPAND_NOT_FOUND"
    await asyncio.sleep(0.8)

    # Extract all links
    links_raw = await jsjson(tab, """
        var links = document.querySelectorAll('#description-inline-expander a[href], #description a[href]');
        var result = [];
        for (var a of links) {
            var href = a.getAttribute('href') || '';
            var text = (a.textContent || '').trim().substring(0,60);
            result.push({href: href, text: text});
        }
        return JSON.stringify(result);
    """)

    if not isinstance(links_raw, list):
        return True, f"DESC_EXPANDED no_links"

    # Parse YouTube redirect URLs
    real_links = []
    for item in links_raw:
        href = item.get("href", "")
        if "youtube.com/redirect" in href:
            try:
                parsed = urllib.parse.urlparse(href)
                real = urllib.parse.parse_qs(parsed.query).get("q", [href])[0]
                real_links.append(real)
            except Exception:
                real_links.append(href)
        elif href.startswith("http"):
            real_links.append(href)

    opened = 0
    if open_links and real_links:
        for link in real_links[:3]:  # max 3 links
            try:
                await tab.get(link)
                await asyncio.sleep(3)
                opened += 1
            except Exception:
                pass
        # Return to video
        try:
            await tab.get(str(current_url))
            await asyncio.sleep(4)
        except Exception:
            pass

    return True, f"DESC_EXPANDED links={len(real_links)} opened={opened}"


# ═══════════════════════════════════════════════════════════════════
# 16. SIDEBAR — CLICK UNWATCHED CHANNEL VIDEO
#     permanent: ytd-compact-video-renderer a#thumbnail
# ═══════════════════════════════════════════════════════════════════

async def click_unwatched_sidebar(tab, channel_filter: str = "") -> Tuple[bool, str]:
    """
    Click unwatched related video in sidebar.
    Permanent: ytd-compact-video-renderer a#thumbnail (custom element).
    ytd-thumbnail-overlay-resume-playback-renderer = already watched → skip.
    Optionally filter by channel name.
    """
    current_vid = await js(tab, "return new URLSearchParams(location.search).get('v') || '';")

    # If no recommendations, scroll window to trigger lazy load
    count = await js(tab, "return document.querySelectorAll('ytd-compact-video-renderer').length;")
    if not count or int(str(count)) == 0:
        for i in range(8):
            await js(tab, "window.scrollBy(0, 500);")
            await asyncio.sleep(1.2)
            count = await js(tab, "return document.querySelectorAll('ytd-compact-video-renderer').length;")
            if count and int(str(count)) > 0:
                break
        await js(tab, "window.scrollTo(0, 0);")
        await asyncio.sleep(0.5)

    result = await js(tab, f"""
        var currentVid = {json.dumps(str(current_vid))};
        var chanFilter = {json.dumps(channel_filter.lower())};
        var videos = Array.from(document.querySelectorAll('ytd-compact-video-renderer'));

        // Prefer unwatched, optionally by channel
        for (var pass = 0; pass < 2; pass++) {{
            for (var v of videos) {{
                // Channel filter check (pass 0: filter active, pass 1: ignore filter)
                if (pass === 0 && chanFilter) {{
                    var chanEl = v.querySelector('#channel-name, #byline-container');
                    var chanTxt = (chanEl ? chanEl.textContent : '').toLowerCase();
                    if (!chanTxt.includes(chanFilter)) continue;
                }}
                var link = v.querySelector('a#thumbnail');
                if (!link) continue;
                var href = link.getAttribute('href') || '';
                if (!href || href.includes(currentVid)) continue;
                // Skip already watched (pass 0 only)
                if (pass === 0) {{
                    var watched = v.querySelector('ytd-thumbnail-overlay-resume-playback-renderer');
                    if (watched) continue;
                }}
                link.scrollIntoView({{block:'nearest'}});
                link.click();
                return (pass === 0 ? 'PLAYING_UNWATCHED:' : 'PLAYING_ANY:') + href;
            }}
        }}

        // Last resort: #secondary a links
        var anyLinks = document.querySelectorAll('#secondary a[href*="/watch?v="]');
        for (var a of anyLinks) {{
            var href = a.getAttribute('href') || '';
            if (href && !href.includes(currentVid)) {{
                a.click();
                return 'PLAYING_LINK:' + href;
            }}
        }}
        return 'NO_RELATED_FOUND count=' + videos.length;
    """)
    ok = result and "PLAYING" in str(result)
    if ok:
        await asyncio.sleep(6)
    return ok, str(result)


# Alias for full_test.py
async def play_unwatched_related(tab) -> Tuple[bool, str]:
    return await click_unwatched_sidebar(tab)


# ═══════════════════════════════════════════════════════════════════
# 17. SIDEBAR SCROLL
# ═══════════════════════════════════════════════════════════════════

async def scroll_sidebar(tab, px: int = 600) -> Tuple[bool, str]:
    """Scroll sidebar — also scrolls window briefly to trigger YT lazy loading."""
    # Window scroll to trigger lazy loading
    await js(tab, f"window.scrollBy(0, {px});")
    await asyncio.sleep(1.0)
    await js(tab, f"window.scrollBy(0, -{px});")

    # Also scroll #secondary element
    result = await js(tab, f"""
        var s = document.querySelector('#secondary, #related');
        if (s) {{ s.scrollTop += {px}; return 'SIDEBAR_SCROLLED:{px}px'; }}
        return 'SIDEBAR_NOT_FOUND';
    """)
    await asyncio.sleep(2)
    related = await js(tab, "return document.querySelectorAll('ytd-compact-video-renderer').length;")
    return True, f"{result} | related_visible={related}"


# ═══════════════════════════════════════════════════════════════════
# 18. HUMAN BEHAVIOR MANAGER
# ═══════════════════════════════════════════════════════════════════

class HumanBehaviorManager:
    """
    Manages human-like behavior during a watch session.
    Tracks state, performs random actions, guards autoplay OFF.
    """

    def __init__(self, tab):
        self.tab   = tab
        self.state = {
            "autoplay":   False,  # always off
            "liked":      False,
            "disliked":   False,
            "subscribed": False,
            "volume":     70,
        }
        self._autoplay_guard_task = None

    async def _random_delay(self, base: float = 0.1):
        await asyncio.sleep(max(0.05, _rng.gauss(base, base * 0.3)))

    async def random_scroll(self):
        delta = _rng.randint(100, 400) * _rng.choice([1, -1])
        await js(self.tab, f"window.scrollBy(0, {delta});")
        await self._random_delay(0.5)

    async def random_volume_tweak(self):
        delta = _rng.randint(3, 12) * _rng.choice([1, -1])
        cur = await js(self.tab, "return Math.round((document.querySelector('video')?.volume||0.7)*100);")
        try:
            new_v = max(10, min(95, int(str(cur)) + delta))
        except Exception:
            new_v = 65
        await set_volume(self.tab, new_v)
        self.state["volume"] = new_v

    async def random_small_seek(self):
        sec = _rng.choice([5, 10, -5, -10])
        await seek_by(self.tab, sec)

    async def random_pause_resume(self):
        await pause_video(self.tab)
        await asyncio.sleep(_rng.uniform(1.5, 4.0))
        await play_video(self.tab)

    async def check_description(self):
        await expand_description_links(self.tab, open_links=False)

    async def autoplay_guard_loop(self, check_interval: float = 30.0):
        """Periodically ensure autoplay stays OFF."""
        while True:
            try:
                await asyncio.sleep(check_interval)
                cur = await js(self.tab, """
                    var btn = document.querySelector('button[aria-label*="Autoplay"]');
                    if (!btn) return 'unknown';
                    return (btn.getAttribute('aria-label')||'').toLowerCase().includes('is on') ? 'on' : 'off';
                """)
                if str(cur) == "on":
                    print("    [autoplay_guard] Autoplay turned ON — disabling...")
                    await set_autoplay(self.tab, want_on=False)
            except asyncio.CancelledError:
                break
            except Exception:
                pass

    def start_autoplay_guard(self, interval: float = 30.0):
        """Start background task to keep autoplay OFF."""
        if self._autoplay_guard_task is None or self._autoplay_guard_task.done():
            self._autoplay_guard_task = asyncio.ensure_future(
                self.autoplay_guard_loop(interval))
        return self._autoplay_guard_task

    def stop_autoplay_guard(self):
        if self._autoplay_guard_task and not self._autoplay_guard_task.done():
            self._autoplay_guard_task.cancel()

    async def watch_session(self, duration: float = 60.0):
        """
        Simulate a human watch session for `duration` seconds.
        Randomly picks actions with weights. Autoplay guard runs in background.
        """
        # Define actions with weights
        actions = [
            (self.random_scroll,        4),
            (self.random_volume_tweak,  2),
            (self.random_small_seek,    2),
            (self.random_pause_resume,  1),
            (self.check_description,    1),
        ]
        weights = [w for _, w in actions]
        funcs   = [f for f, _ in actions]

        self.start_autoplay_guard(interval=25.0)

        start = time.monotonic()
        while time.monotonic() - start < duration:
            fn = _rng.choices(funcs, weights=weights, k=1)[0]
            try:
                await fn()
            except Exception as e:
                print(f"    [human] action error: {e}")
            # Random wait between actions
            await asyncio.sleep(max(2.0, _rng.gauss(6.0, 2.0)))

        self.stop_autoplay_guard()
        return f"WATCH_SESSION_DONE duration={round(time.monotonic()-start)}s"
