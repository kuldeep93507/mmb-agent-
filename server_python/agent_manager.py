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
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import random
import time
from typing import Any, Callable

from behavior.youtube.entry_flow import accept_consent_if_present
from behavior.youtube.play_pause_limiter import PlayPauseLimiter
from behavior.youtube.scroll_activity import ScrollActivityPlanner
from behavior.youtube.player_focus import focus_player
from behavior.youtube.safe_actions import safe_eval_js
from behavior.youtube.state import (
    get_video_duration_when_ready,
    is_disliked,
    is_liked,
    is_subscribed,
    get_volume_percent,
)
from behavior.youtube import desktop as yt_desktop

log = logging.getLogger("mmb.agent_manager")

try:
    import nodriver as uc
    NODRIVER_OK = True
except ImportError:
    NODRIVER_OK = False
    log.warning("nodriver not installed — run: pip install nodriver")


# ══════════════════════════════════════════════════════════════════════════════
# YouTubeAgent — Single profile automation (full v2 feature set)
# ══════════════════════════════════════════════════════════════════════════════

class YouTubeAgent:
    """
    Single profile ka YouTube automation — MMB-Agent-v2 features integrated.
    nodriver CDP connect + human typing + guardian + entropy + AI brain.
    """

    def __init__(self, profile_id: str, cdp_port: int | str, settings: dict, log_fn: Callable | None = None):
        self.profile_id  = profile_id
        self.cdp_port    = int(cdp_port)
        self.settings    = settings
        self.browser     = None
        self.tab         = None
        self._running    = False
        self._guardian   = None  # PlaybackGuardian
        _profile_seed = int(hashlib.sha256(profile_id.encode()).hexdigest()[:16], 16)
        self._rng        = random.Random(_profile_seed)
        self._log_fn     = log_fn  # external log sink (e.g. job log)
        self._mouse_x    = float(self._rng.randint(400, 650))
        self._mouse_y    = float(self._rng.randint(260, 420))

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
            self.tab,
            code,
            action_name=action_name,
            wrap=wrap,
            log_result=False,
        )

    async def _human_pause(self, lo: float, hi: float) -> None:
        """Random delay between actions — anti-detection Rule C."""
        await asyncio.sleep(self._rng.uniform(lo, hi))

    # ── Connect ───────────────────────────────────────────────────────────────

    async def connect_cdp(self, cdp_endpoint: str):
        """Connect to already-running Multilogin/MoreLogin browser via CDP port.
        
        nodriver 0.50.3: when host+port are both set, it uses connect_existing=True
        which ATTACHES to existing browser instead of starting a new one.
        """
        if not NODRIVER_OK:
            raise RuntimeError("nodriver not installed")

        self._log(f"Connecting via CDP → {cdp_endpoint} (port={self.cdp_port})")
        try:
            # nodriver with host+port = connect_existing mode (no new process)
            self.browser = await uc.start(
                host="127.0.0.1",
                port=self.cdp_port,
                headless=False,
            )
            tabs = self.browser.tabs
            self.tab = tabs[0] if tabs else await self.browser.get("about:blank")
            self._running = True
            self._log(f"nodriver attached to existing browser ✓ (port={self.cdp_port})")
        except Exception as e:
            self._log(f"CDP attach error: {e}")
            raise

    # ── Warm up ───────────────────────────────────────────────────────────────

    async def warm_up(self) -> None:
        """Navigate to YouTube home — dismiss consent if any."""
        self._log("Warm-up: navigating to YouTube home")
        try:
            await self.tab.get("https://www.youtube.com")
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            # Try dismiss consent overlay
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
        )

        nav_mode = (source or "").strip().lower() or "entropy"
        self._log(f"Navigation mode={nav_mode} → video: {video_id}")
        nav_success = await entropy.execute_for_source(self.tab, target, source=source)

        if not nav_success:
            # Fallback: direct URL
            self._log("Entropy navigation failed — falling back to direct URL")
            video_url = f"https://www.youtube.com/watch?v={video_id}"
            try:
                await self.tab.get(video_url)
                await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            except Exception as e:
                self._log(f"Direct URL fallback also failed: {e}")
                return False

        # Consent + ads before player-ready (critical for monetized videos)
        await self._dismiss_consent()
        await asyncio.sleep(self._rng.uniform(1.5, 2.5))

        _ad_delay_min = int((engagement or {}).get("adSkipDelaySec", 5))
        _ad_delay_max = int((engagement or {}).get("adSkipDelayMaxSec", 15))
        if (engagement or {}).get("adSkipEnabled", True):
            self._log("Pre-roll ad handling (monetized-safe order)…")
            await self._skip_ads(delay_min=_ad_delay_min, delay_max=_ad_delay_max)
        else:
            self._log("Ad skip disabled — waiting for ad to finish naturally")
            await asyncio.sleep(self._rng.uniform(8.0, 15.0))

        # Wait for main video player after ads
        from server_python.human_engine import wait_for_player
        player_ready = await wait_for_player(self.tab, timeout=60.0)
        self._log(f"Player ready: {player_ready}")
        if not player_ready:
            self._log("Player not ready — retrying direct URL once")
            try:
                await self.tab.get(f"https://www.youtube.com/watch?v={video_id}")
                await asyncio.sleep(self._rng.uniform(4.0, 6.0))
                await self._dismiss_consent()
                if (engagement or {}).get("adSkipEnabled", True):
                    await self._skip_ads(delay_min=_ad_delay_min, delay_max=_ad_delay_max)
                player_ready = await wait_for_player(self.tab, timeout=45.0)
                self._log(f"Player ready after retry: {player_ready}")
            except Exception as e:
                self._log(f"Player retry failed: {e}")
        if not player_ready:
            try:
                raw_url = await self._js("location.href", action_name="GET_URL", wrap=False)
                self._log(f"Player failed — current URL: {raw_url}")
            except Exception:
                pass
            return False

        eng = engagement or {}
        if eng.get("honestTest") or self.settings.get("honestTest"):
            from behavior.youtube.action_audit import ActionAudit
            from behavior.youtube.verify_actions import verify_logged_in

            pname = eng.get("profileName") or self.settings.get("profileName") or self.profile_id[:8]
            ActionAudit.enable(self.profile_id, pname)
            logged_in = await verify_logged_in(self.tab)
            ActionAudit.current().set_login_state(logged_in)
            self._log(f"[AUDIT] verify_logged_in() = {logged_in}")

        # Apply settings: autoplay OFF hard-lock
        await self._apply_video_settings()

        # Early setup window — quality/speed/captions within first ~15s of playback
        self._watch_session_t0 = time.monotonic()
        settle = self._rng.uniform(3.0, 8.0)
        self._log(f"[Watch] Player settle {settle:.1f}s before early setup…")
        await asyncio.sleep(settle)

        # 4a. Quality change — MUST happen early (Bug #1), not at end of watch
        quality_on = eng.get("qualityChange", eng.get("qualityChangeEnabled", True))
        quality = eng.get("videoQuality", self.settings.get("videoQuality", "auto"))
        if quality_on and quality and str(quality).lower() != "auto":
            q_ok = await self._do_quality_change(str(quality))
            elapsed_q = time.monotonic() - self._watch_session_t0
            self._log(
                f"[QUALITY] @ {elapsed_q:.1f}s → {quality} "
                f"{'OK ✓' if q_ok else 'FAILED ✗'} (target <15s)"
            )
            self._quality_change_at_sec = elapsed_q

        # 4a2. Playback speed (optional)
        speed_on = eng.get("speedChange", eng.get("speedChangeEnabled", False))
        speed_target = str(eng.get("playbackSpeed", "1x") or "1x")
        if speed_on and speed_target not in ("1x", "1", ""):
            try:
                rate = float(speed_target.replace("x", "").strip())
                ok, proof = await yt_desktop.set_playback_speed(self.tab, rate)
                self._log(f"[Speed] {speed_target}: {proof}")
            except (TypeError, ValueError) as exc:
                self._log(f"[Speed] skip invalid {speed_target!r}: {exc}")

        # 4a3. Captions toggle (optional)
        if eng.get("captionsToggle", eng.get("captionsEnabled", False)):
            cap_ok = await yt_desktop.toggle_captions(self.tab)
            self._log(f"[Captions] toggle: {'OK ✓' if cap_ok else 'skip'}")

        # 4b. Volume adjust — use configured level or human-like random
        await asyncio.sleep(self._rng.uniform(0.5, 1.5))
        _vol_pct = (engagement or {}).get("volumePct", None)
        await self._do_volume_adjust(_vol_pct)

        # 4c. Per-session SHA-256 behavior plan (unique pattern per profile+session+video)
        from server_python.session_behavior import SessionBehaviorPlan
        behavior = SessionBehaviorPlan.create(
            self.profile_id,
            video_id,
            session_nonce=session_nonce or None,
        )
        self._mouse_x = behavior.mouse_start_x
        self._mouse_y = behavior.mouse_start_y
        self._log(behavior.summary_line())

        # 4d. Store natural scroll setting in instance for _scroll helper
        self._natural_scroll = (engagement or {}).get("naturalScrollCurves", True)

        # 5. Get video duration — wait extra so real video metadata loads after ads
        await asyncio.sleep(self._rng.uniform(2.0, 3.5))
        duration = await self._get_duration()
        if not duration:
            duration = 300.0
            self._log("Duration unknown — defaulting to 300s")
        watch_secs = max(60.0, min(duration * watch_pct, 600.0))
        self._log(f"Will watch {watch_secs:.0f}s / {duration:.0f}s ({watch_pct:.0%})")

        # 6. Start Guardian (background video-continuity watcher)
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

            # 8b. Record analytics (views, watch time, engagement actions)
            try:
                from server_python.analytics_store import record_watch_session
                record_watch_session(
                    self.profile_id,
                    watch_secs,
                    traffic_source=nav_mode,
                    completed_actions=engagement_done,
                )
            except Exception as e:
                self._log(f"Analytics record warning: {e}")

            # 9. Mark main video as watched in per-profile history (with title for dedup)
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
            audit = None
            try:
                from behavior.youtube.action_audit import ActionAudit
                audit = ActionAudit.current()
                if audit:
                    self._log(f"[AUDIT] session captured {len(audit.rows)} action rows (saved on profile close)")
            except Exception:
                pass

    def _get_watch_pattern(self, duration: float, planned_watch: float) -> dict:
        """Get natural watch pattern — AI or default."""
        defaults = {
            "pause_probability": 0.05,
            "seek_probability": 0.18,
            "scroll_breaks": 1,
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
        """Scroll back to top of page so video player + like/subscribe buttons are visible."""
        try:
            await yt_desktop.scroll_to_top(self.tab)
            await self._human_pause(0.5, 1.0)
        except Exception:
            pass

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

        All timings/probabilities come from SessionBehaviorPlan (SHA-256 per
        profile+session+video) so 20 profiles never share the same pattern.

        Scroll policy:
          - Random scroll only when NO engagement action fires this tick
          - Actions that scroll away (description, comment) always scroll back to top
          - Like / Dislike / Subscribe / Bell: always executed at page TOP (video visible)
          - Scroll amounts are small (±120px) to stay near the player
        """
        rng = behavior.rng
        self._watch_rng = rng
        timings = behavior.abs_timings(watch_secs)
        pause_at = timings["pause_at"]
        like_at = timings["like_at"]
        dislike_at = timings["dislike_at"]
        sub_at = timings["sub_at"]
        bell_at = timings["bell_at"]
        desc_at = timings["desc_at"]
        desc_link_at = timings["desc_link_at"]
        seek_at = timings["seek_at"]
        cmt_at = timings["comment_at"]
        cmt_like_at = timings["comment_like_at"]

        elapsed = 0.0
        engagement_done: set[str] = set()
        _scrolled_away = False
        _like_failures = 0
        _MAX_LIKE_ATTEMPTS = 3
        watch_deadline = time.monotonic() + watch_secs

        # Anti-detection: max 0-2 pauses per session, min 30s apart (~50% sessions = zero)
        pause_limiter = PlayPauseLimiter(rng=rng)
        _pause_hold_cfg = float(engagement.get("pauseHoldSec", 0) or 0)
        _pause_prob = min(0.08, max(0.0, float(engagement.get("pauseProbability", 0.05))))
        _pause_earliest = max(30.0, pause_at)
        self._log(
            f"[PauseLimiter] max={pause_limiter.max_pauses} "
            f"prob={_pause_prob:.0%} earliest={_pause_earliest:.0f}s"
        )

        _scroll_enabled = engagement.get(
            "scrollActivity",
            engagement.get("scroll", True),
        )
        scroll_planner = ScrollActivityPlanner(
            watch_secs,
            rng,
            enabled=bool(_scroll_enabled),
            log_fn=self._log,
        )
        if scroll_planner.planned_count:
            planned = [f"{a.name}@{a.at_time:.0f}s" for a in scroll_planner.activities]
            self._log(f"[ScrollActivity] planned {scroll_planner.planned_count}: {', '.join(planned)}")

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

            # Mid-roll ads during watch
            if engagement.get("adSkipEnabled", True):
                if await self._try_skip_ad_quick():
                    guardian.suppress(6.0)

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
                and "seek" not in engagement_done
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
                "seek": will_seek,
                "like": will_like,
                "dislike": will_dislike,
                "desc": will_desc,
                "desc_link": will_desc_link,
                "subscribe": will_sub,
                "bell": will_bell,
                "comment": will_cmt,
                "comment_like": will_cmt_like,
            }

            if any(pending.values()):
                engagement_this_tick = True

            # Scroll activities run on schedule — NEVER blocked by failed like retries
            if await scroll_planner.tick_and_run(self.tab, elapsed, guardian):
                engagement_this_tick = True
                _scrolled_away = False

            # Micro scroll jitter — only when no engagement or planned scroll this tick
            if not engagement_this_tick and not _scrolled_away:
                if rng.random() < behavior.scroll_prob:
                    px = rng.randint(-60, 120)
                    await self._scroll(px)

            # Random mouse move (profile-unique probability)
            if rng.random() < behavior.mouse_prob:
                await self._move_mouse()

            # Rate-limited pause — max 0-2 per session, realistic 2-6s hold (not 18-28s)
            if pause_limiter.can_pause(elapsed) and elapsed >= _pause_earliest:
                explicit_hold = _pause_hold_cfg > 0 and pause_limiter.pauses_in_session == 0
                random_hit = _pause_prob > 0 and rng.random() < _pause_prob
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
                    self._log("Resume after pause ✓")
                    engagement_this_tick = True

            # Execute pending actions in profile-unique order
            for action in behavior.action_order:
                if not pending.get(action):
                    continue

                if action == "pause":
                    # Handled above via PlayPauseLimiter — skip legacy action slot
                    continue

                elif action == "seek":
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
                    seek_ok = await self._do_seek(direction, seconds=behavior.seek_seconds)
                    if seek_ok:
                        engagement_done.add("seek")
                    else:
                        engagement_done.add("seek_failed")

                elif action == "like":
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
                        self._log(f"👍 Like FAILED ✗ verified=False [{_like_failures}/{_MAX_LIKE_ATTEMPTS}]")
                        if _like_failures >= _MAX_LIKE_ATTEMPTS:
                            engagement_done.add("like_failed")
                            self._log("👍 Like ABANDONED — moving on to scroll/seek/desc")

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
                        await asyncio.sleep(
                            rng.uniform(behavior.desc_dwell_lo, behavior.desc_dwell_hi)
                        )
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                    else:
                        engagement_done.add("desc_failed")
                        self._log("📄 Description expand FAILED ✗ (unverified)")

                elif action == "desc_link":
                    engagement_done.add("desc_link")
                    guardian.suppress(10.0)
                    await self._do_click_description_link()
                    await asyncio.sleep(rng.uniform(0.5, 1.5))
                    await self._scroll_to_video_top()
                    _scrolled_away = False

                elif action == "subscribe":
                    if _scrolled_away:
                        await self._scroll_to_video_top()
                        _scrolled_away = False
                    guardian.suppress(8.0)
                    if await self._do_subscribe():
                        engagement_done.add("subscribe")
                        self._log("✅ Subscribed ✓")

                elif action == "bell":
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
                        await asyncio.sleep(
                            rng.uniform(behavior.comment_dwell_lo, behavior.comment_dwell_hi)
                        )
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

        if scroll_planner.completed:
            self._log(f"[ScrollActivity] completed: {scroll_planner.completed}")
        self._log(
            f"Watch loop done | elapsed={elapsed:.0f}s "
            f"engagement={sorted(engagement_done)}"
        )
        self._watch_rng = None
        return engagement_done

    def _get_ai_comment(self, video_title: str, channel: str, engagement: dict) -> str | None:
        """Get AI-generated comment or fall back to template."""
        templates = engagement.get("comment_templates", [
            "Great video! Really helpful content.",
            "This is exactly what I was looking for.",
            "Amazing explanation, thanks for sharing!",
            "Very informative, learned a lot.",
            "Keep up the great work!",
        ])
        try:
            from server_python.ai_brain import generate_comment, is_available
            if is_available() and video_title:
                return generate_comment(
                    video_title=video_title,
                    channel_name=channel,
                    fallback_templates=templates,
                    rng=self._rng,
                )
        except Exception:
            pass
        return self._rng.choice(templates) if templates else None

    # ── Watch by direct URL (simple mode) ─────────────────────────────────────

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

            duration = await self._get_duration() or 300.0
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
        """Basic human watch loop — scroll + mouse move."""
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

    # ── V2 action helpers (delegate to behavior/youtube/) ─────────────────────

    async def _get_duration(self) -> float | None:
        """Get video duration — V2 state helper with ad-stub filtering."""
        return await get_video_duration_when_ready(self.tab)

    async def _skip_ads(self, delay_min: int = 5, delay_max: int = 15) -> None:
        """
        Skip ads using AdHandler + CDP hover+click (same as like button).
        Human delay before first skip attempt; polls until ad clears.
        """
        try:
            from server_python.ad_handler import AdHandler
            handler = AdHandler(self.tab, log_fn=self._log, rng=self._rng)
            handler._mouse_x = self._mouse_x
            handler._mouse_y = self._mouse_y
            await handler.wait_for_video_start(
                skip_ads=True,
                timeout=120.0,
                delay_min=float(delay_min),
                delay_max=float(delay_max),
            )
            self._mouse_x = handler._mouse_x
            self._mouse_y = handler._mouse_y
        except Exception as e:
            self._log(f"Ad skip warning (non-fatal): {e}")

    async def _try_skip_ad_quick(self) -> bool:
        """Mid-roll ad skip during watch loop — no extra human delay."""
        try:
            from server_python.ad_handler import AdHandler
            handler = AdHandler(self.tab, log_fn=self._log, rng=getattr(self, "_watch_rng", None) or self._rng)
            handler._mouse_x = self._mouse_x
            handler._mouse_y = self._mouse_y
            if await handler.skip_ad_if_present():
                self._mouse_x = handler._mouse_x
                self._mouse_y = handler._mouse_y
                return True
        except Exception:
            pass
        return False

    async def _apply_video_settings(self) -> None:
        """Apply settings: autoplay OFF — verified only."""
        from behavior.youtube.action_audit import ActionAudit
        from behavior.youtube.selectors import DESKTOP

        try:
            from behavior.youtube.verify_actions import verify_autoplay_off

            ok = await yt_desktop.disable_autoplay(self.tab)
            verified = ok and await verify_autoplay_off(self.tab)
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    "autoplay_off",
                    selector_used=str(DESKTOP.get("autoplay_toggle_button", ("",))[0]),
                    click_registered=ok,
                    verified=verified,
                    reason="UI_VERIFIED visible toggle off" if verified else "toggle not visible or still ON",
                )
            if verified:
                self._log("Autoplay OFF OK (UI verified)")
            else:
                self._log("Autoplay OFF FAILED (not visible or still ON)")
        except Exception as exc:
            self._log(f"Autoplay OFF error: {exc}")

    async def _focus_player(self) -> None:
        """Focus player so keyboard shortcuts (k/j/l) work — V2 player_focus."""
        try:
            await focus_player(self.tab)
            await self._human_pause(0.2, 0.4)
        except Exception:
            pass

    async def _do_like(self) -> bool:
        """Like video — single verified attempt (no internal retry)."""
        self._last_like_proof = ""
        try:
            await self._scroll_to_video_top()
            await self._human_pause(0.4, 0.8)
            if await is_liked(self.tab):
                self._last_like_proof = "ALREADY_LIKED"
                return True
            ok, proof = await yt_desktop.like(self.tab, want=True)
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
        """Subscribe — V2 safe_click + is_subscribed() guard."""
        try:
            if await is_subscribed(self.tab):
                return True
            ok, proof = await yt_desktop.subscribe(self.tab, want=True)
            await self._human_pause(0.5, 1.5)
            return ok
        except Exception:
            return False

    async def _do_comment(self, text: str) -> bool:
        """Post comment — V2 scroll_to_comments + post_comment (human_type)."""
        if not self.tab:
            return False
        try:
            await yt_desktop.scroll_to_comments(self.tab)
            ok, proof = await yt_desktop.post_comment(self.tab, text)
            await self._human_pause(1.0, 2.0)
            return ok
        except Exception as e:
            self._log(f"Comment error: {e}")
            return False

    async def _do_dislike(self) -> bool:
        """Dislike — V2 state check + safe_click."""
        try:
            if await is_disliked(self.tab):
                return True
            ok, proof = await yt_desktop.dislike(self.tab, want=True)
            if ok:
                await self._human_pause(0.5, 1.5)
            return ok
        except Exception:
            return False

    async def _do_bell(self) -> bool:
        """Bell notification — V2 toggle_bell + set_bell_level('All')."""
        try:
            if not await yt_desktop.toggle_bell(self.tab):
                return False
            await self._human_pause(0.8, 1.5)
            ok, proof = await yt_desktop.set_bell_level(self.tab, "All")
            if ok:
                await self._human_pause(0.5, 1.0)
                self._log("🔔 Bell notification ON ✓")
            return ok
        except Exception:
            return False

    async def _do_quality_change(self, quality: str = "auto") -> bool:
        """Change video quality — bulletproof V2 change_quality with diagnostics."""
        if quality in ("auto", ""):
            return True
        try:
            from behavior.youtube.quality import change_quality

            ok, proof = await change_quality(
                self.tab,
                quality,
                profile_name=self.profile_id[:8],
                rng=self._rng,
                max_attempts=4,
            )
            from behavior.youtube.action_audit import ActionAudit
            from behavior.youtube.selectors import DESKTOP

            verified = ok and "UI_VERIFIED" in proof
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    f"quality_{quality}",
                    selector_used=str(DESKTOP.get("settings_gear_button", ("",))[0]),
                    click_registered=ok,
                    verified=verified,
                    reason=proof,
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
        """Set player volume — V2 set_volume + get_volume_percent verify."""
        try:
            target = int(target_pct if target_pct is not None else self._rng.randint(60, 95))
            target = max(0, min(100, target))
            low = max(10, target - self._rng.randint(20, 35))
            high = min(100, target + self._rng.randint(8, 20))
            await self._focus_player()

            ok, proof = await yt_desktop.set_volume(self.tab, target)
            self._log(f"Volume target -> {proof} (wanted {target}%)")
            await self._human_pause(0.5, 1.0)

            from behavior.youtube.player_controls import read_volume_slider_pct
            from behavior.youtube.verify_actions import verify_volume

            final = await read_volume_slider_pct(self.tab)
            vol_ok = "UI_VERIFIED" in proof and await verify_volume(self.tab, target)
            from behavior.youtube.action_audit import ActionAudit
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    f"volume_{target}",
                    selector_used=".ytp-volume-panel slider CDP click",
                    click_registered=ok,
                    verified=vol_ok,
                    reason=f"slider={final}% target={target}% | {proof}",
                )
            if vol_ok:
                self._log(f"Volume OK at {final}% (UI verified)")
            else:
                self._log(f"Volume FAILED: slider={final}% target={target}% | {proof}")
        except Exception as e:
            self._log(f"Volume adjust error: {e}")

    async def _do_seek(self, direction: str = "forward", seconds: int | None = None) -> bool:
        """Seek forward/backward — verify currentTime changed."""
        try:
            from behavior.youtube.verify_actions import verify_seeked
            from behavior.youtube.state import get_current_time

            secs = seconds if seconds is not None else self._rng.choice([10, 15, 20])
            before = await get_current_time(self.tab)
            await self._focus_player()
            key = "l" if direction == "forward" else "j"
            presses = max(1, round(secs / 10))
            for _ in range(presses):
                await self._tap_key(key)
                await asyncio.sleep(self._rng.uniform(0.08, 0.2))
            expected = secs if direction == "forward" else -secs
            ok = await verify_seeked(self.tab, before, abs(expected))
            from behavior.youtube.action_audit import ActionAudit
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    f"seek_{direction}_{secs}s",
                    selector_used="CDP keypress (j/l)",
                    click_registered=True,
                    verified=ok,
                    reason=f"before={before:.1f}s delta_expected={abs(expected)}",
                )
            if ok:
                self._log(f"Seek {direction} {secs}s ✓ VERIFIED")
            else:
                self._log(f"Seek {direction} {secs}s FAILED ✗ (time unchanged)")
            return ok
        except Exception as exc:
            self._log(f"Seek error: {exc}")
            return False

    async def _do_like_comment(self) -> bool:
        """Like first visible comment — V2 like_comment_first."""
        try:
            ok = await yt_desktop.like_comment_first(self.tab)
            if ok:
                self._log("💬👍 Comment liked ✓")
            return ok
        except Exception:
            return False

    async def _do_expand_description(self) -> bool:
        """Expand video description — V2 expand_description."""
        try:
            ok = await yt_desktop.expand_description(self.tab)
            from behavior.youtube.action_audit import ActionAudit
            from behavior.youtube.selectors import DESKTOP

            audit = ActionAudit.current()
            if audit:
                audit.record(
                    "description_expand",
                    selector_used=str(DESKTOP.get("description_more_button", ("",))[0]),
                    click_registered=ok,
                    verified=ok,
                )
            if ok:
                self._log("📄 Description expanded ✓ VERIFIED")
            else:
                self._log("📄 Description expand FAILED ✗ (unverified)")
            return ok
        except Exception:
            return False

    async def _do_click_description_link(self) -> bool:
        """Click description link — V2 click_description_link, close extra tabs."""
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
        """Send a keyboard key press (k=pause/play, j=back10s, l=fwd10s, m=mute)."""
        try:
            from nodriver import cdp
            code = f"Key{key.upper()}" if len(key) == 1 and key.isalpha() else key
            await self.tab.send(cdp.input_.dispatch_key_event(
                "keyDown", key=key, code=code, windows_virtual_key_code=0,
            ))
            await asyncio.sleep(0.05)
            await self.tab.send(cdp.input_.dispatch_key_event(
                "keyUp", key=key, code=code, windows_virtual_key_code=0,
            ))
        except Exception as e:
            self._log(f"Key {key!r} failed: {e}")

    async def _scroll(self, px: int) -> None:
        """Natural eased scroll via safe_eval_js — no raw tab.evaluate."""
        try:
            if getattr(self, "_natural_scroll", True):
                steps = self._rng.randint(3, 7)
                step_px = px / steps
                for i in range(steps):
                    t = (i + 1) / steps
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
            nx, ny = await cdp_wander_player_area(
                self.tab, self._mouse_x, self._mouse_y, rng,
            )
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
                action_name="MOUSE_MOVE",
                wrap=False,
            )
        except Exception:
            pass

    async def _do_related_video(self, own_channel_names: list[str]) -> None:
        """
        Sidebar related video — own channel only, unwatched by this profile only.
        Silent skip if none found. Never raises — always non-fatal.
        """
        if not own_channel_names:
            self._log("[Sidebar] own_channel_names empty — skipping related video")
            return
        if not self.tab:
            return
        try:
            from server_python.sidebar_video import SidebarVideoManager
            mgr = SidebarVideoManager(
                tab=self.tab,
                profile_id=self.profile_id,
                own_channel_names=own_channel_names,
                rng=self._rng,
                log_fn=self._log,
            )
            # Small human pause before looking at sidebar
            await asyncio.sleep(self._rng.uniform(2.0, 5.0))
            result = await mgr.find_and_click()
            if result:
                self._log("[Sidebar] ✓ Related video clicked from own channel")
            else:
                self._log("[Sidebar] No own-channel unwatched video — skipped")
        except Exception as e:
            self._log(f"[Sidebar] Related video error (non-fatal): {e}")

    async def go_to_youtube_home(self) -> None:
        """YouTube home — warm up."""
        try:
            await self.tab.get("https://www.youtube.com")
            await asyncio.sleep(self._rng.uniform(2.0, 5.0))
            await self._dismiss_consent()
        except Exception as e:
            self._log(f"YouTube home error: {e}")

    async def close(self) -> None:
        self._running = False
        if self._guardian:
            try:
                await self._guardian.stop()
            except Exception:
                pass
            self._guardian = None
        try:
            if self.browser:
                await self.browser.stop()
        except Exception:
            pass
        self.browser = None
        self.tab = None


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
        self._recycle_task  = None
        self._recycle_data: dict = {}
        self._loop = None

    def set_loop(self, loop) -> None:
        """Background asyncio loop — recycle engine ke liye."""
        self._loop = loop

    # ── Schedule Run ──────────────────────────────────────────────────────────

    async def run_schedule(
        self,
        schedule: dict,
        provider_name: str,
        workers: dict,
        log_fn: Callable,
    ):
        """Run schedule — concurrent automation for all profiles."""
        from server_python.providers.morelogin  import MoreLoginProvider
        from server_python.providers.multilogin import MultiloginProvider
        from server_python.smart_proxy import get_proxy_manager

        profile_ids    = schedule.get("selectedProfiles", [])
        videos         = schedule.get("videos", [])
        watch_pct      = schedule.get("watchTimeMin", 70) / 100.0
        max_concurrent = schedule.get("maxConcurrent", 4)
        engagement_cfg = schedule.get("engagement", {})
        use_entropy    = schedule.get("useEntropy", True)   # organic nav on by default
        use_proxy      = schedule.get("useProxy", False)
        own_channels   = schedule.get("ownChannelNames", [])  # for related video feature

        if not profile_ids or not videos:
            log_fn("error", "schedule", "No profiles or videos in schedule")
            return

        provider = MultiloginProvider() if provider_name == "multilogin" else MoreLoginProvider()
        proxy_mgr = get_proxy_manager() if use_proxy else None
        sem = asyncio.Semaphore(max_concurrent)

        async def _run_one(pid: str):
            async with sem:
                workers[pid] = workers.get(pid, {})
                workers[pid]["status"] = "starting"
                log_fn("info", "agent", f"[{pid[:8]}] Starting profile...")

                try:
                    # 1. Start browser via provider
                    start_res = await provider.start_profile(pid)
                    if start_res.get("code") != 0:
                        raise RuntimeError(f"Provider start failed: {start_res.get('message')}")

                    cdp_port = start_res.get("data", {}).get("cdpPort")
                    if not cdp_port:
                        raise RuntimeError("No CDP port returned by provider")

                    cdp_endpoint = start_res.get("data", {}).get("cdpEndpoint", f"http://127.0.0.1:{cdp_port}")

                    # 2. Log proxy config if enabled
                    if proxy_mgr:
                        proxy_cfg = proxy_mgr.get_proxy_config(pid)
                        log_fn("info", "proxy", f"[{pid[:8]}] Proxy: {proxy_cfg['username']}")

                    # 3. Create agent + connect
                    agent = YouTubeAgent(pid, cdp_port, schedule)
                    await agent.connect_cdp(cdp_endpoint)
                    self._active_agents[pid] = agent

                    workers[pid]["status"] = "watching"
                    log_fn("info", "agent", f"[{pid[:8]}] Connected via nodriver ✓")

                    # 4. Warm up
                    await agent.warm_up()

                    # 4b. Apply browser identity (timezone/lang/resolution/noise)
                    if use_proxy:
                        try:
                            from server_python.identity_manager import get_identity_manager
                            id_mgr = get_identity_manager(proxy_manager=proxy_mgr)
                            identity = await id_mgr.get_identity(pid)
                            await id_mgr.apply_to_browser(agent.tab, identity)
                            log_fn("info", "identity",
                                   f"[{pid[:8]}] Identity applied: "
                                   f"{identity.country_code}/{identity.city} "
                                   f"tz={identity.timezone} "
                                   f"res={identity.screen_width}x{identity.screen_height}")
                        except Exception as ie:
                            log_fn("info", "identity",
                                   f"[{pid[:8]}] Identity apply skipped (non-fatal): {ie}")

                    # 5. Watch each video
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

                        # Use organic entropy navigation (default)
                        if use_entropy:
                            ok = await agent.watch_video_organic(
                                video_id=video_id,
                                title_hint=title,
                                channel_name=channel,
                                watch_pct=watch_pct,
                                engagement=engagement_cfg,
                                own_channel_names=own_channels,
                            )
                        else:
                            # Direct URL fallback
                            url = f"https://www.youtube.com/watch?v={video_id}"
                            ok = await agent.watch_video_direct(url, int(watch_pct * 100))

                        status = "done" if ok else "error"
                        log_fn("info", "agent", f"[{pid[:8]}] Video {i+1}: {status}")

                        # Inter-video gap
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
                    workers[pid]["error"] = str(e)
                    log_fn("error", "agent", f"[{pid[:8]}] Error: {e}")

                    # AI error recovery attempt
                    try:
                        from server_python.ai_brain import recover_from_error, is_available
                        if is_available():
                            recovery = recover_from_error(
                                error_message=str(e),
                                dom_summary="",
                                current_url="",
                                goal="Watch YouTube video",
                            )
                            log_fn("info", "agent", f"[{pid[:8]}] AI recovery: {recovery.get('action')} → {recovery.get('explanation')}")
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
            recycle_engine.start(data),
            self._loop,
        )

    def stop_recycle(
        self,
        slot_id: str | None = None,
        profile_id: str | None = None,
    ) -> None:
        from server_python.recycle_engine import recycle_engine

        if not self._loop:
            return
        asyncio.run_coroutine_threadsafe(
            recycle_engine.stop(slot_id=slot_id, profile_id=profile_id),
            self._loop,
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
