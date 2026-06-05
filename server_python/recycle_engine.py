"""
RecycleEngine — 24/7 Video Shuffle loop
========================================
Har profile slot: watch assigned videos → cooldown → repeat.
Uses YouTubeAgent (same path as Engagement) for ads, human behavior, analytics.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("mmb.recycle")


@dataclass
class RecycleSlot:
    slot_id: str
    profile_name: str
    browser_type: str = "multilogin"
    proxy_type: str = "none"
    os: str = "Windows"
    current_profile_id: str = ""
    status: str = "queued"
    cycle_count: int = 0
    cooldown_until: Optional[int] = None
    last_error: Optional[str] = None
    video_count: int = 0
    enabled: bool = True
    is_paused: bool = False
    profile_id_changed_at: Optional[int] = None
    current_video: str = ""
    consecutive_errors: int = 0

    def __post_init__(self):
        if not self.current_profile_id:
            self.current_profile_id = self.slot_id

    def to_dict(self) -> dict:
        return {
            "slotId": self.slot_id,
            "profileName": self.profile_name,
            "currentProfileId": self.current_profile_id,
            "status": self.status,
            "cycleCount": self.cycle_count,
            "cooldownUntil": self.cooldown_until,
            "lastError": self.last_error,
            "videoCount": self.video_count,
            "enabled": self.enabled,
            "isPaused": self.is_paused,
            "profileIdChangedAt": self.profile_id_changed_at,
            "currentVideo": self.current_video,
        }


class RecycleEngine:
    """Singleton 24/7 recycle loop orchestrator."""

    MAX_CONSECUTIVE_ERRORS = 5
    ERROR_RETRY_SEC = 90
    NO_VIDEOS_RETRY_SEC = 120

    def __init__(self):
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._log_fn: Callable[[str, str, str], None] = self._default_log
        self._root: Path = Path(__file__).resolve().parent.parent
        self._shuffle_file: Path = self._root / "shuffle_data.json"
        self._settings_file: Path = self._root / "user-settings.json"
        self._recycle_file: Path = self._root / "recycle_state.json"

        self._enabled = False
        self._paused = False
        self._cooldown_min_ms = 10 * 60_000
        self._cooldown_max_ms = 30 * 60_000
        self._slots: dict[str, RecycleSlot] = {}
        self._slot_tasks: dict[str, asyncio.Task] = {}
        self._sem: Optional[asyncio.Semaphore] = None
        self._lock = asyncio.Lock()

    def configure(
        self,
        loop: asyncio.AbstractEventLoop,
        log_fn: Optional[Callable[[str, str, str], None]] = None,
        root: Optional[Path] = None,
    ) -> None:
        self._loop = loop
        if log_fn:
            self._log_fn = log_fn
        if root:
            self._root = root
            self._shuffle_file = root / "shuffle_data.json"
            self._settings_file = root / "user-settings.json"
            self._recycle_file = root / "recycle_state.json"

    @staticmethod
    def _default_log(level: str, source: str, message: str) -> None:
        log.log(
            logging.INFO if level != "error" else logging.ERROR,
            "[%s] %s",
            source,
            message,
        )

    def _load_json(self, path: Path, default: Any) -> Any:
        try:
            if path.exists():
                return json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning("Load %s failed: %s", path.name, e)
        return default

    def _save_recycle_state(self) -> None:
        try:
            data = {
                "enabled": self._enabled,
                "paused": self._paused,
                "cooldownMinMinutes": self._cooldown_min_ms // 60_000,
                "cooldownMaxMinutes": self._cooldown_max_ms // 60_000,
                "profiles": [
                    {
                        "id": s.current_profile_id,
                        "slotId": s.slot_id,
                        "name": s.profile_name,
                        "browserType": s.browser_type,
                        "proxyType": s.proxy_type,
                        "os": s.os,
                    }
                    for s in self._slots.values()
                ],
                "status": "running" if self._enabled and not self._paused else (
                    "paused" if self._enabled and self._paused else "stopped"
                ),
                "startedAt": int(time.time() * 1000),
                "slots": [s.to_dict() for s in self._slots.values()],
            }
            tmp = self._recycle_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(self._recycle_file)
        except Exception as e:
            log.warning("Save recycle state failed: %s", e)

    def _load_shuffle_settings(self) -> dict:
        shuffle = self._load_json(self._shuffle_file, {})
        settings = shuffle.get("settings") or {}
        user = self._load_json(self._settings_file, {})
        return {
            "watchTimeMin": int(settings.get("watchTimeMin", user.get("ytWatchTimeMin", 90))),
            "watchTimeMax": int(settings.get("watchTimeMax", user.get("ytWatchTimeMax", 100))),
            "videoQuality": settings.get("videoQuality", user.get("ytVideoQuality", "auto")),
            "adSkipEnabled": settings.get("adSkipEnabled", True),
            "adSkipAfterSec": int(settings.get("adSkipAfterSec", 5)),
            "midRollAdWaitSec": int(settings.get("midRollAdWaitSec", 10)),
            "volumePct": int(settings.get("volumePct", 75)),
            "seekEnabled": settings.get("seekEnabled", True),
            "seekDirection": settings.get("seekDirection", "forward"),
            "descriptionExpand": settings.get("descriptionExpand", True),
            "descriptionLinks": settings.get("descriptionLinks", False),
            "pauseProbability": float(settings.get("pauseProbability", 12)) / 100.0
            if float(settings.get("pauseProbability", 12)) > 1
            else float(settings.get("pauseProbability", 0.12)),
            "uniqueTypingPersonality": settings.get("uniqueTypingPersonality", True),
            "naturalScrollCurves": settings.get("naturalScrollCurves", True),
            "maxConcurrent": int(user.get("maxConcurrent", user.get("ytMaxTotalAgents", 20))),
            # Traffic Source mix (% per source) — defaults: balanced
            "srcNotificationPct": int(settings.get("srcNotificationPct", 20)),
            "srcSearchPct":       int(settings.get("srcSearchPct", 30)),
            "srcHomepagePct":     int(settings.get("srcHomepagePct", 30)),
            # Direct = remainder; auto-calculated below
        }

    def _load_profile_config(self, profile_id: str) -> dict:
        """Load per-profile config (like/subscribe/comment/etc) from SETTINGS_FILE.profileConfigs."""
        user = self._load_json(self._settings_file, {})
        configs = user.get("profileConfigs", [])
        if isinstance(configs, list):
            return next((c for c in configs if c.get("id") == profile_id or c.get("profileId") == profile_id), {})
        if isinstance(configs, dict):
            return configs.get(profile_id, {}) or {}
        return {}

    @staticmethod
    def _pick_traffic_source(global_settings: dict, profile_cfg: dict) -> str:
        """Roll traffic source per cycle based on profile or global mix.
        Per-profile takes priority if set, else global."""
        # Per-profile mix (if user set on ProfileSettings)
        notif = int(profile_cfg.get("srcNotificationPct", global_settings.get("srcNotificationPct", 20)))
        search = int(profile_cfg.get("srcSearchPct", global_settings.get("srcSearchPct", 30)))
        home = int(profile_cfg.get("srcHomepagePct", global_settings.get("srcHomepagePct", 30)))
        notif = max(0, min(100, notif))
        search = max(0, min(100, search))
        home = max(0, min(100, home))
        direct = max(0, 100 - notif - search - home)

        roll = random.randint(1, 100)
        if roll <= notif:
            return "notification"
        if roll <= notif + search:
            return "search"
        if roll <= notif + search + home:
            return "homepage"
        return "direct"

    def _get_assignment_videos(self, profile_id: str) -> list[dict]:
        shuffle = self._load_json(self._shuffle_file, {})
        assignments = shuffle.get("assignments") or []
        matched = None
        for a in assignments:
            if a.get("profileId") == profile_id:
                matched = a
                break
        if not matched:
            settings = shuffle.get("settings") or {}
            if settings.get("assignmentMode") == "same-all" and assignments:
                matched = assignments[0]
        if not matched:
            return []
        videos = matched.get("videos") or []
        out = list(videos)
        random.shuffle(out)
        return out

    def get_status(self) -> dict:
        active = sum(
            1 for s in self._slots.values()
            if s.enabled and s.status in ("running", "starting", "recreating")
        )
        return {
            "enabled": self._enabled,
            "paused": self._paused,
            "cooldownMinMs": self._cooldown_min_ms,
            "cooldownMaxMs": self._cooldown_max_ms,
            "activeSlots": active,
            "slots": [s.to_dict() for s in self._slots.values()],
        }

    async def start(self, data: dict) -> dict:
        async with self._lock:
            await self._stop_internal(clear_state=False)

            profiles = data.get("profiles") or []
            if not profiles:
                raise ValueError("No profiles provided for recycle loop")

            min_min = int(data.get("cooldownMinMinutes", 10))
            max_min = int(data.get("cooldownMaxMinutes", 30))
            min_min = max(1, min_min)
            max_min = max(min_min, max_min)

            self._cooldown_min_ms = min_min * 60_000
            self._cooldown_max_ms = max_min * 60_000
            self._enabled = True
            self._paused = False

            settings = self._load_shuffle_settings()
            max_conc = max(1, settings.get("maxConcurrent", 20))
            self._sem = asyncio.Semaphore(max_conc)

            self._slots.clear()
            for p in profiles:
                slot_id = p.get("id") or p.get("profileId") or str(uuid.uuid4())
                slot = RecycleSlot(
                    slot_id=slot_id,
                    profile_name=p.get("name") or p.get("profileName") or f"Profile-{slot_id[-4:]}",
                    browser_type=p.get("browserType", "multilogin"),
                    proxy_type=p.get("proxyType", "none"),
                    os=p.get("os", "Windows"),
                    current_profile_id=slot_id,
                    status="queued",
                )
                self._slots[slot_id] = slot
                task = asyncio.create_task(
                    self._slot_loop(slot),
                    name=f"recycle-{slot_id[-6:]}",
                )
                self._slot_tasks[slot_id] = task

            self._save_recycle_state()
            self._log_fn(
                "success",
                "recycle",
                f"24/7 loop started — {len(self._slots)} slot(s), cooldown {min_min}–{max_min} min",
            )
            return self.get_status()

    async def restore(self, saved: dict) -> None:
        """Resume loop after server restart if it was enabled."""
        if not saved.get("enabled"):
            return
        profiles = saved.get("profiles") or []
        if not profiles:
            return
        try:
            await self.start({
                "profiles": profiles,
                "cooldownMinMinutes": saved.get("cooldownMinMinutes", 10),
                "cooldownMaxMinutes": saved.get("cooldownMaxMinutes", 30),
            })
            if saved.get("paused"):
                await self.pause()
            self._log_fn("info", "recycle", "24/7 loop restored after server restart")
        except Exception as e:
            log.error("Recycle restore failed: %s", e)

    async def stop(
        self,
        slot_id: Optional[str] = None,
        profile_id: Optional[str] = None,
    ) -> dict:
        async with self._lock:
            if slot_id or profile_id:
                target = None
                for sid, slot in self._slots.items():
                    if slot_id and sid == slot_id:
                        target = sid
                        break
                    if profile_id and (
                        slot.current_profile_id == profile_id or sid == profile_id
                    ):
                        target = sid
                        break
                if target:
                    await self._stop_slot(target)
                    self._save_recycle_state()
                    return self.get_status()

            await self._stop_internal(clear_state=True)
            self._log_fn("info", "recycle", "24/7 loop stopped")
            return self.get_status()

    async def pause(self) -> dict:
        self._paused = True
        for slot in self._slots.values():
            if slot.enabled and slot.status not in ("stopped", "error"):
                slot.is_paused = True
                if slot.status == "running":
                    slot.status = "paused"
        self._save_recycle_state()
        self._log_fn("info", "recycle", "24/7 loop paused")
        return self.get_status()

    async def resume(self) -> dict:
        self._paused = False
        for slot in self._slots.values():
            slot.is_paused = False
            if slot.status == "paused":
                slot.status = "queued"
        self._save_recycle_state()
        self._log_fn("info", "recycle", "24/7 loop resumed")
        return self.get_status()

    async def _stop_internal(self, clear_state: bool) -> None:
        for sid in list(self._slot_tasks.keys()):
            await self._stop_slot(sid, disable=False)
        self._slot_tasks.clear()
        if clear_state:
            self._enabled = False
            self._paused = False
            self._slots.clear()
            try:
                data = self._load_json(self._recycle_file, {})
                data["enabled"] = False
                data["status"] = "stopped"
                data["slots"] = []
                tmp = self._recycle_file.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
                tmp.replace(self._recycle_file)
            except Exception:
                pass

    async def _stop_slot(self, slot_id: str, disable: bool = True) -> None:
        task = self._slot_tasks.pop(slot_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=8.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass
        slot = self._slots.get(slot_id)
        if slot:
            if disable:
                slot.enabled = False
            slot.status = "stopped"
            slot.cooldown_until = None
            slot.current_video = ""

    async def _slot_loop(self, slot: RecycleSlot) -> None:
        slot_id = slot.slot_id
        try:
            while self._enabled and slot.enabled:
                if self._paused or slot.is_paused:
                    slot.status = "paused"
                    await asyncio.sleep(2.0)
                    continue

                videos = self._get_assignment_videos(slot.current_profile_id)
                slot.video_count = len(videos)

                if not videos:
                    slot.status = "needs_attention"
                    slot.last_error = "No videos assigned — shuffle first on Video Shuffle page"
                    self._save_recycle_state()
                    await asyncio.sleep(self.NO_VIDEOS_RETRY_SEC)
                    continue

                slot.status = "starting"
                slot.last_error = None
                self._save_recycle_state()

                try:
                    sem = self._sem
                    if sem is None:
                        sem = asyncio.Semaphore(20)
                    async with sem:
                        ok = await self._run_cycle(slot, videos)
                    if ok:
                        slot.consecutive_errors = 0
                        slot.cycle_count += 1
                    else:
                        slot.consecutive_errors += 1
                        if slot.consecutive_errors >= self.MAX_CONSECUTIVE_ERRORS:
                            slot.status = "error"
                            slot.last_error = slot.last_error or "Too many consecutive failures"
                            self._log_fn(
                                "error",
                                "recycle",
                                f"[{slot.profile_name}] Stopped after {self.MAX_CONSECUTIVE_ERRORS} errors",
                            )
                            slot.enabled = False
                            break
                        await asyncio.sleep(self.ERROR_RETRY_SEC)
                        continue
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    slot.consecutive_errors += 1
                    slot.last_error = str(e)
                    slot.status = "error"
                    self._log_fn("error", "recycle", f"[{slot.profile_name}] Cycle error: {e}")
                    self._save_recycle_state()
                    if slot.consecutive_errors >= self.MAX_CONSECUTIVE_ERRORS:
                        slot.enabled = False
                        break
                    await asyncio.sleep(self.ERROR_RETRY_SEC)
                    continue

                if not self._enabled or not slot.enabled:
                    break

                # Cooldown before next cycle
                cooldown_ms = random.randint(
                    self._cooldown_min_ms,
                    self._cooldown_max_ms,
                )
                slot.status = "cooldown"
                slot.cooldown_until = int(time.time() * 1000) + cooldown_ms
                slot.current_video = ""
                self._save_recycle_state()

                self._log_fn(
                    "info",
                    "recycle",
                    f"[{slot.profile_name}] Cycle {slot.cycle_count} done — cooldown {cooldown_ms // 60_000}m",
                )

                deadline = time.time() + cooldown_ms / 1000.0
                while time.time() < deadline:
                    if not self._enabled or not slot.enabled:
                        break
                    if self._paused or slot.is_paused:
                        slot.status = "paused"
                        await asyncio.sleep(2.0)
                        continue
                    remaining = int((deadline - time.time()) * 1000)
                    slot.cooldown_until = int(time.time() * 1000) + max(0, remaining)
                    await asyncio.sleep(min(5.0, max(0.5, remaining / 1000.0)))

                slot.cooldown_until = None
                slot.status = "queued"

        except asyncio.CancelledError:
            slot.status = "stopped"
            raise
        finally:
            slot.current_video = ""
            self._save_recycle_state()

    async def _run_cycle(self, slot: RecycleSlot, videos: list[dict]) -> bool:
        from server_python.agent_manager import YouTubeAgent
        from server_python.providers.morelogin import MoreLoginProvider
        from server_python.providers.multilogin import MultiloginProvider

        settings = self._load_shuffle_settings()
        profile_id = slot.current_profile_id
        provider = None
        agent = None
        videos_ok = 0

        def _slot_log(msg: str):
            log.info("[Recycle][%s] %s", profile_id[:8], msg)

        try:
            slot.status = "running"
            browser_type = slot.browser_type or "multilogin"
            provider = (
                MultiloginProvider() if browser_type == "multilogin"
                else MoreLoginProvider()
            )

            start_res = await provider.start_profile(profile_id)
            if start_res.get("code") != 0:
                raise RuntimeError(
                    f"Browser start failed: {start_res.get('message', 'unknown')}"
                )

            cdp_port = start_res.get("data", {}).get("cdpPort")
            cdp_endpoint = start_res.get("data", {}).get(
                "cdpEndpoint", f"http://127.0.0.1:{cdp_port}"
            )
            if not cdp_port:
                raise RuntimeError("No CDP port returned by provider")

            agent_settings = {"videoQuality": settings.get("videoQuality", "auto")}
            agent = YouTubeAgent(
                profile_id,
                cdp_port,
                agent_settings,
                log_fn=_slot_log,
            )
            await agent.connect_cdp(cdp_endpoint)
            await agent.warm_up()

            watch_min = max(1, min(100, int(settings.get("watchTimeMin", 90))))
            watch_max = max(watch_min, min(100, int(settings.get("watchTimeMax", 100))))

            # ── Per-profile config (like/subscribe/comment/bell/etc) ──────────
            pcfg = self._load_profile_config(profile_id)

            # Resolve comment text — template id → text
            comment_text = ""
            if pcfg.get("commentEnabled") and pcfg.get("commentText"):
                comment_text = str(pcfg.get("commentText", "")).strip()
            elif pcfg.get("commentEnabled") and pcfg.get("commentTemplateId"):
                templates = self._load_json(self._root / "comments_data.json", {}).get("comments", [])
                tid = str(pcfg.get("commentTemplateId", ""))
                t = next((x for x in templates if str(x.get("id")) == tid), None)
                if t and t.get("text"):
                    comment_text = str(t["text"]).strip()

            # ── Traffic source — sample per cycle (per-profile mix → global fallback) ──
            traffic_src = self._pick_traffic_source(settings, pcfg)

            engagement = {
                # Engagement actions — from per-profile config (no more hardcoded False!)
                "like":              bool(pcfg.get("likeEnabled", False)),
                "dislike":           bool(pcfg.get("dislikeEnabled", False)),
                "subscribe":         bool(pcfg.get("subscribeEnabled", False)),
                "bell":              bool(pcfg.get("bellEnabled", False)),
                "comment":           bool(pcfg.get("commentEnabled", False)),
                "commentText":       comment_text,
                "descriptionLinks":  bool(pcfg.get("descriptionLinks", settings.get("descriptionLinks", False))),
                "descriptionExpand": bool(pcfg.get("descriptionExpand", settings.get("descriptionExpand", True))),
                # Playback — per-profile overrides global
                "videoQuality":      pcfg.get("videoQuality", settings.get("videoQuality", "auto")),
                "adSkipEnabled":     bool(pcfg.get("adSkipEnabled", settings.get("adSkipEnabled", True))),
                "adSkipDelaySec":    int(pcfg.get("adSkipAfterSec", settings.get("adSkipAfterSec", 5))),
                "adSkipDelayMaxSec": int(pcfg.get("adSkipAfterSec", settings.get("adSkipAfterSec", 5))) + 10,
                "volumePct":         int(pcfg.get("volumePct", settings.get("volumePct", 75))),
                # Human behavior
                "seekEnabled":       bool(pcfg.get("seekEnabled", settings.get("seekEnabled", True))),
                "seekDirection":     pcfg.get("seekDirection", settings.get("seekDirection", "forward")),
                "pauseProbability":  float(pcfg.get("pauseProbability", settings.get("pauseProbability", 0.12))),
                "uniqueTypingPersonality": settings.get("uniqueTypingPersonality", True),
                "naturalScrollCurves":     settings.get("naturalScrollCurves", True),
                # Traffic source for this cycle
                "trafficSource":     traffic_src,
            }

            _slot_log(
                f"Cycle config | source={traffic_src} like={engagement['like']} sub={engagement['subscribe']} "
                f"comment={engagement['comment']} bell={engagement['bell']} quality={engagement['videoQuality']}"
            )

            cycle_nonce = f"recycle-{slot.slot_id}-c{slot.cycle_count + 1}-{int(time.time())}"

            for i, video in enumerate(videos):
                if not self._enabled or not slot.enabled or self._paused:
                    break

                url = video.get("url") or ""
                title = video.get("title") or ""
                ch = video.get("channelName") or video.get("channel", "")

                m = re.search(r"[?&]v=([^&]+)", url) or re.search(
                    r"youtu\.be/([^?&/]+)", url
                )
                raw_id = m.group(1) if m else (video.get("videoId") or "")
                video_id = str(raw_id)[:11] if raw_id else ""

                if not video_id:
                    continue

                slot.current_video = f"https://www.youtube.com/watch?v={video_id}"
                self._save_recycle_state()

                watch_pct = random.randint(watch_min, watch_max) / 100.0
                _slot_log(f"▶ Video {i + 1}/{len(videos)}: {title or video_id}")

                ok = await agent.watch_video_organic(
                    video_id=video_id,
                    title_hint=title,
                    channel_name=ch,
                    watch_pct=watch_pct,
                    engagement=engagement,
                    source="direct",
                    session_nonce=f"{cycle_nonce}|v{i}",
                )
                if ok:
                    videos_ok += 1
                else:
                    _slot_log(f"✗ Video {i + 1} watch failed")

                if i < len(videos) - 1 and self._enabled and slot.enabled:
                    gap = random.uniform(12.0, 35.0)
                    await asyncio.sleep(gap)

            slot.current_video = ""
            if videos_ok == 0:
                slot.last_error = "All videos failed in this cycle"
                return False
            return True

        finally:
            if agent:
                try:
                    await agent.close()
                except Exception:
                    pass
            if provider:
                try:
                    await provider.stop_profile(profile_id)
                except Exception:
                    pass


recycle_engine = RecycleEngine()
