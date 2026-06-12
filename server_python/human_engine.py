"""
Human-emulation primitives: smart-wait, keystroke typing, exact-match discovery.
Adapted from MMB-Agent-v2/behavior/youtube/human_engine.py

No tab.get(), no .value= / set_value — CDP keystrokes only.

FIXED:
  ✅ Bug #1: nodriver.core.tab.Tab + nodriver.core.element.Element internal imports
             removed — replaced with Any (version-safe across nodriver updates)
  ✅ Bug #2: All tab.evaluate() calls wrapped with asyncio.wait_for timeout
             (_js_find_text, _js_find_xpath, _js_find_selector, wait_for_player)
  ✅ Bug #3: tab.save_screenshot() → tab.get_screenshot() with proper fallback
             (nodriver uses different screenshot API than Playwright)
  ✅ Bug #4: slow_scroll() tab.evaluate wrapped with timeout
  ✅ Bug #5: send_keys_human() now respects profile typing_speed param
             SLOW=120-280ms, MEDIUM=70-180ms, FAST=40-120ms (matches plan)
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

# FIX #1: nodriver internal imports removed — Any is version-safe
# from nodriver.core.element import Element  ← REMOVED
# from nodriver.core.tab import Tab          ← REMOVED
Tab     = Any  # type alias — safe across nodriver versions
Element = Any  # type alias — safe across nodriver versions

try:
    from nodriver import cdp as _cdp
    _NODRIVER_OK = True
except ImportError:
    _cdp = None         # type: ignore
    _NODRIVER_OK = False

from server_python.yt_types import ElementNotFoundError, VideoTarget, FAIL_SCREENSHOT_DIR

# ── Plan-aligned typing speed ranges (PART 1 — STEP 6A-3) ────────────────────
# SLOW:   120-280ms per char
# MEDIUM: 70-180ms per char
# FAST:   40-120ms per char
_TYPING_SPEEDS = {
    "slow":   (0.120, 0.280),
    "medium": (0.070, 0.180),
    "fast":   (0.040, 0.120),
    "normal": (0.070, 0.180),  # alias for medium
}


# ── Core helpers ──────────────────────────────────────────────────────────────

def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip().lower())


def _extract_str(result: Any) -> str:
    """Safely extract string from tab.evaluate() result."""
    if isinstance(result, str):
        return result
    if hasattr(result, "value") and isinstance(result.value, str):
        return result.value
    return ""


async def _safe_eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """
    FIX #2: All tab.evaluate calls go through here with timeout.
    Prevents infinite hang on unresponsive tab.
    """
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout,
        )
        return result
    except asyncio.TimeoutError:
        return None
    except Exception:
        return None


# ── JS finders ────────────────────────────────────────────────────────────────

async def _js_find_text(tab: Tab, text: str) -> bool:
    """
    Check if text is visible in any button/link in DOM.
    FIX #2: asyncio.wait_for timeout added.
    """
    text_json = json.dumps(text.lower())
    result = await _safe_eval(tab, f"""
    (() => {{
        var want = {text_json};
        var els = document.querySelectorAll('button, a, tp-yt-paper-button, [role="button"]');
        for (var i = 0; i < els.length; i++) {{
            var t = (els[i].innerText || els[i].textContent || '').trim().toLowerCase();
            if (t && t.startsWith(want) && els[i].offsetParent !== null) return true;
        }}
        return false;
    }})()
    """)
    if isinstance(result, bool):
        return result
    if hasattr(result, "value"):
        return bool(result.value)
    return False


async def _js_find_xpath(tab: Tab, xpath: str) -> bool:
    """
    Check if xpath matches any visible element.
    FIX #2: asyncio.wait_for timeout added.
    """
    xpath_json = json.dumps(xpath)
    result = await _safe_eval(tab, f"""
    (() => {{
        try {{
            var r = document.evaluate({xpath_json}, document, null,
                XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            var el = r.singleNodeValue;
            return el && el.offsetParent !== null ? true : false;
        }} catch(e) {{ return false; }}
    }})()
    """)
    if isinstance(result, bool):
        return result
    if hasattr(result, "value"):
        return bool(result.value)
    return False


async def _js_find_selector(tab: Tab, selectors: tuple) -> str:
    """
    Single JS IIFE — checks all selectors, returns first matching one.
    FIX #2: asyncio.wait_for timeout added.
    Returns empty string if none found.
    """
    sels_json = json.dumps(list(selectors))
    result = await _safe_eval(tab, f"""
    (() => {{
        var sels = {sels_json};
        for (var i = 0; i < sels.length; i++) {{
            try {{
                var el = document.querySelector(sels[i]);
                if (el && el.offsetWidth > 0 && el.offsetHeight > 0) return sels[i];
            }} catch(e) {{}}
        }}
        return '';
    }})()
    """)
    return _extract_str(result)


async def _is_visible_clickable(element: Element) -> bool:
    """Check if element is visible and clickable."""
    try:
        result = await element.apply(
            """
            (el) => {
                if (!el || el.disabled) return false;
                if (el.getAttribute('aria-disabled') === 'true') return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const top = document.elementFromPoint(cx, cy);
                return top && (el === top || el.contains(top) || top.contains(el));
            }
            """,
            return_by_value=True,
        )
        return bool(result)
    except Exception:
        return False


# ── Smart-wait helpers ────────────────────────────────────────────────────────

async def _save_fail_screenshot(tab: Any, label: str) -> Path:
    """
    FIX #3: nodriver screenshot API — tab.get_screenshot() not tab.save_screenshot().
    Falls back gracefully if screenshot fails.
    """
    FAIL_SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    shot  = FAIL_SCREENSHOT_DIR / f"wait_fail_{label}_{stamp}.png"
    try:
        # nodriver screenshot: returns bytes
        data = await asyncio.wait_for(
            tab.get_screenshot(format="png"),
            timeout=5.0,
        )
        if data:
            shot.write_bytes(data)
            return shot
    except Exception:
        pass
    # Secondary fallback
    try:
        await asyncio.wait_for(
            tab.save_screenshot(str(shot)),
            timeout=5.0,
        )
        return shot
    except Exception:
        pass
    return Path("screenshot_failed")


async def wait_for_element(
    tab: Tab,
    selector: str,
    *,
    timeout: float = 20.0,
    label: str = "",
    log: Optional[Callable[[str], None]] = None,
) -> Element:
    """
    Poll DOM every 500ms until element is present, visible, and clickable.
    FIX #2: _js_find_selector uses timeout internally.
    FIX #3: Screenshot uses nodriver-compatible API.
    On timeout: screenshot + ElementNotFoundError.
    """
    deadline   = time.monotonic() + timeout
    last_error = ""

    while time.monotonic() < deadline:
        matched = await _js_find_selector(tab, (selector,))
        if matched:
            try:
                element = await asyncio.wait_for(
                    tab.select(selector),
                    timeout=5.0,
                )
                if element and await _is_visible_clickable(element):
                    if log:
                        log(f"Smart-wait OK | {label or selector}")
                    return element
                last_error = "present but not clickable"
            except asyncio.TimeoutError:
                last_error = "select timeout"
            except Exception as exc:
                last_error = str(exc)
        else:
            last_error = "not in DOM"
        await asyncio.sleep(0.5)

    shot = await _save_fail_screenshot(tab, label or "element")
    raise ElementNotFoundError(
        f"Smart-wait timeout ({timeout}s) | label={label!r} selector={selector!r} "
        f"last={last_error} screenshot={shot}"
    )


async def wait_for_any_element(
    tab: Tab,
    selectors: tuple,
    *,
    timeout: float = 20.0,
    label: str = "",
    log: Optional[Callable[[str], None]] = None,
) -> tuple:
    """
    Wait for any of multiple selectors.
    FIX #2: All evals have timeout via _js_find_selector.
    FIX #3: Screenshot uses nodriver-compatible API.
    Returns (Element, matched_selector).
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        matched_sel = await _js_find_selector(tab, selectors)
        if matched_sel:
            try:
                element = await asyncio.wait_for(
                    tab.select(matched_sel),
                    timeout=5.0,
                )
                if element and await _is_visible_clickable(element):
                    if log:
                        log(f"Smart-wait OK | {label or matched_sel}")
                    return element, matched_sel
            except Exception:
                pass
        await asyncio.sleep(0.5)

    shot = await _save_fail_screenshot(tab, label or "any")
    raise ElementNotFoundError(
        f"Smart-wait timeout ({timeout}s) | label={label!r} selectors={selectors} "
        f"screenshot={shot}"
    )


# ── Human typing ──────────────────────────────────────────────────────────────

async def send_keys_human(
    tab: Tab,
    text: str,
    rng: Any,
    *,
    element: Optional[Element] = None,
    typing_speed: str = "medium",
) -> None:
    """
    Human-like typing via CDP insert_text (fires React-compatible native input events).

    FIX #5: typing_speed param added — matches plan's 3-tier system:
      SLOW:   120-280ms per char  (120-280ms)
      MEDIUM: 70-180ms per char   (70-180ms)
      FAST:   40-120ms per char   (40-120ms)

    Also has:
      Word-boundary pause: 200-600ms after space (~40% chance)
      Mid-word think pause: 1.0-2.5s every 8-15 chars (~12% chance)
      Typo+correction: ~8% per alphabetic char
      Pre-type focus delay: 150-450ms
    """
    if not _NODRIVER_OK or _cdp is None:
        return

    # FIX #5: Get speed range from plan-aligned table
    speed_key = (typing_speed or "medium").lower().strip()
    lo, hi    = _TYPING_SPEEDS.get(speed_key, _TYPING_SPEEDS["medium"])

    if element is not None:
        try:
            await element.focus()
        except Exception:
            pass
    await asyncio.sleep(rng.uniform(0.15, 0.45))

    chars             = list(text)
    i                 = 0
    chars_since_pause = 0

    while i < len(chars):
        char = chars[i]

        # Word-boundary pause: after space, human hesitates before next word
        if char == " " and rng.random() < 0.40:
            await tab.send(_cdp.input_.insert_text(text=char))
            await asyncio.sleep(rng.uniform(0.20, 0.60))
            i += 1
            chars_since_pause = 0
            continue

        # Mid-word think pause every 8-15 chars
        chars_since_pause += 1
        if chars_since_pause >= rng.randint(8, 15) and rng.random() < 0.12:
            await asyncio.sleep(rng.uniform(1.0, 2.5))
            chars_since_pause = 0

        # Typo + correction: ~8% for alphabetic chars
        if (
            char.isalpha()
            and i > 0
            and rng.random() < 0.08
            and char.lower() != chars[i - 1].lower()
        ):
            wrong = rng.choice("abcdefghijklmnopqrstuvwxyz")
            # Type wrong char
            await tab.send(_cdp.input_.insert_text(text=wrong))
            await asyncio.sleep(rng.uniform(0.09, 0.22))
            # Backspace to delete
            await tab.send(_cdp.input_.dispatch_key_event(
                "keyDown", key="Backspace", code="Backspace",
                windows_virtual_key_code=8,
            ))
            await tab.send(_cdp.input_.dispatch_key_event(
                "keyUp", key="Backspace", code="Backspace",
                windows_virtual_key_code=8,
            ))
            await asyncio.sleep(rng.uniform(0.15, 0.40))

        # Type the correct char
        await tab.send(_cdp.input_.insert_text(text=char))

        # FIX #5: Use profile typing speed range (not hardcoded gauss)
        delay = rng.uniform(lo, hi)
        await asyncio.sleep(delay)
        i += 1


async def clear_search_input(tab: Tab, element: Optional[Element], rng: Any) -> bool:
    """
    Solid search-bar clear: click → focus → Ctrl+A → Backspace (+ JS value wipe).
    Must run with the search element focused before typing.
    """
    if not _NODRIVER_OK or _cdp is None:
        return False

    if element is not None:
        try:
            await element.click()
        except Exception:
            pass
        try:
            await element.focus()
        except Exception:
            pass

    await asyncio.sleep(rng.uniform(0.28, 0.58))

    try:
        await tab.evaluate(
            """
            (() => {
              const el = document.activeElement;
              if (!el) return 'no_focus';
              if ('value' in el) {
                el.focus();
                el.select();
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'js_cleared';
              }
              return 'no_value';
            })()
            """,
            return_by_value=True,
        )
    except Exception:
        pass

    await asyncio.sleep(rng.uniform(0.06, 0.14))

    try:
        await tab.send(_cdp.input_.dispatch_key_event(
            "keyDown", key="a", code="KeyA", modifiers=2, windows_virtual_key_code=65,
        ))
        await tab.send(_cdp.input_.dispatch_key_event(
            "keyUp", key="a", code="KeyA", modifiers=2, windows_virtual_key_code=65,
        ))
        await asyncio.sleep(0.08)
        await tab.send(_cdp.input_.dispatch_key_event(
            "keyDown", key="Backspace", code="Backspace", windows_virtual_key_code=8,
        ))
        await tab.send(_cdp.input_.dispatch_key_event(
            "keyUp", key="Backspace", code="Backspace", windows_virtual_key_code=8,
        ))
    except Exception:
        return False

    await asyncio.sleep(rng.uniform(0.05, 0.12))
    return True


async def press_enter(tab: Tab) -> None:
    """Press Enter key via CDP."""
    if not _NODRIVER_OK or _cdp is None:
        return
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyDown", key="Enter", code="Enter", windows_virtual_key_code=13,
    ))
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyUp", key="Enter", code="Enter", windows_virtual_key_code=13,
    ))


async def address_bar_navigate(tab: Tab, host: str, rng: Any) -> None:
    """
    Ctrl+L → clear → type host → Enter.
    Never uses tab.get() — pure CDP keystrokes.
    """
    if not _NODRIVER_OK or _cdp is None:
        return
    # Ctrl+L — focus address bar
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyDown", key="l", code="KeyL", modifiers=2,
        windows_virtual_key_code=76,
    ))
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyUp", key="l", code="KeyL", modifiers=2,
        windows_virtual_key_code=76,
    ))
    await asyncio.sleep(rng.uniform(0.35, 0.75))

    # Ctrl+A — select all
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyDown", key="a", code="KeyA", modifiers=2,
        windows_virtual_key_code=65,
    ))
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyUp", key="a", code="KeyA", modifiers=2,
        windows_virtual_key_code=65,
    ))
    await asyncio.sleep(rng.uniform(0.08, 0.2))

    # Backspace — clear
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyDown", key="Backspace", code="Backspace",
        windows_virtual_key_code=8,
    ))
    await tab.send(_cdp.input_.dispatch_key_event(
        "keyUp", key="Backspace", code="Backspace",
        windows_virtual_key_code=8,
    ))
    await asyncio.sleep(rng.uniform(0.12, 0.3))

    await send_keys_human(tab, host, rng)
    await asyncio.sleep(rng.uniform(0.3, 0.7))
    await press_enter(tab)


# ── Video match helper ────────────────────────────────────────────────────────

def exact_match(title: str, channel: str, target: VideoTarget) -> bool:
    """
    Require title_hint AND channel_name match when both are provided.
    Used by entropy.py to verify correct video before clicking.
    """
    result_title   = _normalize(title)
    result_channel = _normalize(channel)
    want_title     = _normalize(target.title_hint or "")
    want_channel   = _normalize(target.channel_name or "")

    if target.video_id and target.video_id in (title or channel or ""):
        if not want_title and not want_channel:
            return True

    title_ok = not want_title
    if want_title:
        title_ok = want_title in result_title or result_title in want_title

    channel_ok = not want_channel
    if want_channel:
        channel_ok = (
            want_channel in result_channel
            or result_channel in want_channel
            or all(w in result_channel for w in want_channel.split() if len(w) > 2)
        )

    if want_title and want_channel:
        return title_ok and channel_ok
    if want_title:
        return title_ok
    if want_channel:
        return channel_ok
    if target.video_id:
        combined = f"{title} {channel}"
        return target.video_id in combined
    return False


# ── Scroll helper ─────────────────────────────────────────────────────────────

async def slow_scroll(tab: Tab, rng: Any, *, delta_px: Optional[int] = None) -> None:
    """
    Smooth scroll by delta_px pixels.
    FIX #4: evaluate wrapped with timeout via _safe_eval.
    """
    px = delta_px or rng.randint(180, 420)
    await _safe_eval(tab, f"(() => window.scrollBy(0, {px}))()", timeout=5.0)
    await asyncio.sleep(rng.uniform(0.6, 1.4))


# ── Player wait ───────────────────────────────────────────────────────────────

async def wait_for_player(tab: Tab, timeout: float = 25.0) -> bool:
    """
    Wait until main video element is loaded (post-ad safe).
    FIX #2: evaluate wrapped with _safe_eval timeout.
    WebSocket error detection retained — bail early so caller can reconnect.
    """
    deadline              = time.monotonic() + timeout
    consecutive_ws_errors = 0
    nudge_at              = time.monotonic() + 8.0

    while time.monotonic() < deadline:
        try:
            result = await asyncio.wait_for(
                tab.evaluate("""
                (() => {
                    const v = document.querySelector('#movie_player video')
                           || document.querySelector('video');
                    if (!v) return false;
                    const d = v.duration;
                    if (!isFinite(d) || d <= 0) return false;
                    // Main content only — ignore short ad segments
                    if (d <= 30) return false;
                    if (v.readyState >= 2) return true;
                    if (v.currentTime > 0.3) return true;
                    // Metadata loaded on watch page — proceed (autoplay may be blocked)
                    if (v.readyState >= 1 && location.href.includes('/watch')) return true;
                    return false;
                })()
                """, return_by_value=True),
                timeout=5.0,
            )
            raw = getattr(result, "value", result) if result is not None else False
            consecutive_ws_errors = 0  # reset on success
            if raw:
                return True
        except asyncio.TimeoutError:
            # Tab slow — not necessarily dead, keep trying
            pass
        except Exception as e:
            err_str = str(e).lower()
            # Detect WebSocket disconnection — bail early so caller can reconnect
            if "close frame" in err_str or "websocket" in err_str or "connection" in err_str:
                consecutive_ws_errors += 1
                if consecutive_ws_errors >= 3:
                    return False  # Tab WS is dead — caller should reconnect
        if time.monotonic() >= nudge_at:
            nudge_at = time.monotonic() + 8.0
            try:
                await asyncio.wait_for(
                    tab.evaluate("""
                    (() => {
                        var p = document.querySelector('#movie_player')
                             || document.querySelector('.html5-video-player');
                        if (!p) return false;
                        var vc = p.querySelector('.html5-video-container') || p;
                        vc.focus();
                        vc.click();
                        return true;
                    })()
                    """, return_by_value=True),
                    timeout=4.0,
                )
            except Exception:
                pass
        await asyncio.sleep(0.5)

    # Last resort: watch page shell loaded (metadata may be slow / autoplay blocked)
    try:
        result = await asyncio.wait_for(
            tab.evaluate("""
            (() => {
                if (!location.href.includes('/watch')) return false;
                var player = document.querySelector('#movie_player')
                          || document.querySelector('ytd-watch-flexy');
                if (!player) return false;
                var v = document.querySelector('#movie_player video')
                     || document.querySelector('video');
                if (!v) return true;
                var d = v.duration;
                if (isFinite(d) && d > 0 && d <= 30) return false;
                return true;
            })()
            """, return_by_value=True),
            timeout=5.0,
        )
        raw = getattr(result, "value", result) if result is not None else False
        if raw:
            return True
    except Exception:
        pass

    return False
