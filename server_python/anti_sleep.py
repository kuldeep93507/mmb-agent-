"""
AntiSleep v2 — keep browser profiles awake in background.

Fixes Chrome background-tab throttling when operator switches to another window/tab:
  1. Page Visibility API override (document.hidden → always false)
  2. CDP Page.setWebLifecycleState('active')
  3. Periodic micro-wake loop (mouse jitter + lifecycle refresh)
  4. bring_to_foreground() before search / watch / critical actions
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Callable, Optional

log = logging.getLogger("mmb.anti_sleep")

# Injected on every document + re-applied on wake ticks
VISIBILITY_OVERRIDE_JS = """
(() => {
  if (window.__mmbAntiSleepV2) return 'already';
  window.__mmbAntiSleepV2 = true;
  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true, get: function() { return false; }
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: function() { return 'visible'; }
    });
  } catch (e) {}
  try {
    document.addEventListener('visibilitychange', function(e) {
      e.stopImmediatePropagation();
    }, true);
  } catch (e) {}
  try {
    var p = document.querySelector('#movie_player');
    if (p && typeof p.getPlayerState === 'function' && typeof p.playVideo === 'function') {
      var st = p.getPlayerState();
      if (st === 2) { p.playVideo(); return 'yt_resume'; }
    }
  } catch (e) {}
  try {
    var v = document.querySelector('video');
    if (v && v.paused && !v.ended && v.readyState >= 2) {
      v.play().catch(function() {});
      return 'raw_resume';
    }
  } catch (e) {}
  return 'ok';
})()
"""

# Lightweight check — wake loop calls this when another app has focus
RESUME_PAUSED_VIDEO_JS = """
(() => {
  if (!location.href || location.href.indexOf('/watch') < 0) return 'not_watch';
  try {
    var p = document.querySelector('#movie_player');
    if (p && typeof p.getPlayerState === 'function' && typeof p.playVideo === 'function') {
      var st = p.getPlayerState();
      if (st === 2) { p.playVideo(); return 'yt_resumed'; }
      if (st === 1) return 'playing';
    }
  } catch (e) {}
  try {
    var v = document.querySelector('video');
    if (!v || v.ended) return 'no_video';
    if (!v.paused) return 'playing';
    if (v.readyState >= 2) { v.play().catch(function(){}); return 'raw_resumed'; }
  } catch (e) {}
  return 'paused';
})()
"""


class AntiSleepKeeper:
    """Per-profile background keep-alive — start after CDP connect, stop on agent close."""

    def __init__(
        self,
        *,
        log_fn: Callable[[str], None] | None = None,
        wake_interval: float = 5.0,
    ) -> None:
        self._tab: Any = None
        self._browser: Any = None
        self._log = log_fn or (lambda msg: log.info(msg))
        self._interval = wake_interval
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._wake_count = 0
        self._resume_count = 0
        self._script_registered = False
        self._watch_phase = False

    async def start(self, tab: Any, browser: Any = None) -> None:
        if self._running:
            return
        self._tab = tab
        self._browser = browser
        self._running = True
        await self._register_persistent_script()
        await self.inject_visibility()
        await self.set_lifecycle_active()
        await self.bring_to_foreground("session-start")
        self._task = asyncio.create_task(self._wake_loop(), name="anti_sleep_v2")
        self._log("[AntiSleep] v2 started | visibility override + wake every "
                  f"{self._interval:.0f}s")

    async def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._log(f"[AntiSleep] Stopped | wake_ticks={self._wake_count} resumes={self._resume_count}")

    async def on_page_load(self, reason: str = "navigation") -> None:
        """Re-apply overrides after tab.get() — new document may reset visibility."""
        if not self._tab:
            return
        await self.inject_visibility()
        await self.set_lifecycle_active()

    def set_watch_phase(self, active: bool) -> None:
        """During video watch: lighter keep-alive (no constant mouse / tab steal)."""
        self._watch_phase = bool(active)
        self._interval = 22.0 if self._watch_phase else 8.0

    async def bring_to_foreground(self, reason: str = "") -> None:
        """Activate tab + lifecycle before search/navigation — skip during passive watch."""
        if not self._tab:
            return
        if self._watch_phase and not reason.startswith(("search", "nav", "entropy", "ensure")):
            await self.inject_visibility()
            return
        tag = f" ({reason})" if reason else ""
        await self.set_lifecycle_active()
        await self._activate_target()
        await self.inject_visibility()
        if not self._watch_phase:
            await self._micro_mouse_wake()
        self._log(f"[AntiSleep] Foreground wake{tag}")

    async def inject_visibility(self) -> bool:
        if not self._tab:
            return False
        try:
            result = await self._tab.evaluate(VISIBILITY_OVERRIDE_JS, return_by_value=True)
            val = result if isinstance(result, str) else getattr(result, "value", "")
            return val in ("ok", "already")
        except Exception as exc:
            self._log(f"[AntiSleep] Visibility inject warn: {exc}")
            return False

    async def set_lifecycle_active(self) -> bool:
        if not self._tab:
            return False
        try:
            from nodriver import cdp
            await self._tab.send(cdp.page.set_web_lifecycle_state(state_="active"))
            return True
        except Exception:
            return False

    async def _register_persistent_script(self) -> None:
        if self._script_registered or not self._tab:
            return
        try:
            from nodriver import cdp
            await self._tab.send(
                cdp.page.add_script_to_evaluate_on_new_document(source=VISIBILITY_OVERRIDE_JS)
            )
            self._script_registered = True
        except Exception as exc:
            self._log(f"[AntiSleep] Persistent script warn (non-fatal): {exc}")

    async def _activate_target(self) -> bool:
        if not self._tab:
            return False
        try:
            if hasattr(self._tab, "activate"):
                await self._tab.activate()
                return True
        except Exception:
            pass
        try:
            from nodriver import cdp
            target_id = getattr(self._tab, "target_id", None)
            if not target_id and hasattr(self._tab, "target"):
                target_id = getattr(self._tab.target, "target_id", None)
            if target_id:
                await self._tab.send(cdp.target.activate_target(target_id=target_id))
                return True
        except Exception:
            pass
        return False

    async def _resume_video_if_paused(self) -> None:
        """When operator switches to another app, Chrome may pause video — resume via YT API."""
        if not self._tab:
            return
        try:
            result = await asyncio.wait_for(
                self._tab.evaluate(RESUME_PAUSED_VIDEO_JS, return_by_value=True),
                timeout=4.0,
            )
            val = result if isinstance(result, str) else getattr(result, "value", "")
            if val in ("yt_resumed", "raw_resumed"):
                self._resume_count += 1
                if self._resume_count <= 5 or self._resume_count % 10 == 0:
                    self._log(f"[AntiSleep] Background resume ({val}) #{self._resume_count}")
        except Exception:
            pass

    async def _micro_mouse_wake(self) -> None:
        if not self._tab:
            return
        try:
            from nodriver import cdp
            x = 400 + random.uniform(-2, 2)
            y = 300 + random.uniform(-2, 2)
            await self._tab.send(
                cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y)
            )
        except Exception:
            pass

    async def _wake_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self._interval)
                if not self._running:
                    break
                self._wake_count += 1
                if self._watch_phase:
                    # Passive watch: visibility + resume only — no mouse curves, rare tab steal
                    await self.inject_visibility()
                    if self._wake_count % 4 == 0:
                        await self.set_lifecycle_active()
                    await self._resume_video_if_paused()
                else:
                    await self._activate_target()
                    await self.set_lifecycle_active()
                    await self.inject_visibility()
                    await self._micro_mouse_wake()
                    await self._resume_video_if_paused()
                if self._wake_count % 6 == 0:
                    self._log(
                        f"[AntiSleep] Keep-alive tick #{self._wake_count} "
                        f"(resumes={self._resume_count})"
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log(f"[AntiSleep] Wake loop error (ignored): {exc}")
                await asyncio.sleep(2.0)
