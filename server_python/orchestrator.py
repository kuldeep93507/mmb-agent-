"""
Orchestrator — 24h Organic Traffic Scheduling for MMB AGENT 24/7
Adapted from MMB-Agent-v2/core/Orchestrator.py

Features:
  1. 24-hour hourly traffic weights (peak 7pm=1.0, night 3am=0.05)
  2. Views organically spread across the day — sab ek saath nahi
  3. RAM-aware concurrency limit (psutil optional)
  4. 12-second stagger between profile starts (Multilogin 429 avoid)
  5. Inter-arrival time randomization (not exactly every N seconds)
  6. Crash-safe cycle state saved to JSON

Usage:
    orch = Orchestrator(schedule, log_fn)
    await orch.run()          # run once (current concurrency)
    await orch.run_organic()  # 24h organic mode — respects hour weights
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import random
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("mmb.orchestrator")

# Cycle state file — crash-safe save
_STATE_DIR  = Path(__file__).resolve().parent.parent / "data" / "orchestrator"

# RAM threshold — reduce concurrency above this %
_RAM_HIGH_WATERMARK = 82.0   # %
_RAM_CRIT_WATERMARK = 92.0   # % — pause new starts

# Stagger between profile starts
_STAGGER_BASE   = 12.0   # seconds (Multilogin / MoreLogin 429 avoid)
_STAGGER_JITTER = 5.0    # ±random seconds added

# ── 24-hour Traffic Weights ───────────────────────────────────────────────────
# Key = hour (0-23 local time), Value = relative traffic weight
# Peak = 1.0 (19:00), lowest = 0.05 (03:00)
HOURLY_WEIGHTS: dict[int, float] = {
    0:  0.15,
    1:  0.10,
    2:  0.07,
    3:  0.05,   # lowest — 3am
    4:  0.07,
    5:  0.12,
    6:  0.20,
    7:  0.35,   # morning commute
    8:  0.45,
    9:  0.55,
    10: 0.60,
    11: 0.65,
    12: 0.70,   # lunch peak
    13: 0.68,
    14: 0.65,
    15: 0.70,
    16: 0.78,   # post-work
    17: 0.85,
    18: 0.92,   # evening rise
    19: 1.00,   # PEAK — prime time
    20: 0.98,
    21: 0.90,
    22: 0.75,
    23: 0.45,   # late night
}


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class ViewSlot:
    """One scheduled view assignment — profile × video."""
    profile_id: str
    video_id:   str
    title:      str
    channel:    str
    scheduled_at: float   # epoch when this slot should run
    watch_pct:  float = 0.70
    engagement: dict = field(default_factory=dict)
    status: str = "pending"   # pending / running / done / error


@dataclass
class CycleState:
    """Crash-safe cycle progress saved to disk."""
    cycle_id:    str
    total_slots: int
    done:        int = 0
    errors:      int = 0
    started_at:  float = field(default_factory=time.time)
    updated_at:  float = field(default_factory=time.time)
    completed_profile_video: list = field(default_factory=list)  # ["pid:vid", ...]

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CycleState":
        return cls(**d)


# ── Orchestrator ──────────────────────────────────────────────────────────────

class Orchestrator:
    """
    Intelligent 24h organic traffic scheduler.

    Args:
        schedule    : same dict used by AgentManager.run_schedule()
        log_fn      : callable(level, category, message)
        provider_name : "multilogin" or "morelogin"
        workers     : shared workers dict (for status tracking)
    """

    def __init__(
        self,
        schedule: dict,
        log_fn: Callable,
        provider_name: str = "multilogin",
        workers: dict | None = None,
    ) -> None:
        self._schedule      = schedule
        self._log_fn        = log_fn
        self._provider_name = provider_name
        self._workers       = workers or {}
        self._rng           = random.Random()
        self._running       = False
        self._state: Optional[CycleState] = None

        # Extract schedule params
        self._profile_ids    = schedule.get("selectedProfiles", [])
        self._videos         = self._extract_videos(schedule)
        self._watch_pct      = schedule.get("watchTimeMin", 70) / 100.0
        self._max_concurrent = schedule.get("maxConcurrent", 4)
        self._engagement_cfg = schedule.get("engagement", {})
        self._use_entropy    = schedule.get("useEntropy", True)
        self._use_proxy      = schedule.get("useProxy", False)
        self._own_channels   = schedule.get("ownChannelNames", [])

    def _log(self, level: str, msg: str) -> None:
        self._log_fn(level, "orchestrator", msg)

    @staticmethod
    def _extract_videos(schedule: dict) -> list:
        """
        Frontend schedule format se videos nikalo.
        Format options:
          1. schedule["videos"] — flat list (legacy)
          2. schedule["sameForAll"]["videos"] — same videos for all profiles
          3. schedule["perProfile"][*]["channelSelections"][*]["videos"] — per-profile
        """
        # Option 1: flat videos (legacy / direct)
        if schedule.get("videos"):
            return schedule["videos"]

        # Option 2: sameForAll.videos
        same = schedule.get("sameForAll") or {}
        if same.get("videos"):
            return same["videos"]

        # Option 3: perProfile channelSelections flatten
        per_profile = schedule.get("perProfile") or []
        seen: set = set()
        all_videos: list = []
        for pp in per_profile:
            for ch_sel in (pp.get("channelSelections") or []):
                for v in (ch_sel.get("videos") or []):
                    vid_id = v.get("videoId") or v.get("id", "")
                    if vid_id and vid_id not in seen:
                        seen.add(vid_id)
                        all_videos.append(v)
        if all_videos:
            return all_videos

        return []

    # ── Public API ────────────────────────────────────────────────────────────

    async def run(self) -> None:
        """
        Standard run — starts all profiles with stagger + RAM-aware concurrency.
        Replaces the simple asyncio.gather() in AgentManager.run_schedule().
        """
        if not self._profile_ids:
            self._log("error", "No profiles in schedule")
            return
        if not self._videos:
            self._log("warn", "Top-level videos empty — will try per-profile extraction")

        self._running = True
        self._log("info",
            f"Orchestrator starting | profiles={len(self._profile_ids)} "
            f"videos={len(self._videos)} max_concurrent={self._max_concurrent}"
        )

        sem = asyncio.Semaphore(self._max_concurrent)
        tasks = []

        for i, pid in enumerate(self._profile_ids):
            if not self._running:
                break
            task = asyncio.create_task(
                self._run_profile_with_stagger(pid, i, sem)
            )
            tasks.append(task)

        await asyncio.gather(*tasks, return_exceptions=True)
        self._log("info", f"Orchestrator run complete | {len(self._profile_ids)} profiles")

    async def run_organic(self) -> None:
        """
        24h organic mode — uses hourly weights to decide how many profiles
        to run right now vs defer. Loops until all slots are done or stopped.
        """
        if not self._profile_ids:
            self._log("error", "No profiles for organic run")
            return
        if not self._videos:
            self._log("warn", "Top-level videos empty for organic — will use per-profile")

        self._running = True
        slots = self._build_organic_slots()
        self._init_cycle_state(slots)

        self._log("info",
            f"Organic 24h mode | total_slots={len(slots)} "
            f"current_hour_weight={self._get_hour_weight():.2f}"
        )

        sem = asyncio.Semaphore(self._effective_concurrency())
        tasks = []
        slot_idx = 0

        while slot_idx < len(slots) and self._running:
            slot = slots[slot_idx]
            now  = time.time()

            # Wait until scheduled_at
            wait = slot.scheduled_at - now
            if wait > 0:
                self._log("info",
                    f"Waiting {wait:.0f}s for next slot "
                    f"(hour_weight={self._get_hour_weight():.2f})"
                )
                await asyncio.sleep(min(wait, 30.0))
                continue  # re-check

            # RAM check before starting
            if not await self._ram_ok():
                self._log("info", "RAM high — waiting 60s before next profile")
                await asyncio.sleep(60)
                continue

            # Skip if already done this profile×video combo
            combo = f"{slot.profile_id}:{slot.video_id}"
            if self._state and combo in self._state.completed_profile_video:
                self._log("info", f"Dedup skip: {combo[:30]}")
                slot_idx += 1
                continue

            # Launch slot
            task = asyncio.create_task(
                self._run_slot_organic(slot, sem)
            )
            tasks.append(task)
            slot_idx += 1

            # Stagger
            stagger = self._stagger_delay()
            self._log("info", f"Stagger {stagger:.1f}s before next profile start")
            await asyncio.sleep(stagger)

        # Wait for all running tasks
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        self._save_cycle_state()
        self._log("info",
            f"Organic run complete | done={self._state.done if self._state else 0} "
            f"errors={self._state.errors if self._state else 0}"
        )

    def stop(self) -> None:
        """Signal orchestrator to stop after current tasks finish."""
        self._running = False
        self._log("info", "Orchestrator stop requested")

    # ── Profile runner ────────────────────────────────────────────────────────

    async def _run_profile_with_stagger(
        self, profile_id: str, index: int, sem: asyncio.Semaphore
    ) -> None:
        """Run one profile — stagger before acquiring semaphore."""
        # Stagger: index * base + jitter (so they don't all start at once)
        stagger = (index * _STAGGER_BASE) + self._rng.uniform(0, _STAGGER_JITTER)
        if index > 0:
            self._log("info",
                f"[{profile_id[:8]}] Stagger wait {stagger:.1f}s "
                f"(profile #{index+1})"
            )
            await asyncio.sleep(stagger)

        async with sem:
            # RAM check
            if not await self._ram_ok():
                self._log("info",
                    f"[{profile_id[:8]}] RAM critical — skipping this profile"
                )
                return

            await self._execute_profile(profile_id)

    async def _run_slot_organic(
        self, slot: ViewSlot, sem: asyncio.Semaphore
    ) -> None:
        """Run one organic slot."""
        async with sem:
            slot.status = "running"
            success = await self._execute_profile_video(
                profile_id=slot.profile_id,
                video_id=slot.video_id,
                title=slot.title,
                channel=slot.channel,
                watch_pct=slot.watch_pct,
                engagement=slot.engagement,
            )
            slot.status = "done" if success else "error"
            if self._state:
                combo = f"{slot.profile_id}:{slot.video_id}"
                if success:
                    self._state.done += 1
                    if combo not in self._state.completed_profile_video:
                        self._state.completed_profile_video.append(combo)
                else:
                    self._state.errors += 1
                self._state.updated_at = time.time()
                self._save_cycle_state()

    # ── Profile execution ─────────────────────────────────────────────────────

    def _get_videos_for_profile(self, profile_id: str) -> list:
        """
        Profile-specific videos nikalo.
        perProfile mein profile ka apna video list dhundho — fallback: sameForAll.
        """
        per_profile = self._schedule.get("perProfile") or []
        for pp in per_profile:
            if pp.get("profileId") == profile_id:
                vids: list = []
                seen: set = set()
                for ch_sel in (pp.get("channelSelections") or []):
                    for v in (ch_sel.get("videos") or []):
                        vid_id = v.get("videoId") or v.get("id", "")
                        if vid_id and vid_id not in seen:
                            seen.add(vid_id)
                            vids.append(v)
                if vids:
                    return vids
        # Fallback to shared video list
        return self._videos

    async def _execute_profile(self, profile_id: str) -> None:
        """Run all videos for a profile (standard mode)."""
        videos = self._get_videos_for_profile(profile_id)
        if not videos:
            self._log("error", f"[{profile_id[:8]}] No videos found — skip")
            return
        for video in videos:
            if not self._running:
                break
            video_id = video.get("videoId") or video.get("id", "")
            if not video_id:
                continue
            await self._execute_profile_video(
                profile_id=profile_id,
                video_id=video_id,
                title=video.get("title", ""),
                channel=video.get("channel", ""),
                watch_pct=self._watch_pct,
                engagement=self._engagement_cfg,
            )
            # Inter-video gap
            gap = self._rng.uniform(15.0, 45.0)
            await asyncio.sleep(gap)

    async def _execute_profile_video(
        self,
        profile_id: str,
        video_id: str,
        title: str,
        channel: str,
        watch_pct: float,
        engagement: dict,
    ) -> bool:
        """Execute one profile × video watch session."""
        from server_python.agent_manager import YouTubeAgent
        from server_python.smart_proxy import get_proxy_manager

        self._workers[profile_id] = {
            "status": "starting",
            "currentVideo": f"https://www.youtube.com/watch?v={video_id}",
        }
        self._log("info",
            f"[{profile_id[:8]}] Starting: {video_id} "
            f"(hour_weight={self._get_hour_weight():.2f})"
        )

        proxy_mgr = get_proxy_manager() if self._use_proxy else None

        try:
            # Provider
            if self._provider_name == "multilogin":
                from server_python.providers.multilogin import MultiloginProvider
                provider = MultiloginProvider()
            else:
                from server_python.providers.morelogin import MoreLoginProvider
                provider = MoreLoginProvider()

            # Start browser
            start_res = await provider.start_profile(profile_id)
            if start_res.get("code") != 0:
                raise RuntimeError(f"Provider start failed: {start_res.get('message')}")

            cdp_port     = start_res.get("data", {}).get("cdpPort")
            cdp_endpoint = start_res.get("data", {}).get(
                "cdpEndpoint", f"http://127.0.0.1:{cdp_port}"
            )
            if not cdp_port:
                raise RuntimeError("No CDP port from provider")

            # Proxy log
            if proxy_mgr:
                proxy_cfg = proxy_mgr.get_proxy_config(profile_id)
                self._log("info",
                    f"[{profile_id[:8]}] Proxy: {proxy_cfg['username']}"
                )

            # Agent
            agent = YouTubeAgent(profile_id, cdp_port, self._schedule)
            await agent.connect_cdp(cdp_endpoint)

            self._workers[profile_id]["status"] = "watching"

            # Warm up
            await agent.warm_up()

            # Identity
            if self._use_proxy:
                try:
                    from server_python.identity_manager import get_identity_manager
                    id_mgr = get_identity_manager(proxy_manager=proxy_mgr)
                    identity = await id_mgr.get_identity(profile_id)
                    await id_mgr.apply_to_browser(agent.tab, identity)
                    self._log("info",
                        f"[{profile_id[:8]}] Identity: "
                        f"{identity.country_code}/{identity.city} "
                        f"tz={identity.timezone}"
                    )
                except Exception as ie:
                    self._log("info",
                        f"[{profile_id[:8]}] Identity skipped: {ie}"
                    )

            # Watch
            if self._use_entropy:
                ok = await agent.watch_video_organic(
                    video_id=video_id,
                    title_hint=title,
                    channel_name=channel,
                    watch_pct=watch_pct,
                    engagement=engagement,
                    own_channel_names=self._own_channels,
                )
            else:
                url = f"https://www.youtube.com/watch?v={video_id}"
                ok = await agent.watch_video_direct(url, int(watch_pct * 100))

            self._workers[profile_id]["status"] = "done" if ok else "error"
            self._log("info" if ok else "error",
                f"[{profile_id[:8]}] {video_id}: {'done' if ok else 'error'}"
            )

            await agent.close()
            return ok

        except Exception as e:
            self._workers[profile_id]["status"] = "error"
            self._workers[profile_id]["error"]  = str(e)
            self._log("error", f"[{profile_id[:8]}] Error: {e}")
            return False

        finally:
            try:
                await provider.stop_profile(profile_id)
            except Exception:
                pass

    # ── Organic slot planner ──────────────────────────────────────────────────

    def _build_organic_slots(self) -> list[ViewSlot]:
        """
        Distribute profile×video pairs across the next 24h
        using hourly weights as probability of running in that hour.
        """
        slots: list[ViewSlot] = []
        now = time.time()

        # Build all combinations (profile × video)
        combos = [
            (pid, vid)
            for pid in self._profile_ids
            for vid in self._videos
        ]

        # Spread across 24h using weighted time distribution
        total = len(combos)
        for i, (pid, vid) in enumerate(combos):
            # Pick a weighted random hour for this slot
            scheduled_epoch = self._pick_weighted_time(now, i, total)
            video_id = vid.get("videoId") or vid.get("id", "")
            slots.append(ViewSlot(
                profile_id=pid,
                video_id=video_id,
                title=vid.get("title", ""),
                channel=vid.get("channel", ""),
                scheduled_at=scheduled_epoch,
                watch_pct=self._watch_pct,
                engagement=self._engagement_cfg,
            ))

        # Sort by scheduled time
        slots.sort(key=lambda s: s.scheduled_at)
        self._log("info",
            f"Planned {len(slots)} slots across 24h | "
            f"first in {max(0, slots[0].scheduled_at - now):.0f}s"
        )
        return slots

    def _pick_weighted_time(self, now: float, idx: int, total: int) -> float:
        """
        Pick a weighted random time in the next 24h for slot idx.
        Higher-weight hours get more slots proportionally.
        """
        # Build cumulative weight table for 24 hours
        hours = list(range(24))
        weights = [HOURLY_WEIGHTS[h] for h in hours]
        total_weight = sum(weights)
        cumulative = []
        acc = 0.0
        for w in weights:
            acc += w / total_weight
            cumulative.append(acc)

        # Pick random hour weighted by traffic
        r = self._rng.random()
        chosen_hour = 0
        for h, cum in enumerate(cumulative):
            if r <= cum:
                chosen_hour = h
                break

        # Random minute within that hour
        minute = self._rng.randint(0, 59)
        second = self._rng.randint(0, 59)

        # Build epoch for chosen_hour today (or tomorrow if hour already passed)
        import datetime
        now_dt = datetime.datetime.fromtimestamp(now)
        target_dt = now_dt.replace(
            hour=chosen_hour, minute=minute, second=second, microsecond=0
        )
        if target_dt.timestamp() <= now:
            target_dt += datetime.timedelta(days=1)

        # Add small inter-arrival jitter (±5 min) so slots don't cluster
        jitter = self._rng.uniform(-300, 300)
        return target_dt.timestamp() + jitter

    # ── RAM awareness ─────────────────────────────────────────────────────────

    async def _ram_ok(self) -> bool:
        """Check if RAM usage is below critical threshold."""
        try:
            import psutil
            ram_pct = psutil.virtual_memory().percent
            if ram_pct >= _RAM_CRIT_WATERMARK:
                self._log("info",
                    f"RAM CRITICAL {ram_pct:.0f}% — pausing new starts"
                )
                return False
            if ram_pct >= _RAM_HIGH_WATERMARK:
                self._log("info",
                    f"RAM HIGH {ram_pct:.0f}% — reducing pressure"
                )
                # Not critical — still OK but log warning
                return True
            return True
        except ImportError:
            # psutil not installed — allow everything
            return True
        except Exception:
            return True

    def _effective_concurrency(self) -> int:
        """
        Get effective max_concurrent adjusted for RAM.
        Falls back to schedule value if psutil unavailable.
        """
        base = self._max_concurrent
        try:
            import psutil
            ram_pct = psutil.virtual_memory().percent
            if ram_pct >= _RAM_HIGH_WATERMARK:
                adjusted = max(1, base - 1)
                self._log("info",
                    f"RAM {ram_pct:.0f}% — concurrency reduced {base}→{adjusted}"
                )
                return adjusted
        except ImportError:
            pass
        return base

    # ── Stagger ───────────────────────────────────────────────────────────────

    def _stagger_delay(self) -> float:
        """12s base + 0-5s random jitter."""
        return _STAGGER_BASE + self._rng.uniform(0, _STAGGER_JITTER)

    # ── Hour weight ───────────────────────────────────────────────────────────

    def _get_hour_weight(self) -> float:
        """Return traffic weight for current local hour."""
        import datetime
        hour = datetime.datetime.now().hour
        return HOURLY_WEIGHTS.get(hour, 0.5)

    # ── Cycle state (crash-safe) ──────────────────────────────────────────────

    def _init_cycle_state(self, slots: list[ViewSlot]) -> None:
        """Initialize cycle state for this run."""
        import uuid
        self._state = CycleState(
            cycle_id=str(uuid.uuid4())[:8],
            total_slots=len(slots),
        )
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        self._save_cycle_state()

    def _save_cycle_state(self) -> None:
        """Atomic save of cycle state."""
        if not self._state:
            return
        p   = _STATE_DIR / "current_cycle.json"
        tmp = _STATE_DIR / "current_cycle.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._state.to_dict(), f, indent=2)
            tmp.replace(p)
        except Exception as e:
            log.debug(f"[Orchestrator] State save error: {e}")

    def load_cycle_state(self) -> Optional[CycleState]:
        """Load previous cycle state (for resuming after crash)."""
        p = _STATE_DIR / "current_cycle.json"
        try:
            if p.exists():
                with open(p, "r", encoding="utf-8") as f:
                    return CycleState.from_dict(json.load(f))
        except Exception as e:
            log.debug(f"[Orchestrator] State load error: {e}")
        return None

    def get_status(self) -> dict:
        """Return current orchestrator status for API/UI."""
        hour_weight = self._get_hour_weight()
        return {
            "running": self._running,
            "hour_weight": hour_weight,
            "current_hour": __import__("datetime").datetime.now().hour,
            "total_profiles": len(self._profile_ids),
            "total_videos": len(self._videos),
            "max_concurrent": self._max_concurrent,
            "effective_concurrent": self._effective_concurrency(),
            "stagger_seconds": _STAGGER_BASE,
            "cycle": self._state.to_dict() if self._state else None,
        }
