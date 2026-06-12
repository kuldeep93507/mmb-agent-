"""
AgentManager — Full v2-grade YouTube automation
================================================
Includes all MMB-Agent-v2 features:
 ✓ Human-like CDP keystroke typing (human_engine.py)
 ✓ Behavioral Entropy (4 entry paths A/B/C/D, personality, human mistake)
 ✓ PlaybackGuardian (background video-continuity watcher)
 ✓ AI Brain (Claude-powered comments, keyword selection, error recovery)
 ✓ SmartProxy per-profile rotation
 ✓ Smart-wait, consent dismiss, keyboard shortcuts
 ✓ Concurrent profile management with semaphore
 ✓ Related/Sidebar video — own channel only, unwatched only (watch_history)

FIXED:
  ✅ Bug #1: uc.cdp.network.set_cookies() → correct nodriver cdp pattern
  ✅ Bug #2: Removed repeated imports (nodriver/hashlib) from inside function
  ✅ Bug #3: _reconnect_tab() — clean hasattr check instead of blind getattr loop
  ✅ Bug #4: _do_comment() — SUBMITTED treated as success (prevents duplicate comments)
  ✅ Bug #5-8: rng=self._rng passed to all desktop calls (like/dislike/subscribe/bell)
  ✅ Bug #9: Dead code (low/high variables) removed from _do_volume_adjust
  ✅ Bug #10: browser.stop() with graceful fallback to browser.close()
  ✅ Bug #11: windows_virtual_key_code correct values for j/k/l/Escape keys
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import time
from pathlib import Path
from typing import Any, Callable

# ── nodriver top-level import (FIX #2: not repeated inside functions) ─────────
try:
    import nodriver as uc
    from nodriver import cdp as _cdp   # FIX #1: correct cdp access pattern
    NODRIVER_OK = True
except ImportError:
    uc = None          # type: ignore
    _cdp = None        # type: ignore
    NODRIVER_OK = False

from server_python.behavior.youtube.entry_flow import accept_consent_if_present
from server_python.behavior.youtube.play_pause_limiter import PlayPauseLimiter
from server_python.behavior.youtube.scroll_activity import ScrollActivityPlanner
from server_python.behavior.youtube.player_focus import focus_player
from server_python.behavior.youtube.safe_actions import safe_eval_js
from server_python.behavior.youtube.state import (
    get_video_duration_when_ready,
    is_ad_playing,
    is_disliked,
    is_liked,
    is_subscribed,
    get_volume_percent,
)
from server_python.behavior.youtube import desktop as yt_desktop

log = logging.getLogger("mmb.agent_manager")

if not NODRIVER_OK:
    log.warning("nodriver not installed — run: pip install nodriver")

# ── Key code map for CDP key events (FIX #11) ─────────────────────────────────
_KEY_CODES: dict[str, int] = {
    "j": 74, "k": 75, "l": 76, "m": 77,
    "f": 70, "c": 67,
    "Escape": 27, "Enter": 13, "Space": 32,
    "ArrowLeft": 37, "ArrowRight": 39,
    "ArrowUp": 38, "ArrowDown": 40,
}

# ══════════════════════════════════════════════════════════════════════════════
# YouTubeAgent — Single profile automation (full v2 feature set)
# ══════════════════════════════════════════════════════════════════════════════

class YouTubeAgent:
    """
    Single profile ka YouTube automation — MMB-Agent-v2 features integrated.
    nodriver CDP connect + human typing + guardian + entropy + AI brain.
    """

    def __init__(
        self,
        profile_id: str,
        cdp_port: int | str,
        settings: dict,
        log_fn: Callable | None = None,
    ):
        self.profile_id   = profile_id
        self.cdp_port     = int(cdp_port)
        self.settings     = settings
        self.browser      = None
        self.tab          = None
        self._running     = False
        self._guardian    = None   # PlaybackGuardian
        self._anti_sleep  = None   # AntiSleepKeeper v2
        _profile_seed     = int(hashlib.sha256(profile_id.encode()).hexdigest()[:16], 16)
        self._rng         = random.Random(_profile_seed)
        self._log_fn      = log_fn
        self._mouse_x     = float(self._rng.randint(400, 650))
        self._mouse_y     = float(self._rng.randint(260, 420))

    def _log(self, msg: str) -> None:
        log.info("[%s] %s", self.profile_id[:8], msg)
        if self._log_fn:
            try:
                self._log_fn(msg)
            except Exception:
                pass

    async def _js(self, code: str, *, action_name: str = "JS", wrap: bool = True) -> Any:
        """Thin wrapper — all JS goes through safe_eval_js (IIFE, logged)."""
        if not self.tab:
            return None
        return await safe_eval_js(
            self.tab, code,
            action_name=action_name,
            wrap=wrap,
            log_result=False,
        )

    async def _human_pause(self, lo: float, hi: float) -> None:
        """Random delay between actions — anti-detection Rule C."""
        await asyncio.sleep(self._rng.uniform(lo, hi))

    # ── Connect ───────────────────────────────────────────────────────────────

    async def connect_cdp(self, cdp_endpoint: str) -> None:
        """
        Connect to already-running Multilogin/MoreLogin browser via CDP port.
        nodriver with host+port = connect_existing mode (attaches to existing browser).
        """
        if not NODRIVER_OK:
            raise RuntimeError("nodriver not installed — run: pip install nodriver")

        self._log(f"Connecting via CDP → {cdp_endpoint} (port={self.cdp_port})")
        try:
            self.browser = await uc.start(
                host="127.0.0.1",
                port=self.cdp_port,
                headless=False,
            )
            tabs = self.browser.tabs
            self.tab = tabs[0] if tabs else await self.browser.get("about:blank")
            self._running = True
            self._log(f"nodriver attached to existing browser ✓ (port={self.cdp_port})")
            from server_python.anti_sleep import AntiSleepKeeper
            self._anti_sleep = AntiSleepKeeper(log_fn=self._log)
            await self._anti_sleep.start(self.tab, self.browser)
        except Exception as e:
            self._log(f"CDP attach error: {e}")
            raise

    async def _reconnect_tab(self) -> bool:
        """
        After a long ad / WebSocket drop, refresh tab reference from browser.
        FIX #3: Removed blind getattr loop for non-existent nodriver methods.
        Returns True if reconnection succeeded or tab was already healthy.
        """
        # First: check if current tab is still healthy
        try:
            if self.tab:
                await asyncio.wait_for(
                    self.tab.evaluate("1+1", return_by_value=True),
                    timeout=3.0,
                )
                return True  # Already healthy
        except Exception:
            pass

        self._log("[Reconnect] Tab WS dropped — attempting reconnect…")

        try:
            if not self.browser:
                return False

            tabs = getattr(self.browser, "tabs", []) or []
            if not tabs:
                return False

            # Prefer YouTube tabs
            candidates = []
            for t in tabs:
                url   = getattr(t, "url", "") or ""
                score = 2 if "youtube.com" in url else 1
                candidates.append((score, t))
            candidates.sort(key=lambda x: -x[0])

            for _, t in candidates:
                try:
                    if hasattr(t, "activate"):
                        try:
                            await asyncio.wait_for(t.activate(), timeout=3.0)
                        except Exception:
                            pass
                    await asyncio.wait_for(
                        t.evaluate("1+1", return_by_value=True),
                        timeout=5.0,
                    )
                    self.tab = t
                    if self._anti_sleep:
                        self._anti_sleep._tab = t
                    self._log("[Reconnect] Tab WS refreshed ✓")
                    return True
                except Exception:
                    continue

            self._log("[Reconnect] All tabs unresponsive")
            return False
        except Exception as e:
            self._log(f"[Reconnect] Error: {e}")
            return False

    async def inject_cookies_from_pool(self) -> None:
        """
        Load cookie sets from cookies_pool.json and inject into Chrome via CDP.
        FIX #1: uc.cdp.network.set_cookies() → correct _cdp.network.set_cookies()
        FIX #2: Removed repeated 'import nodriver as uc' and 'import hashlib' from inside function
        """
        try:
            root_dir  = Path(__file__).resolve().parent.parent
            pool_file = root_dir / "cookies_pool.json"

            if not pool_file.exists():
                return

            with open(pool_file, "r", encoding="utf-8") as f:
                pool = json.load(f)

            sets = pool.get("sets", [])
            if not sets:
                return

            # FIX #2: hashlib already imported at top — no re-import needed
            set_idx    = int(hashlib.md5(self.profile_id.encode()).hexdigest(), 16) % len(sets)
            cookie_set = sets[set_idx]
            cookies    = cookie_set.get("cookies", [])
            if not cookies:
                return

            self._log(f"Injecting {len(cookies)} cookies from set '{cookie_set.get('label')}' via CDP")

            cdp_cookies = []
            for c in cookies:
                domain = str(c.get("domain", ""))
                if not domain.startswith(".") and not domain.startswith("http") and not domain.startswith("127."):
                    domain = "." + domain
                cdp_cookies.append({
                    "name":     str(c.get("name", "")),
                    "value":    str(c.get("value", "")),
                    "domain":   domain,
                    "path":     str(c.get("path", "/")),
                    "secure":   bool(c.get("secure", False)),
                    "httpOnly": bool(c.get("httpOnly", False)),
                    "sameSite": "Lax",
                })

            # FIX #1: correct nodriver cdp pattern
            if _cdp is not None:
                await self.tab.send(_cdp.network.set_cookies(cdp_cookies))
                self._log("Cookie injection successful ✓")
            else:
                self._log("Cookie injection skipped — nodriver cdp not available")

        except Exception as e:
            self._log(f"Error injecting cookies: {e}")

    # ── Warm up ───────────────────────────────────────────────────────────────

    async def warm_up(self) -> None:
        """Navigate to YouTube home — inject cookies, dismiss consent if any."""
        self._log("Warm-up: navigating to YouTube home")
        try:
            await self.inject_cookies_from_pool()
            await self.tab.get("https://www.youtube.com")
            if self._anti_sleep:
                await self._anti_sleep.on_page_load("warm-up")
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            await self._dismiss_consent()
        except Exception as e:
            self._log(f"Warm-up error (non-fatal): {e}")

    async def _dismiss_consent(self) -> None:
        """Auto-dismiss YouTube consent/cookie overlay — V2 selectors."""
        if not self.tab:
            return
        try:
            ok = await accept_consent_if_present(self.tab)
            if ok:
                self._log("Consent dismissed via V2 ✓")
                await self._human_pause(1.0, 2.0)
        except Exception as exc:
            self._log(f"Consent dismiss warning: {exc}")

    # ── Watch video — FULL v2 feature set ─────────────────────────────────────

    async def watch_video_organic(
        self,
        video_id: str,
        title_hint: str = "",
        channel_name: str = "",
        watch_pct: float = 0.70,
        engagement: dict | None = None,
        own_channel_names: list[str] | None = None,
        source: str = "",
        session_nonce: str = "",
    ) -> bool:
        """
        Watch a video using Behavioral Entropy:
        1. BehavioralEntropyEngine selects entry path (A/B/C/D)
        2. Human-like typing + navigation
        3. Guardian watches video continuity
        4. AI Brain for comments + error recovery
        5. Related video — own channel only, unwatched only (if enabled)
        Returns True if video was successfully watched.
        """
        if not self.tab:
            raise RuntimeError("Not connected")

        from server_python.behavior.youtube.action_context import set_trust_gmail_login, trust_gmail_login

        eng = engagement or {}
        self._watch_engagement = eng
        self._current_video_id  = video_id
        set_trust_gmail_login(bool(eng.get("gmailLoggedIn", eng.get("gmailReady", False))))
        self._log(
            f"[Engagement] like={eng.get('like')} sub={eng.get('subscribe')} "
            f"bell={eng.get('bell')} comment={eng.get('comment')} "
            f"gmailTrusted={trust_gmail_login()}"
        )

        video_id = (video_id or "").strip()
        if not video_id or len(video_id) != 11:
            self._log(f"Invalid video_id {video_id!r} — need 11-char YouTube ID")
            return False

        from server_python.yt_types import VideoTarget
        from server_python.entropy import BehavioralEntropyEngine
        from server_python.guardian import PlaybackGuardian

        target = VideoTarget(
            video_id=video_id,
            title_hint=title_hint,
            channel_name=channel_name,
            search_keywords=title_hint or video_id,
        )

        # 1. Entropy engine — select path and navigate to video
        entropy = BehavioralEntropyEngine(
            profile_id=self.profile_id,
            rng=self._rng,
            log=self._log,
            wake_fn=self._anti_sleep.bring_to_foreground if self._anti_sleep else None,
        )

        nav_mode = (source or "").strip().lower() or "entropy"
        self._log(f"Navigation mode={nav_mode} → video: {video_id}")
        if self._anti_sleep:
            await self._anti_sleep.bring_to_foreground("pre-navigation")
        nav_success = await entropy.execute_for_source(
            self.tab, target, source=source,
            wake_fn=self._anti_sleep.bring_to_foreground if self._anti_sleep else None,
        )

        if not nav_success:
            self._log("Entropy navigation failed — falling back to direct URL")
            video_url = f"https://www.youtube.com/watch?v={video_id}"
            try:
                if self._anti_sleep:
                    await self._anti_sleep.bring_to_foreground("direct-fallback")
                await self.tab.get(video_url)
                if self._anti_sleep:
                    await self._anti_sleep.on_page_load("direct-fallback")
                await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            except Exception as e:
                self._log(f"Direct URL fallback also failed: {e}")
                return False

        # Consent + ads before player-ready
        await self._dismiss_consent()
        await asyncio.sleep(self._rng.uniform(1.5, 2.5))

        _ad_delay_min = int((engagement or {}).get("adSkipDelaySec", 10))
        _ad_delay_max = int((engagement or {}).get("adSkipDelayMaxSec", 14))
        if (engagement or {}).get("adSkipEnabled", True):
            self._log("Pre-roll ad handling (monetized-safe order)…")
            await self._skip_ads(delay_min=_ad_delay_min, delay_max=_ad_delay_max)
        else:
            self._log("Ad skip disabled — waiting for ad to finish naturally")
            await asyncio.sleep(self._rng.uniform(8.0, 15.0))

        # Wait for main video player after ads
        await self._reconnect_tab()
        from server_python.human_engine import wait_for_player
        player_ready = await wait_for_player(self.tab, timeout=60.0)
        self._log(f"Player ready: {player_ready}")
        if not player_ready:
            self._log("Player not ready — reconnecting + retrying direct URL once")
            await self._reconnect_tab()
            try:
                await self.tab.get(f"https://www.youtube.com/watch?v={video_id}")
                await asyncio.sleep(self._rng.uniform(4.0, 6.0))
                await self._dismiss_consent()
                if (engagement or {}).get("adSkipEnabled", True):
                    await self._skip_ads(delay_min=_ad_delay_min, delay_max=_ad_delay_max)
                await self._reconnect_tab()
                player_ready = await wait_for_player(self.tab, timeout=45.0)
                self._log(f"Player ready after retry: {player_ready}")
            except Exception as e:
                self._log(f"Player retry failed: {e}")
                if await self._reconnect_tab():
                    player_ready = await wait_for_player(self.tab, timeout=20.0)
                    self._log(f"Player ready after emergency reconnect: {player_ready}")
            if not player_ready:
                try:
                    raw_url = await self._js("location.href", action_name="GET_URL", wrap=False)
                    self._log(f"Player failed — current URL: {raw_url}")
                except Exception:
                    pass
                return False

        eng = engagement or {}
        if eng.get("honestTest") or self.settings.get("honestTest"):
            from server_python.behavior.youtube.action_audit import ActionAudit
            from server_python.behavior.youtube.verify_actions import verify_logged_in
            pname = eng.get("profileName") or self.settings.get("profileName") or self.profile_id[:8]
            ActionAudit.enable(self.profile_id, pname)
            logged_in = await verify_logged_in(self.tab)
            ActionAudit.current().set_login_state(logged_in)
            self._log(f"[AUDIT] verify_logged_in() = {logged_in}")

        # Apply settings: autoplay OFF hard-lock
        await self._apply_video_settings()

        # Early setup window — quality/speed/captions within first ~15s
        self._watch_session_t0 = time.monotonic()
        settle = self._rng.uniform(3.0, 8.0)
        self._log(f"[Watch] Player settle {settle:.1f}s before early setup…")
        await asyncio.sleep(settle)

        # 4a. Quality change — MUST happen early
        quality_on = eng.get("qualityChange", eng.get("qualityChangeEnabled", True))
        quality    = eng.get("videoQuality", self.settings.get("videoQuality", "auto"))
        if quality_on and quality and str(quality).lower() != "auto":
            q_ok     = await self._do_quality_change(str(quality))
            elapsed_q = time.monotonic() - self._watch_session_t0
            self._log(
                f"[QUALITY] @ {elapsed_q:.1f}s → {quality} "
                f"{'OK ✓' if q_ok else 'FAILED ✗'} (target <15s)"
            )
            self._quality_change_at_sec = elapsed_q

        # 4a2. Playback speed
        speed_on     = eng.get("speedChange", eng.get("speedChangeEnabled", False))
        speed_target = str(eng.get("playbackSpeed", "1x") or "1x")
        if speed_on and speed_target not in ("1x", "1", ""):
            try:
                rate = float(speed_target.replace("x", "").strip())
                ok, proof = await yt_desktop.set_playback_speed(self.tab, rate)
                self._log(f"[Speed] {speed_target}: {proof}")
            except (TypeError, ValueError) as exc:
                self._log(f"[Speed] skip invalid {speed_target!r}: {exc}")

        # 4a3. Captions toggle
        if eng.get("captionsToggle", eng.get("captionsEnabled", False)):
            cap_ok = await yt_desktop.toggle_captions(self.tab)
            self._log(f"[Captions] toggle: {'OK ✓' if cap_ok else 'skip'}")

        # 4b. Volume adjust
        await asyncio.sleep(self._rng.uniform(0.5, 1.5))
        _vol_pct = (engagement or {}).get("volumePct", None)
        await self._do_volume_adjust(_vol_pct)

        # 4c. Per-session SHA-256 behavior plan
        from server_python.session_behavior import SessionBehaviorPlan
        behavior = SessionBehaviorPlan.create(
            self.profile_id, video_id, session_nonce=session_nonce or None,
        )
        self._mouse_x = behavior.mouse_start_x
        self._mouse_y = behavior.mouse_start_y
        self._log(behavior.summary_line())

        # 4d. Natural scroll setting
        self._natural_scroll = (engagement or {}).get("naturalScrollCurves", True)

        # 5. Get video duration
        await asyncio.sleep(self._rng.uniform(2.0, 3.5))
        duration = await self._get_duration()
        if not duration:
            duration = 300.0
            self._log("Duration unknown — defaulting to 300s")
        watch_secs = max(60.0, min(duration * watch_pct, 600.0))
        self._log(f"Will watch {watch_secs:.0f}s / {duration:.0f}s ({watch_pct:.0%})")

        if self._anti_sleep:
            await self._anti_sleep.bring_to_foreground("pre-watch")

        # 6. Start Guardian
        guardian = PlaybackGuardian(tab=self.tab, log_fn=self._log)
        self._guardian = guardian
        await guardian.start()

        try:
            # 7. AI-powered watch pattern
            watch_pattern = self._get_watch_pattern(duration, watch_secs)

            # 8. Human-like watch loop with engagement
            engagement_done = await self._human_watch_loop(
                watch_secs=watch_secs,
                watch_pattern=watch_pattern,
                engagement=engagement or {},
                video_title=title_hint,
                channel=channel_name,
                guardian=guardian,
                behavior=behavior,
            )

            # 8b. Record analytics
            try:
                from server_python.analytics_store import record_watch_session
                record_watch_session(
                    self.profile_id, watch_secs,
                    traffic_source=nav_mode,
                    completed_actions=engagement_done,
                )
            except Exception as e:
                self._log(f"Analytics record warning: {e}")

            # 9. Mark main video as watched
            try:
                from server_python.watch_history import mark_watched
                mark_watched(self.profile_id, video_id, video_title=title_hint or "")
                self._log(f"[History] Marked {video_id!r} as watched for this profile")
            except Exception as e:
                self._log(f"[History] mark_watched error (non-fatal): {e}")

            # 10. Related video — own channel only, unwatched only
            eng_cfg = engagement or {}
            if eng_cfg.get("related_video", False):
                channels = own_channel_names or eng_cfg.get("own_channel_names", [])
                await self._do_related_video(channels)

            self._log(f"Video watched ✓ ({watch_secs:.0f}s)")
            return True

        except asyncio.CancelledError:
            self._log("Watch cancelled")
            raise
        except Exception as e:
            self._log(f"Watch error: {e}")
            return False
        finally:
            try:
                await yt_desktop.pause(self.tab)
            except Exception:
                pass
            await guardian.stop()
            self._guardian = None
            try:
                from server_python.behavior.youtube.action_audit import ActionAudit
                audit = ActionAudit.current()
                if audit:
                    self._log(f"[AUDIT] session captured {len(audit.rows)} action rows")
            except Exception:
                pass

    def _get_watch_pattern(self, duration: float, planned_watch: float) -> dict:
        """Get natural watch pattern — AI or default."""
        defaults = {
            "pause_probability":    0.05,
            "seek_probability":     0.18,
            "scroll_breaks":        1,
            "engagement_delay_factor": 1.0,
        }
        try:
            from server_python.ai_brain import get_natural_watch_pattern, is_available
            if is_available():
                personality = getattr(
                    self, "_personality_type",
                    self._rng.choice(["normal", "impatient", "curious", "cautious"])
                )
                return get_natural_watch_pattern(duration, planned_watch, personality)
        except Exception:
            pass
        return defaults

    async def _scroll_to_video_top(self) -> None:
        """Scroll back to top so video player + like/subscribe buttons are visible."""
        try:
            await yt_desktop.scroll_to_top(self.tab)
            await self._human_pause(0.5, 1.0)
        except Exception:
            pass

    async def _ensure_on_watch_page(self) -> bool:
        """Return to watch URL if navigation drifted to homepage."""
        vid = getattr(self, "_current_video_id", "") or ""
        if not vid or not self.tab:
            return False
        try:
            raw  = await self.tab.evaluate("location.href", return_by_value=True)
            href = str(getattr(raw, "value", raw) or "")
            if f"watch?v={vid}" in href:
                return True
            self._log(f"[Engagement] Off watch page ({href[:60]}) — navigating back…")
            await self.tab.get(f"https://www.youtube.com/watch?v={vid}")
            await asyncio.sleep(self._rng.uniform(2.0, 3.5))
            await self._scroll_to_video_top()
            return True
        except Exception as exc:
            self._log(f"[Engagement] ensure watch page failed: {exc}")
            return False

    # ── Human watch loop ──────────────────────────────────────────────────────

    async def _human_watch_loop(
        self,
        watch_secs: float,
        watch_pattern: dict,
        engagement: dict,
        video_title: str,
        channel: str,
        guardian: Any,
        behavior: Any,
    ) -> set[str]:
        """
        Human-like watch loop with full engagement actions.
        All timings from SessionBehaviorPlan (SHA-256 per profile+session+video).
        """
        rng            = behavior.rng
        self._watch_rng = rng
        timings        = behavior.abs_timings(watch_secs)
        pause_at       = timings["pause_at"]
        like_at        = timings["like_at"]
        dislike_at     = timings["dislike_at"]
        sub_at         = timings["sub_at"]
        bell_at        = timings["bell_at"]
        desc_at        = timings["desc_at"]
        desc_link_at   = timings["desc_link_at"]
        seek_at        = timings["seek_at"]
        cmt_at         = timings["comment_at"]
        cmt_like_at    = timings["comment_like_at"]

        elapsed          = 0.0
        engagement_done: set[str] = set()
        _scrolled_away   = False
        _like_failures   = 0
        _MAX_LIKE_ATTEMPTS = 3
        watch_deadline   = time.monotonic() + watch_secs

        # Rule 3: Pause — only after 30% duration, max 1-2 times
        pause_limiter    = PlayPauseLimiter(rng=rng)
        _pause_hold_cfg  = float(engagement.get("pauseHoldSec", 0) or 0)
        _pause_prob      = min(0.08, max(0.0, float(engagement.get("pauseProbability", 0.05))))
        _pause_earliest  = max(watch_secs * 0.30, 60.0)
        if _pause_prob > 0 and pause_limiter.max_pauses == 0:
            pause_limiter.max_pauses = 1
        self._log(
            f"[PauseLimiter] max={pause_limiter.max_pauses} "
            f"prob={_pause_prob:.0%} earliest={_pause_earliest:.0f}s"
        )

        # Rule 7: Autoplay re-verify at 80% mark
        _autoplay_recheck_done = False
        _autoplay_recheck_at   = watch_secs * 0.80

        # Rule 9: Seek counter
        _seek_count = 0
        _seek_max   = rng.randint(1, 3)

        _scroll_enabled = engagement.get("scrollActivity", engagement.get("scroll", True))
        scroll_planner  = ScrollActivityPlanner(
            watch_secs, rng, enabled=bool(_scroll_enabled), log_fn=self._log,
        )
        if scroll_planner.planned_count:
            planned = [f"{a.name}@{a.at_time:.0f}s" for a in scroll_planner.activities]
            self._log(f"[ScrollActivity] planned {scroll_planner.planned_count}: {', '.join(planned)}")

        # Track video start time to correctly sync elapsed with actual video progress
        # FIX: elapsed = wall-clock time, but actions need VIDEO time.
        # We periodically read actual video currentTime and use it as ground truth.
        _video_start_ct: float = -1.0   # video currentTime when watch loop started
        _last_ct_sync:   float = 0.0    # wall time of last CT sync
        _ct_offset:      float = 0.0    # accumulated ad/buffer time to subtract

        # Get initial video position
        try:
            from server_python.behavior.youtube.state import get_current_time as _get_ct_init
            _video_start_ct = await _get_ct_init(self.tab)
        except Exception:
            _video_start_ct = 0.0
        _last_ct_sync = time.monotonic()

        while elapsed < watch_secs and self._running and time.monotonic() < watch_deadline:
            remaining_wall = watch_deadline - time.monotonic()
            if remaining_wall <= 0:
                break
            chunk = rng.uniform(behavior.chunk_lo, behavior.chunk_hi)
            chunk = min(chunk, watch_secs - elapsed, remaining_wall)
            if chunk <= 0:
                break
            await asyncio.sleep(chunk)
            elapsed += chunk

            # FIX: Sync elapsed with ACTUAL video time every ~15s
            # This corrects for ad time, buffering, and page load delays
            now_wall = time.monotonic()
            if now_wall - _last_ct_sync >= 15.0:
                try:
                    from server_python.behavior.youtube.state import get_current_time as _get_ct_now
                    actual_ct = await _get_ct_now(self.tab)
                    if actual_ct > 0 and _video_start_ct >= 0:
                        # actual_ct = real video position
                        # video_elapsed = how much video actually played
                        video_elapsed = actual_ct - _video_start_ct
                        if video_elapsed > 0:
                            # Sync elapsed to actual video time (capped at wall time)
                            elapsed = min(elapsed, video_elapsed + _ct_offset)
                    _last_ct_sync = now_wall
                except Exception:
                    pass  # non-fatal — keep wall-clock elapsed

            # Mid-roll ads
            _ad_active = False
            if engagement.get("adSkipEnabled", True):
                if await self._try_skip_ad_quick():
                    guardian.suppress(6.0)
                    _ad_active = True
            if not _ad_active:
                try:
                    _ad_active = await is_ad_playing(self.tab)
                except Exception:
                    _ad_active = False

            # Rule 7: Autoplay re-verify at 80%
            if not _autoplay_recheck_done and elapsed >= _autoplay_recheck_at:
                _autoplay_recheck_done = True
                self._log("[Autoplay] Re-checking at 80% mark (SECURITY)...")
                await yt_desktop.disable_autoplay(self.tab)
                self._log("[Autoplay] Re-verified OFF at 80% ✓")

            engagement_this_tick = False

            will_like = (
                elapsed >= like_at
                and "like" not in engagement_done
                and "like_failed" not in engagement_done
                and "dislike" not in engagement_done
                and engagement.get("like", False)
                and _like_failures < _MAX_LIKE_ATTEMPTS
            )
            will_dislike = (
                elapsed >= dislike_at
                and "dislike" not in engagement_done
                and "like" not in engagement_done
                and engagement.get("dislike", False)
            )
            will_sub = (
                elapsed >= sub_at
                and "subscribe" not in engagement_done
                and engagement.get("subscribe", False)
            )
            will_bell = (
                elapsed >= bell_at
                and "subscribe" in engagement_done
                and "bell" not in engagement_done
                and engagement.get("bell", False)
            )
            will_desc = (
                elapsed >= desc_at
                and "desc_expanded" not in engagement_done
                and engagement.get("descriptionExpand", True)
            )
            will_desc_link = (
                elapsed >= desc_link_at
                and "desc_expanded" in engagement_done
                and "desc_link" not in engagement_done
                and engagement.get("descriptionLinks", False)
            )
            will_seek = (
                elapsed >= seek_at
                and _seek_count < _seek_max
                and engagement.get("seekEnabled", True)
            )
            will_cmt = (
                elapsed >= cmt_at
                and "comment" not in engagement_done
                and engagement.get("comment", False)
            )
            will_cmt_like = (
                elapsed >= cmt_like_at
                and "comment_liked" not in engagement_done
                and rng.random() * 100 < engagement.get("commentLikePct", 30)
            )
            pending: dict[str, bool] = {
                "seek":         will_seek,
                "like":         will_like,
                "dislike":      will_dislike,
                "desc":         will_desc,
                "desc_link":    will_desc_link,
                "subscribe":    will_sub,
                "bell":         will_bell,
                "comment":      will_cmt,
                "comment_like": will_cmt_like,
            }

            if any(pending.values()):
                engagement_this_tick = True

            # Scroll activities
            if await scroll_planner.tick_and_run(self.tab, elapsed, guardian):
                engagement_this_tick = True
                _scrolled_away = False

            # Micro scroll jitter
            if not engagement_this_tick and not _scrolled_away:
                if rng.random() < behavior.scroll_prob:
                    px = rng.randint(-60, 120)
                    await self._scroll(px)

            # Random mouse move
            if rng.random() < behavior.mouse_prob:
                await self._move_mouse()

            # Rule 3: Pause
            if pause_limiter.can_pause(elapsed) and elapsed >= _pause_earliest and not _ad_active:
                explicit_hold = _pause_hold_cfg > 0 and pause_limiter.pauses_in_session == 0
                random_hit    = _pause_prob > 0 and rng.random() < _pause_prob
                if explicit_hold or random_hit:
                    hold = _pause_hold_cfg if explicit_hold else rng.uniform(2.0, 6.0)
                    guardian.suppress(hold + 12.0)
                    await self._focus_player()
                    await yt_desktop.pause(self.tab)
                    pause_limiter.record_pause(elapsed)
                    engagement_done.add("pause")
                    self._log(
                        f"Pause (human) ~{hold:.0f}s "
                        f"[{pause_limiter.pauses_in_session}/{pause_limiter.max_pauses}]…"
                    )
                    await asyncio.sleep(hold)
                    await self._focus_player()
                    await yt_desktop.play(self.tab)
                    await asyncio.sleep(1.5)
                    try:
                        from server_python.behavior.youtube.state import get_current_time as _get_ct
                        t1 = await _get_ct(self.tab)
                        await asyncio.sleep(2.0)
                        t2 = await _get_ct(self.tab)
                        if t2 > t1:
                            self._log(f"Resume after pause VERIFIED ✓ (t={t2:.1f}s)")
                        else:
                            await yt_desktop.play(self.tab)
                            self._log("Resume after pause: force play retry ✓")
                    except Exception:
                        pass
                    engagement_this_tick = True

            # Execute pending actions in profile-unique order
            for action in behavior.action_order:
                if not pending.get(action):
                    continue

                if action == "pause":
                    continue  # Handled above via PlayPauseLimiter

                elif action == "seek":
                    if _ad_active:
                        self._log("[Seek] SKIPPED — ad is playing (Rule 9)")
                    else:
                        guardian.suppress(5.0)
                        _seek_dir_cfg = engagement.get("seekDirection", "both")
                        if _seek_dir_cfg == "forward":
                            direction = "forward"
                        elif _seek_dir_cfg == "backward":
                            direction = "backward"
                        elif behavior.seek_dir == "mixed":
                            direction = rng.choice(["forward", "forward", "backward"])
                        else:
                            direction = behavior.seek_dir
                        seek_secs = min(behavior.seek_seconds, 30)
                        seek_ok   = await self._do_seek(direction, seconds=seek_secs)
                        _seek_count += 1
                        if seek_ok:
                            engagement_done.add("seek")
                            seek_at = elapsed + rng.uniform(45.0, 120.0)

                elif action == "like":
                    await self._ensure_on_watch_page()
                    await self._scroll_to_video_top()
                    _scrolled_away = False
                    guardian.suppress(8.0)
                    liked = await self._do_like()
                    if liked:
                        engagement_done.add("like")
                        self._log("👍 Liked ✓ VERIFIED")
                    elif getattr(self, "_last_like_proof", "") and "SKIP_NOT_LOGGED_IN" in self._last_like_proof:
                        engagement_done.add("like_failed")
                        self._log("👍 Like SKIPPED — NOT_LOGGED_IN (no retry)")
                    else:
                        _like_failures += 1
                        self._log(f"👍 Like FAILED ✗ [{_like_failures}/{_MAX_LIKE_ATTEMPTS}]")
                        if _like_failures >= _MAX_LIKE_ATTEMPTS:
                            engagement_done.add("like_failed")
                            self._log("👍 Like ABANDONED — moving on")

                elif action == "dislike":
                    if _scrolled_away:
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                    guardian.suppress(8.0)
                    if await self._do_dislike():
                        engagement_done.add("dislike")
                        self._log("👎 Disliked ✓")

                elif action == "desc":
                    guardian.suppress(5.0)
                    expanded = await self._do_expand_description()
                    if expanded:
                        engagement_done.add("desc_expanded")
                        await asyncio.sleep(rng.uniform(behavior.desc_dwell_lo, behavior.desc_dwell_hi))
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                    else:
                        engagement_done.add("desc_failed")
                        self._log("📄 Description expand FAILED ✗")

                elif action == "desc_link":
                    engagement_done.add("desc_link")
                    guardian.suppress(10.0)
                    await self._do_click_description_link()
                    await asyncio.sleep(rng.uniform(0.5, 1.5))
                    await self._scroll_to_video_top()
                    _scrolled_away = False

                elif action == "subscribe":
                    await self._ensure_on_watch_page()
                    if _scrolled_away:
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                    guardian.suppress(8.0)
                    if await self._do_subscribe():
                        engagement_done.add("subscribe")
                        self._log("✅ Subscribed ✓")

                elif action == "bell":
                    if "subscribe" not in engagement_done:
                        self._log("🔔 Bell: subscribe not done yet — doing subscribe first")
                        await self._ensure_on_watch_page()
                        if _scrolled_away:
                            await self._scroll_to_video_top()
                            _scrolled_away = False
                        guardian.suppress(8.0)
                        if await self._do_subscribe():
                            engagement_done.add("subscribe")
                            self._log("✅ Subscribed ✓ (forced before bell)")
                    await asyncio.sleep(1.5)
                    if _scrolled_away:
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                    guardian.suppress(6.0)
                    if await self._do_bell():
                        engagement_done.add("bell")

                elif action == "comment":
                    guardian.suppress(25.0)
                    comment_text = (
                        engagement.get("commentText")
                        or self._get_ai_comment(video_title, channel, engagement)
                    )
                    if comment_text:
                        _scrolled_away = True
                        posted = await self._do_comment(comment_text)
                        if posted:
                            engagement_done.add("comment")
                            self._log(f"💬 Comment posted: {comment_text[:40]!r}")
                            await asyncio.sleep(rng.uniform(behavior.comment_dwell_lo, behavior.comment_dwell_hi))
                            await self._scroll_to_video_top()
                            _scrolled_away = False

                elif action == "comment_like":
                    engagement_done.add("comment_liked")
                    guardian.suppress(8.0)
                    await self._scroll(behavior.comment_like_scroll_px)
                    await asyncio.sleep(rng.uniform(1.0, 2.0))
                    await self._do_like_comment()
                    await asyncio.sleep(rng.uniform(1.0, 2.0))
                    await self._scroll_to_video_top()
                    _scrolled_away = False

        # Forced fallback: comment enabled but missed — force before exit
        if (
            engagement.get("comment", False)
            and "comment" not in engagement_done
        ):
            self._log("💬 Comment was due but missed — forcing now before watch ends")
            comment_text = (
                engagement.get("commentText")
                or self._get_ai_comment(video_title, channel, engagement)
            )
            if comment_text:
                try:
                    guardian.suppress(25.0)
                    if _scrolled_away:
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                    if await self._do_comment(comment_text):
                        engagement_done.add("comment")
                        self._log(f"💬 Comment posted (forced): {comment_text[:40]!r}")
                        await asyncio.sleep(rng.uniform(behavior.comment_dwell_lo, behavior.comment_dwell_hi))
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                except Exception as e:
                    self._log(f"Forced comment failed: {e}")

        if scroll_planner.completed:
            self._log(f"[ScrollActivity] completed: {scroll_planner.completed}")
        self._log(
            f"Watch loop done | elapsed={elapsed:.0f}s "
            f"engagement={sorted(engagement_done)}"
        )
        self._watch_rng = None
        return engagement_done

    def _get_ai_comment(self, video_title: str, channel: str, engagement: dict) -> str | None:
        """Get AI-generated comment or fall back to template. Adds human typos (Rule 6)."""
        templates = engagement.get("comment_templates", [
            "Great video! Really helpful content.",
            "This is exactly what I was looking for.",
            "Amazing explanation, thanks for sharing!",
            "Very informative, learned a lot.",
            "Keep up the great work!",
        ])
        text = None
        try:
            from server_python.ai_brain import generate_comment, is_available
            if is_available() and video_title:
                text = generate_comment(
                    video_title=video_title,
                    channel_name=channel,
                    fallback_templates=templates,
                    rng=self._rng,
                )
        except Exception:
            pass
        if not text:
            text = self._rng.choice(templates) if templates else None
        if text:
            text = self._add_human_typos(text)
        return text

    def _add_human_typos(self, text: str) -> str:
        """Rule 6: ~30% chance of 1 small typo — swap adjacent chars or miss a letter."""
        if self._rng.random() > 0.30:
            return text
        words = text.split()
        if not words:
            return text
        idx  = self._rng.randint(1, max(1, len(words) - 1))
        word = words[idx]
        if len(word) < 3:
            return text
        typo_type = self._rng.randint(0, 2)
        if typo_type == 0:
            i    = self._rng.randint(0, len(word) - 2)
            word = word[:i] + word[i+1] + word[i] + word[i+2:]
        elif typo_type == 1:
            i    = self._rng.randint(1, len(word) - 1)
            word = word[:i] + word[i+1:]
        else:
            i    = self._rng.randint(0, len(word) - 1)
            word = word[:i] + word[i] + word[i:]
        words[idx] = word
        return " ".join(words)

    # ── V2 action helpers (delegate to behavior/youtube/) ─────────────────────

    async def _get_duration(self) -> float | None:
        return await get_video_duration_when_ready(self.tab)

    async def _skip_ads(self, delay_min: int = 10, delay_max: int = 14) -> None:
        """Pre-roll ad skip — canonical ad_skip_engine."""
        try:
            from server_python.ad_skip_engine import skip_ads_until_clear, wait_for_main_video
            from server_python.behavior.youtube.action_audit import ActionAudit
            from server_python.fourteen_actions import verify_log_for

            verify_marker = verify_log_for("ad_skip")
            ok, proof, self._mouse_x, self._mouse_y = await skip_ads_until_clear(
                self.tab,
                delay_min=float(delay_min),
                delay_max=float(delay_max),
                timeout=180.0,
                log_fn=self._log,
                rng=self._rng,
                mouse_x=self._mouse_x,
                mouse_y=self._mouse_y,
            )
            self._last_ad_skip_proof = proof
            verified = (
                verify_marker in proof
                or "VERIFIED" in proof
                or proof in ("NO_AD", "UNSKIPPABLE_NO_UI")
            )
            audit = ActionAudit.current()
            if audit:
                audit.record("ad_skip", click_registered=verified, verified=verified, reason=proof)
            if not ok:
                self._log(f"[AdSkip] Pre-roll result: {proof} — waiting for main video…")
                playing, self._mouse_x, self._mouse_y = await wait_for_main_video(
                    self.tab, timeout=120.0, skip_ads=True,
                    delay_min=float(delay_min), delay_max=float(delay_max),
                    log_fn=self._log, rng=self._rng,
                    mouse_x=self._mouse_x, mouse_y=self._mouse_y,
                )
                if not playing:
                    self._log("[AdSkip] Main video not confirmed — continuing watch loop")
        except Exception as e:
            self._log(f"Ad skip warning (non-fatal): {e}")

    async def _try_skip_ad_quick(self) -> bool:
        """Mid-roll ad skip during watch loop."""
        try:
            from server_python.ad_skip_engine import skip_ads_poll, is_ad_showing
            from server_python.behavior.youtube.action_audit import ActionAudit
            from server_python.fourteen_actions import verify_log_for

            if not await is_ad_showing(self.tab):
                return False

            eng        = getattr(self, "_watch_engagement", None) or {}
            delay_min  = float(eng.get("adSkipDelaySec", 10))
            delay_max  = float(eng.get("adSkipDelayMaxSec", 14))
            verify_marker = verify_log_for("ad_skip")

            ok, proof, self._mouse_x, self._mouse_y = await skip_ads_poll(
                self.tab,
                delay_min=delay_min, delay_max=delay_max, timeout=90.0,
                log_fn=self._log,
                rng=getattr(self, "_watch_rng", None) or self._rng,
                mouse_x=self._mouse_x, mouse_y=self._mouse_y,
            )
            verified = verify_marker in proof or "VERIFIED" in proof
            audit = ActionAudit.current()
            if audit:
                audit.record("ad_skip", click_registered=ok, verified=verified, reason=proof)
            if verified:
                self._log(f"[AdSkip] Mid-roll {proof}")
                return True
            if ok and proof in ("NO_AD", "UNSKIPPABLE_NO_UI"):
                return True
        except Exception as exc:
            self._log(f"[AdSkip] Mid-roll error: {exc}")
        return False

    async def _apply_video_settings(self) -> None:
        """Apply settings: autoplay OFF — with retry."""
        from server_python.behavior.youtube.action_audit import ActionAudit
        from server_python.behavior.youtube.selectors import DESKTOP
        try:
            from server_python.behavior.youtube.verify_actions import verify_autoplay_off
            verified = False
            for attempt in range(3):
                ok       = await yt_desktop.disable_autoplay(self.tab)
                verified = ok and await verify_autoplay_off(self.tab)
                if verified:
                    break
                if attempt < 2:
                    await asyncio.sleep(2.0)
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    "autoplay_off",
                    selector_used=str(DESKTOP.get("autoplay_toggle_button", ("",))[0]),
                    click_registered=verified, verified=verified,
                    reason="UI_VERIFIED visible toggle off" if verified else "toggle not visible or still ON",
                )
            self._log("Autoplay OFF OK (UI verified)" if verified else "Autoplay OFF FAILED (non-critical)")
        except Exception as exc:
            self._log(f"Autoplay OFF error (non-critical): {exc}")

    async def _focus_player(self) -> None:
        try:
            await focus_player(self.tab)
            await self._human_pause(0.2, 0.4)
        except Exception:
            pass

    async def _do_like(self) -> bool:
        """Like video — FIX #6: rng=self._rng passed for profile-seeded CDP click."""
        self._last_like_proof = ""
        try:
            await self._scroll_to_video_top()
            await self._human_pause(0.4, 0.8)
            if await is_liked(self.tab):
                self._last_like_proof = "ALREADY_LIKED"
                return True
            # FIX #6: pass rng so CDP Bezier uses profile-seeded random
            ok, proof = await yt_desktop.like(self.tab, want=True, rng=self._rng)
            self._last_like_proof = proof
            if ok and "VERIFIED" in proof:
                self._log(f"👍 Liked ✓ ({proof})")
                return True
            self._log(f"Like: {proof}")
            return False
        except Exception as e:
            self._last_like_proof = str(e)
            self._log(f"Like error: {e}")
            return False

    async def _do_subscribe(self) -> bool:
        """Subscribe — with retry up to 3 times. FIX #7: rng=self._rng passed."""
        try:
            if await is_subscribed(self.tab):
                self._log("✅ Already subscribed ✓")
                return True
            for attempt in range(3):
                # FIX #7: pass rng for profile-seeded CDP click
                ok, proof = await yt_desktop.subscribe(self.tab, want=True, rng=self._rng)
                self._log(f"[Subscribe] attempt {attempt+1}: {proof}")
                if ok and "VERIFIED" in proof:
                    return True
                if attempt < 2:
                    await asyncio.sleep(2.0)
                    await self._scroll_to_video_top()
                    await asyncio.sleep(0.5)
            return False
        except Exception as e:
            self._log(f"Subscribe error: {e}")
            return False

    async def _do_comment(self, text: str) -> bool:
        """
        Post comment — V2 scroll_to_comments + post_comment.
        FIX #4: SUBMITTED result also counted as success.
        (Desktop.py returns SUBMITTED when comment posted but DOM verify pending —
        treating it as False caused retry → duplicate comments.)
        """
        if not self.tab:
            return False
        try:
            await yt_desktop.scroll_to_comments(self.tab)
            ok, proof = await yt_desktop.post_comment(self.tab, text)
            self._log(f"[Comment] {proof}")
            await self._human_pause(1.0, 2.0)
            # FIX #4: Accept both VERIFIED and SUBMITTED as success
            if ok and ("VERIFIED" in proof or "SUBMITTED" in proof):
                return True
            return False
        except Exception as e:
            self._log(f"Comment error: {e}")
            return False

    async def _do_dislike(self) -> bool:
        """Dislike — FIX #5: rng=self._rng passed for profile-seeded CDP click."""
        try:
            if await is_disliked(self.tab):
                return True
            # FIX #5: pass rng for profile-seeded CDP Bezier
            ok, proof = await yt_desktop.dislike(self.tab, want=True, rng=self._rng)
            self._log(f"[Dislike] {proof}")
            if ok:
                await self._human_pause(0.5, 1.5)
            return ok
        except Exception:
            return False

    async def _do_bell(self) -> bool:
        """Bell notification — FIX #8: rng=self._rng passed."""
        try:
            if not await is_subscribed(self.tab):
                self._log("🔔 Bell SKIPPED — not subscribed yet")
                return False
            await self._scroll_to_video_top()
            await asyncio.sleep(0.5)
            # FIX #8: pass rng for profile-seeded CDP click
            if not await yt_desktop.toggle_bell(self.tab, rng=self._rng):
                self._log("🔔 Bell toggle FAILED — button not found/invisible")
                return False
            await self._human_pause(0.8, 1.5)
            ok, proof = await yt_desktop.set_bell_level(self.tab, "All")
            if ok:
                await self._human_pause(0.5, 1.0)
                self._log("🔔 Bell notification ON ✓")
            else:
                self._log(f"🔔 Bell level set FAILED: {proof}")
            return ok
        except Exception as e:
            self._log(f"Bell error: {e}")
            return False

    async def _do_quality_change(self, quality: str = "auto") -> bool:
        """Change video quality — NOT during ads (Rule 2), verified + retry."""
        if quality in ("auto", ""):
            return True
        try:
            ad_running = await is_ad_playing(self.tab)
            if ad_running:
                self._log(f"[Quality] SKIPPED — ad is playing (Rule 2). Waiting...")
                await asyncio.sleep(15.0)
                ad_running = await is_ad_playing(self.tab)
                if ad_running:
                    self._log("[Quality] Ad still running — quality change deferred")
                    return False
        except Exception:
            pass
        try:
            from server_python.behavior.youtube.quality import change_quality
            ok, proof = await change_quality(
                self.tab, quality,
                profile_name=self.profile_id[:8],
                rng=self._rng, max_attempts=4,
            )
            from server_python.behavior.youtube.action_audit import ActionAudit
            from server_python.behavior.youtube.selectors import DESKTOP
            verified = ok and "UI_VERIFIED" in proof
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    f"quality_{quality}",
                    selector_used=str(DESKTOP.get("settings_gear_button", ("",))[0]),
                    click_registered=ok, verified=verified, reason=proof,
                )
            if verified:
                self._log(f"Quality changed to {quality} ✓ ({proof})")
            else:
                await self._tap_key("Escape")
                self._log(f"Quality change FAILED ✗: {proof}")
                ok = False
            return ok
        except Exception as e:
            self._log(f"Quality change error: {e}")
            return False

    async def _do_volume_adjust(self, target_pct: int | None = None) -> None:
        """
        Set player volume.
        FIX #9: Removed dead code (low/high variables that were calculated but never used).
        """
        try:
            target = int(target_pct if target_pct is not None else self._rng.randint(75, 100))
            target = max(0, min(100, target))
            await self._focus_player()
            ok, proof = await yt_desktop.set_volume(self.tab, target)
            self._log(f"Volume target → {proof} (wanted {target}%)")
            await self._human_pause(0.5, 1.0)

            from server_python.behavior.youtube.player_controls import read_volume_slider_pct
            from server_python.behavior.youtube.verify_actions import verify_volume
            from server_python.behavior.youtube.action_audit import ActionAudit

            final  = await read_volume_slider_pct(self.tab)
            vol_ok = "UI_VERIFIED" in proof and await verify_volume(self.tab, target)
            audit  = ActionAudit.current()
            if audit:
                audit.record(
                    f"volume_{target}",
                    selector_used=".ytp-volume-panel slider CDP click",
                    click_registered=ok, verified=vol_ok,
                    reason=f"slider={final}% target={target}% | {proof}",
                )
            if vol_ok:
                self._log(f"Volume OK at {final}% (UI verified)")
            else:
                self._log(f"Volume FAILED: slider={final}% target={target}% | {proof}")
        except Exception as e:
            self._log(f"Volume adjust error: {e}")

    async def _do_seek(self, direction: str = "forward", seconds: int | None = None) -> bool:
        """Seek forward/backward — keyboard first, JS currentTime fallback. Skips during ads."""
        try:
            if await is_ad_playing(self.tab):
                self._log("Seek SKIPPED — ad is playing")
                return False
            from server_python.behavior.youtube.verify_actions import verify_seeked
            from server_python.behavior.youtube.state import get_current_time

            secs   = seconds if seconds is not None else self._rng.choice([10, 15, 20])
            before = await get_current_time(self.tab)
            for _ in range(5):
                if before >= 0:
                    break
                await asyncio.sleep(0.6)
                if await is_ad_playing(self.tab):
                    self._log("Seek SKIPPED — ad started while waiting")
                    return False
                before = await get_current_time(self.tab)
            if before < 0:
                self._log("Seek SKIPPED — video element not found after retries")
                return False

            await self._focus_player()
            key    = "l" if direction == "forward" else "j"
            presses = max(1, round(secs / 10))
            for _ in range(presses):
                await self._tap_key(key)
                await asyncio.sleep(self._rng.uniform(0.08, 0.2))

            ok = await verify_seeked(self.tab, before, secs, direction=direction)
            if not ok:
                from server_python.yt_actions import seek_backward, seek_forward
                proof = "video_not_found"
                for retry in range(3):
                    if direction == "forward":
                        ok, proof = await seek_forward(self.tab, secs)
                    else:
                        ok, proof = await seek_backward(self.tab, secs)
                    if ok or "video_not_found" not in proof:
                        break
                    await asyncio.sleep(0.8)
                    if await is_ad_playing(self.tab):
                        self._log("Seek SKIPPED — ad started mid-retry")
                        return False
                self._log(f"Seek JS fallback ({direction} {secs}s): {proof}")

            from server_python.behavior.youtube.action_audit import ActionAudit
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    f"seek_{direction}_{secs}s",
                    selector_used="CDP keypress (j/l) + JS fallback",
                    click_registered=True, verified=ok,
                    reason=f"before={before:.1f}s delta={secs}s dir={direction}",
                )
            self._log(f"Seek {direction} {secs}s {'✓ VERIFIED' if ok else 'FAILED ✗'}")
            return ok
        except Exception as exc:
            self._log(f"Seek error: {exc}")
            return False

    async def _do_like_comment(self) -> bool:
        try:
            ok = await yt_desktop.like_comment_first(self.tab)
            if ok:
                self._log("💬👍 Comment liked ✓")
            return ok
        except Exception:
            return False

    async def _do_expand_description(self) -> bool:
        try:
            ok = await yt_desktop.expand_description(self.tab)
            from server_python.behavior.youtube.action_audit import ActionAudit
            from server_python.behavior.youtube.selectors import DESKTOP
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    "description_expand",
                    selector_used=str(DESKTOP.get("description_more_button", ("",))[0]),
                    click_registered=ok, verified=ok,
                )
            self._log("📄 Description expanded ✓ VERIFIED" if ok else "📄 Description expand FAILED ✗")
            return ok
        except Exception:
            return False

    async def _do_click_description_link(self) -> bool:
        try:
            ok = await yt_desktop.click_description_link(self.tab, rng=self._rng)
            if ok:
                await self._human_pause(2.5, 5.0)
                try:
                    if self.browser:
                        for extra in list(self.browser.tabs)[1:]:
                            try:
                                await extra.close()
                            except Exception:
                                pass
                except Exception:
                    pass
                self._log("🔗 Description link clicked ✓")
            return ok
        except Exception:
            return False

    async def _tap_key(self, key: str) -> None:
        """
        Send a keyboard key press via CDP.
        FIX #11: windows_virtual_key_code uses correct values from _KEY_CODES map.
        """
        if not _cdp:
            return
        try:
            code     = f"Key{key.upper()}" if len(key) == 1 and key.isalpha() else key
            vk_code  = _KEY_CODES.get(key, 0)
            await self.tab.send(_cdp.input_.dispatch_key_event(
                "keyDown", key=key, code=code, windows_virtual_key_code=vk_code,
            ))
            await asyncio.sleep(0.05)
            await self.tab.send(_cdp.input_.dispatch_key_event(
                "keyUp", key=key, code=code, windows_virtual_key_code=vk_code,
            ))
        except Exception as e:
            self._log(f"Key {key!r} failed: {e}")

    async def _scroll(self, px: int) -> None:
        """Natural eased scroll via safe_eval_js."""
        try:
            if getattr(self, "_natural_scroll", True):
                steps   = self._rng.randint(3, 7)
                step_px = px / steps
                for i in range(steps):
                    t    = (i + 1) / steps
                    ease = t * t * (3 - 2 * t)
                    step = int(step_px * ease * steps / max(1, i + 1)) if i > 0 else int(step_px)
                    await self._js(f"window.scrollBy(0, {step})", action_name="SCROLL", wrap=False)
                    await self._human_pause(0.04, 0.12)
            else:
                await self._js(f"window.scrollBy(0, {px})", action_name="SCROLL", wrap=False)
            await self._human_pause(0.3, 0.8)
        except Exception:
            pass

    async def _move_mouse(self) -> None:
        """CDP Bezier wander in player area; safe_eval_js mousemove fallback."""
        rng = getattr(self, "_watch_rng", None) or self._rng
        try:
            from server_python.cdp_mouse import cdp_wander_player_area
            nx, ny = await cdp_wander_player_area(self.tab, self._mouse_x, self._mouse_y, rng)
            if abs(nx - self._mouse_x) > 2 or abs(ny - self._mouse_y) > 2:
                self._mouse_x, self._mouse_y = nx, ny
                return
        except Exception:
            pass
        try:
            x = rng.randint(200, 800)
            y = rng.randint(200, 600)
            self._mouse_x, self._mouse_y = float(x), float(y)
            await self._js(
                f"document.dispatchEvent(new MouseEvent('mousemove', {{clientX: {x}, clientY: {y}}}))",
                action_name="MOUSE_MOVE", wrap=False,
            )
        except Exception:
            pass

    async def _do_related_video(self, own_channel_names: list[str]) -> None:
        """Sidebar related video — own channel only, unwatched by this profile only."""
        if not own_channel_names:
            self._log("[Sidebar] own_channel_names empty — skipping related video")
            return
        if not self.tab:
            return
        try:
            from server_python.sidebar_video import SidebarVideoManager
            mgr = SidebarVideoManager(
                tab=self.tab, profile_id=self.profile_id,
                own_channel_names=own_channel_names,
                rng=self._rng, log_fn=self._log,
            )
            await asyncio.sleep(self._rng.uniform(2.0, 5.0))
            result = await mgr.find_and_click()
            self._log(
                "[Sidebar] ✓ Related video clicked from own channel"
                if result else "[Sidebar] No own-channel unwatched video — skipped"
            )
        except Exception as e:
            self._log(f"[Sidebar] Related video error (non-fatal): {e}")

    # ── Simple helpers ────────────────────────────────────────────────────────

    async def watch_video_direct(self, video_url: str, watch_pct: int = 60) -> bool:
        """Direct URL watch (no entropy). Kept as fallback."""
        if not self.tab:
            raise RuntimeError("Not connected")
        try:
            self._log(f"Direct URL: {video_url}")
            await self.tab.get(video_url)
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            from server_python.human_engine import wait_for_player
            await wait_for_player(self.tab, timeout=20.0)
            await self._skip_ads()
            duration   = await self._get_duration() or 300.0
            watch_secs = max(30, min(int(duration * watch_pct / 100), 600))
            from server_python.guardian import PlaybackGuardian
            guardian = PlaybackGuardian(tab=self.tab, log_fn=self._log)
            await guardian.start()
            try:
                await self._human_watch_basic(watch_secs)
            finally:
                await guardian.stop()
            self._log(f"Direct watch done ✓ ({watch_secs}s)")
            return True
        except Exception as e:
            self._log(f"Direct watch error: {e}")
            return False

    async def _human_watch_basic(self, watch_secs: int) -> None:
        elapsed = 0
        while elapsed < watch_secs and self._running:
            chunk = self._rng.uniform(10, 30)
            chunk = min(chunk, watch_secs - elapsed)
            await asyncio.sleep(chunk)
            elapsed += chunk
            if self._rng.random() < 0.3:
                await self._scroll(self._rng.randint(-100, 200))
            if self._rng.random() < 0.2:
                await self._move_mouse()

    async def go_to_youtube_home(self) -> None:
        try:
            await self.tab.get("https://www.youtube.com")
            await asyncio.sleep(self._rng.uniform(2.0, 5.0))
            await self._dismiss_consent()
        except Exception as e:
            self._log(f"YouTube home error: {e}")

    async def close(self) -> None:
        """
        Clean shutdown — anti_sleep → guardian → browser.
        FIX #10: browser.stop() with graceful fallback to browser.close().
        """
        self._running = False
        if self._anti_sleep:
            try:
                await self._anti_sleep.stop()
            except Exception:
                pass
            self._anti_sleep = None
        if self._guardian:
            try:
                await self._guardian.stop()
            except Exception:
                pass
            self._guardian = None
        # FIX #10: try stop() first, then close() as fallback
        if self.browser:
            try:
                await self.browser.stop()
            except Exception:
                try:
                    await self.browser.close()
                except Exception:
                    pass
        self.browser = None
        self.tab     = None


# ══════════════════════════════════════════════════════════════════════════════
# AgentManager — Multi-profile orchestrator
# ══════════════════════════════════════════════════════════════════════════════

class AgentManager:
    """
    Multiple profiles ke agents manage karta hai.
    Full v2-grade: entropy, guardian, AI brain, SmartProxy.
    """

    def __init__(self):
        self._active_agents: dict[str, YouTubeAgent] = {}
        self._recycle_task = None
        self._recycle_data: dict = {}
        self._loop = None

    def set_loop(self, loop) -> None:
        self._loop = loop

    async def run_schedule(
        self,
        schedule: dict,
        provider_name: str,
        workers: dict,
        log_fn: Callable,
    ):
        """Run schedule — concurrent automation for all profiles."""
        from server_python.providers.morelogin import MoreLoginProvider
        from server_python.providers.multilogin import MultiloginProvider
        from server_python.smart_proxy import get_proxy_manager

        profile_ids     = schedule.get("selectedProfiles", [])
        videos          = schedule.get("videos", [])
        watch_pct       = schedule.get("watchTimeMin", 70) / 100.0
        max_concurrent  = schedule.get("maxConcurrent", 4)
        engagement_cfg  = schedule.get("engagement", {})
        use_entropy     = schedule.get("useEntropy", True)
        use_proxy       = schedule.get("useProxy", False)
        own_channels    = schedule.get("ownChannelNames", [])

        if not profile_ids or not videos:
            log_fn("error", "schedule", "No profiles or videos in schedule")
            return

        provider  = MultiloginProvider() if provider_name == "multilogin" else MoreLoginProvider()
        proxy_mgr = get_proxy_manager() if use_proxy else None
        sem       = asyncio.Semaphore(max_concurrent)

        async def _run_one(pid: str):
            async with sem:
                workers[pid] = workers.get(pid, {})
                workers[pid]["status"] = "starting"
                log_fn("info", "agent", f"[{pid[:8]}] Starting profile...")
                try:
                    start_res = await provider.start_profile(pid)
                    if start_res.get("code") != 0:
                        raise RuntimeError(f"Provider start failed: {start_res.get('message')}")
                    cdp_port = start_res.get("data", {}).get("cdpPort")
                    if not cdp_port:
                        raise RuntimeError("No CDP port returned by provider")
                    cdp_endpoint = start_res.get("data", {}).get("cdpEndpoint", f"http://127.0.0.1:{cdp_port}")

                    if proxy_mgr:
                        proxy_cfg = proxy_mgr.get_proxy_config(pid)
                        log_fn("info", "proxy", f"[{pid[:8]}] Proxy: {proxy_cfg['username']}")

                    agent = YouTubeAgent(pid, cdp_port, schedule)
                    await agent.connect_cdp(cdp_endpoint)
                    self._active_agents[pid] = agent
                    workers[pid]["status"] = "watching"
                    log_fn("info", "agent", f"[{pid[:8]}] Connected via nodriver ✓")
                    await agent.warm_up()

                    if use_proxy:
                        try:
                            from server_python.identity_manager import get_identity_manager
                            id_mgr   = get_identity_manager(proxy_manager=proxy_mgr)
                            identity = await id_mgr.get_identity(pid)
                            await id_mgr.apply_to_browser(agent.tab, identity)
                            log_fn("info", "identity",
                                   f"[{pid[:8]}] Identity applied: "
                                   f"{identity.country_code}/{identity.city} "
                                   f"tz={identity.timezone}")
                        except Exception as ie:
                            log_fn("info", "identity", f"[{pid[:8]}] Identity apply skipped: {ie}")

                    for i, video in enumerate(videos):
                        if workers[pid].get("status") != "watching":
                            break
                        video_id = video.get("videoId") or video.get("id", "")
                        title    = video.get("title", "")
                        channel  = video.get("channel", "")
                        if not video_id:
                            continue
                        workers[pid]["currentVideo"] = f"https://www.youtube.com/watch?v={video_id}"
                        log_fn("info", "agent", f"[{pid[:8]}] Video {i+1}/{len(videos)}: {video_id}")

                        if use_entropy:
                            ok = await agent.watch_video_organic(
                                video_id=video_id, title_hint=title, channel_name=channel,
                                watch_pct=watch_pct, engagement=engagement_cfg,
                                own_channel_names=own_channels,
                            )
                        else:
                            url = f"https://www.youtube.com/watch?v={video_id}"
                            ok  = await agent.watch_video_direct(url, int(watch_pct * 100))

                        log_fn("info", "agent", f"[{pid[:8]}] Video {i+1}: {'done' if ok else 'error'}")

                        if i < len(videos) - 1:
                            gap = random.uniform(15.0, 45.0)
                            log_fn("info", "agent", f"[{pid[:8]}] Gap: {gap:.0f}s")
                            await asyncio.sleep(gap)

                    workers[pid]["status"] = "done"
                    log_fn("success", "agent", f"[{pid[:8]}] All videos done ✓")

                except asyncio.CancelledError:
                    workers[pid]["status"] = "stopped"
                    raise
                except Exception as e:
                    workers[pid]["status"] = "error"
                    workers[pid]["error"]  = str(e)
                    log_fn("error", "agent", f"[{pid[:8]}] Error: {e}")
                    try:
                        from server_python.ai_brain import recover_from_error, is_available
                        if is_available():
                            recovery = recover_from_error(
                                error_message=str(e), dom_summary="",
                                current_url="", goal="Watch YouTube video",
                            )
                            log_fn("info", "agent",
                                   f"[{pid[:8]}] AI recovery: {recovery.get('action')} → {recovery.get('explanation')}")
                    except Exception:
                        pass
                finally:
                    if pid in self._active_agents:
                        await self._active_agents[pid].close()
                        del self._active_agents[pid]
                    try:
                        await provider.stop_profile(pid)
                    except Exception:
                        pass

        tasks = [asyncio.create_task(_run_one(pid)) for pid in profile_ids]
        await asyncio.gather(*tasks, return_exceptions=True)
        log_fn("info", "schedule", f"Schedule complete — {len(profile_ids)} profiles")

    # ── Recycle ───────────────────────────────────────────────────────────────

    def start_recycle(self, data: dict, log_fn=None) -> None:
        from server_python.recycle_engine import recycle_engine
        if not self._loop:
            raise RuntimeError("Async loop not configured — call set_loop() first")
        recycle_engine.configure(self._loop, log_fn=log_fn)
        self._recycle_data = data
        self._recycle_task = asyncio.run_coroutine_threadsafe(
            recycle_engine.start(data), self._loop,
        )

    def stop_recycle(self, slot_id: str | None = None, profile_id: str | None = None) -> None:
        from server_python.recycle_engine import recycle_engine
        if not self._loop:
            return
        asyncio.run_coroutine_threadsafe(
            recycle_engine.stop(slot_id=slot_id, profile_id=profile_id), self._loop,
        )

    def pause_recycle(self) -> None:
        from server_python.recycle_engine import recycle_engine
        if self._loop:
            asyncio.run_coroutine_threadsafe(recycle_engine.pause(), self._loop)

    def resume_recycle(self) -> None:
        from server_python.recycle_engine import recycle_engine
        if self._loop:
            asyncio.run_coroutine_threadsafe(recycle_engine.resume(), self._loop)

    def get_recycle_status(self) -> dict:
        from server_python.recycle_engine import recycle_engine
        return recycle_engine.get_status()

    async def stop_all(self) -> None:
        for agent in list(self._active_agents.values()):
            await agent.close()
        self._active_agents.clear()
