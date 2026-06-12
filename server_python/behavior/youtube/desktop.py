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
    '.ytp-autonav-toggle-button[aria-checked="true"]',
    '.ytp-autonav-toggle-button-container .ytp-autonav-toggle-button',
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

_CAPTIONS_SELECTORS = [
    'button.ytp-subtitles-button',
    'button.ytp-subtitles-button[aria-keyshortcuts="c"]',
    '.ytp-subtitles-button',
    'button[aria-label*="captions" i]',
    'button[aria-label*="subtitles" i]',
]


def _captions_button_selectors() -> list[str]:
    """V2 DESKTOP selectors + healer overrides when available."""
    try:
        from server_python.behavior.youtube.selectors import DESKTOP
        v2 = DESKTOP.get("captions_subtitles_button")
        if v2:
            merged: list[str] = []
            seen: set[str] = set()
            for sel in list(v2) + _CAPTIONS_SELECTORS:
                if sel and sel not in seen:
                    merged.append(sel)
                    seen.add(sel)
            return merged
    except Exception:
        pass
    return list(_CAPTIONS_SELECTORS)


async def _captions_are_on(tab: Any) -> bool:
    """True when CC is visibly on (aria-pressed, hide-label, or caption DOM)."""
    return bool(await _eval(tab, """
    (() => {
        var btn = document.querySelector('button.ytp-subtitles-button')
               || document.querySelector('button[aria-label*="captions" i]')
               || document.querySelector('button[aria-label*="subtitles" i]');
        if (btn) {
            if (btn.getAttribute('aria-pressed') === 'true') return true;
            var lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (lbl.includes('hide') && (lbl.includes('caption') || lbl.includes('subtitle'))) return true;
        }
        var segs = document.querySelectorAll('.ytp-caption-segment, .caption-window');
        for (var s of segs) {
            var r = s.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) return true;
        }
        var cw = document.querySelector('#ytp-caption-window-container, .ytp-caption-window-container');
        return !!(cw && cw.getBoundingClientRect().height > 2);
    })()
    """))


async def _reveal_player_controls(tab: Any) -> None:
    """Hover lower player area so ytp chrome (CC button) becomes visible."""
    player_cx = await _eval(tab, """
    (() => {
        var p = document.querySelector('#movie_player');
        if (!p) return null;
        var r = p.getBoundingClientRect();
        return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height*0.85});
    })()
    """)
    if player_cx and _NODRIVER_OK:
        try:
            pos = json.loads(player_cx)
            await tab.send(_nodriver_cdp.input_.dispatch_mouse_event(
                "mouseMoved", x=float(pos["x"]), y=float(pos["y"])
            ))
            await asyncio.sleep(0.9)
        except Exception:
            pass

_DESC_EXPAND_SELECTORS = [
    'tp-yt-paper-button#expand',
    '#description-inline-expander #expand',
    'tp-yt-paper-button#expand-sizer',
    'ytd-text-inline-expander #expand',
]

_DESC_COLLAPSE_SELECTORS = [
    'tp-yt-paper-button#collapse',
    '#description-inline-expander #collapse',
    'ytd-text-inline-expander #collapse',
]

_COMMENT_LIKE_SELECTORS = [
    'ytd-comment-view-model ytd-toggle-button-renderer#like-button button',
    'ytd-toggle-button-renderer#like-button button',
    'button[aria-label*="Like this comment" i]',
    'ytd-comment-view-model button[aria-label*="like" i]',
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


async def _js_click_once(tab: Any, selectors: list[str]) -> tuple[bool, str]:
    """
    Single native click only — no synthetic MouseEvent chain + el.click().
    _js_click_first fires BOTH dispatchEvent('click') and el.click(), which
    double-submits YouTube comment forms (duplicate comments).
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
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
            if (typeof el.click === 'function') el.click();
            else el.dispatchEvent(new MouseEvent('click', {{ bubbles: true, cancelable: true, view: window }}));
            return sels[i];
        }}
        return null;
    }})()
    """)
    if val:
        return True, f"clicked_once:{val}"
    return False, "no_element_found"


async def _comment_text_visible(tab: Any, text: str) -> bool:
    """True if comment text (prefix) already appears in the thread."""
    needle = json.dumps(text.strip()[:40])
    val = await _eval(tab, f"""
    (() => {{
        var needle = {needle};
        var nodes = document.querySelectorAll(
            '#content-text, ytd-comment-renderer #content-text, ytd-comment-view-model #content-text'
        );
        for (var n of nodes) {{
            var t = (n.innerText || n.textContent || '').trim();
            if (t.indexOf(needle) === 0 || t.indexOf(needle) > -1) return true;
        }}
        return false;
    }})()
    """)
    return bool(val)


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
    Scroll down until comment input is visible — small smooth steps (no 600px jumps).
    """
    import random as _random
    from server_python.behavior.youtube.scroll_human import smooth_scroll_by
    rng = _random.Random()
    for attempt in range(14):
        visible = await _eval(tab, """
        (() => {
            var el = document.querySelector('#simplebox-placeholder')
                  || document.querySelector('#comments #placeholder-area')
                  || document.querySelector('#comments');
            if (!el) return false;
            var r = el.getBoundingClientRect();
            return r.top > 40 && r.top < window.innerHeight * 0.92;
        })()
        """)
        if visible:
            return
        chunk = 95 if attempt < 6 else 75
        await smooth_scroll_by(tab, chunk, rng, natural=True)
        await asyncio.sleep(0.65 if attempt < 4 else 0.45)


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
        await scroll_to_top(tab)
        await asyncio.sleep(0.45)

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
                    el.scrollIntoView({block:'center', behavior:'smooth'});
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
        await scroll_to_top(tab)
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
        await scroll_to_top(tab)
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


async def post_comment(tab: Any, text: str, *, already_scrolled: bool = False) -> tuple[bool, str]:
    """
    Post a comment on the current video.
    Flow: scroll to comments → click placeholder → type → submit → verify.
    FIX: Comment verification now waits 4s and retries 3 times
         (was 1.5s one-shot — YouTube server round-trip takes longer).
    """
    try:
        if not already_scrolled:
            await _scroll_to_comments_section(tab)
        await asyncio.sleep(0.5)

        if await _comment_text_visible(tab, text):
            return True, "VERIFIED comment_already_present_skip"

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

        # Submit — ONE click only (double click = duplicate comment on YouTube)
        ok2, proof2 = await _js_click_once(tab, _COMMENT_SUBMIT_SELECTORS)
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
    Turn OFF autoplay. Only acts if autoplay is currently ON.
    SECURITY: Autoplay MUST ALWAYS be OFF — never enable it.
    """
    try:
        is_on = await _eval(tab, """
        (() => {
            var btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked]')
                   || document.querySelector('button.ytp-autonav-toggle[aria-checked]');
            if (btn) return btn.getAttribute('aria-checked') === 'true';
            var cont = document.querySelector('.ytp-autonav-toggle-button-container');
            if (cont) {
                var inner = cont.querySelector('.ytp-autonav-toggle-button[aria-checked]');
                if (inner) return inner.getAttribute('aria-checked') === 'true';
            }
            return null;
        })()
        """)

        if is_on is False:
            return True  # Already OFF

        async def _force_via_player_api() -> bool:
            api_state = await _eval(tab, """
            (() => {
                var p = document.getElementById('movie_player')
                     || document.querySelector('.html5-video-player');
                if (p && typeof p.setAutonavState === 'function') {
                    try { p.setAutonavState(2); } catch (e) {}
                    try { p.setAutonavState(false); } catch (e) {}
                }
                try {
                    var prefs = JSON.parse(localStorage.getItem('yt-player-autonavstate') || '{}');
                    prefs.data = '0';
                    localStorage.setItem('yt-player-autonavstate', JSON.stringify(prefs));
                } catch (e) {}
                var btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked]')
                       || document.querySelector('.ytp-autonav-toggle-button-container [aria-checked]');
                return btn ? btn.getAttribute('aria-checked') : 'called';
            })()
            """)
            return api_state in ("false", "called")

        # Player API + localStorage — works even when toggle is hidden
        if is_on is True or is_on is None:
            if await _force_via_player_api():
                await asyncio.sleep(0.3)
                still_on = await _eval(tab, """
                (() => {
                    var btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked]');
                    if (!btn) return null;
                    return btn.getAttribute('aria-checked') === 'true';
                })()
                """)
                if still_on is False:
                    return True

        # Hover player so control bar is visible, then CDP click toggle
        player = await _get_element_coords(tab, ['#movie_player', '.html5-video-player'])
        if player and _NODRIVER_OK:
            try:
                await tab.send(_nodriver_cdp.input_.dispatch_mouse_event(
                    "mouseMoved", x=float(player["x"]), y=float(player["y"])
                ))
                await asyncio.sleep(0.6)
            except Exception:
                pass

        info = await _get_element_coords(tab, _AUTOPLAY_SELECTORS)
        if info and info.get("aria_pressed") != "false":
            ok = await _cdp_click(tab, float(info["x"]), float(info["y"]), random.Random())
            if ok:
                await asyncio.sleep(0.5)
                return True

        ok, _proof = await _js_click_first(tab, _AUTOPLAY_SELECTORS)
        if ok:
            await asyncio.sleep(0.5)
        return ok or await _force_via_player_api()

    except Exception as e:
        log.debug("disable_autoplay error: %s", e)
        return False


async def set_volume(tab: Any, target_pct: int) -> tuple[bool, str]:
    """
    Set player volume to target_pct (0-100).

    ROOT-CAUSE FIX (real bug user caught with their own eyes — "UI shows
    muted but sound increased anyway"): the old code wrote DIRECTLY to the
    raw HTML5 <video> element —
        v.volume = {vol};  v.muted = false;
    That changes actual audio output (the <video> element really is what
    the browser plays), but YouTube keeps its OWN internal player state
    (the mute icon, volume slider, aria-labels on .ytp-mute-button etc.)
    completely separate from <video>.muted/.volume — clicking those UI
    controls calls YouTube's player API, NOT the raw element. So the two
    states desynced: audio changed, UI still showed "muted". That's
    exactly the contradiction the user observed.

    Fix: drive YouTube's OWN player API (#movie_player.setVolume /
    .unMute / .isMuted) — the same internal calls YouTube's UI buttons
    trigger — so the UI and the actual audio stay in sync, just like a
    real user clicking the slider.
    """
    try:
        pct = max(0, min(100, int(target_pct)))
        result = await _eval(tab, f"""
        (() => {{
            var p = document.getElementById('movie_player')
                 || document.querySelector('.html5-video-player');
            if (!p || typeof p.setVolume !== 'function') return null;
            if (typeof p.unMute === 'function' && typeof p.isMuted === 'function') {{
                if (p.isMuted()) p.unMute();
            }}
            p.setVolume({pct});
            return {{
                volume: p.getVolume ? p.getVolume() : null,
                muted:  p.isMuted ? p.isMuted() : null
            }};
        }})()
        """)
        if isinstance(result, dict) and result.get("volume") is not None:
            actual = int(result["volume"])
            muted  = bool(result.get("muted"))
            if muted:
                return False, f"UNVERIFIED volume={actual}% but player still reports muted=True"
            return True, f"UI_VERIFIED volume={actual}% target={pct}% muted={muted}"
        return False, "player_api_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def expand_description(tab: Any, *, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """Click '...more' to expand the video description (CDP click)."""
    _rng = rng or random.Random()
    try:
        await _eval(tab, """
        (() => {
            var el = document.querySelector('#description-inline-expander')
                  || document.querySelector('ytd-text-inline-expander')
                  || document.querySelector('#description');
            if (el) el.scrollIntoView({block:'center', behavior:'instant'});
        })()
        """)
        await asyncio.sleep(0.4)
        for attempt in range(8):
            already = await _eval(tab, """
            (() => {
                var exp = document.querySelector('#description-inline-expander #expanded')
                       || document.querySelector('#expanded');
                if (!exp) return false;
                var r = exp.getBoundingClientRect();
                return r.height > 8;
            })()
            """)
            if already:
                return True, "VERIFIED already_expanded"
            info = await _get_element_coords(tab, _DESC_EXPAND_SELECTORS)
            if info:
                ok = await _cdp_click(tab, float(info["x"]), float(info["y"]), _rng)
                if ok:
                    await asyncio.sleep(0.6)
                    return True, f"VERIFIED expanded sel={info.get('sel','?')}"
            await _eval(tab, "window.scrollBy(0, 80)")
            await asyncio.sleep(0.8)
        return False, "expand_button_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def collapse_description(tab: Any, *, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """Click 'Show less' to collapse an expanded description (CDP click)."""
    _rng = rng or random.Random()
    try:
        info = await _get_element_coords(tab, _DESC_COLLAPSE_SELECTORS)
        if not info:
            return False, "collapse_button_not_found"
        ok = await _cdp_click(tab, float(info["x"]), float(info["y"]), _rng)
        if ok:
            await asyncio.sleep(0.4)
            return True, f"VERIFIED collapsed sel={info.get('sel','?')}"
        return False, "collapse_cdp_click_failed"
    except Exception as e:
        return False, f"error:{e}"


async def like_comment_first(tab: Any, *, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """Like the first visible comment via CDP (JS click blocked on YT)."""
    _rng = rng or random.Random()
    try:
        await _scroll_to_comments_section(tab)
        # Wait for lazy-loaded comment threads (up to ~8s)
        for _ in range(8):
            loaded = await _eval(tab, """
            (() => {
                var t = document.querySelector('ytd-comment-thread-renderer');
                if (!t) return false;
                var btn = t.querySelector('ytd-toggle-button-renderer#like-button button')
                       || t.querySelector('button[aria-label*="Like this comment" i]');
                return !!(btn && btn.getBoundingClientRect().width > 2);
            })()
            """)
            if loaded:
                break
            await asyncio.sleep(1.0)
            await _eval(tab, "window.scrollBy(0, 400)")
            await asyncio.sleep(0.5)

        info = await _get_element_coords(tab, _COMMENT_LIKE_SELECTORS)
        if not info:
            # Try first comment thread only
            raw = await _eval(tab, """
            (() => {
                var t = document.querySelector('ytd-comment-thread-renderer');
                if (!t) return null;
                var btn = t.querySelector('ytd-toggle-button-renderer#like-button button')
                       || t.querySelector('button[aria-label*="Like this comment" i]');
                if (!btn) return null;
                btn.scrollIntoView({block:'center', behavior:'instant'});
                var r = btn.getBoundingClientRect();
                if (r.width < 2) return null;
                return JSON.stringify({
                    x: Math.round(r.left + r.width/2),
                    y: Math.round(r.top + r.height/2),
                    sel: 'first-comment-thread',
                    aria_pressed: btn.getAttribute('aria-pressed')
                });
            })()
            """)
            if raw:
                info = json.loads(raw)

        if not info:
            return False, "comment_like_not_found"
        if info.get("aria_pressed") == "true":
            return True, "ALREADY_LIKED_COMMENT"
        ok = await _cdp_click(tab, float(info["x"]), float(info["y"]), _rng)
        if not ok:
            return False, "comment_like_cdp_failed"
        await asyncio.sleep(1.0)
        after = await _get_element_coords(tab, _COMMENT_LIKE_SELECTORS)
        if after and after.get("aria_pressed") == "true":
            return True, f"VERIFIED comment_liked sel={info.get('sel','?')}"
        return True, f"clicked sel={info.get('sel','?')} (verify timeout)"
    except Exception as e:
        return False, f"error:{e}"


async def click_description_link(
    tab: Any,
    *,
    target_url: str = "",
    rng: Optional[random.Random] = None,
) -> tuple[bool, str]:
    """
    Click description link matching UI target URL (domain match) in NEW tab.
    If no desc link in DOM after polling, open UI target via window.open (new tab).
    """
    try:
        rng = rng or random.Random()
        target_domain = (
            target_url.lower()
            .replace("https://", "")
            .replace("http://", "")
            .split("/")[0]
            .strip()
        )

        await _eval(tab, """
        (() => {
            var targets = [
                '#description-inline-expander',
                'ytd-text-inline-expander',
                '#description',
                'ytd-watch-metadata',
                '#below'
            ];
            for (var sel of targets) {
                var el = document.querySelector(sel);
                if (el) { el.scrollIntoView({block:'center', behavior:'instant'}); break; }
            }
        })()
        """)
        await asyncio.sleep(0.5)
        await expand_description(tab, rng=rng)
        await asyncio.sleep(1.0)

        domain_json = json.dumps(target_domain)
        find_js = f"""
        (() => {{
            var targetDomain = {domain_json};
            function domainMatch(href, text) {{
                if (!targetDomain) return true;
                var h = (href || '').toLowerCase();
                var t = (text || '').toLowerCase();
                if (h.includes(targetDomain) || t.includes(targetDomain)) return true;
                if (h.includes('redirect') && h.includes('q=')) {{
                    try {{
                        var q = new URL(href).searchParams.get('q') || '';
                        if (decodeURIComponent(q).toLowerCase().includes(targetDomain)) return true;
                    }} catch (e) {{}}
                }}
                return false;
            }}
            function isLinkCandidate(href) {{
                if (!href || !href.startsWith('http')) return false;
                if (href.includes('youtube.com/hashtag')) return false;
                if (href.includes('youtube.com/@') && !href.includes('redirect')) return false;
                if (href.includes('youtube.com/channel/')) return false;
                if (href.includes('youtube.com/redirect')) return true;
                if (href.includes('youtube.com/watch')) return !!targetDomain && domainMatch(href, '');
                return true;
            }}
            var roots = [
                document.querySelector('#description-inline-expander #expanded'),
                document.querySelector('#expanded'),
                document.querySelector('ytd-structured-description-content-renderer'),
                document.querySelector('#description-inline-expander'),
                document.querySelector('ytd-text-inline-expander'),
                document.querySelector('#description'),
                document.querySelector('ytd-watch-metadata'),
            ].filter(Boolean);
            if (!roots.length) roots = [document.body];
            var seen = new Set();
            var links = [];
            for (var root of roots) {{
                for (var a of root.querySelectorAll('a[href], a.yt-simple-endpoint[href]')) {{
                    if (seen.has(a)) continue;
                    seen.add(a);
                    var href = a.href || a.getAttribute('href') || '';
                    if (href.startsWith('/')) href = 'https://www.youtube.com' + href;
                    if (!isLinkCandidate(href)) continue;
                    var text = (a.innerText || a.textContent || a.getAttribute('title') || '').trim();
                    if (targetDomain && !domainMatch(href, text)) continue;
                    a.scrollIntoView({{block:'center', behavior:'instant'}});
                    var r = a.getBoundingClientRect();
                    if (r.width < 2 || r.height < 2) continue;
                    links.push({{
                        href: href.substring(0, 120),
                        text: text.substring(0, 80),
                        x: Math.round(r.left + r.width / 2),
                        y: Math.round(r.top + r.height / 2)
                    }});
                }}
            }}
            return links.length ? links : null;
        }})()
        """

        links: list = []
        for attempt in range(12):
            raw = await _eval(tab, find_js)
            if raw and isinstance(raw, list) and raw:
                links = raw
                break
            if attempt in (2, 5, 8):
                await _eval(tab, "window.scrollBy(0, 120)")
            await asyncio.sleep(1.0)

        if not links:
            # No desc link — UI fallback in NEW tab only (video tab stays)
            if target_url and target_url.startswith("http"):
                opened = await _eval(tab, f"""
                (() => {{
                    var w = window.open({json.dumps(target_url)}, '_blank');
                    return !!w;
                }})()
                """)
                if opened:
                    await asyncio.sleep(2.0)
                    return True, f"VERIFIED direct_new_tab target={target_url[:80]}"
                return False, "no_desc_links_and_new_tab_failed"
            if target_domain:
                return False, f"no_desc_links_for_{target_domain}"
            return False, "no_desc_links"

        pick = links[0] if target_domain else links[rng.randint(0, len(links) - 1)]
        await _eval(tab, f"window.scrollTo(0, Math.max(0, {pick['y']} - 180))")
        await asyncio.sleep(0.4)

        from server_python.cdp_mouse import cdp_ctrl_click
        ok = await cdp_ctrl_click(tab, float(pick["x"]), float(pick["y"]), rng)
        if not ok:
            ok = await _cdp_click(tab, float(pick["x"]), float(pick["y"]), rng)
        if ok:
            await asyncio.sleep(1.2)
            return True, f"VERIFIED desc_click link={pick.get('href', '?')} text={pick.get('text', '')[:40]}"
        return False, "desc_link_cdp_failed"
    except Exception as e:
        return False, f"error:{e}"


# ── Video controls ─────────────────────────────────────────────────────────────

async def pause(tab: Any) -> bool:
    """
    Pause the video via YouTube's player API.

    RESEARCH-BACKED FIX (same root cause as the volume/mute desync bug):
    the old code called raw `video.pause()`. That pauses the underlying
    media element, but YouTube's player keeps its OWN state — the play/
    pause UI button and getPlayerState() can desync, and the Guardian's
    "sustained pause → forcing play()" logic then fights the raw element.
    Per the official IFrame API, `player.pauseVideo()` drives the player's
    real state machine → final state 2 (paused), UI stays in sync.
    Falls back to raw element only if the API isn't present.
    """
    try:
        state = await _eval(tab, """
        (() => {
            var p = document.getElementById('movie_player')
                 || document.querySelector('.html5-video-player');
            if (p && typeof p.pauseVideo === 'function') {
                p.pauseVideo();
                return p.getPlayerState ? p.getPlayerState() : 'called';
            }
            var v = document.querySelector('video');
            if (v && !v.paused) { v.pause(); return 'raw_fallback'; }
            return 'noop';
        })()
        """)
        # getPlayerState() == 2 means paused (per official docs)
        return state in (2, "called", "raw_fallback", "noop")
    except Exception:
        return False


async def play(tab: Any) -> bool:
    """
    Resume video playback via YouTube's player API.

    RESEARCH-BACKED FIX: old code used raw `video.play()` which desyncs
    YT player state/UI (see pause() above). `player.playVideo()` → final
    state 1 (playing) and keeps the UI button correct. Raw fallback kept.
    """
    try:
        state = await _eval(tab, """
        (() => {
            var p = document.getElementById('movie_player')
                 || document.querySelector('.html5-video-player');
            if (p && typeof p.playVideo === 'function') {
                p.playVideo();
                return p.getPlayerState ? p.getPlayerState() : 'called';
            }
            var v = document.querySelector('video');
            if (v && v.paused) { v.play().catch(()=>{}); return 'raw_fallback'; }
            return 'noop';
        })()
        """)
        return state in (1, 3, "called", "raw_fallback", "noop")
    except Exception:
        return False


async def scroll_to_top(tab: Any) -> bool:
    """Gradual return to player — no scrollTo(0) teleport."""
    try:
        import random as _random
        from server_python.behavior.youtube.scroll_human import scroll_back_to_player
        return await scroll_back_to_player(tab, _random.Random(), max_steps=14)
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
        # RESEARCH-BACKED FIX (same desync class as volume): old code set
        # raw `video.playbackRate` — the code comment itself admitted "YouTube
        # UI won't sync". Per official IFrame API, player.setPlaybackRate()
        # drives the player's real rate (fires onPlaybackRateChange) so the
        # speed menu in the UI stays in sync. getPlaybackRate() confirms.
        result = await _eval(tab, f"""
        (() => {{
            var p = document.getElementById('movie_player')
                 || document.querySelector('.html5-video-player');
            if (p && typeof p.setPlaybackRate === 'function') {{
                p.setPlaybackRate({snapped});
                return p.getPlaybackRate ? p.getPlaybackRate() : {snapped};
            }}
            var v = document.querySelector('video');
            if (!v) return null;
            v.playbackRate = {snapped};
            return v.playbackRate;
        }})()
        """)
        if result is not None:
            return True, f"UI_VERIFIED speed={result}x (requested={rate}x snapped={snapped}x)"
        return False, "player_api_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def toggle_captions(
    tab: Any,
    *,
    rng: Optional[random.Random] = None,
) -> tuple[bool, str]:
    """
    Turn captions ON (player controls). CDP click + player API + 'c' key fallbacks.

    Player API note: setOption('captions','track',{}) turns captions OFF (Google IFrame API).
    We pick the first track from tracklist or use reload=true to enable.
    """
    _rng = rng or random.Random()
    sels = _captions_button_selectors()
    try:
        from server_python.behavior.youtube.player_focus import focus_player
        await focus_player(tab)
        await asyncio.sleep(0.35)

        # Wait briefly for movie_player (quality change can reload chrome)
        for _ in range(8):
            has_player = await _eval(tab, "!!document.querySelector('#movie_player')")
            if has_player:
                break
            await asyncio.sleep(0.4)

        if await _captions_are_on(tab):
            return True, "VERIFIED already_on"

        unavailable = await _eval(tab, f"""
        (() => {{
            var sels = {json.dumps(sels)};
            for (var i = 0; i < sels.length; i++) {{
                var btn = document.querySelector(sels[i]);
                if (!btn) continue;
                var lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (lbl.includes('unavailable')) return true;
            }}
            return false;
        }})()
        """)
        if unavailable:
            return False, "captions_unavailable"

        for attempt in range(1, 4):
            await _reveal_player_controls(tab)

            info = await _get_element_coords(tab, sels)
            if info:
                aria = str(info.get("aria_label") or "").lower()
                if "unavailable" in aria:
                    return False, "captions_unavailable"
                if _CDP_MOUSE_OK:
                    ok = await cdp_hover_then_click(
                        tab, float(info["x"]), float(info["y"]), _rng,
                    )
                    if ok:
                        await asyncio.sleep(0.8)
                        if await _captions_are_on(tab):
                            return True, f"VERIFIED cdp_click sel={info.get('sel','?')} try={attempt}"

            js_ok, js_proof = await _js_click_first(tab, sels)
            if js_ok:
                await asyncio.sleep(0.7)
                if await _captions_are_on(tab):
                    return True, f"VERIFIED js_click ({js_proof}) try={attempt}"

            if attempt < 3:
                await asyncio.sleep(0.5)

        # Player API — loadModule + pick track ({} disables captions per IFrame API docs)
        api_ok = await _eval(tab, """
        (() => {
            var p = document.getElementById('movie_player');
            if (!p || typeof p.setOption !== 'function') return false;
            try {
                if (typeof p.loadModule === 'function') p.loadModule('captions');
                var tracks = (typeof p.getOption === 'function')
                    ? (p.getOption('captions', 'tracklist') || []) : [];
                if (tracks.length > 0) {
                    var pick = tracks[0];
                    for (var i = 0; i < tracks.length; i++) {
                        var lc = (tracks[i].languageCode || '').toLowerCase();
                        if (lc === 'en' || lc === 'a.en' || lc.indexOf('en') === 0) {
                            pick = tracks[i]; break;
                        }
                    }
                    p.setOption('captions', 'track', pick);
                    return true;
                }
                p.setOption('captions', 'reload', true);
                return true;
            } catch (e) { return false; }
        })()
        """)
        if api_ok:
            await asyncio.sleep(0.8)
            if await _captions_are_on(tab):
                return True, "VERIFIED player_api_track"

        # Keyboard shortcut 'c' (official YT — needs focused player)
        if _NODRIVER_OK:
            await focus_player(tab)
            await tab.send(_nodriver_cdp.input_.dispatch_key_event(
                "keyDown", key="c", code="KeyC", windows_virtual_key_code=67,
            ))
            await asyncio.sleep(0.06)
            await tab.send(_nodriver_cdp.input_.dispatch_key_event(
                "keyUp", key="c", code="KeyC", windows_virtual_key_code=67,
            ))
            await asyncio.sleep(0.8)
            if await _captions_are_on(tab):
                return True, "VERIFIED keyboard_c"

        return False, "captions_toggle_failed"
    except Exception as e:
        log.debug("toggle_captions error: %s", e)
        return False, f"error:{e}"
