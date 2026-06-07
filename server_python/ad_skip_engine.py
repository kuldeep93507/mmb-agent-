"""
ad_skip_engine — SINGLE canonical YouTube ad skip implementation.

All paths (AdHandler, agent_manager, tests) must use this module.
Selectors: MMB_YOUTUBE_SELECTORS_FINAL_V2.py via behavior.youtube.selectors.DESKTOP
Click: CDP Input.dispatchMouseEvent (isTrusted-friendly) → then JS events fallback.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any, Callable, Optional

log = logging.getLogger("mmb.ad_skip_engine")

from server_python.behavior.youtube.selectors import DESKTOP, JS_API
from server_python.behavior.youtube.state import is_ad_playing

# V2 master list (38+ selectors) — no hardcoded 3-selector subset
_SKIP_SELECTORS: tuple[str, ...] = tuple(
    dict.fromkeys(DESKTOP.get("ad_skip_button", ()))
)
if len(_SKIP_SELECTORS) < 20:
    log.warning("ad_skip_engine: only %d skip selectors loaded — check V2 file path", len(_SKIP_SELECTORS))


async def _eval(tab: Any, js: str) -> Any:
    try:
        result = await tab.evaluate(js, return_by_value=True)
        return getattr(result, "value", result)
    except Exception as exc:
        log.debug("eval error: %s", exc)
        return None


async def is_ad_showing(tab: Any) -> bool:
    try:
        if await is_ad_playing(tab):
            return True
        raw = await _eval(
            tab,
            """
            (() => {
                var p = document.querySelector('#movie_player, .html5-video-player');
                if (p && (p.classList.contains('ad-showing') ||
                          p.classList.contains('ad-interrupting'))) return true;
                return !!document.querySelector(
                    '.video-ads .ytp-ad-player-overlay-layout, .ytp-ad-module, .ytp-ad-duration-remaining'
                );
            })()
            """,
        )
        return bool(raw)
    except Exception:
        return False


async def dump_ad_skip_dom(tab: Any) -> dict:
    """Live diagnostic — all skip candidates with id/class/visible."""
    dump_js = JS_API.get("dump_ad_skip_dom")
    if not dump_js:
        return {"error": "dump_ad_skip_dom missing from JS_API"}
    raw = await _eval(tab, dump_js.strip())
    return raw if isinstance(raw, dict) else {"raw": raw}


async def find_skip_target(tab: Any) -> dict | None:
    """First visible skip control from full V2 selector list."""
    sels_json = json.dumps(list(_SKIP_SELECTORS))
    raw = await _eval(
        tab,
        f"""
        (() => {{
            function pack(btn, selector) {{
                btn.scrollIntoView({{block:'center', inline:'center', behavior:'instant'}});
                var r = btn.getBoundingClientRect();
                var ow = btn.offsetWidth, oh = btn.offsetHeight;
                var w = Math.max(ow, r.width), h = Math.max(oh, r.height);
                if (w < 2 || h < 2) return null;
                var cs = window.getComputedStyle(btn);
                if (cs.display === 'none' || cs.visibility === 'hidden') return null;
                return {{
                    selector: selector,
                    x: Math.round(r.left + w / 2),
                    y: Math.round(r.top + h / 2),
                    id: btn.id || '',
                    text: (btn.innerText || btn.getAttribute('aria-label') || '').substring(0, 32)
                }};
            }}
            var sels = {sels_json};
            for (var i = 0; i < sels.length; i++) {{
                var nodes = document.querySelectorAll(sels[i]);
                for (var n = 0; n < nodes.length; n++) {{
                    var hit = pack(nodes[n], sels[i]);
                    if (hit) return hit;
                }}
            }}
            var broad = document.querySelectorAll(
                '[class*="skip-ad-button"], [class*="skip-button"], ' +
                '[id^="skip-button"], [id^="skip-ad"]'
            );
            for (var b = 0; b < broad.length; b++) {{
                var el = broad[b];
                if (el.tagName === 'DIV' && !el.querySelector('button')) {{
                    var hit2 = pack(el, 'id/class-broad');
                    if (hit2) return hit2;
                }} else {{
                    var hit3 = pack(el, 'id/class-broad');
                    if (hit3) return hit3;
                }}
            }}
            var player = document.querySelector('#movie_player, .html5-video-player');
            if (player) {{
                player.querySelectorAll('button, [role="button"]').forEach(function(btn) {{
                    var t = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
                    if (t.indexOf('skip') >= 0) {{
                        var hit4 = pack(btn, 'aria-skip-text');
                        if (hit4) return hit4;
                    }}
                }});
            }}
            return null;
        }})()
        """,
    )
    return raw if isinstance(raw, dict) else None


async def verify_ad_cleared(tab: Any) -> bool:
    await asyncio.sleep(0.8)
    return not await is_ad_showing(tab)


async def cdp_click_at(tab: Any, x: float, y: float) -> bool:
    """Direct CDP mouse click — same technique as yt_actions.smart_ad_skip."""
    try:
        from nodriver import cdp

        await tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
        await asyncio.sleep(0.08)
        await tab.send(
            cdp.input_.dispatch_mouse_event(
                type_="mousePressed",
                x=x,
                y=y,
                button=cdp.input_.MouseButton.LEFT,
                click_count=1,
            )
        )
        await asyncio.sleep(0.08)
        await tab.send(
            cdp.input_.dispatch_mouse_event(
                type_="mouseReleased",
                x=x,
                y=y,
                button=cdp.input_.MouseButton.LEFT,
                click_count=1,
            )
        )
        return True
    except Exception as exc:
        log.debug("cdp_click_at error: %s", exc)
        return False


async def click_skip_via_js(tab: Any, selector: str) -> bool:
    sel_json = json.dumps(selector)
    raw = await _eval(
        tab,
        f"""
        (() => {{
            var btn = document.querySelector({sel_json});
            if (!btn) return 'no_el';
            btn.scrollIntoView({{ block: 'center', inline: 'center' }});
            var r = btn.getBoundingClientRect();
            var x = r.left + r.width / 2, y = r.top + r.height / 2;
            var opts = {{ bubbles: true, cancelable: true, view: window,
                          clientX: x, clientY: y, button: 0 }};
            ['pointerover','mouseover','pointerdown','mousedown',
             'pointerup','mouseup','click'].forEach(t =>
                btn.dispatchEvent(new MouseEvent(t, opts)));
            if (typeof btn.click === 'function') btn.click();
            return 'clicked';
        }})()
        """,
    )
    return str(raw).startswith("clicked")


async def try_player_skip_api(tab: Any) -> bool:
    raw = await _eval(
        tab,
        """
        (() => {
            var p = document.getElementById('movie_player')
                 || document.querySelector('.html5-video-player');
            if (!p) return 'no_player';
            if (typeof p.skipAd === 'function') { p.skipAd(); return 'skipAd_called'; }
            return 'no_api';
        })()
        """,
    )
    return str(raw) == "skipAd_called"


async def try_skip_once(
    tab: Any,
    target: dict,
    *,
    log_fn: Callable[[str], None],
    mouse_x: float,
    mouse_y: float,
    rng: random.Random,
) -> tuple[bool, float, float]:
    """Returns (verified, new_mouse_x, new_mouse_y)."""
    if not target:
        return False, mouse_x, mouse_y

    sel = target.get("selector", "")
    x, y = float(target["x"]), float(target["y"])
    btn_id = target.get("id", "")

    # 1) Direct CDP click (proven in yt_actions)
    if await cdp_click_at(tab, x, y):
        if await verify_ad_cleared(tab):
            log_fn(
                f"[AdSkip] ✓ SKIP VERIFIED via CDP ({x:.0f},{y:.0f}) "
                f"id={btn_id!r} sel={sel}"
            )
            return True, x, y
        log_fn("[AdSkip] CDP click sent — ad still showing, try hover+JS…")

    # 2) Bezier hover+click (human-like)
    try:
        from server_python.cdp_mouse import cdp_hover_then_click

        if await cdp_hover_then_click(
            tab, x, y, rng,
            from_x=mouse_x, from_y=mouse_y,
            dwell_min=0.12, dwell_max=0.35,
        ):
            if await verify_ad_cleared(tab):
                log_fn(
                    f"[AdSkip] ✓ SKIP VERIFIED via CDP hover ({x:.0f},{y:.0f}) "
                    f"id={btn_id!r} sel={sel}"
                )
                return True, x, y
    except Exception as exc:
        log_fn(f"[AdSkip] hover click error: {exc}")

    # 3) JS event chain
    if sel and await click_skip_via_js(tab, sel):
        if await verify_ad_cleared(tab):
            log_fn(f"[AdSkip] ✓ SKIP VERIFIED via JS sel={sel}")
            return True, x, y

    for s in _SKIP_SELECTORS:
        if s == sel:
            continue
        if await click_skip_via_js(tab, s):
            if await verify_ad_cleared(tab):
                log_fn(f"[AdSkip] ✓ SKIP VERIFIED via fallback sel={s}")
                return True, x, y

    if await try_player_skip_api(tab):
        if await verify_ad_cleared(tab):
            log_fn("[AdSkip] ✓ SKIP VERIFIED via player.skipAd()")
            return True, x, y

    log_fn(f"[AdSkip] ✗ Skip click FAILED sel={sel!r} id={btn_id!r}")
    return False, x, y


async def skip_ads_until_clear(
    tab: Any,
    *,
    delay_min: float = 10.0,
    delay_max: float = 14.0,
    timeout: float = 180.0,
    log_fn: Optional[Callable[[str], None]] = None,
    rng: Optional[random.Random] = None,
    mouse_x: float = 640.0,
    mouse_y: float = 360.0,
) -> tuple[bool, str, float, float]:
    """
    Poll until ad cleared. Returns (success, proof, mouse_x, mouse_y).

    success True only when:
      - verified skip click, OR
      - no ad on load, OR
      - unskippable ad ended (no skip UI ever appeared)
    """
    _log = log_fn or (lambda m: log.info(m))
    _rng = rng or random.Random()

    if not await is_ad_showing(tab):
        _log("[AdSkip] No ad detected on load")
        return True, "NO_AD", mouse_x, mouse_y

    ad_start = time.monotonic()
    target_wait = float(delay_min)
    if delay_max > delay_min:
        target_wait = _rng.uniform(float(delay_min), float(delay_max))

    _log(
        f"[AdSkip] Ad detected — {_len_skip_selectors()} V2 selectors + CDP "
        f"(human delay ~{target_wait:.0f}s)…"
    )

    deadline = time.monotonic() + timeout
    skipped_count = 0
    saw_skip_ui = False
    last_heartbeat = ad_start
    mx, my = mouse_x, mouse_y

    while time.monotonic() < deadline:
        if not await is_ad_showing(tab):
            if skipped_count:
                proof = f"VERIFIED_SKIPS={skipped_count}"
                _log(f"[AdSkip] Ad cleared after {skipped_count} verified skip(s) ✓")
                return True, proof, mx, my
            if not saw_skip_ui:
                _log("[AdSkip] Ad ended — no skip UI (unskippable bumper)")
                return True, "UNSKIPPABLE_NO_UI", mx, my
            _log("[AdSkip] ✗ SKIP FAILED — skip UI was visible but click never verified")
            return False, "SKIP_UI_BUT_NOT_VERIFIED", mx, my

        elapsed = time.monotonic() - ad_start
        target = await find_skip_target(tab)

        if target:
            saw_skip_ui = True
            if elapsed >= target_wait:
                ok, mx, my = await try_skip_once(
                    tab, target, log_fn=_log, mouse_x=mx, mouse_y=my, rng=_rng,
                )
                if ok:
                    skipped_count += 1
                    await asyncio.sleep(1.0)
                    continue
            elif time.monotonic() - last_heartbeat >= 4.0:
                _log(
                    f"[AdSkip] Skip button @ {elapsed:.0f}s "
                    f"sel={target.get('selector','')!r} text={target.get('text','')[:20]!r} "
                    f"— wait ~{target_wait:.0f}s"
                )
                last_heartbeat = time.monotonic()
        else:
            if time.monotonic() - last_heartbeat >= 8.0:
                await close_overlay_ads(tab, log_fn=_log)
                dump = await dump_ad_skip_dom(tab)
                n = len(dump.get("skipCandidates") or [])
                cd = dump.get("countdown") or "?"
                _log(
                    f"[AdSkip] Still polling @ {elapsed:.0f}s — "
                    f"no skip target ({n} DOM candidates, countdown={cd!r})"
                )
                last_heartbeat = time.monotonic()

        await asyncio.sleep(0.35)

    proof = f"TIMEOUT verified_skips={skipped_count}"
    _log(f"[AdSkip] TIMEOUT ({timeout:.0f}s) {proof}")
    return skipped_count > 0, proof, mx, my


async def skip_ads_poll(
    tab: Any,
    *,
    delay_min: float = 10.0,
    delay_max: float = 14.0,
    timeout: float = 90.0,
    log_fn: Optional[Callable[[str], None]] = None,
    rng: Optional[random.Random] = None,
    mouse_x: float = 640.0,
    mouse_y: float = 360.0,
) -> tuple[bool, str, float, float]:
    """Mid-roll / quick skip — same engine, shorter default timeout."""
    if not await is_ad_showing(tab):
        return True, "NO_AD", mouse_x, mouse_y
    return await skip_ads_until_clear(
        tab,
        delay_min=delay_min,
        delay_max=delay_max,
        timeout=timeout,
        log_fn=log_fn,
        rng=rng,
        mouse_x=mouse_x,
        mouse_y=mouse_y,
    )


async def close_overlay_ads(tab: Any, log_fn: Optional[Callable[[str], None]] = None) -> bool:
    """Banner overlay close — V2 ad_overlay_close selectors."""
    _log = log_fn or (lambda m: log.info(m))
    sels_json = json.dumps(list(DESKTOP.get("ad_overlay_close", ())))
    raw = await _eval(
        tab,
        f"""
        (() => {{
            var closeSels = {sels_json};
            for (var i = 0; i < closeSels.length; i++) {{
                var el = document.querySelector(closeSels[i]);
                if (el && el.offsetParent !== null) {{
                    el.click(); return 'closed:' + closeSels[i];
                }}
            }}
            return 'none';
        }})()
        """,
    )
    if raw and str(raw).startswith("closed"):
        _log(f"[AdSkip] Overlay closed | {raw}")
        return True
    return False


async def wait_for_main_video(
    tab: Any,
    *,
    timeout: float = 120.0,
    skip_ads: bool = True,
    delay_min: float = 10.0,
    delay_max: float = 14.0,
    log_fn: Optional[Callable[[str], None]] = None,
    rng: Optional[random.Random] = None,
    mouse_x: float = 640.0,
    mouse_y: float = 360.0,
) -> tuple[bool, float, float]:
    """Wait until main video is playing (not ad-showing). Returns (ok, mouse_x, mouse_y)."""
    _log = log_fn or (lambda m: log.info(m))
    _rng = rng or random.Random()
    mx, my = mouse_x, mouse_y
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        if await is_ad_showing(tab):
            if skip_ads:
                _, _, mx, my = await skip_ads_poll(
                    tab,
                    delay_min=delay_min,
                    delay_max=delay_max,
                    timeout=min(90.0, max(5.0, deadline - time.monotonic())),
                    log_fn=_log,
                    rng=_rng,
                    mouse_x=mx,
                    mouse_y=my,
                )
            await close_overlay_ads(tab, log_fn=_log)
            await asyncio.sleep(0.5)
            continue

        raw = await _eval(
            tab,
            """
            (() => {
                var p = document.querySelector('#movie_player');
                if (p && p.classList.contains('ad-showing')) return null;
                var v = document.querySelector('video');
                if (!v) return null;
                return {
                    currentTime: v.currentTime,
                    duration: v.duration,
                    readyState: v.readyState
                };
            })()
            """,
        )
        if isinstance(raw, dict):
            ct = float(raw.get("currentTime") or 0)
            dur = float(raw.get("duration") or 0)
            rs = int(raw.get("readyState") or 0)
            if dur > 30.0 and (ct > 0.5 or rs >= 2):
                _log("[AdSkip] Main video playing ✓")
                return True, mx, my
        await asyncio.sleep(0.6)

    _log("[AdSkip] wait_for_main_video timeout — proceeding anyway")
    return False, mx, my


def _len_skip_selectors() -> int:
    return len(_SKIP_SELECTORS)


def skip_selector_count() -> int:
    """Public check for tests — must match V2 ad_skip_button length."""
    return len(_SKIP_SELECTORS)
