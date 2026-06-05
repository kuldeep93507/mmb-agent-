"""
AdHandler — Ad Detection & Skip for MMB AGENT 24/7

Skip button (inspect): button.ytp-skip-ad-button  id="skip-button:2"
Uses same CDP hover+click as like/subscribe — plain CDP click often misses YT player.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any, Callable, Optional

log = logging.getLogger("mmb.ad_handler")

from behavior.youtube.selectors import DESKTOP
from behavior.youtube.state import is_ad_playing as state_is_ad_playing

# V2 single source of truth — 12 fallback selectors for skip ad
_SKIP_SELECTORS = tuple(DESKTOP.get("ad_skip_button", ()))


class AdHandler:
    """Handles YouTube pre-roll / mid-roll / overlay ads."""

    def __init__(
        self,
        tab: Any,
        *,
        log_fn: Optional[Callable[[str], None]] = None,
        rng: Any = None,
    ) -> None:
        self._tab = tab
        self._log = log_fn or (lambda m: log.info(m))
        self._rng = rng or random.Random()
        self._mouse_x = 640.0
        self._mouse_y = 360.0

    # ── Detection ─────────────────────────────────────────────────────────────

    async def is_ad_playing(self) -> bool:
        """Delegate to V2 state detection."""
        try:
            return await state_is_ad_playing(self._tab)
        except Exception as exc:
            log.debug("is_ad_playing error: %s", exc)
            return False

    async def _is_ad_showing(self) -> bool:
        try:
            result = await self._tab.evaluate(
                """
                (() => {
                    var p = document.querySelector('#movie_player');
                    return !!(p && (p.classList.contains('ad-showing') ||
                                   p.classList.contains('ad-interrupting')));
                })()
                """,
                return_by_value=True,
            )
            return bool(getattr(result, "value", result))
        except Exception:
            return await self.is_ad_playing()

    async def _ensure_player_visible(self) -> None:
        try:
            await self._tab.evaluate(
                """
                (() => {
                    var p = document.querySelector('#movie_player');
                    if (p) p.scrollIntoView({ block: 'center', behavior: 'instant' });
                })()
                """,
                return_by_value=True,
            )
            await asyncio.sleep(0.2)
        except Exception:
            pass

    async def _focus_player(self) -> None:
        try:
            await self._tab.evaluate(
                """
                (() => {
                    var p = document.querySelector('#movie_player .html5-video-container')
                         || document.querySelector('#movie_player');
                    if (p) { p.focus(); p.click(); }
                })()
                """,
                return_by_value=True,
            )
            await asyncio.sleep(0.12)
        except Exception:
            pass

    # ── Skip button probe ─────────────────────────────────────────────────────

    async def _probe_skip_button(self) -> dict:
        sels_json = json.dumps(list(_SKIP_SELECTORS))
        try:
            result = await self._tab.evaluate(
                f"""
                (() => {{
                    var p = document.querySelector('#movie_player');
                    if (p && !p.classList.contains('ad-showing') &&
                        !p.classList.contains('ad-interrupting')) {{
                        var badge = document.querySelector('.ytp-ad-simple-ad-badge');
                        if (!badge || badge.offsetParent === null)
                            return {{ status: 'ad_done' }};
                    }}
                    var sels = {sels_json};
                    var best = null;
                    var waiting = null;
                    for (var i = 0; i < sels.length; i++) {{
                        var btn = document.querySelector(sels[i]);
                        if (!btn) continue;
                        var r = btn.getBoundingClientRect();
                        if (r.width < 4 || r.height < 4) continue;
                        var cs = window.getComputedStyle(btn);
                        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                        if (cs.pointerEvents === 'none') continue;
                        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {{
                            waiting = {{ status: 'waiting', detail: 'disabled', selector: sels[i] }};
                            continue;
                        }}
                        var op = parseFloat(cs.opacity || '1');
                        var txt = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
                        var hasSkipText = txt.indexOf('skip') >= 0;
                        var clickable = hasSkipText ? op >= 0.4 : op >= 0.85;
                        if (!clickable) {{
                            waiting = {{ status: 'waiting', detail: 'opacity=' + op, selector: sels[i] }};
                            continue;
                        }}
                        best = {{
                            status: 'ready',
                            x: Math.round(r.left + r.width / 2),
                            y: Math.round(r.top + r.height / 2),
                            selector: sels[i],
                            opacity: op,
                            id: btn.id || '',
                            text: txt.substring(0, 24)
                        }};
                        break;
                    }}
                    if (best) return best;
                    if (waiting) return waiting;
                    var cd = document.querySelector('.ytp-ad-duration-remaining, .ytp-ad-preview-text');
                    return {{
                        status: 'no_button',
                        detail: cd ? cd.textContent.trim().substring(0, 40) : 'ad_loading'
                    }};
                }})()
                """,
                return_by_value=True,
            )
            raw = getattr(result, "value", result)
            return raw if isinstance(raw, dict) else {"status": "no_button"}
        except Exception as e:
            return {"status": "no_button", "detail": str(e)}

    async def _verify_ad_cleared(self) -> bool:
        await asyncio.sleep(0.8)
        return not await self._is_ad_showing()

    async def _js_human_click(self, selector: str) -> bool:
        """Full pointer/mouse event chain on skip button."""
        sel_json = json.dumps(selector)
        try:
            result = await self._tab.evaluate(
                f"""
                (() => {{
                    var btn = document.querySelector({sel_json});
                    if (!btn) return 'no_el';
                    btn.scrollIntoView({{ block: 'center', inline: 'center' }});
                    var r = btn.getBoundingClientRect();
                    var x = r.left + r.width / 2;
                    var y = r.top + r.height / 2;
                    btn.focus();
                    var opts = {{ bubbles: true, cancelable: true, view: window,
                                  clientX: x, clientY: y, button: 0 }};
                    ['pointerover','mouseover','pointerenter','mouseenter',
                     'pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t) {{
                        btn.dispatchEvent(new MouseEvent(t, opts));
                    }});
                    if (typeof btn.click === 'function') btn.click();
                    return 'clicked:' + {sel_json};
                }})()
                """,
                return_by_value=True,
            )
            raw = result if isinstance(result, str) else getattr(result, "value", "")
            return bool(raw and str(raw).startswith("clicked"))
        except Exception:
            return False

    async def _perform_skip_click(self, probe: dict) -> bool:
        """CDP hover+click → JS events → verify ad cleared."""
        if probe.get("status") != "ready":
            return False

        x, y = float(probe["x"]), float(probe["y"])
        sel = probe.get("selector", "")
        btn_id = probe.get("id", "")

        await self._ensure_player_visible()
        await self._focus_player()

        # 1) Same strategy as like/subscribe — Bezier hover + click
        try:
            from server_python.cdp_mouse import cdp_hover_then_click
            if await cdp_hover_then_click(
                self._tab, x, y, self._rng,
                from_x=self._mouse_x, from_y=self._mouse_y,
                dwell_min=0.15, dwell_max=0.45,
            ):
                self._mouse_x, self._mouse_y = x, y
                if await self._verify_ad_cleared():
                    self._log(
                        f"[AdHandler] ✓ Skip via CDP hover+click ({x:.0f},{y:.0f}) "
                        f"id={btn_id!r} sel={sel}"
                    )
                    return True
                self._log("[AdHandler] CDP click sent but ad still showing — retry JS…")
        except Exception as e:
            self._log(f"[AdHandler] CDP hover+click error: {e}")

        # 2) JS human event chain on the element
        if sel and await self._js_human_click(sel):
            if await self._verify_ad_cleared():
                self._log(f"[AdHandler] ✓ Skip via JS events sel={sel}")
                return True

        # 3) Brute: try every selector
        for s in _SKIP_SELECTORS:
            if s == sel:
                continue
            if await self._js_human_click(s):
                if await self._verify_ad_cleared():
                    self._log(f"[AdHandler] ✓ Skip via fallback sel={s}")
                    return True

        self._log(f"[AdHandler] Skip click attempts failed (id={btn_id!r})")
        return False

    async def skip_ad_if_present(self) -> bool:
        """Immediate skip when button is ready (mid-roll / quick poll)."""
        if not await self.is_ad_playing():
            return False
        probe = await self._probe_skip_button()
        if probe.get("status") != "ready":
            return False
        return await self._perform_skip_click(probe)

    async def handle_overlay_ad(self) -> bool:
        try:
            result = await self._tab.evaluate(
                """
                (() => {
                    var closeSels = """ + json.dumps(list(DESKTOP.get("ad_overlay_close", ()))) + """;
                    for (var i = 0; i < closeSels.length; i++) {
                        var el = document.querySelector(closeSels[i]);
                        if (el && el.offsetParent !== null) {
                            el.click(); return 'closed:' + closeSels[i];
                        }
                    }
                    return 'none';
                })()
                """,
                return_by_value=True,
            )
            raw = result if isinstance(result, str) else getattr(result, "value", "")
            if raw and str(raw).startswith("closed"):
                self._log(f"[AdHandler] Overlay closed | {raw}")
                return True
        except Exception:
            pass
        return False

    async def skip_all_ads(
        self,
        *,
        delay_min: float = 5.0,
        delay_max: float = 15.0,
        timeout: float = 120.0,
    ) -> bool:
        """
        Pre-roll flow:
        1. Human delay
        2. Poll skip button — hover+click when clickable
        3. Verify ad cleared; retry until timeout
        """
        if not await self.is_ad_playing():
            self._log("[AdHandler] No ad detected on load")
            return True

        wait_sec = float(delay_min)
        if delay_max > delay_min:
            wait_sec = self._rng.uniform(float(delay_min), float(delay_max))
        self._log(f"[AdHandler] Ad detected — wait {wait_sec:.0f}s then skip…")
        await asyncio.sleep(wait_sec)

        deadline = time.monotonic() + timeout
        skipped_count = 0
        last_log = ""
        fail_clicks = 0

        while time.monotonic() < deadline:
            if not await self._is_ad_showing():
                if skipped_count:
                    self._log(f"[AdHandler] Ad cleared after {skipped_count} skip(s) ✓")
                else:
                    self._log("[AdHandler] Ad ended (auto or unskippable) ✓")
                return True

            probe = await self._probe_skip_button()
            st = probe.get("status")

            if st == "ready":
                if await self._perform_skip_click(probe):
                    skipped_count += 1
                    fail_clicks = 0
                    await asyncio.sleep(1.5)
                    continue
                fail_clicks += 1
                if fail_clicks >= 5:
                    self._log("[AdHandler] Multiple skip failures — waiting for countdown…")
                    await asyncio.sleep(2.0)
                    fail_clicks = 0

            elif st == "waiting":
                msg = f"countdown ({probe.get('detail', '')})"
                if msg != last_log:
                    self._log(f"[AdHandler] Skip {msg}")
                    last_log = msg
            elif st == "ad_done":
                return True
            else:
                msg = probe.get("detail") or "no skip button yet"
                if msg != last_log:
                    self._log(f"[AdHandler] {msg}")
                    last_log = msg
                await self.handle_overlay_ad()

            await asyncio.sleep(0.55)

        self._log(f"[AdHandler] Ad skip timeout ({timeout:.0f}s) skipped={skipped_count}")
        return skipped_count > 0

    async def wait_for_video_start(
        self,
        *,
        timeout: float = 90.0,
        skip_ads: bool = True,
        delay_min: float = 5.0,
        delay_max: float = 15.0,
    ) -> bool:
        """Wait until main video plays. Runs full skip_all_ads for pre-roll."""
        if skip_ads and await self.is_ad_playing():
            await self.skip_all_ads(
                delay_min=delay_min,
                delay_max=delay_max,
                timeout=min(timeout, 120.0),
            )

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if await self._is_ad_showing():
                if skip_ads:
                    await self.skip_ad_if_present()
                await asyncio.sleep(0.8)
                continue

            try:
                result = await self._tab.evaluate(
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
                    return_by_value=True,
                )
                raw = getattr(result, "value", result)
                if isinstance(raw, dict):
                    ct = float(raw.get("currentTime") or 0)
                    dur = float(raw.get("duration") or 0)
                    rs = int(raw.get("readyState") or 0)
                    if dur > 30.0 and (ct > 0.5 or rs >= 2):
                        self._log("[AdHandler] Main video playing ✓")
                        return True
            except Exception:
                pass
            await asyncio.sleep(0.6)

        self._log("[AdHandler] wait_for_video_start timeout — proceeding anyway")
        return False

    async def get_ad_remaining_time(self) -> Optional[float]:
        try:
            result = await self._tab.evaluate(
                """
                (() => {
                    var countdown = document.querySelector(
                        '.ytp-ad-duration-remaining, .ytp-ad-simple-ad-badge'
                    );
                    if (!countdown) return null;
                    var text = (countdown.innerText || '').trim();
                    var m = text.match(/(\\d+):(\\d+)/);
                    if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
                    return null;
                })()
                """,
                return_by_value=True,
            )
            raw = getattr(result, "value", result)
            return float(raw) if raw is not None else None
        except Exception:
            return None
