"""
PlaybackGuardian — Tab-Sentry background loop.

Smart behavior:
  1. Double-check pause — pehle paused dekha, 3s baad fir check. Sirf sustained
     pause (3s+) pe force play. Engagement actions ke brief pause ignore hote hain.
  2. Autoplay HARD-LOCK via JS — no UI click needed.
  3. suppress() method — engagement actions ke dauran guardian mute.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Optional


class PlaybackGuardian:
    def __init__(
        self,
        tab,
        *,
        log: Callable[[str], None] | None = None,
        check_interval: float = 15.0,   # 15s interval — less intrusive
        autoplay_lock: bool = True,
    ) -> None:
        self._tab = tab
        self._log = log or (lambda msg: None)
        self._interval = check_interval
        self._autoplay_lock = autoplay_lock
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._play_count = 0
        self._autoplay_enforced_count = 0
        self._suppress_until: float = 0.0   # epoch time until suppressed

    # ── Public API ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self._force_autoplay_off()
        self._running = True
        self._task = asyncio.create_task(self._loop(), name="playback_guardian")
        self._log("[Guardian] Started | interval=15s autoplay_lock=ON")

    async def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._log(
            f"[Guardian] Stopped | play_fixes={self._play_count} "
            f"autoplay_enforced={self._autoplay_enforced_count}"
        )

    def suppress(self, duration_sec: float = 8.0) -> None:
        """Suppress guardian for duration_sec seconds — call before engagement actions."""
        self._suppress_until = time.monotonic() + duration_sec

    def _is_suppressed(self) -> bool:
        return time.monotonic() < self._suppress_until

    # ── Internal loop ─────────────────────────────────────────────────────────

    async def _loop(self) -> None:
        check_no = 0
        while self._running:
            await asyncio.sleep(self._interval)
            if not self._running:
                break
            check_no += 1
            try:
                await self._check_and_fix(check_no)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log(f"[Guardian] Check error (ignored): {exc}")

    async def _check_and_fix(self, check_no: int) -> None:
        """
        Smart double-check:
        - Suppressed? Skip silently.
        - Paused? Wait 3s and check AGAIN.
        - Still paused after 3s? THEN force play.
        - Brief pause (< 3s) = engagement/human action = ignore.
        """
        if self._is_suppressed():
            # Silent — don't log every suppressed tick
            return

        paused = await self._is_video_paused()

        if paused is True:
            # Double-check after 3s — could be intentional human pause or engagement
            await asyncio.sleep(3.0)

            if self._is_suppressed():
                return  # Suppressed while waiting

            still_paused = await self._is_video_paused()
            if still_paused is True:
                self._log(f"[Guardian] tick={check_no} | Sustained pause → forcing play()")
                await self._force_play()
                self._play_count += 1
            else:
                self._log(f"[Guardian] tick={check_no} | Brief pause resolved ✓")
        else:
            self._log(f"[Guardian] tick={check_no} | Playing ✓")

        # Re-enforce autoplay OFF every 4 ticks (~60s)
        if self._autoplay_lock and check_no % 4 == 0:
            await self._force_autoplay_off()
            self._autoplay_enforced_count += 1

    # ── JS helpers ────────────────────────────────────────────────────────────

    async def _is_video_paused(self) -> Optional[bool]:
        try:
            result = await self._tab.evaluate(
                "(() => { var v = document.querySelector('video'); "
                "if (!v) return null; return v.paused; })()",
                return_by_value=True,
            )
            val = result if isinstance(result, bool) else getattr(result, "value", None)
            if val is None:
                return None
            return bool(val)
        except Exception:
            return None

    async def _force_play(self) -> None:
        try:
            await self._tab.evaluate(
                "(() => { var v = document.querySelector('video'); "
                "if (v && v.paused) { v.play().catch(()=>{}); } })()",
                return_by_value=True,
            )
        except Exception:
            pass

    async def _force_autoplay_off(self) -> None:
        """Hard-lock autoplay OFF via JS — no UI interaction needed."""
        try:
            result = await self._tab.evaluate(
                """
                (() => {
                    // Method 1: YouTube player API
                    try {
                        var p = document.querySelector('#movie_player');
                        if (p && p.setAutonavState) {
                            p.setAutonavState(false);
                        }
                    } catch(e) {}

                    // Method 2: localStorage preference
                    try {
                        localStorage.setItem(
                            'yt-player-autonav-is-on',
                            JSON.stringify({data: 'false'})
                        );
                    } catch(e) {}

                    // Method 3: Click toggle only if currently ON
                    try {
                        var btn = document.querySelector(
                            '.ytp-autonav-toggle-button, '
                            'button[data-tooltip-target-id="ytp-autonav-toggle-button"]'
                        );
                        if (btn) {
                            var isOn = btn.getAttribute('aria-checked') === 'true'
                                    || btn.classList.contains('ytp-autonav-toggle-button-enabled');
                            if (isOn) { btn.click(); return 'toggled_off'; }
                            return 'already_off';
                        }
                    } catch(e) {}
                    return 'done';
                })()
                """,
                return_by_value=True,
            )
            val = result if isinstance(result, str) else getattr(result, "value", "")
            if val == "toggled_off":
                self._log("[Guardian] Autoplay was ON → forced OFF via JS")
        except Exception:
            pass

    async def verify_autoplay_off(self) -> bool:
        """Returns True if autoplay is confirmed OFF."""
        try:
            result = await self._tab.evaluate(
                """
                (() => {
                    var btn = document.querySelector('.ytp-autonav-toggle-button');
                    if (!btn) return 'not_found';
                    var isOn = btn.getAttribute('aria-checked') === 'true'
                            || btn.classList.contains('ytp-autonav-toggle-button-enabled');
                    return isOn ? 'on' : 'off';
                })()
                """,
                return_by_value=True,
            )
            val = result if isinstance(result, str) else getattr(result, "value", "")
            return val in ("off", "not_found")
        except Exception:
            return True  # assume off if can't check
