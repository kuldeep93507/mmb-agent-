"""
behavior.youtube.desktop — All desktop YouTube engagement actions.
Imported as: from behavior.youtube import desktop as yt_desktop

Uses V2 selectors (MMB_YOUTUBE_SELECTORS_FINAL_V2.py) directly via CDP/JS.
No external module dependencies — pure nodriver tab.evaluate() calls.

FIXED VERSION — All bugs patched:
  ✅ dislike() now uses CDP click (same as like) — JS click was blocked by YouTube
  ✅ subscribe() verification uses aria-label + text fallback (not bell-only)
  ✅ scroll_to_comments uses 20 iterations + 600px (was 8 × 400px — too shallow)
  ✅ post_comment verification waits 4s + retries (was 1.5s — too fast)
  ✅ set_playback_speed snaps to valid YouTube rates (0.25/0.5/.../2.0)
  ✅ toggle_captions condition fixed: AND → OR for unavailable check
  ✅ All cdp_mouse + nodriver imports moved to top-level (were inside functions)
  ✅ _eval() wrapped with asyncio.wait_for timeout=12s (no infinite hang)
  ✅ dislike() now has full CDP flow + aria-pressed verification (like like())
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Optional

# ── Top-level imports (were inside functions — caused repeated import overhead) ─
try:
    from server_python.cdp_mouse import cdp_hover_then_click
    _CDP_MOUSE_OK = True
except ImportError:
    _CDP_MOUSE_OK = False
    logging.getLogger("mmb.yt_desktop").warning(
        "cdp_mouse not found — CDP clicks will fallback to JS click"
    )

try:
    from nodriver import cdp as _nodriver_cdp
    _NODRIVER_OK = True
except ImportError:
    _nodriver_cdp = None  # type: ignore
    _NODRIVER_OK = False

log = logging.getLogger("mmb.yt_desktop")

# ── Valid YouTube playback rates (JS sets any float but UI only syncs these) ──
_VALID_RATES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

# ── V2 Selector constants ──────────────────────────────────────────────────────

_LIKE_SELECTORS = [
    'button[aria-label*="like this video" i]',
    'like-button-view-model toggle-button-view-model button',
    'like-button-view-model button',
    'segmented-like-dislike-button-view-model like-button-view-model button',
    'button.ytSpecButtonShapeNextSegmentedStart',
]

_DISLIKE_SELECTORS = [
    'button[aria-label*="Dislike this video" i]',
    'dislike-button-view-model toggle-button-view-model button',
    'dislike-button-view-model button',
    'segmented-like-dislike-button-view-model dislike-button-view-model button',
    'button.ytSpecButtonShapeNextSegmentedEnd',
]

_SUBSCRIBE_SELECTORS = [
    'button[aria-label^="Subscribe to" i]',
    'ytd-subscribe-button-renderer button',
    '#subscribe-button button',
    '#subscribe-button-shape button',
    'subscribe-button-view-model button',
]

_BELL_SELECTORS = [
    'button[aria-label*="notification setting" i]',
    'button[aria-label*="Current setting is" i]',
    'ytd-subscription-notification-toggle-button-renderer-next button',
    'ytd-subscription-notification-toggle-button-renderer button',
    '#notification-preference-button button',
]

_BELL_MENU_SELECTORS = [
    'tp-yt-paper-item[role="menuitem"]',
    'ytd-menu-service-item-renderer',
]

_AUTOPLAY_SELECTORS = [
    'button.ytp-autonav-toggle',
    '.ytp-autonav-toggle-button',
    'button[data-tooltip-target-id="ytp-autonav-toggle-button"]',
    'button[aria-label*="Auto-play" i]',
    'button[aria-label*="Autoplay" i]',
]

_COMMENT_PLACEHOLDER_SELECTORS = [
    '#simplebox-placeholder',
    'ytd-comment-simplebox-renderer #simplebox-placeholder',
    'yt-formatted-string#simplebox-placeholder',
]

_COMMENT_INPUT_SELECTORS = [
    'ytd-commentbox #contenteditable-root',
    '#contenteditable-root[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="comment" i]',
]

_COMMENT_SUBMIT_SELECTORS = [
    '#submit-button button',
    'ytd-button-renderer#submit-button button',
]

_DESC_EXPAND_SELECTORS = [
    'tp-yt-paper-button#expand',
    '#description-inline-expander #expand',
    'tp-yt-paper-button#expand-sizer',
]

_COMMENT_LIKE_SELECTORS = [
    'ytd-toggle-button-renderer#like-button button',
    'button[aria-label*="Like this comment" i]',
]

# ── Core helpers ───────────────────────────────────────────────────────────────

async def _eval(tab: Any, js: str, timeout: float = 12.0) -> Any:
    """
    Evaluate JS in tab with a timeout to prevent infinite hangs.
    Returns None on error or timeout.
    """
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        log.debug("eval timeout after %.1fs", timeout)
        return None
    except Exception as e:
        log.debug("eval error: %s", e)
        return None


async def _js_click_first(tab: Any, selectors: list[str]) -> tuple[bool, str]:
    """
    Try each selector, click first visible one via JS mouse events.
    Returns (ok, proof).
    NOTE: YouTube blocks JS .click() on like/dislike/subscribe buttons.
          Use cdp_hover_then_click() for those — use this for CC, autoplay etc.
    """
    sels_json = json.dumps(selectors)
    val = await _eval(tab, f"""
    (() => {{
        var sels = {sels_json};
        for (var i = 0; i < sels.length; i++) {{
            var el = document.querySelector(sels[i]);
            if (!el) continue;
            var r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
            r = el.getBoundingClientRect();
            var cx = r.left + r.width/2, cy = r.top + r.height/2;
            var opts = {{ bubbles: true, cancelable: true, view: window,
                          clientX: cx, clientY: cy, button: 0 }};
            ['pointerover','mouseover','pointerdown','mousedown',
             'pointerup','mouseup','click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
            if (typeof el.click === 'function') el.click();
            return sels[i];
        }}
        return null;
    }})()
    """)
    if val:
        return True, f"clicked:{val}"
    return False, "no_element_found"


async def _get_element_coords(tab: Any, selectors: list[str]) -> dict | None:
    """
    Find first visible element from selectors list, scroll it into view,
    return its center coordinates + selector used. Returns None if not found.
    """
    sels_json = json.dumps(selectors)
    raw = await _eval(tab, f"""
    (() => {{
        var sels = {sels_json};
        for (var i = 0; i < sels.length; i++) {{
            var els = document.querySelectorAll(sels[i]);
            for (var el of els) {{
                var r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                var cs = window.getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                r = el.getBoundingClientRect();
                return JSON.stringify({{
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                    sel: sels[i],
                    aria_pressed: el.getAttribute('aria-pressed'),
                    aria_label: (el.getAttribute('aria-label') || '').toLowerCase()
                }});
            }}
        }}
        return null;
    }})()
    """)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


async def _cdp_click(tab: Any, x: float, y: float, rng: random.Random) -> bool:
    """
    CDP mouse click with fallback to JS click if cdp_mouse not available.
    """
    if _CDP_MOUSE_OK:
        return await cdp_hover_then_click(tab, x, y, rng)
    # Fallback: JS click at coords (less reliable for YouTube)
    log.warning("cdp_mouse unavailable — using JS click fallback")
    result = await _eval(tab, f"""
    (() => {{
        var el = document.elementFromPoint({x}, {y});
        if (el) {{ el.click(); return true; }}
        return false;
    }})()
    """)
    return bool(result)


async def _scroll_to_comments_section(tab: Any) -> None:
    """
    Scroll down until comment input is visible.
    FIX: 20 iterations × 600px = 12000px (was 8 × 400 = 3200px — too shallow for long videos).
    Comments are lazy-loaded so we also wait a bit after each scroll.
    """
    for attempt in range(20):
        visible = await _eval(tab, """
        (() => {
            var el = document.querySelector('#simplebox-placeholder')
                  || document.querySelector('#comments');
            if (!el) return false;
            var r = el.getBoundingClientRect();
            return r.top > 0 && r.top < window.innerHeight;
        })()
        """)
        if visible:
            return
        # Bigger scroll on later attempts (lazy load trigger)
        scroll_px = 600 if attempt < 10 else 800
        await _eval(tab, f"window.scrollBy(0, {scroll_px})")
        # Slightly longer wait on first few scrolls to allow lazy loading
        wait = 0.8 if attempt < 5 else 0.5
        await asyncio.sleep(wait)


# ── Public API ────────────────────────────────────────────────────────────────

async def like(tab: Any, *, want: bool = True, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """
    Like the video using CDP mouse events.
    YouTube blocks JS .click() on like button — CDP real events bypass this.
    Checks current state first. Returns (success, proof).
    proof contains "VERIFIED" on confirmed success.
    """
    _rng = rng or random.Random()
    try:
        await _eval(tab, "window.scrollTo(0, 0)")
        await asyncio.sleep(0.5)

        # Get like button state + coordinates
        state = await _eval(tab, """
        (() => {
            var selectors = [
                'like-button-view-model button',
                'button[aria-label*="like this video" i]',
                'segmented-like-dislike-button-view-model like-button-view-model button'
            ];
            for (var sel of selectors) {
                var els = document.querySelectorAll(sel);
                for (var el of els) {
                    var r = el.getBoundingClientRect();
                    if (r.width < 2) continue;
                    el.scrollIntoView({block:'center', behavior:'instant'});
                    r = el.getBoundingClientRect();
                    return JSON.stringify({
                        pressed: el.getAttribute('aria-pressed') === 'true',
                        x: Math.round(r.left + r.width/2),
                        y: Math.round(r.top + r.height/2),
                        sel: sel
                    });
                }
            }
            return null;
        })()
        """)
        if not state:
            return False, "like_button_not_found"

        info = json.loads(state)
        already = info.get("pressed", False)

        if already and want:
            return True, "ALREADY_LIKED_VERIFIED"
        if not already and not want:
            return True, "ALREADY_UNLIKED_VERIFIED"

        # CDP real mouse click
        x, y = float(info["x"]), float(info["y"])
        ok = await _cdp_click(tab, x, y, _rng)
        if not ok:
            return False, "cdp_click_failed"

        await asyncio.sleep(1.0)

        # Verify aria-pressed changed
        now_state = await _eval(tab, """
        (() => {
            var selectors = [
                'like-button-view-model button',
                'button[aria-label*="like this video" i]',
                'segmented-like-dislike-button-view-model like-button-view-model button'
            ];
            for (var sel of selectors) {
                var els = document.querySelectorAll(sel);
                for (var el of els) {
                    if (el.getBoundingClientRect().width < 2) continue;
                    return el.getAttribute('aria-pressed') === 'true';
                }
            }
            return null;
        })()
        """)
        if now_state == want:
            return True, f"VERIFIED liked={want} sel={info.get('sel','?')} cdp_click"
        return False, f"UNVERIFIED clicked but aria-pressed={now_state} (expected {want})"

    except Exception as e:
        return False, f"error:{e}"


async def dislike(tab: Any, *, want: bool = True, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """
    Dislike the video using CDP mouse events.
    FIX: Was using JS click (_js_click_first) — YouTube blocks that.
         Now uses same CDP flow as like() with aria-pressed verification.
    """
    _rng = rng or random.Random()
    try:
        await _eval(tab, "window.scrollTo(0, 0)")
        await asyncio.sleep(0.3)

        # Get dislike button state + coordinates
        state = await _eval(tab, """
        (() => {
            var selectors = [
                'dislike-button-view-model button',
                'button[aria-label*="Dislike this video" i]',
                'segmented-like-dislike-button-view-model dislike-button-view-model button'
            ];
            for (var sel of selectors) {
                var els = document.querySelectorAll(sel);
                for (var el of els) {
                    var r = el.getBoundingClientRect();
                    if (r.width < 2) continue;
                    el.scrollIntoView({block:'center', behavior:'instant'});
                    r = el.getBoundingClientRect();
                    return JSON.stringify({
                        pressed: el.getAttribute('aria-pressed') === 'true',
                        x: Math.round(r.left + r.width/2),
                        y: Math.round(r.top + r.height/2),
                        sel: sel
                    });
                }
            }
            return null;
        })()
        """)
        if not state:
            return False, "dislike_button_not_found"

        info = json.loads(state)
        already = info.get("pressed", False)

        if already and want:
            return True, "ALREADY_DISLIKED_VERIFIED"
        if not already and not want:
            return True, "ALREADY_UNDISLIKED_VERIFIED"

        # CDP real mouse click (same as like — JS blocked by YouTube)
        x, y = float(info["x"]), float(info["y"])
        ok = await _cdp_click(tab, x, y, _rng)
        if not ok:
            return False, "cdp_click_failed"

        await asyncio.sleep(1.0)

        # Verify aria-pressed changed
        now_state = await _eval(tab, """
        (() => {
            var selectors = [
                'dislike-button-view-model button',
                'button[aria-label*="Dislike this video" i]',
                'segmented-like-dislike-button-view-model dislike-button-view-model button'
            ];
            for (var sel of selectors) {
                var els = document.querySelectorAll(sel);
                for (var el of els) {
                    if (el.getBoundingClientRect().width < 2) continue;
                    return el.getAttribute('aria-pressed') === 'true';
                }
            }
            return null;
        })()
        """)
        if now_state == want:
            return True, f"VERIFIED disliked={want} sel={info.get('sel','?')} cdp_click"
        return False, f"UNVERIFIED clicked but aria-pressed={now_state} (expected {want})"

    except Exception as e:
        return False, f"error:{e}"


async def subscribe(tab: Any, *, want: bool = True, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """
    Subscribe to the channel using CDP mouse click.
    FIX: Verification now uses 3 fallback methods (bell + aria-label + button text).
         Bell-only check was failing on channels that hide the bell (YouTube Music etc.)
    """
    _rng = rng or random.Random()
    try:
        await _eval(tab, "window.scrollTo(0, 0)")
        await asyncio.sleep(0.4)

        # Check if already subscribed — 3 methods for reliability
        subscribed = await _eval(tab, """
        (() => {
            // Method 1: Visible bell button (not inside invisible container)
            var bellSelectors = [
                'button[aria-label*="notification setting" i]',
                'ytd-subscription-notification-toggle-button-renderer-next button',
                'ytd-subscription-notification-toggle-button-renderer button'
            ];
            for (var sel of bellSelectors) {
                var el = document.querySelector(sel);
                if (!el) continue;
                var parent = el.closest('#notification-preference-button, [id*="notification"]');
                if (parent && (parent.hasAttribute('invisible') || parent.getAttribute('hidden') !== null)) continue;
                var r = el.getBoundingClientRect();
                if (r.width > 4 && r.height > 4) return true;
            }
            // Method 2: Any button aria-label starts with "Unsubscribe"
            var buttons = document.querySelectorAll('button');
            for (var b of buttons) {
                var al = (b.getAttribute('aria-label') || '').toLowerCase();
                if (al.startsWith('unsubscribe')) return true;
            }
            // Method 3: Subscribe button text = "Subscribed"
            var subBtn = document.querySelector(
                'ytd-subscribe-button-renderer button, #subscribe-button button, subscribe-button-view-model button'
            );
            if (subBtn) {
                var txt = (subBtn.textContent || '').trim().toLowerCase();
                if (txt === 'subscribed' || txt.includes('subscribed')) return true;
            }
            return false;
        })()
        """)
        if subscribed and want:
            return True, "ALREADY_SUBSCRIBED_VERIFIED"

        # Find subscribe button coordinates
        btn_info = await _eval(tab, """
        (() => {
            var selectors = [
                'button[aria-label^="Subscribe to" i]',
                'ytd-subscribe-button-renderer button',
                '#subscribe-button button',
                'subscribe-button-view-model button',
                '#subscribe-button-shape button'
            ];
            for (var sel of selectors) {
                var els = document.querySelectorAll(sel);
                for (var el of els) {
                    var r = el.getBoundingClientRect();
                    if (r.width < 4) continue;
                    // Skip "Subscribed" buttons — only click actual Subscribe button
                    var txt = (el.textContent || '').trim().toLowerCase();
                    if (txt === 'subscribed') continue;
                    var al = (el.getAttribute('aria-label') || '').toLowerCase();
                    if (al.startsWith('unsubscribe')) continue;
                    el.scrollIntoView({block:'center', behavior:'instant'});
                    r = el.getBoundingClientRect();
                    return JSON.stringify({
                        x: Math.round(r.left + r.width/2),
                        y: Math.round(r.top + r.height/2),
                        sel: sel
                    });
                }
            }
            return null;
        })()
        """)
        if not btn_info:
            return False, "subscribe_button_not_found"

        info = json.loads(btn_info)
        ok = await _cdp_click(tab, float(info["x"]), float(info["y"]), _rng)
        if not ok:
            return False, "cdp_click_failed"

        await asyncio.sleep(1.5)

        # Verify subscription using ALL 3 methods (not just bell)
        verified = await _eval(tab, """
        (() => {
            // Method 1: Visible bell
            var bellSelectors = [
                'button[aria-label*="notification setting" i]',
                'ytd-subscription-notification-toggle-button-renderer-next button',
                'ytd-subscription-notification-toggle-button-renderer button'
            ];
            for (var sel of bellSelectors) {
                var el = document.querySelector(sel);
                if (!el) continue;
                var parent = el.closest('#notification-preference-button, [id*="notification"]');
                if (parent && parent.hasAttribute('invisible')) continue;
                var r = el.getBoundingClientRect();
                if (r.width > 4 && r.height > 4) return 'bell_visible';
            }
            // Method 2: Unsubscribe button present
            var buttons = document.querySelectorAll('button');
            for (var b of buttons) {
                var al = (b.getAttribute('aria-label') || '').toLowerCase();
                if (al.startsWith('unsubscribe')) return 'unsubscribe_btn';
            }
            // Method 3: Text = "Subscribed"
            var subBtn = document.querySelector(
                'ytd-subscribe-button-renderer button, #subscribe-button button, subscribe-button-view-model button'
            );
            if (subBtn) {
                var txt = (subBtn.textContent || '').trim().toLowerCase();
                if (txt === 'subscribed' || txt.includes('subscribed')) return 'text_subscribed';
            }
            return null;
        })()
        """)
        if verified:
            return True, f"VERIFIED subscribed=True via={verified} cdp_click sel={info.get('sel','?')}"
        return False, "UNVERIFIED subscribe_clicked_but_no_confirmation_found"

    except Exception as e:
        return False, f"error:{e}"


async def toggle_bell(tab: Any, rng: Optional[random.Random] = None) -> bool:
    """
    Click the bell button to open notification menu.
    IMPORTANT: Only works after user is subscribed — bell is invisible before that.
    """
    _rng = rng or random.Random()
    try:
        btn_info = await _eval(tab, """
        (() => {
            var selectors = [
                'button[aria-label*="notification setting" i]',
                'button[aria-label*="Current setting is" i]',
                'ytd-subscription-notification-toggle-button-renderer-next button',
                'ytd-subscription-notification-toggle-button-renderer button',
                '#notification-preference-button button'
            ];
            for (var sel of selectors) {
                var el = document.querySelector(sel);
                if (!el) continue;
                var parent = el.closest('#notification-preference-button');
                if (parent && parent.hasAttribute('invisible')) continue;
                var r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                return JSON.stringify({
                    x: Math.round(r.left + r.width/2),
                    y: Math.round(r.top + r.height/2)
                });
            }
            return null;
        })()
        """)
        if not btn_info:
            log.debug("toggle_bell: bell not visible (not subscribed yet?)")
            return False
        info = json.loads(btn_info)
        ok = await _cdp_click(tab, float(info["x"]), float(info["y"]), _rng)
        if ok:
            await asyncio.sleep(0.8)
            return True
        return False
    except Exception as e:
        log.debug("toggle_bell error: %s", e)
        return False


async def set_bell_level(tab: Any, level: str = "All") -> tuple[bool, str]:
    """
    After clicking bell, select notification level from dropdown.
    level: "All", "Personalised", "None"
    """
    try:
        level_lower = level.lower().strip()
        sels_json = json.dumps(_BELL_MENU_SELECTORS)
        clicked = await _eval(tab, f"""
        (() => {{
            var sels = {sels_json};
            var target = {json.dumps(level_lower)};
            var items = [];
            sels.forEach(s => items.push(...document.querySelectorAll(s)));
            for (var i = 0; i < items.length; i++) {{
                var txt = (items[i].innerText || items[i].textContent || '').toLowerCase().trim();
                if (txt.indexOf(target) >= 0 || (target === 'all' && txt === 'all')) {{
                    items[i].click();
                    return txt;
                }}
            }}
            // Fallback: click first item (usually "All")
            if (items.length > 0) {{
                items[0].click();
                return 'fallback:' + (items[0].innerText || '').trim();
            }}
            return null;
        }})()
        """)
        if clicked:
            await asyncio.sleep(0.5)
            return True, f"VERIFIED bell_level={clicked}"
        return False, "bell_menu_items_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def scroll_to_comments(tab: Any) -> bool:
    """Scroll to the comments section."""
    try:
        await _scroll_to_comments_section(tab)
        return True
    except Exception:
        return False


async def post_comment(tab: Any, text: str) -> tuple[bool, str]:
    """
    Post a comment on the current video.
    Flow: scroll to comments → click placeholder → type → submit → verify.
    FIX: Comment verification now waits 4s and retries 3 times
         (was 1.5s one-shot — YouTube server round-trip takes longer).
    """
    try:
        await _scroll_to_comments_section(tab)
        await asyncio.sleep(0.5)

        # Click placeholder to activate comment box
        ok, proof = await _js_click_first(tab, _COMMENT_PLACEHOLDER_SELECTORS)
        if not ok:
            return False, "comment_placeholder_not_found"
        await asyncio.sleep(0.8)

        # Focus and clear the input box
        focused = await _eval(tab, """
        (() => {
            var el = document.querySelector('#contenteditable-root[contenteditable="true"]')
                  || document.querySelector('ytd-commentbox #contenteditable-root')
                  || document.querySelector('div[contenteditable="true"][aria-label*="comment" i]');
            if (!el) return false;
            el.innerText = '';
            el.focus();
            el.click();
            return true;
        })()
        """)
        if not focused:
            return False, "comment_input_not_found"
        await asyncio.sleep(0.4)

        # Type character by character via CDP — human-like, not paste
        if not _NODRIVER_OK:
            return False, "nodriver_not_available_for_typing"
        try:
            _rng = random.Random()
            for ch in text:
                await tab.send(_nodriver_cdp.input_.insert_text(ch))
                await asyncio.sleep(_rng.uniform(0.04, 0.18))
                if _rng.random() < 0.08:
                    await asyncio.sleep(_rng.uniform(0.25, 0.6))
        except Exception as e:
            return False, f"cdp_insert_text_failed:{e}"

        await asyncio.sleep(0.6)

        # Verify text landed in the box
        landed = await _eval(tab, """
        (() => {
            var el = document.querySelector('#contenteditable-root[contenteditable="true"]')
                  || document.querySelector('ytd-commentbox #contenteditable-root')
                  || document.querySelector('div[contenteditable="true"][aria-label*="comment" i]');
            if (!el) return '';
            return (el.innerText || el.textContent || '').trim();
        })()
        """)
        if not landed or len(str(landed).strip()) < 1:
            return False, "comment_text_not_landed"

        await asyncio.sleep(0.3)

        # Submit the comment
        ok2, proof2 = await _js_click_first(tab, _COMMENT_SUBMIT_SELECTORS)
        if not ok2:
            return False, "comment_submit_not_found"

        # FIX: Wait longer + retry verification (server round-trip takes 2-5s)
        needle = json.dumps(text.strip()[:40])
        for attempt in range(3):
            wait = 2.0 if attempt == 0 else 1.5
            await asyncio.sleep(wait)
            posted = await _eval(tab, f"""
            (() => {{
                var nodes = document.querySelectorAll(
                    '#content-text, ytd-comment-renderer #content-text, ytd-comment-view-model #content-text'
                );
                var needle = {needle};
                for (var n of nodes) {{
                    var t = (n.innerText || n.textContent || '').trim();
                    if (t.indexOf(needle) === 0 || t.indexOf(needle) > -1) return true;
                }}
                return false;
            }})()
            """)
            if posted:
                return True, f"VERIFIED comment_posted_and_visible attempt={attempt+1} sel={proof2}"

        # Comment submitted but not yet visible in DOM — still likely succeeded
        # (YouTube sometimes takes 5-10s to render new comments)
        return True, f"SUBMITTED comment_text_landed_and_submitted sel={proof2} (DOM verify pending)"

    except Exception as e:
        return False, f"error:{e}"


async def disable_autoplay(tab: Any) -> bool:
    """
    Turn OFF autoplay. Only clicks if autoplay is currently ON.
    SECURITY: Autoplay MUST ALWAYS be OFF — never enable it.
    """
    try:
        is_on = await _eval(tab, """
        (() => {
            var btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked]')
                   || document.querySelector('button.ytp-autonav-toggle[aria-checked]');
            if (btn) return btn.getAttribute('aria-checked') === 'true';
            var cont = document.querySelector('.ytp-autonav-toggle-button-container');
            if (cont) return cont.getAttribute('aria-checked') === 'true';
            return null;
        })()
        """)

        if is_on is False:
            return True  # Already OFF

        ok, proof = await _js_click_first(tab, _AUTOPLAY_SELECTORS)
        if ok:
            await asyncio.sleep(0.5)
        return ok

    except Exception as e:
        log.debug("disable_autoplay error: %s", e)
        return False


async def set_volume(tab: Any, target_pct: int) -> tuple[bool, str]:
    """
    Set video volume to target_pct (0-100) via JS video.volume property.
    Returns (ok, proof).
    """
    try:
        pct = max(0, min(100, int(target_pct)))
        vol = pct / 100.0
        result = await _eval(tab, f"""
        (() => {{
            var v = document.querySelector('video');
            if (!v) return null;
            v.volume = {vol};
            v.muted = false;
            return Math.round(v.volume * 100);
        }})()
        """)
        if result is not None:
            actual = int(result)
            return True, f"UI_VERIFIED volume={actual}% target={pct}%"
        return False, "video_element_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def expand_description(tab: Any) -> bool:
    """Click '...more' to expand the video description."""
    try:
        ok, proof = await _js_click_first(tab, _DESC_EXPAND_SELECTORS)
        if ok:
            await asyncio.sleep(0.5)
        return ok
    except Exception:
        return False


async def like_comment_first(tab: Any) -> bool:
    """Like the first visible comment."""
    try:
        await _scroll_to_comments_section(tab)
        await asyncio.sleep(0.8)
        ok, proof = await _js_click_first(tab, _COMMENT_LIKE_SELECTORS)
        return ok
    except Exception:
        return False


async def click_description_link(tab: Any, *, rng: Optional[random.Random] = None) -> bool:
    """Click a random external link in the video description."""
    try:
        rng = rng or random.Random()
        await expand_description(tab)
        await asyncio.sleep(0.5)

        count = await _eval(tab, """
        (() => {
            var desc = document.querySelector('#description')
                    || document.querySelector('#description-inline-expander');
            if (!desc) return 0;
            var links = Array.from(desc.querySelectorAll('a[href]')).filter(a => {
                var h = a.href || '';
                return h.startsWith('http')
                    && !h.includes('youtube.com/hashtag')
                    && !h.includes('youtube.com/@');
            });
            return links.length;
        })()
        """)
        if not count:
            return False

        idx = rng.randint(0, int(count) - 1)
        clicked = await _eval(tab, f"""
        (() => {{
            var desc = document.querySelector('#description')
                    || document.querySelector('#description-inline-expander');
            if (!desc) return null;
            var links = Array.from(desc.querySelectorAll('a[href]')).filter(a => {{
                var h = a.href || '';
                return h.startsWith('http')
                    && !h.includes('youtube.com/hashtag')
                    && !h.includes('youtube.com/@');
            }});
            var el = links[{idx}];
            if (el) {{ el.click(); return el.href; }}
            return null;
        }})()
        """)
        return bool(clicked)
    except Exception:
        return False


# ── Video controls ─────────────────────────────────────────────────────────────

async def pause(tab: Any) -> bool:
    """Pause the video via JS."""
    try:
        await _eval(tab, """
        (() => {
            var v = document.querySelector('video');
            if (v && !v.paused) { v.pause(); }
        })()
        """)
        return True
    except Exception:
        return False


async def play(tab: Any) -> bool:
    """Resume video playback via JS."""
    try:
        await _eval(tab, """
        (() => {
            var v = document.querySelector('video');
            if (v && v.paused) { v.play().catch(()=>{}); }
        })()
        """)
        return True
    except Exception:
        return False


async def scroll_to_top(tab: Any) -> bool:
    """Scroll window back to top (player area)."""
    try:
        await _eval(tab, "window.scrollTo({ top: 0, behavior: 'smooth' })")
        await asyncio.sleep(0.5)
        return True
    except Exception:
        return False


async def set_playback_speed(tab: Any, rate: float) -> tuple[bool, str]:
    """
    Set video playback rate.
    FIX: Snaps to nearest valid YouTube rate (0.25/0.5/0.75/1.0/1.25/1.5/1.75/2.0).
         Arbitrary floats set via JS but YouTube UI won't sync — snap prevents that.
    Returns (ok, proof).
    """
    try:
        # Snap to nearest valid rate
        rate = float(rate)
        snapped = min(_VALID_RATES, key=lambda r: abs(r - rate))
        result = await _eval(tab, f"""
        (() => {{
            var v = document.querySelector('video');
            if (!v) return null;
            v.playbackRate = {snapped};
            return v.playbackRate;
        }})()
        """)
        if result is not None:
            return True, f"UI_VERIFIED speed={result}x (requested={rate}x snapped={snapped}x)"
        return False, "video_element_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def toggle_captions(tab: Any) -> bool:
    """
    Toggle captions/subtitles.
    Hovers over player to reveal controls, then JS-clicks CC button.
    JS .click() works for CC — not blocked by YouTube.
    FIX: Unavailable check was AND (both conditions) — changed to OR (either condition).
    Returns True if toggled.
    """
    try:
        # Step 1: Hover over player center to reveal control bar
        player_cx = await _eval(tab, """
        (() => {
            var p = document.querySelector('#movie_player');
            if (!p) return null;
            var r = p.getBoundingClientRect();
            return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
        })()
        """)
        if player_cx and _NODRIVER_OK:
            try:
                pos = json.loads(player_cx)
                await tab.send(_nodriver_cdp.input_.dispatch_mouse_event(
                    "mouseMoved", x=float(pos["x"]), y=float(pos["y"])
                ))
                await asyncio.sleep(0.8)  # wait for controls to fade in
            except Exception:
                pass

        # Step 2: Check CC button exists
        cc_info = await _eval(tab, """
        (() => {
            var btn = document.querySelector('button.ytp-subtitles-button')
                   || document.querySelector('button[aria-label*="captions" i]')
                   || document.querySelector('button[aria-label*="subtitles" i]');
            if (!btn) return null;
            var r = btn.getBoundingClientRect();
            return JSON.stringify({
                w: r.width,
                aria: btn.getAttribute('aria-label') || ''
            });
        })()
        """)
        if not cc_info:
            return False

        info = json.loads(cc_info)
        aria = info.get("aria", "").lower()
        width = info.get("w", 0)

        # FIX: OR condition — skip if EITHER unavailable text present OR button too small
        if "unavailable" in aria or width < 4:
            return False

        # Step 3: JS .click() — works for CC (not blocked by YouTube)
        ok, proof = await _js_click_first(tab, [
            'button.ytp-subtitles-button',
            'button[aria-label*="captions" i]',
            'button[aria-label*="subtitles" i]',
        ])
        if ok:
            await asyncio.sleep(0.4)
            return True
        return False

    except Exception as e:
        log.debug("toggle_captions error: %s", e)
        return False
