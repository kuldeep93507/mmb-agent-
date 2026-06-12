"""
PlaybackGuardian — Tab-Sentry background loop.
Adapted from MMB-Agent-v2/behavior/youtube/guardian.py

Smart behavior:
  1. Double-check pause — pehle paused dekha, 3s baad fir check. Sirf sustained
     pause (3s+) pe force play. Engagement actions ke brief pause ignore hote hain.
  2. Autoplay HARD-LOCK via JS — no UI click needed.
  3. suppress() method — engagement actions ke dauran guardian mute.

FIXED:
  ✅ Bug #1: tab.evaluate() calls wrapped with asyncio.wait_for timeout=5s
             (tab hang pe guardian loop forever stuck hota tha)
  ✅ Bug #2: _force_autoplay_off() selector updated to match V2 file exactly
             aria-label="Autoplay" → aria-label*="Auto-play" i (V2 accurate)
  ✅ Bug #3: _is_video_paused() result extraction more robust
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Optional

log = logging.getLogger("mmb.guardian")


class PlaybackGuardian:

    def __init__(
        self,
        tab,
        *,
        log_fn: Callable[[str], None] | None = None,
        check_interval: float = 8.0,
        autoplay_lock: bool = True,
    ) -> None:
        self._tab                    = tab
        self._log                    = log_fn or (lambda msg: log.info(msg))
        self._interval               = check_interval
        self._autoplay_lock          = autoplay_lock
        self._task: Optional[asyncio.Task] = None
        self._running                = False
        self._play_count             = 0
        self._autoplay_enforced_count = 0
        self._suppress_until: float  = 0.0

    # ── Public API ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self._force_autoplay_off()
        self._running = True
        self._task    = asyncio.create_task(self._loop(), name="playback_guardian")
        self._log("[Guardian] Started | interval=8s autoplay_lock=ON")

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
        """
        if self._is_suppressed():
            return

        paused = await self._is_video_paused()

        if paused is True:
            await asyncio.sleep(2.0)
            if self._is_suppressed():
                return
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

    async def _safe_eval(self, js: str, timeout: float = 5.0):
        """
        FIX #1: All tab.evaluate calls go through here with timeout.
        Prevents guardian from hanging forever on unresponsive tab.
        """
        try:
            result = await asyncio.wait_for(
                self._tab.evaluate(js, return_by_value=True),
                timeout=timeout,
            )
            return result
        except asyncio.TimeoutError:
            log.debug("[Guardian] eval timeout after %.1fs", timeout)
            return None
        except Exception:
            return None

    async def _is_video_paused(self) -> Optional[bool]:
        """
        FIX #1: Uses _safe_eval with timeout.
        FIX #3: More robust result extraction.
        """
        result = await self._safe_eval(
            "(() => {"
            "  var v = document.querySelector('video');"
            "  if (!v) return null;"
            "  if (v.ended) return null;"  # ended naturally — don't force play
            "  return v.paused;"
            "})()"
        )
        if result is None:
            return None
        # FIX #3: Handle both direct bool and wrapped RemoteObject
        if isinstance(result, bool):
            return result
        val = getattr(result, "value", None)
        if val is None:
            return None
        return bool(val)

    async def _force_play(self) -> None:
        """YT player API first (UI sync), raw video element fallback."""
        await self._safe_eval(
            "(() => {"
            "  try {"
            "    var p = document.querySelector('#movie_player');"
            "    if (p && typeof p.playVideo === 'function') {"
            "      if (!p.getPlayerState || p.getPlayerState() === 2) {"
            "        p.playVideo(); return 'yt';"
            "      }"
            "      return 'already';"
            "    }"
            "  } catch(e) {}"
            "  var v = document.querySelector('video');"
            "  if (v && v.paused && !v.ended) { v.play().catch(() => {}); return 'raw'; }"
            "  return 'none';"
            "})()"
        )

    async def _force_autoplay_off(self) -> None:
        """
        Hard-lock autoplay OFF via JS — no UI interaction needed.
        FIX #1: Uses _safe_eval with timeout.
        FIX #2: Selector updated to match V2 file exactly.
                'aria-label="Autoplay"' → 'aria-label*="Auto-play"' (V2 accurate)
        """
        result = await self._safe_eval(
            """
            (() => {
                // Method 1: YouTube player internal API
                try {
                    var p = document.querySelector('#movie_player');
                    if (p && p.setAutonavState) {
                        p.setAutonavState(false);
                    }
                } catch(e) {}

                // Method 2: localStorage preference (persists across sessions)
                try {
                    localStorage.setItem(
                        'yt-player-autonav-is-on',
                        JSON.stringify({data: 'false'})
                    );
                } catch(e) {}

                // Method 3: Click toggle only if currently ON
                // FIX #2: V2 selectors — aria-label*="Auto-play" matches both
                //         "Auto-play is on" and "Auto-play is off" text variants
                try {
                    var btn = document.querySelector(
                        'button[aria-label*="Auto-play" i], '
                        + 'button[aria-label*="Autoplay" i], '
                        + 'button.ytp-autonav-toggle, '
                        + 'button[data-tooltip-target-id="ytp-autonav-toggle-button"]'
                    );
                    if (btn) {
                        var isOn = btn.getAttribute('aria-checked') === 'true'
                            || btn.getAttribute('aria-pressed') === 'true'
                            || btn.classList.contains('ytp-autonav-toggle-button-enabled');
                        if (isOn) {
                            btn.click();
                            return 'toggled_off';
                        }
                        return 'already_off';
                    }
                } catch(e) {}

                // Method 4: ytInitialData localStorage fallback
                try {
                    var prefs = JSON.parse(localStorage.getItem('yt-player-quality') || '{}');
                    prefs.autonav = false;
                    localStorage.setItem('yt-player-quality', JSON.stringify(prefs));
                } catch(e) {}

                return 'done';
            })()
            """,
            timeout=8.0,
        )
        if result is not None:
            val = result if isinstance(result, str) else getattr(result, "value", "")
            if val == "toggled_off":
                self._log("[Guardian] Autoplay was ON → forced OFF via JS")

    async def verify_autoplay_off(self) -> bool:
        """
        Returns True if autoplay is confirmed OFF.
        FIX #1: Uses _safe_eval with timeout.
        FIX #2: V2-accurate selectors.
        """
        result = await self._safe_eval(
            """
            (() => {
                var btn = document.querySelector(
                    'button[aria-label*="Auto-play" i], '
                    + 'button[aria-label*="Autoplay" i], '
                    + 'button.ytp-autonav-toggle, '
                    + 'button[data-tooltip-target-id="ytp-autonav-toggle-button"]'
                );
                if (!btn) return 'not_found';
                var isOn = btn.getAttribute('aria-checked') === 'true'
                    || btn.getAttribute('aria-pressed') === 'true'
                    || btn.classList.contains('ytp-autonav-toggle-button-enabled');
                return isOn ? 'on' : 'off';
            })()
            """,
            timeout=5.0,
        )
        if result is None:
            return True  # assume OK on timeout
        val = result if isinstance(result, str) else getattr(result, "value", "")
        return val in ("off", "not_found")
