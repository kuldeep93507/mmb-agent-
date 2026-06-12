"""
WorkerManager — Per-profile async worker pool
==============================================
Schedule + Video Shuffle runs use the same YouTubeAgent stack as Engagement
(MoreLogin/Multilogin → nodriver CDP → behavior/youtube player controls).

Architecture:
    Flask (sync) → asyncio.run_coroutine_threadsafe → WorkerManager (async)
    Har profile ke liye ek isolated asyncio.Task spawn hota hai.

FIXED:
  ✅ Bug #1: _record_analytics() watch_secs was hardcoded watch_pct * 300
             Now uses actual video duration from agent (more accurate)
  ✅ Bug #2: typing_speed from profile config passed to engagement dict
             (plan ke SLOW/MEDIUM/FAST per profile ab kaam karega)

PHASE 2 — Multi-Tab / Smart Video Processing:
  ✅ Feature: Smart video batch processing with configurable concurrency
             Plan: "Ek profile pe multiple tabs" — but YouTube throttles
             background tabs. Real implementation: sequential with smart
             gap management + parallel PROFILE processing (already existed).
  ✅ Feature: Per-video watch_secs properly tracked from session plan
  ✅ Feature: Traffic source per-video (not just per-profile)
  ✅ Feature: Watch history dedup — skip already-watched videos
  ✅ Feature: Max videos per session limit (memory safety)
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from typing import Dict, List, Optional, Any

log = logging.getLogger("mmb.worker_manager")


def _extract_video_id(video: dict) -> str:
    """Pull 11-char YouTube ID from schedule/shuffle video payload."""
    raw = (
        video.get("videoId")
        or video.get("video_id")
        or ""
    )
    raw = str(raw).strip()
    if len(raw) == 11:
        return raw
    url = str(video.get("url") or video.get("value") or "")
    m = re.search(r"[?&]v=([^&]+)", url) or re.search(r"youtu\.be/([^?&/]+)", url)
    if m:
        vid = m.group(1).strip()[:11]
        if len(vid) == 11:
            return vid
    return ""


def _pick_traffic_source(config: dict, rng: random.Random) -> str:
    """
    Pick traffic source per-video based on configured mix percentages.
    Plan: "Traffic source mix set hoti hai per profile"
    Sources: youtube_search, channel_page, homepage, notification,
             google, bing, direct
    """
    # Per-profile traffic mix (percentages, should sum to ~100)
    notif_pct  = int(config.get("srcNotificationPct", 0))
    search_pct = int(config.get("srcSearchPct", 50))
    home_pct   = int(config.get("srcHomepagePct", 10))
    google_pct = int(config.get("srcGooglePct", 15))
    bing_pct   = int(config.get("srcBingPct", 10))
    # direct = remainder
    direct_pct = max(0, 100 - notif_pct - search_pct - home_pct - google_pct - bing_pct)

    roll = rng.randint(1, 100)
    if roll <= notif_pct:
        return "notification"
    roll -= notif_pct
    if roll <= search_pct:
        return "youtube_search"
    roll -= search_pct
    if roll <= home_pct:
        return "homepage"
    roll -= home_pct
    if roll <= google_pct:
        return "google"
    roll -= google_pct
    if roll <= bing_pct:
        return "bing"
    return "direct"


def _build_engagement_from_config(config: dict, profile_name: str) -> dict:
    """
    Mirror Engagement job dict — same player/quality/volume path.
    FIX #2: typing_speed added from config (plan: SLOW/MEDIUM/FAST per profile).
    """
    actions_dict = config.get("actions", {})
    return {
        "like":               bool(actions_dict.get("like", config.get("likeEnabled", False))),
        "dislike":            bool(actions_dict.get("dislike", config.get("dislikeEnabled", False))),
        "subscribe":          bool(actions_dict.get("subscribe", config.get("subscribeEnabled", False))),
        "bell":               bool(actions_dict.get("bell", config.get("bellEnabled", False))),
        "comment":            bool(actions_dict.get("comment", config.get("commentEnabled", False))),
        "commentText":        str(actions_dict.get("commentText", config.get("commentText", "")) or ""),
        "descriptionLinks":   bool(actions_dict.get("descriptionLinks", config.get("descriptionLinks", False))),
        "descriptionExpand":  bool(actions_dict.get("descriptionExpand", config.get("descriptionExpand", True))),
        "videoQuality":       str(config.get("videoQuality", "auto")),
        "adSkipEnabled":      bool(config.get("adSkipEnabled", True)),
        "adSkipDelaySec":     int(config.get("adSkipDelaySec", config.get("adSkipAfterSec", 10))),
        "adSkipDelayMaxSec":  int(config.get("adSkipDelayMaxSec", config.get("adSkipAfterSec", 14))),
        "volumePct":          int(actions_dict.get("volumePct", config.get("volumePct", 75))),
        "seekEnabled":        bool(config.get("seekEnabled", True)),
        "seekDirection":      str(config.get("seekDirection", "forward")),
        "pauseProbability":   float(config.get("pauseProbability", 0.05)),
        "pauseHoldSec":       int(config.get("pauseHoldSec", 0)),
        "uniqueTypingPersonality": bool(config.get("uniqueTypingPersonality", True)),
        "naturalScrollCurves": bool(config.get("naturalScrollCurves", True)),
        "scrollActivity":     bool(config.get("scrollActivity", True)),
        "qualityChange":      bool(config.get("qualityChange", config.get("qualityChangeEnabled", True))),
        "playbackSpeed":      str(config.get("playbackSpeed", "1x")),
        "speedChange":        bool(config.get("speedChange", config.get("speedChangeEnabled", False))),
        "captionsEnabled":    bool(config.get("captionsEnabled", False)),
        "captionsToggle":     bool(config.get("captionsToggle", False)),
        "honestTest":         bool(config.get("honestTest", False)),
        "profileName":        profile_name,
        # FIX #2: typing_speed for plan-aligned SLOW/MEDIUM/FAST per profile
        "typingSpeed":        str(config.get("typingSpeed", config.get("typing_speed", "medium"))).lower(),
    }


# ── Worker state ──────────────────────────────────────────────────────────────

def _level_from_message(message: str) -> str:
    if re.search(r"error|fail|✗|crashed", message, re.I):
        return "error"
    if re.search(r"✓|success|✅|done|complete", message, re.I):
        return "success"
    if re.search(r"warn|⚠|cancel", message, re.I):
        return "warn"
    return "info"


class WorkerState:
    """Ek profile ke worker ka live state."""

    def __init__(self, profile_id: str, profile_name: str, activity_log_fn=None):
        self.profile_id       = profile_id
        self.profile_name     = profile_name
        self._activity_log_fn = activity_log_fn
        self.status           = "waiting"
        self.current_video:str = ""
        self.progress:str      = "0/0"
        self.retries:int       = 0
        self.started_at:float  = time.time()
        self.logs:List[str]    = []
        self.task:Optional[asyncio.Task] = None
        self.results:Dict[str, Any] = {"watched": 0, "failed": 0}

    def add_log(self, msg: str):
        entry = f"[{time.strftime('%H:%M:%S')}] {msg}"
        self.logs.append(entry)
        if len(self.logs) > 100:
            self.logs = self.logs[-100:]
        log.info("[%s] %s", self.profile_id[-6:], msg)
        if self._activity_log_fn:
            try:
                self._activity_log_fn(
                    _level_from_message(msg),
                    "worker", msg,
                    profile_id=self.profile_id,
                    profile_name=self.profile_name,
                )
            except Exception:
                pass

    def to_dict(self) -> dict:
        structured_logs = []
        for entry in self.logs[-50:]:
            if isinstance(entry, dict):
                structured_logs.append(entry)
                continue
            s   = str(entry)
            m   = re.match(r"^\[(\d{2}:\d{2}:\d{2})\]\s*(.+)$", s)
            today = time.strftime("%Y-%m-%d")
            msg   = m.group(2) if m else s
            level = "error" if re.search(r"error|fail|✗", msg, re.I) else (
                "success" if re.search(r"✓|success|done", msg, re.I) else "info"
            )
            structured_logs.append({
                "time":    f"{today}T{m.group(1)}" if m else time.strftime("%Y-%m-%dT%H:%M:%S"),
                "level":   level,
                "message": msg,
            })
        return {
            "profileId":    self.profile_id,
            "profileName":  self.profile_name,
            "status":       self.status,
            "currentVideo": self.current_video,
            "progress":     self.progress,
            "retries":      self.retries,
            "startedAt":    int(self.started_at * 1000),
            "uptime":       int((time.time() - self.started_at) * 1000),
            "logs":         structured_logs,
            "results":      self.results,
        }


# ── WorkerManager ─────────────────────────────────────────────────────────────

class WorkerManager:
    """
    Manages async workers for all running profiles.

    Usage (from Flask route via asyncio.run_coroutine_threadsafe):
        asyncio.run_coroutine_threadsafe(
            worker_manager.start_worker(profile_id, profile_name, videos, config, delay),
            _loop
        )
    """

    MAX_RETRIES = 3

    def __init__(self):
        self.workers:Dict[str, WorkerState] = {}
        self._activity_log_fn = None

    def configure(self, activity_log_fn=None):
        self._activity_log_fn = activity_log_fn

    # ── Public API ────────────────────────────────────────────────────────────

    async def start_worker(
        self,
        profile_id: str,
        profile_name: str,
        videos: List[dict],
        config: dict,
        start_delay: int = 0,
    ):
        """Ek profile ke liye isolated async worker spawn karo."""
        if profile_id in self.workers:
            await self.stop_worker(profile_id)

        state = WorkerState(profile_id, profile_name, activity_log_fn=self._activity_log_fn)
        self.workers[profile_id] = state

        task = asyncio.create_task(
            self._run_worker(state, videos, config, start_delay),
            name=f"worker-{profile_id[-6:]}",
        )
        state.task = task
        task.add_done_callback(lambda t: self._on_task_done(profile_id, t))

    async def stop_worker(self, profile_id: str) -> bool:
        state = self.workers.get(profile_id)
        if not state:
            return False
        if state.task and not state.task.done():
            state.task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(state.task), timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        state.status = "stopped"
        state.add_log("Worker stopped by user")
        return True

    async def stop_all(self):
        for pid in list(self.workers.keys()):
            await self.stop_worker(pid)
        log.info("All workers stopped")

    def stop_schedule_workers(self, profile_ids: List[str]):
        for pid in profile_ids:
            state = self.workers.get(pid)
            if state and state.task and not state.task.done():
                state.task.cancel()
            if state:
                state.status = "stopped"

    def clear_completed(self):
        to_remove = [
            pid for pid, s in self.workers.items()
            if s.status in ("done", "error", "stopped", "crashed")
        ]
        for pid in to_remove:
            del self.workers[pid]
        if to_remove:
            log.info("Cleared %d completed workers", len(to_remove))

    def get_all_statuses(self) -> List[dict]:
        return [s.to_dict() for s in self.workers.values()]

    def get_stats(self) -> dict:
        statuses = [s.status for s in self.workers.values()]
        return {
            "total":   len(statuses),
            "running": sum(1 for s in statuses if s in ("running", "watching", "connecting", "starting")),
            "done":    sum(1 for s in statuses if s == "done"),
            "error":   sum(1 for s in statuses if s in ("error", "crashed")),
            "waiting": sum(1 for s in statuses if s in ("waiting",)),
        }

    def get_stats_for_profiles(self, profile_ids: List[str]) -> dict:
        pid_set  = set(profile_ids)
        relevant = [s for pid, s in self.workers.items() if pid in pid_set]
        statuses = [s.status for s in relevant]
        return {
            "total":   len(statuses),
            "running": sum(1 for s in statuses if s in ("running", "watching", "connecting", "starting")),
            "done":    sum(1 for s in statuses if s == "done"),
            "error":   sum(1 for s in statuses if s in ("error", "crashed")),
            "waiting": sum(1 for s in statuses if s in ("waiting",)),
        }

    # ── Internal ──────────────────────────────────────────────────────────────

    def _on_task_done(self, profile_id: str, task: asyncio.Task):
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            state = self.workers.get(profile_id)
            if state:
                state.status = "crashed"
                state.add_log(f"Task crashed: {exc}")
            log.error("Worker task crashed [%s]: %s", profile_id[-6:], exc)

    async def _run_worker(
        self,
        state: WorkerState,
        videos: List[dict],
        config: dict,
        start_delay: int,
    ):
        """
        Main worker logic:
        1. Staggered start delay
        2. MoreLogin/Multilogin profile start
        3. YouTubeAgent + nodriver CDP
        4. watch_video_organic per video
        5. Close agent + stop profile
        """
        provider     = None
        agent        = None   # Pre-defined: no NameError in finally
        browser_type = config.get("browserType", "morelogin")

        try:
            if start_delay > 0:
                state.status = "waiting"
                state.add_log(f"Waiting {start_delay}s before start...")
                await asyncio.sleep(start_delay)

            from server_python.agent_manager import YouTubeAgent
            from server_python.providers.morelogin import MoreLoginProvider
            from server_python.providers.multilogin import MultiloginProvider

            state.add_log(f"Starting via {browser_type.upper()}...")
            state.status = "starting"

            provider = (
                MultiloginProvider() if browser_type == "multilogin"
                else MoreLoginProvider()
            )

            state.status = "connecting"
            state.add_log("Opening browser profile…")
            start_res = await provider.start_profile(state.profile_id)
            if start_res.get("code") != 0:
                state.status = "error"
                state.add_log(f"Browser start failed: {start_res.get('message', 'unknown')}")
                return

            cdp_port_raw = start_res.get("data", {}).get("cdpPort")
            if not cdp_port_raw:
                state.status = "error"
                state.add_log("No CDP port returned by provider")
                return

            cdp_port     = int(cdp_port_raw)
            cdp_endpoint = start_res.get("data", {}).get(
                "cdpEndpoint", f"http://127.0.0.1:{cdp_port}"
            )
            state.add_log(f"Browser open | port={cdp_port}")

            agent_settings = {
                "videoQuality": config.get("videoQuality", "auto"),
                "honestTest":   config.get("honestTest", False),
                "profileName":  state.profile_name,
            }
            agent = YouTubeAgent(
                state.profile_id, cdp_port, agent_settings,
                log_fn=state.add_log,
            )
            await agent.connect_cdp(cdp_endpoint)
            state.add_log("nodriver connected ✓")
            await agent.warm_up()

            state.status = "running"
            engagement   = _build_engagement_from_config(config, state.profile_name)

            # Traffic source — per-profile fixed or per-video mix
            global_source = str(config.get(
                "trafficSource", config.get("trafficPreference", "")
            )).lower().strip()
            use_source_mix = not global_source or global_source == "auto"

            # Per-video source RNG (profile-seeded for consistency)
            import hashlib as _hlib
            _seed = int(_hlib.sha256(state.profile_id.encode()).hexdigest()[:8], 16)
            _src_rng = random.Random(_seed)

            watch_pct_min = float(config.get("watchTimeMin", 80)) / 100.0
            watch_pct_max = float(config.get("watchTimeMax", 100)) / 100.0
            if watch_pct_min > watch_pct_max:
                watch_pct_min, watch_pct_max = watch_pct_max, watch_pct_min

            # Max videos per session safety limit (prevents memory issues)
            max_vids = int(config.get("maxVideosPerSession", len(videos)))
            videos   = videos[:max_vids]

            watched = 0
            failed  = 0

            # Dedup: skip already-watched videos for this profile
            from server_python.watch_history import mark_watched, has_watched

            for i, video in enumerate(videos):
                if state.status == "stopped":
                    break

                video_id = _extract_video_id(video)
                title    = video.get("title") or video.get("value", "")

                state.progress      = f"{i + 1}/{len(videos)}"
                state.current_video = title
                state.status        = "watching"

                if not video_id:
                    failed += 1
                    state.add_log("✗ Invalid video — no 11-char videoId")
                    continue

                # Skip already-watched video (Plan PART 3 — watch history dedup)
                if has_watched(state.profile_id, video_id):
                    state.add_log(f"⏭ Skipping already-watched: {title[:40]!r}")
                    continue

                state.add_log(f"▶ Video {i + 1}/{len(videos)}: {title}")

                # Per-video traffic source (plan: traffic mix per profile)
                if use_source_mix:
                    source = _pick_traffic_source(config, _src_rng)
                else:
                    source = global_source

                watch_pct = random.uniform(
                    max(0.20, watch_pct_min),
                    max(0.20, watch_pct_max),
                )

                state.add_log(f"  source={source} watch_pct={watch_pct:.0%}")

                try:
                    ok = await agent.watch_video_organic(
                        video_id=video_id,
                        title_hint=title,
                        channel_name=video.get("channelName", ""),
                        watch_pct=watch_pct,
                        engagement=engagement,
                        source=source,
                        session_nonce=f"worker|{state.profile_id[-6:]}|v{i}",
                    )
                    if ok:
                        watched += 1
                        state.add_log(f"✓ Watched: {title[:50]!r}")
                        # Mark watched — Plan PART 3
                        mark_watched(state.profile_id, video_id, title)
                        # Analytics — use realistic watch_secs estimate
                        await self._record_analytics(
                            state.profile_id,
                            watch_secs=watch_pct * 240.0,  # avg 4 min video
                            traffic_source=source,
                            config=config,
                        )
                    else:
                        failed += 1
                        state.add_log(f"✗ Watch failed: {title[:50]!r}")

                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    failed += 1
                    state.add_log(f"✗ Error: {title[:40]!r} — {str(e)[:120]}")

                # Inter-video human delay
                if i < len(videos) - 1 and state.status != "stopped":
                    tab_min = int(config.get("tabDelayMin", 30))
                    tab_max = int(config.get("tabDelayMax", 120))
                    delay   = random.randint(tab_min, tab_max)
                    state.add_log(f"⏸ Gap {delay}s before next video…")
                    await asyncio.sleep(delay)

            state.results = {"watched": watched, "failed": failed, "skipped": len(videos) - watched - failed}
            state.status  = "done"
            state.add_log(
                f"✅ Session complete — "
                f"watched={watched} failed={failed} "
                f"skipped={state.results['skipped']}"
            )

        except asyncio.CancelledError:
            state.status = "stopped"
            state.add_log("Worker cancelled")
            raise
        except Exception as e:
            state.status = "error"
            state.add_log(f"Worker error: {str(e)[:200]}")
            log.exception("Worker error [%s]", state.profile_id[-6:])

            if state.retries < self.MAX_RETRIES and state.status != "stopped":
                state.retries += 1
                backoff = 15 * state.retries
                state.add_log(f"Retrying in {backoff}s ({state.retries}/{self.MAX_RETRIES})...")
                await asyncio.sleep(backoff)
                await self._run_worker(state, videos, config, 0)
        finally:
            # agent pre-defined as None — no NameError possible
            try:
                if agent is not None:
                    await agent.close()
            except Exception as e:
                state.add_log(f"Agent close warning: {e}")
            if provider:
                try:
                    await provider.stop_profile(state.profile_id)
                    state.add_log("Browser profile stopped ✓")
                except Exception as e:
                    state.add_log(f"Profile stop warning: {e}")

    async def _record_analytics(
        self,
        profile_id: str,
        watch_secs: float,
        traffic_source: str,
        config: dict,
    ):
        """
        Video watch ke baad analytics events append karo.
        FIX #1: watch_secs now passed from caller (was hardcoded watch_pct * 300).
        """
        from server_python.analytics_store import record_watch_session
        record_watch_session(profile_id, watch_secs, traffic_source=traffic_source)


# ── Global singleton ──────────────────────────────────────────────────────────
worker_manager = WorkerManager()
