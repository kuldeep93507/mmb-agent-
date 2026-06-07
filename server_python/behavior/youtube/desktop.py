"""
behavior.youtube.desktop — All desktop YouTube engagement actions.
Imported as: from behavior.youtube import desktop as yt_desktop

Uses V2 selectors (MMB_YOUTUBE_SELECTORS_FINAL_V2.py) directly via CDP/JS.
No external module dependencies — pure nodriver tab.evaluate() calls.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Optional

log = logging.getLogger("mmb.yt_desktop")

# ── V2 Selector constants (inline for reliability) ────────────────────────────

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

# ── Core helper ───────────────────────────────────────────────────────────────

async def _eval(tab: Any, js: str) -> Any:
    try:
        result = await tab.evaluate(js, return_by_value=True)
        return getattr(result, "value", result)
    except Exception as e:
        log.debug("eval error: %s", e)
        return None


async def _js_click_first(tab: Any, selectors: list[str]) -> tuple[bool, str]:
    """Try each selector, click first visible one. Returns (ok, proof)."""
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


async def _scroll_to_comments_section(tab: Any) -> None:
    """Scroll down until comment input is visible."""
    for _ in range(8):
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
        await _eval(tab, "window.scrollBy(0, 400)")
        await asyncio.sleep(0.6)


# ── Public API ────────────────────────────────────────────────────────────────

async def like(tab: Any, *, want: bool = True, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """
    Like the video using CDP mouse events (YouTube blocks JS .click() on like button).
    Checks state first. Returns (success, proof) where proof contains "VERIFIED" on success.
    """
    _rng = rng or random.Random()
    try:
        # Scroll to top so like button is in viewport
        await _eval(tab, "window.scrollTo(0, 0)")
        await asyncio.sleep(0.5)

        # Check if already liked (pick first visible button with w > 0)
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

        # CDP mouse click (real events — not blocked by YouTube)
        from server_python.cdp_mouse import cdp_hover_then_click
        x, y = float(info["x"]), float(info["y"])
        ok = await cdp_hover_then_click(tab, x, y, _rng)
        if not ok:
            return False, "cdp_click_failed"

        await asyncio.sleep(1.0)

        # Verify state changed
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


async def dislike(tab: Any, *, want: bool = True) -> tuple[bool, str]:
    """Dislike the video."""
    try:
        await _eval(tab, "window.scrollTo(0, 0)")
        await asyncio.sleep(0.3)

        already = await _eval(tab, """
        (() => {
            var btn = document.querySelector('dislike-button-view-model button')
                   || document.querySelector('button[aria-label*="Dislike" i]');
            return btn ? btn.getAttribute('aria-pressed') === 'true' : false;
        })()
        """)
        if already and want:
            return True, "ALREADY_DISLIKED_VERIFIED"

        ok, proof = await _js_click_first(tab, _DISLIKE_SELECTORS)
        if not ok:
            return False, "dislike_button_not_found"

        await asyncio.sleep(0.6)
        return ok, f"VERIFIED {proof}"

    except Exception as e:
        return False, f"error:{e}"


async def subscribe(tab: Any, *, want: bool = True, rng: Optional[random.Random] = None) -> tuple[bool, str]:
    """Subscribe to the channel using CDP mouse click."""
    _rng = rng or random.Random()
    try:
        await _eval(tab, "window.scrollTo(0, 0)")
        await asyncio.sleep(0.4)

        # Check if already subscribed — must be VISIBLE bell (no 'invisible' attr) OR unsubscribe button
        subscribed = await _eval(tab, """
        (() => {
            // Check for visible bell button (notification toggle) - must NOT have 'invisible' attr
            var bellSelectors = [
                'button[aria-label*="notification setting" i]',
                'ytd-subscription-notification-toggle-button-renderer-next button',
                'ytd-subscription-notification-toggle-button-renderer button'
            ];
            for (var sel of bellSelectors) {
                var el = document.querySelector(sel);
                if (!el) continue;
                // Check parent container for 'invisible' attribute — YouTube sets this when NOT subscribed
                var parent = el.closest('#notification-preference-button, [id*="notification"]');
                if (parent && (parent.hasAttribute('invisible') || parent.getAttribute('hidden') !== null)) continue;
                var r = el.getBoundingClientRect();
                if (r.width > 4 && r.height > 4) return true;  // visible bell = subscribed
            }
            // Check subscribe button aria-label for "Unsubscribe"
            var subs = document.querySelectorAll('button');
            for (var b of subs) {
                var al = (b.getAttribute('aria-label')||'').toLowerCase();
                if (al.startsWith('unsubscribe')) return true;
            }
            // Check if subscribe button text says "Subscribed"
            var subBtn = document.querySelector('ytd-subscribe-button-renderer button, #subscribe-button button');
            if (subBtn) {
                var txt = (subBtn.textContent || '').trim().toLowerCase();
                if (txt === 'subscribed') return true;
            }
            return false;
        })()
        """)
        if subscribed and want:
            return True, "ALREADY_SUBSCRIBED_VERIFIED"

        # Find subscribe button and get its coordinates
        btn_info = await _eval(tab, """
        (() => {
            var selectors = [
                'button[aria-label^="Subscribe to" i]',
                'ytd-subscribe-button-renderer button',
                '#subscribe-button button',
                'subscribe-button-view-model button'
            ];
            for (var sel of selectors) {
                var els = document.querySelectorAll(sel);
                for (var el of els) {
                    var r = el.getBoundingClientRect();
                    if (r.width < 4) continue;
                    el.scrollIntoView({block:'center', behavior:'instant'});
                    r = el.getBoundingClientRect();
                    return JSON.stringify({x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), sel:sel});
                }
            }
            return null;
        })()
        """)
        if not btn_info:
            return False, "subscribe_button_not_found"

        info = json.loads(btn_info)
        from server_python.cdp_mouse import cdp_hover_then_click
        ok = await cdp_hover_then_click(tab, float(info["x"]), float(info["y"]), _rng)
        if not ok:
            return False, "cdp_click_failed"

        await asyncio.sleep(1.5)

        # Verify — bell should now be VISIBLE (not invisible) after subscribing
        bell_visible = await _eval(tab, """
        (() => {
            var selectors = [
                'button[aria-label*="notification setting" i]',
                'ytd-subscription-notification-toggle-button-renderer-next button',
                'ytd-subscription-notification-toggle-button-renderer button'
            ];
            for (var sel of selectors) {
                var el = document.querySelector(sel);
                if (!el) continue;
                var parent = el.closest('#notification-preference-button, [id*="notification"]');
                if (parent && parent.hasAttribute('invisible')) continue;
                var r = el.getBoundingClientRect();
                if (r.width > 4 && r.height > 4) return true;
            }
            return false;
        })()
        """)
        if bell_visible:
            return True, f"VERIFIED subscribed=True cdp_click sel={info.get('sel','?')}"
        # Subscribe click happened but bell not visible — ACTUALLY FAILED, not success
        return False, f"UNVERIFIED subscribe_clicked_but_bell_not_visible"

    except Exception as e:
        return False, f"error:{e}"


async def toggle_bell(tab: Any, rng: Optional[random.Random] = None) -> bool:
    """Click the bell button to open notification menu. Returns True if opened.
    IMPORTANT: Only works after user is subscribed — bell is invisible before that."""
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
                // Must NOT be inside an invisible container (happens before subscribing)
                var parent = el.closest('#notification-preference-button');
                if (parent && parent.hasAttribute('invisible')) continue;
                var r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                return JSON.stringify({x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)});
            }
            return null;
        })()
        """)
        if not btn_info:
            log.debug("toggle_bell: bell button not visible (not subscribed yet?)")
            return False
        info = json.loads(btn_info)
        from server_python.cdp_mouse import cdp_hover_then_click
        ok = await cdp_hover_then_click(tab, float(info["x"]), float(info["y"]), _rng)
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
        # Find menu items and click the one matching level
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
                return 'fallback:' + (items[0].innerText||'').trim();
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
    Flow: scroll to comments → click placeholder → type → submit
    """
    try:
        await _scroll_to_comments_section(tab)
        await asyncio.sleep(0.5)

        # Click placeholder to activate comment box
        ok, proof = await _js_click_first(tab, _COMMENT_PLACEHOLDER_SELECTORS)
        if not ok:
            return False, "comment_placeholder_not_found"
        await asyncio.sleep(0.8)

        # Focus the active input (real focus, not execCommand text injection —
        # YouTube's modern comment box rejects document.execCommand('insertText'))
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

        # Type CHARACTER BY CHARACTER via CDP Input.insertText — looks like real
        # human typing (with small randomized delays), not an instant paste.
        # (A single insert_text(full_text) call lands the whole string in one
        # frame — that's what made it look "pasted" instead of typed.)
        try:
            from nodriver import cdp
            rng = random.Random()
            for ch in text:
                await tab.send(cdp.input_.insert_text(ch))
                await asyncio.sleep(rng.uniform(0.04, 0.18))
                # occasional slightly longer pause, like a human thinking
                if rng.random() < 0.08:
                    await asyncio.sleep(rng.uniform(0.25, 0.6))
        except Exception as e:
            return False, f"cdp_insert_text_failed:{e}"

        await asyncio.sleep(0.6)

        # Verify text actually landed in the box before submitting
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

        # Click submit
        ok2, proof2 = await _js_click_first(tab, _COMMENT_SUBMIT_SELECTORS)
        if not ok2:
            return False, "comment_submit_not_found"

        await asyncio.sleep(1.5)

        # Verify the comment actually appears in the comment list (real proof,
        # not just "submit button was clicked")
        posted = await _eval(tab, f"""
        (() => {{
            var nodes = document.querySelectorAll('#content-text, ytd-comment-renderer #content-text');
            var needle = {json.dumps(text.strip()[:30])};
            for (var n of nodes) {{
                var t = (n.innerText || n.textContent || '').trim();
                if (t.indexOf(needle) === 0 || t.indexOf(needle) > -1) return true;
            }}
            return false;
        }})()
        """)
        if posted:
            return True, f"VERIFIED comment_posted_and_visible sel={proof2}"
        return False, f"UNVERIFIED comment_submitted_but_not_visible sel={proof2}"

    except Exception as e:
        return False, f"error:{e}"


async def disable_autoplay(tab: Any) -> bool:
    """
    Turn OFF autoplay. Only clicks if autoplay is currently ON.
    SECURITY: Autoplay MUST ALWAYS be OFF — never enable it.
    """
    try:
        # Check current state
        is_on = await _eval(tab, """
        (() => {
            var btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked]')
                   || document.querySelector('button.ytp-autonav-toggle[aria-checked]');
            if (btn) return btn.getAttribute('aria-checked') === 'true';
            // Alternative: check container
            var cont = document.querySelector('.ytp-autonav-toggle-button-container');
            if (cont) return cont.getAttribute('aria-checked') === 'true';
            return null;
        })()
        """)

        if is_on is False:
            return True  # Already OFF — no action needed

        # Click to toggle OFF
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
    """Click a random link in the video description."""
    try:
        rng = rng or random.Random()
        # Expand description first
        await expand_description(tab)
        await asyncio.sleep(0.5)

        # Get all description links
        count = await _eval(tab, """
        (() => {
            var desc = document.querySelector('#description') || document.querySelector('#description-inline-expander');
            if (!desc) return 0;
            var links = desc.querySelectorAll('a[href]');
            // Filter out hashtag/channel links
            var ext = Array.from(links).filter(a => {
                var h = a.href || '';
                return h.startsWith('http') && !h.includes('youtube.com/hashtag') && !h.includes('youtube.com/@');
            });
            return ext.length;
        })()
        """)
        if not count:
            return False

        idx = rng.randint(0, int(count) - 1)
        clicked = await _eval(tab, f"""
        (() => {{
            var desc = document.querySelector('#description') || document.querySelector('#description-inline-expander');
            if (!desc) return null;
            var links = Array.from(desc.querySelectorAll('a[href]')).filter(a => {{
                var h = a.href || '';
                return h.startsWith('http') && !h.includes('youtube.com/hashtag') && !h.includes('youtube.com/@');
            }});
            var el = links[{idx}];
            if (el) {{ el.click(); return el.href; }}
            return null;
        }})()
        """)
        return bool(clicked)
    except Exception:
        return False


# ── Missing functions required by agent_manager ───────────────────────────────

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
    Set video playback rate (e.g. 1.25, 1.5, 2.0).
    Returns (ok, proof).
    """
    try:
        rate = max(0.25, min(2.0, float(rate)))
        result = await _eval(tab, f"""
        (() => {{
            var v = document.querySelector('video');
            if (!v) return null;
            v.playbackRate = {rate};
            return v.playbackRate;
        }})()
        """)
        if result is not None:
            return True, f"UI_VERIFIED speed={result}x"
        return False, "video_element_not_found"
    except Exception as e:
        return False, f"error:{e}"


async def toggle_captions(tab: Any) -> bool:
    """
    Toggle captions/subtitles. Hovers over player first to reveal controls,
    then JS-clicks the CC button (JS .click() works for CC — not blocked by YouTube).
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
        if player_cx:
            pos = json.loads(player_cx)
            try:
                from nodriver import cdp
                await tab.send(cdp.input_.dispatch_mouse_event(
                    "mouseMoved", x=float(pos["x"]), y=float(pos["y"])
                ))
                await asyncio.sleep(0.8)  # controls fadein
            except Exception:
                pass

        # Step 2: Check if CC button exists and is available
        cc_info = await _eval(tab, """
        (() => {
            var btn = document.querySelector('button.ytp-subtitles-button');
            if (!btn) btn = document.querySelector('button[aria-label*="captions" i]');
            if (!btn) btn = document.querySelector('button[aria-label*="subtitles" i]');
            if (!btn) return null;
            var r = btn.getBoundingClientRect();
            return JSON.stringify({w: r.width, aria: btn.getAttribute('aria-label') || ''});
        })()
        """)
        if not cc_info:
            return False

        info = json.loads(cc_info)
        # Skip if captions unavailable for this video
        aria = info.get("aria", "").lower()
        if "unavailable" in aria and info.get("w", 0) < 4:
            return False  # No captions available for this video

        # Step 3: JS .click() — works for CC button (not blocked by YouTube)
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
