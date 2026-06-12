"""
MMB AGENT 24/7 — Python Backend Server
=======================================
Node.js + Playwright ki jagah Python + nodriver.
Port 3100 pe chalta hai — React frontend same rahega.

Run: python server_python/main.py

FIXED:
  ✅ Bug #1: _trigger_schedule_run_logic defined BEFORE _trigger_schedule_run
             (was NameError crash on every timer-triggered schedule)
  ✅ Bug #2: Timer task reference saved + done callback added (was silently lost)
  ✅ Bug #3: agent = None pre-defined before try block (locals() check removed)
  ✅ Bug #4: Gmail login uses correct nodriver cdp.input_ path
  ✅ Bug #5: _append_log uses in-memory buffer + periodic disk flush (no per-call IO)
  ✅ Bug #6: run_async accepts configurable timeout param
  ✅ Bug #7: tab.url replaced with proper JS evaluate for nodriver compat
  ✅ Bug #8: uc.Browser.create() replaced with correct uc.start() API
  ✅ Bug #9: Engagement jobs trim logic fixed (no None slots)
  ✅ Bug #10: datetime imported at top level (not repeatedly inside functions)
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from threading import Thread
from typing import Any

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

# ── Load .env ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
SP = Path(__file__).resolve().parent
import sys
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(SP) not in sys.path:
    sys.path.insert(0, str(SP))
load_dotenv(ROOT / ".env")

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("mmb.server")
werkzeug_log = logging.getLogger("werkzeug")
werkzeug_log.setLevel(logging.ERROR)

# ── Flask app ────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

PORT = int(os.getenv("SERVER_PORT", os.getenv("BACKEND_PORT", 3100)))
API_KEY = os.getenv("BACKEND_API_KEY", "mmb-local-dev-2025")
SERVER_START_TIME = time.time()

# ── Data files ────────────────────────────────────────────────────────────────
WATCH_HISTORY_FILE  = ROOT / "watch_history.json"
CHANNELS_FILE       = ROOT / "channels_data.json"
ACTIVITY_LOG_FILE   = ROOT / "activity_logs.json"
AGENT_STATES_FILE   = ROOT / "agent_states.json"
ANALYTICS_FILE      = ROOT / "analytics_data.json"
SCHEDULES_FILE      = ROOT / "schedules_data.json"
SHUFFLE_FILE        = ROOT / "shuffle_data.json"
RECYCLE_FILE        = ROOT / "recycle_state.json"
HEALTH_FILE         = ROOT / "health_stats.json"
COMMENTS_FILE       = ROOT / "comments_data.json"
SETTINGS_FILE       = ROOT / "user-settings.json"
TIMERS_FILE         = ROOT / "timers_active.json"
NOTIFICATION_HUB_FILE = ROOT / "notification_hub_plans.json"
COOKIES_POOL_FILE   = ROOT / "cookies_pool.json"
BACKLINKS_FILE      = ROOT / "backlinks_data.json"

# ── Helper: load / save JSON ──────────────────────────────────────────────────
def _load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}

def _save(path: Path, data):
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except Exception as e:
        print(f"[Save Error] Failed to save {path}: {e}")

# ── In-memory state ───────────────────────────────────────────────────────────
_workers: dict[str, dict] = {}          # profileId → worker status
_engagement_jobs: list[dict] = []       # engagement queue
_log_lines: list[dict] = []             # live log buffer (max 2000)

# FIX #5: Log buffer for deferred disk writes (not per-call file IO)
_log_flush_buffer: list[dict] = []
_LOG_FLUSH_EVERY = 20   # flush every N entries

def _level_from_message(message: str) -> str:
    if not message:
        return "info"
    if re.search(r"error|fail|✗|crashed|❌", message, re.I):
        return "error"
    if re.search(r"✓|success|✅|done|complete", message, re.I):
        return "success"
    if re.search(r"warn|⚠|cancel", message, re.I):
        return "warn"
    return "info"

def _flush_log_buffer() -> None:
    """Write buffered log entries to disk atomically."""
    global _log_flush_buffer
    if not _log_flush_buffer:
        return
    to_write = list(_log_flush_buffer)
    _log_flush_buffer = []
    try:
        logs = _load(ACTIVITY_LOG_FILE, [])
        if not isinstance(logs, list):
            logs = []
        logs.extend(to_write)
        if len(logs) > 5000:
            logs = logs[-5000:]
        _save(ACTIVITY_LOG_FILE, logs)
    except Exception as e:
        log.warning("Log flush error: %s", e)

def _append_log(
    level: str,
    source: str,
    message: str,
    *,
    profile_id: str | None = None,
    profile_name: str | None = None,
):
    """
    Append a log entry to in-memory buffer and periodic disk flush.
    FIX #5: Was doing file read+write on EVERY call — race condition + slow.
    Now buffers in memory and flushes every _LOG_FLUSH_EVERY entries.
    """
    entry = {
        "id": str(uuid.uuid4())[:8],
        "level": level,
        "source": source,
        "message": message,
        "timestamp": int(time.time() * 1000),
        "profileId": profile_id,
        "profileName": profile_name,
    }
    _log_lines.append(entry)
    if len(_log_lines) > 2000:
        del _log_lines[:-2000]

    # Buffer for disk write
    _log_flush_buffer.append(entry)
    if len(_log_flush_buffer) >= _LOG_FLUSH_EVERY:
        _flush_log_buffer()

def _normalize_log_entry(raw: dict) -> dict:
    ts = raw.get("timestamp")
    if isinstance(ts, str):
        try:
            dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            ts = int(dt.timestamp() * 1000)
        except Exception:
            ts = int(time.time() * 1000)
    elif not isinstance(ts, (int, float)):
        ts = int(time.time() * 1000)
    return {
        "id": raw.get("id") or str(uuid.uuid4())[:8],
        "level": raw.get("level", "info"),
        "source": raw.get("source", "system"),
        "message": raw.get("message", ""),
        "timestamp": int(ts),
        "profileId": raw.get("profileId") or raw.get("profile_id"),
        "profileName": raw.get("profileName") or raw.get("profile_name"),
    }

# ── Async event loop (runs in background thread) ──────────────────────────────
_loop = asyncio.new_event_loop()

def _start_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_forever()

Thread(target=_start_loop, args=(_loop,), daemon=True).start()

# FIX #6: run_async accepts configurable timeout
def run_async(coro, timeout: float = 60.0):
    """Run coroutine in background asyncio loop, return result synchronously."""
    fut = asyncio.run_coroutine_threadsafe(coro, _loop)
    return fut.result(timeout=timeout)

# ── Import agent manager ──────────────────────────────────────────────────────
from server_python.agent_manager import AgentManager
from server_python.providers.morelogin import MoreLoginProvider
from server_python.providers.multilogin import MultiloginProvider

_agent_manager = AgentManager()
_agent_manager.set_loop(_loop)

# ── Timer background task ─────────────────────────────────────────────────────
_timers: list[dict] = []
# FIX #2: Keep reference so task is not GC'd
_timer_task: asyncio.Task | None = None

def _load_timers():
    global _timers
    _timers = _load(TIMERS_FILE, [])

def _save_timers():
    _save(TIMERS_FILE, _timers)

def _repeat_interval_ms(timer: dict) -> int:
    """
    Resolve timer repeat interval in ms.
    Supports both frontend schedule shape (repeatEnabled + repeatInterval)
    and legacy timer-level 'repeat' field (none/daily/weekly).
    Returns 0 when not repeating.
    """
    schedule = timer.get("schedule", {}) or {}
    if schedule.get("repeatEnabled"):
        interval_map = {
            "1hr":  1  * 60 * 60 * 1000,
            "3hr":  3  * 60 * 60 * 1000,
            "6hr":  6  * 60 * 60 * 1000,
            "12hr": 12 * 60 * 60 * 1000,
            "24hr": 24 * 60 * 60 * 1000,
        }
        return interval_map.get(schedule.get("repeatInterval", "6hr"), 6 * 60 * 60 * 1000)
    repeat = timer.get("repeat", "none")
    if repeat == "daily":
        return 24 * 60 * 60 * 1000
    if repeat == "weekly":
        return 7 * 24 * 60 * 60 * 1000
    return 0

# ══════════════════════════════════════════════════════════════════════════════
# FIX #1: _trigger_schedule_run_logic MUST be defined BEFORE _trigger_schedule_run
# Previously it was defined ~120 lines AFTER being called → NameError crash
# ══════════════════════════════════════════════════════════════════════════════

def _trigger_schedule_run_logic(schedule: dict) -> dict:
    """
    Internal logic to trigger a schedule run.
    Returns: { "spawned": int, "skipped": int, "error": str|None,
               "trimmed": bool, "limit": int }
    """
    from server_python.worker_manager import worker_manager
    import random as _random

    selected_profiles = schedule.get("selectedProfiles", [])
    if not selected_profiles:
        return {"spawned": 0, "skipped": 0, "error": "selectedProfiles required",
                "trimmed": False, "limit": 0}

    assignment_mode    = schedule.get("assignmentMode", "same-all")
    same_for_all       = schedule.get("sameForAll", [])
    per_profile_data   = schedule.get("perProfile", [])
    profile_configs    = schedule.get("profileConfigs", [])

    settings       = _load(SETTINGS_FILE, {})
    max_concurrent = int(settings.get("maxConcurrent", settings.get("ytMaxTotalAgents", 20)))
    current_stats  = worker_manager.get_stats()
    current_running = current_stats["running"]

    available = max(0, max_concurrent - current_running)
    if available <= 0:
        return {"spawned": 0, "skipped": 0,
                "error": f"Max concurrent limit reached ({max_concurrent})",
                "trimmed": False, "limit": max_concurrent}

    trimmed = False
    if len(selected_profiles) > available:
        selected_profiles = selected_profiles[:available]
        trimmed = True
        _append_log("warn", "scheduler",
                    f"Trimmed to {available} profile(s) — concurrency limit {max_concurrent}")

    spawned = 0
    skipped = 0
    skipped_watched_today = 0

    from server_python.watch_history import should_skip_video
    from server_python.worker_manager import _extract_video_id

    allow_same_day = bool(schedule.get("allowSameDayRepeat", False))

    for i, profile_id in enumerate(selected_profiles):
        videos = []
        if assignment_mode == "same-all":
            for cs in same_for_all:
                for v in cs.get("videos", []):
                    videos.append({**v, "channelName": cs.get("channelName", "")})
        else:
            pa = next(
                (p for p in per_profile_data if p.get("profileId") == profile_id), None
            )
            if pa:
                for cs in pa.get("channelSelections", []):
                    for v in cs.get("videos", []):
                        videos.append({**v, "channelName": cs.get("channelName", "")})

        if not videos:
            skipped += 1
            _append_log("warn", "scheduler", f"Profile {profile_id[-6:]} skipped — no videos")
            continue

        playable = []
        for v in videos:
            vid = _extract_video_id(v)
            if vid and should_skip_video(profile_id, vid, allow_same_day):
                continue
            playable.append(v)

        if not playable:
            skipped += 1
            skipped_watched_today += 1
            _append_log(
                "warn", "scheduler",
                f"Profile {profile_id[-6:]} skipped — sab videos aaj watched (profile open nahi)",
            )
            continue

        pc = next((p for p in profile_configs if p.get("profileId") == profile_id), {})
        max_vids = int(
            pc.get("videosPerProfile")
            or pc.get("maxVideosPerSession")
            or len(playable)
        )
        videos = playable[:max(1, max_vids)]

        _ad_max = int(
            pc.get("adSkipMaxSec")
            or pc.get("adSkipAfterSec")
            or pc.get("adSkipDelayMaxSec")
            or settings.get("adSkipMaxSec")
            or settings.get("adSkipAfterSec")
            or 60
        )
        from server_python.action_registry import sanitize_config
        config = sanitize_config({
            "browserType":          pc.get("browserType", settings.get("browserProvider", "multilogin")),
            "watchTimeMin":         int(pc.get("watchTimeMin", settings.get("ytWatchTimeMin", 40))),
            "watchTimeMax":         int(pc.get("watchTimeMax", settings.get("ytWatchTimeMax", 100))),
            "tabDelayMin":          int(schedule.get("tabDelayMin", 30)),
            "tabDelayMax":          int(schedule.get("tabDelayMax", 120)),
            "trafficPreference":    pc.get("trafficPreference", "custom"),
            "likeEnabled":          pc.get("likeEnabled", False),
            "subscribeEnabled":     pc.get("subscribeEnabled", False),
            "commentEnabled":       pc.get("commentEnabled", False),
            "bellEnabled":          pc.get("bellEnabled", False),
            "dislikeEnabled":       pc.get("dislikeEnabled", False),
            "descriptionLinks":     pc.get("descriptionLinks", False),
            "descriptionLinkUrl":   str(pc.get("descriptionLinkUrl", "") or ""),
            "descriptionLinkVisitSec": int(pc.get("descriptionLinkVisitSec", 120)),
            "descriptionExpand":    pc.get("descriptionExpand", True),
            "descriptionCollapse":  pc.get("descriptionCollapse", True),
            "commentLikeEnabled":   pc.get("commentLikeEnabled", False),
            "commentLikePct":       float(pc.get("commentLikePct", 100 if pc.get("commentLikeEnabled") else 0)),
            "commentText":          pc.get("commentText", ""),
            "videoQuality":         pc.get("videoQuality", settings.get("ytVideoQuality", "auto")),
            # volumePct sirf explicitly set ho to — warna None (volumeMin..Max range chalegi)
            "volumePct":            int(pc["volumePct"]) if pc.get("volumePct") is not None else None,
            "volumeMin":            int(pc.get("volumeMin") or pc.get("volumePct") or 60),
            "volumeMax":            int(pc.get("volumeMax") or pc.get("volumePct") or 80),
            "adSkipEnabled":        pc.get("adSkipEnabled", True),
            "adSkipAfterSec":       _ad_max,
            "adSkipMaxSec":         _ad_max,
            "adSkipDelaySec":       int(pc.get("adSkipDelaySec") or min(10, _ad_max)),
            "adSkipDelayMaxSec":    _ad_max,
            "midRollAdWaitSec":     int(pc.get("midRollAdWaitSec", 10)),
            "adClickEnabled":       bool(pc.get("adClickEnabled", False)),
            "adClickDelayMinSec":   int(pc.get("adClickDelayMinSec", 10)),
            "adClickDelayMaxSec":   int(pc.get("adClickDelayMaxSec", 15)),
            "adClickVisitSec":      int(pc.get("adClickVisitSec", 20)),
            "videosPerProfile":     max_vids,
            "maxVideosPerSession":  max_vids,
            "seekEnabled":          pc.get("seekEnabled", True),
            "seekDirection":        pc.get("seekDirection", "forward"),
            "pauseProbability":     float(pc.get("pauseProbability", 0.05)),
            "uniqueTypingPersonality": pc.get("uniqueTypingPersonality", True),
            "naturalScrollCurves":  pc.get("naturalScrollCurves", True),
            "scrollActivity":       pc.get("scrollActivity", True),
            "qualityChange":        pc.get("qualityChange", pc.get("qualityChangeEnabled", True)),
            "playbackSpeed":        pc.get("playbackSpeed", "1x"),
            "speedChange":          pc.get("speedChange", False),
            "captionsEnabled":      bool(pc.get("captionsEnabled", pc.get("captionsToggle", False))),
            "captionsToggle":       bool(pc.get("captionsToggle", pc.get("captionsEnabled", False))),
            "honestTest":           pc.get("honestTest", False),
            "trafficSource":        pc.get("trafficSource", "direct"),
            "srcNotificationPct":   int(pc.get("srcNotificationPct", 20)),
            "srcSearchPct":         int(pc.get("srcSearchPct", 30)),
            "srcHomepagePct":       int(pc.get("srcHomepagePct", 20)),
            "srcGooglePct":         int(pc.get("srcGooglePct", 12)),
            "srcBingPct":           int(pc.get("srcBingPct", 8)),
            "srcChannelDiscPct":    int(pc.get("srcChannelDiscPct", 10)),
            "ownChannelNames":      schedule.get("ownChannelNames")
                                    or pc.get("ownChannelNames")
                                    or [],
            "relatedVideoEnabled":  pc.get(
                "relatedVideoEnabled",
                schedule.get("relatedVideoEnabled", False),
            ),
            "allowSameDayRepeat": bool(schedule.get("allowSameDayRepeat", False)),
        })

        delay_min   = int(schedule.get("profileDelayMin", 5))
        delay_max   = int(schedule.get("profileDelayMax", 20))
        start_delay = _random.randint(delay_min, delay_max) + (i * 3)
        profile_name = f"Profile-{profile_id[-4:]}"

        asyncio.run_coroutine_threadsafe(
            worker_manager.start_worker(profile_id, profile_name, videos, config, start_delay),
            _loop,
        )
        spawned += 1

    schedule_name = schedule.get("name", "Schedule")
    skip_note = ""
    if skipped:
        skip_note = f", {skipped} skipped"
        if skipped_watched_today:
            skip_note += f" ({skipped_watched_today} aaj watched)"
    _append_log("success", "scheduler",
                f'Started "{schedule_name}" — {spawned} worker(s) spawned{skip_note}')

    return {"spawned": spawned, "skipped": skipped, "error": None,
            "trimmed": trimmed, "limit": max_concurrent}


def _trigger_schedule_run(schedule_data: dict) -> None:
    """
    Internal trigger for a scheduled (fixed-time) run.
    FIX #1: Now calls _trigger_schedule_run_logic which is defined ABOVE this function.
    """
    if not schedule_data:
        print("[Timer] _trigger_schedule_run called with empty schedule — skipped")
        return
    try:
        result = _trigger_schedule_run_logic(schedule_data)
        if result["error"]:
            print(f"[Timer] Schedule '{schedule_data.get('name')}' did not run: {result['error']}")
        else:
            print(f"[Timer] Schedule '{schedule_data.get('name')}' started — "
                  f"{result['spawned']} worker(s) spawned, {result['skipped']} skipped")
    except Exception as e:
        print(f"[Timer] _trigger_schedule_run failed: {e}")


async def _timer_checker_loop() -> None:
    """Background loop to check if any timer is due."""
    while True:
        try:
            now_ms = int(time.time() * 1000)
            due_timers = [
                t for t in _timers
                if t.get("nextRun", 0) <= now_ms and t.get("status") == "active"
            ]
            for t in due_timers:
                print(f"[Timer] Triggering schedule: {t.get('name')} (id: {t.get('id')})")
                _trigger_schedule_run(t.get("schedule", {}))

                interval_ms = _repeat_interval_ms(t)
                if interval_ms > 0:
                    next_run = t.get("nextRun", now_ms)
                    while next_run <= now_ms:
                        next_run += interval_ms
                    t["nextRun"] = next_run
                else:
                    t["status"] = "completed"

            if due_timers:
                _save_timers()

            # Notification Hub — daily time slots (e.g. 09:00, 14:00, 18:00)
            try:
                from server_python.notification_hub import (
                    check_due_plans,
                    load_plans,
                    save_plans,
                )
                hub_plans = load_plans(NOTIFICATION_HUB_FILE)
                if hub_plans:
                    def _save_hub_plans(plans: list) -> None:
                        save_plans(NOTIFICATION_HUB_FILE, plans)

                    def _fleet_bc(ids: list, path: str, payload: dict) -> dict:
                        from server_python import fleet_manager
                        return fleet_manager.broadcast(ids, path, payload)

                    check_due_plans(
                        hub_plans,
                        trigger_schedule_fn=_trigger_schedule_run_logic,
                        fleet_broadcast_fn=_fleet_bc,
                        log_fn=_append_log,
                        save_fn=_save_hub_plans,
                    )
            except Exception as hub_err:
                log.debug("[NotificationHub] slot check: %s", hub_err)

            # Mastermind plan executor — due slots → real workers
            if _MASTERMIND_OK:
                try:
                    from server_python.worker_manager import worker_manager as _wm

                    def _mastermind_spawn(pid, pname, videos, cfg, delay):
                        asyncio.run_coroutine_threadsafe(
                            _wm.start_worker(pid, pname, videos, cfg, delay),
                            _loop,
                        )

                    await _mastermind_exec_tick(
                        _wm,
                        _load(SETTINGS_FILE, {}),
                        _mastermind_spawn,
                        log_fn=_append_log,
                    )
                    _mastermind_check_scheduled(log_fn=_append_log)
                except Exception as mm_err:
                    log.debug("[Mastermind] executor tick: %s", mm_err)

        except Exception as e:
            print(f"[Timer Error] {e}")

        await asyncio.sleep(30)


def _start_timer_loop() -> None:
    """
    FIX #2: Create timer task with reference saved + done callback.
    Was: lambda: asyncio.create_task(...) — task lost, exceptions swallowed.
    """
    global _timer_task

    async def _create_and_store():
        global _timer_task
        task = asyncio.create_task(_timer_checker_loop(), name="timer_checker")
        _timer_task = task

        def _on_timer_done(t: asyncio.Task):
            if t.cancelled():
                return
            exc = t.exception()
            if exc:
                log.error("[Timer] timer_checker_loop crashed: %s", exc)
                # Auto-restart
                _start_timer_loop()

        task.add_done_callback(_on_timer_done)

    _loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_create_and_store()))


# ── Load settings + init engines ──────────────────────────────────────────────
def _load_settings_to_env() -> None:
    try:
        s = _load(SETTINGS_FILE, {})
        if not s:
            return
        _env_map = {
            "multiloginToken":    "MULTILOGIN_TOKEN",
            "multiloginEmail":    "MULTILOGIN_EMAIL",
            "multiloginPassword": "MULTILOGIN_PASSWORD",
            "multiloginFolderId": "MULTILOGIN_FOLDER_ID",
            "moreloginApiKey":    "MORELOGIN_API_KEY",
            "moreloginPort":      "MORELOGIN_PORT",
            "proxyServer":        "PROXY_SERVER",
            "proxyPort":          "PROXY_PORT",
            "proxyPassword":      "PROXY_PASSWORD",
            "proxyPrefix":        "PROXY_PREFIX",
            "defaultProxyLife":   "DEFAULT_PROXY_LIFE",
            "browserProvider":    "BROWSER_PROVIDER",
            "anthropicApiKey":    "ANTHROPIC_API_KEY",
        }
        for key, env_key in _env_map.items():
            val = s.get(key)
            if val is not None and str(val).strip():
                os.environ[env_key] = str(val)
        log.info("Settings loaded from user-settings.json into env vars")
        try:
            from server_python.smart_proxy import reset_proxy_manager
            reset_proxy_manager()
        except Exception:
            pass
    except Exception as e:
        log.warning("_load_settings_to_env error (non-fatal): %s", e)


_load_settings_to_env()

if "proxy.smartproxy" in os.getenv("PROXY_SERVER", "").lower():
    os.environ["PROXY_SERVER"] = "us.smartproxy.net"
    log.warning("PROXY_SERVER corrected: proxy.smartproxy.net → us.smartproxy.net")


def _init_recycle_engine():
    from server_python.recycle_engine import recycle_engine
    recycle_engine.configure(_loop, log_fn=_append_log, root=ROOT)
    saved = _load(RECYCLE_FILE, {})
    if saved.get("enabled"):
        asyncio.run_coroutine_threadsafe(recycle_engine.restore(saved), _loop)


def _configure_worker_logging():
    from server_python.worker_manager import worker_manager

    def _worker_activity_log(level, source, message, profile_id=None, profile_name=None):
        _append_log(level, source, message, profile_id=profile_id, profile_name=profile_name)

    worker_manager.configure(activity_log_fn=_worker_activity_log)


_init_recycle_engine()
_configure_worker_logging()

# Mastermind — load before timer loop (executor tick uses _MASTERMIND_OK)
_MASTERMIND_OK = False
try:
    from mastermind_store import get_state as _mastermind_get_state
    from mastermind_store import save_campaign as _mastermind_save_campaign
    from mastermind_store import save_plan as _mastermind_save_plan
    from mastermind_store import list_scheduled_plans as _mastermind_list_scheduled
    from mastermind_store import save_scheduled_plan as _mastermind_save_scheduled
    from mastermind_store import delete_scheduled_plan as _mastermind_delete_scheduled
    from mastermind_executor import (
        get_execution_status as _mastermind_exec_status,
        start_execution as _mastermind_exec_start,
        stop_execution as _mastermind_exec_stop,
        tick_execution as _mastermind_exec_tick,
        check_scheduled_plans as _mastermind_check_scheduled,
    )
    _MASTERMIND_OK = True
except Exception as _mm_import_err:
    log.warning("Mastermind store not loaded: %s", _mm_import_err)

# Load timers + start background loop
_load_timers()
_start_timer_loop()   # FIX #2: proper task creation with reference + callback

# ── Auth middleware ───────────────────────────────────────────────────────────
@app.before_request
def _check_auth():
    if request.method == "OPTIONS":
        return
    if request.path in ("/api/health", "/api/cookies/status"):
        return
    key = (
        request.headers.get("x-api-key")
        or request.headers.get("X-MMB-Token")
        or request.args.get("api_key")
    )
    # Accept the env/default key OR this laptop's generated fleet agent key,
    # so other laptops (controllers) can connect with the generated key.
    valid = {API_KEY}
    try:
        from server_python.fleet_manager import get_agent_key
        valid.add(get_agent_key())
    except Exception:
        pass
    if key not in valid:
        return jsonify({"error": "Unauthorized"}), 401

# ══════════════════════════════════════════════════════════════════════════════
# HEALTH
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/health")
def api_health():
    from server_python.worker_manager import worker_manager
    w_stats = worker_manager.get_stats()
    schedules_data = _load(SCHEDULES_FILE, {"schedules": []})
    if isinstance(schedules_data, list):
        schedule_list = schedules_data
    elif isinstance(schedules_data, dict):
        schedule_list = schedules_data.get("schedules", [])
        if not isinstance(schedule_list, list):
            schedule_list = []
    else:
        schedule_list = []
    active_schedules = sum(
        1 for s in schedule_list
        if isinstance(s, dict) and s.get("status") in ("running", "scheduled", "countdown")
    )
    eng_counts = {
        s: sum(1 for j in _engagement_jobs if j.get("status") == s)
        for s in ("pending", "running", "done", "failed", "cancelled", "partial")
    }
    try:
        recycle = _agent_manager.get_recycle_status()
    except Exception:
        recycle = _load(RECYCLE_FILE, {"enabled": False})
    settings = _load(SETTINGS_FILE, {})
    return jsonify({
        "status": "ok",
        "agents": w_stats.get("running", 0),
        "schedules": active_schedules,
        "workers": w_stats,
        "uptime": int((time.time() - SERVER_START_TIME) * 1000),
        "version": "2.0.0-py",
        "engagement": eng_counts,
        "recycleEnabled": bool(recycle.get("enabled")),
        "concurrency": {
            "limit":     int(settings.get("ytMaxTotalAgents", 6)),
            "running":   w_stats.get("running", 0),
            "available": max(0, int(settings.get("ytMaxTotalAgents", 6)) - w_stats.get("running", 0)),
        },
    })

# ══════════════════════════════════════════════════════════════════════════════
# PROFILES
# ══════════════════════════════════════════════════════════════════════════════

def _get_provider(name: str):
    n = (name or "").lower()
    if n == "multilogin":
        return MultiloginProvider(
            token=os.getenv("MULTILOGIN_TOKEN", ""),
            email=os.getenv("MULTILOGIN_EMAIL", ""),
            password=os.getenv("MULTILOGIN_PASSWORD", ""),
            folder_id=os.getenv("MULTILOGIN_FOLDER_ID", ""),
        )
    return MoreLoginProvider()

@app.route("/api/profiles/list", methods=["GET", "POST"])
def api_profiles_list():
    provider_name = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "morelogin"))
    body = request.get_json(silent=True) or {}
    page = int(body.get("pageNo", 1))
    page_size = int(body.get("pageSize", 100))
    try:
        provider = _get_provider(provider_name)
        profiles = run_async(provider.list_profiles(page, page_size))
        return jsonify({
            "code": 0,
            "message": f"Fetched {len(profiles)} profiles",
            "data": {"profiles": profiles, "total": len(profiles), "page": page, "pageSize": page_size},
        })
    except Exception as e:
        log.error("profiles/list error: %s", e)
        return jsonify({
            "code": -1, "message": str(e),
            "data": {"profiles": [], "total": 0, "page": 1, "pageSize": page_size},
        }), 200

@app.route("/api/profiles/list-all", methods=["GET", "POST"])
def api_profiles_list_all():
    body = request.get_json(silent=True) or {}
    page = int(body.get("pageNo", 1))
    page_size = int(body.get("pageSize", 100))
    provider_name = os.getenv("BROWSER_PROVIDER", "morelogin")
    try:
        provider = _get_provider(provider_name)
        profiles = run_async(provider.list_profiles(page, page_size))
        return jsonify({
            "code": 0,
            "message": f"Fetched {len(profiles)} profiles",
            "data": {"profiles": profiles, "total": len(profiles), "page": page, "pageSize": page_size},
        })
    except Exception as e:
        _append_log("error", "profiles", f"Profile list failed: {e}")
        return jsonify({"code": -1, "message": str(e), "data": {"profiles": [], "total": 0}}), 200

@app.post("/api/profiles/create")
def api_profiles_create():
    provider_name = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "morelogin"))
    body = request.get_json(silent=True) or {}
    try:
        provider = _get_provider(provider_name)
        result = run_async(provider.create_profile(body))
        _append_log("info", "profiles", f"Profile created via {provider_name}")
        return jsonify(result)
    except Exception as e:
        log.error("profiles/create error: %s", e)
        _append_log("error", "profiles", f"Profile create failed: {e}")
        return jsonify({"code": -1, "message": str(e)}), 200

@app.post("/api/profiles/start")
def api_profiles_start():
    provider_name = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "morelogin"))
    body = request.get_json(silent=True) or {}
    profile_id = body.get("profileId") or body.get("id")
    try:
        provider = _get_provider(provider_name)
        result = run_async(provider.start_profile(profile_id))
        _append_log("info", "profiles", f"Profile {profile_id} started")
        return jsonify(result)
    except Exception as e:
        log.error("profiles/start error: %s", e)
        _append_log("error", "profiles", f"Profile {profile_id} start failed: {e}")
        return jsonify({"code": -1, "message": str(e)}), 200

@app.post("/api/profiles/stop")
def api_profiles_stop():
    provider_name = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "morelogin"))
    body = request.get_json(silent=True) or {}
    profile_id = body.get("profileId") or body.get("id")
    try:
        provider = _get_provider(provider_name)
        result = run_async(provider.stop_profile(profile_id))
        _append_log("info", "profiles", f"Profile {profile_id} stopped")
        return jsonify(result)
    except Exception as e:
        _append_log("error", "profiles", f"Profile {profile_id} stop failed: {e}")
        return jsonify({"code": -1, "message": str(e)}), 200

@app.post("/api/profiles/delete")
def api_profiles_delete():
    provider_name = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "morelogin"))
    body = request.get_json(silent=True) or {}
    profile_id = body.get("profileId") or body.get("id")
    try:
        provider = _get_provider(provider_name)
        result = run_async(provider.delete_profile(profile_id))
        _append_log("info", "profiles", f"Profile {profile_id} deleted")
        return jsonify(result)
    except Exception as e:
        _append_log("error", "profiles", f"Profile {profile_id} delete failed: {e}")
        return jsonify({"code": -1, "message": str(e)}), 200

@app.get("/api/profiles/trash")
def api_profiles_trash():
    return jsonify({"code": 0, "data": {"dataList": []}})

@app.post("/api/profiles/trash/delete")
@app.post("/api/profiles/trash/empty")
def api_profiles_trash_delete():
    return jsonify({"code": 0, "message": "ok"})

# ══════════════════════════════════════════════════════════════════════════════
# WORKERS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/workers")
def api_workers():
    from server_python.worker_manager import worker_manager
    statuses = worker_manager.get_all_statuses()
    stats = worker_manager.get_stats()
    return jsonify({"workers": statuses, "stats": stats})

# ══════════════════════════════════════════════════════════════════════════════
# SCHEDULES
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/schedules")
def api_schedules_get():
    raw = _load(SCHEDULES_FILE, {"schedules": []})
    data = {"schedules": raw} if isinstance(raw, list) else raw
    if not isinstance(data.get("schedules"), list):
        data["schedules"] = []
    return jsonify(data)

@app.route("/api/schedules", methods=["POST", "PUT"])
def api_schedules_post():
    body = request.get_json(silent=True) or {}
    raw = _load(SCHEDULES_FILE, {"schedules": []})
    data = {"schedules": raw} if isinstance(raw, list) else raw
    schedules = data.get("schedules", [])
    if not isinstance(schedules, list):
        schedules = []

    if request.method == "PUT" and "schedules" in body:
        data["schedules"] = body["schedules"]
        _save(SCHEDULES_FILE, data)
        return jsonify({"success": True, "count": len(body["schedules"])})

    sid = body.get("id") or str(uuid.uuid4())
    body["id"] = sid
    existing = next((i for i, s in enumerate(schedules) if s.get("id") == sid), None)
    if existing is not None:
        schedules[existing] = body
    else:
        schedules.append(body)
    data["schedules"] = schedules
    _save(SCHEDULES_FILE, data)
    return jsonify({"success": True, "schedule": body})

@app.get("/api/schedule/timer/list")
def api_schedule_timer_list():
    return jsonify([
        {"id": t.get("id", ""), "name": t.get("name", ""),
         "nextRun": t.get("nextRun", 0), "repeat": t.get("repeat", "none")}
        for t in _timers if t.get("status") == "active"
    ])

@app.post("/api/schedule/timer/set")
def api_schedule_timer_set():
    body = request.get_json(silent=True) or {}
    schedule = body.get("schedule", {})
    sid = schedule.get("id")
    if not sid:
        return jsonify({"success": False, "error": "schedule id required"}), 400
    global _timers
    _timers = [t for t in _timers if t.get("id") != sid]
    _timers.append({
        "id": sid,
        "name": schedule.get("name", "Timer"),
        "nextRun": int(schedule.get("scheduledTime", 0)),
        "repeat": schedule.get("repeatInterval") if schedule.get("repeatEnabled") else "none",
        "status": "active",
        "schedule": schedule,
    })
    _save_timers()
    return jsonify({"success": True})

@app.post("/api/schedule/timer/cancel")
def api_schedule_timer_cancel():
    body = request.get_json(silent=True) or {}
    schedule_id = body.get("scheduleId", "")
    if not schedule_id:
        return jsonify({"success": False, "error": "scheduleId required"}), 400
    global _timers
    for t in _timers:
        if t.get("id") == schedule_id:
            t["status"] = "cancelled"
    _save_timers()
    return jsonify({"success": True})

@app.post("/api/schedule/run")
def api_schedule_run():
    body = request.get_json(silent=True) or {}
    schedule = body.get("schedule")
    if not schedule:
        return jsonify({"error": "schedule required"}), 400
    result = _trigger_schedule_run_logic(schedule)
    if result["error"]:
        status_code = 429 if "Max concurrent" in result["error"] else 400
        return jsonify({"error": result["error"]}), status_code
    return jsonify({
        "success": True,
        "workersSpawned": result["spawned"],
        "skippedNoVideos": result["skipped"],
        "trimmed": result["trimmed"],
        "limit": result["limit"],
        "message": f'Schedule started with {result["spawned"]} worker(s).',
    })

@app.post("/api/schedule/stop")
def api_schedule_stop():
    from server_python.worker_manager import worker_manager
    body = request.get_json(silent=True) or {}
    schedule_id = body.get("scheduleId", "")
    profile_ids = body.get("profileIds", [])
    if profile_ids:
        worker_manager.stop_schedule_workers(profile_ids)
    else:
        asyncio.run_coroutine_threadsafe(worker_manager.stop_all(), _loop)
    _append_log("warn", "scheduler", f"Schedule stopped | id={schedule_id}")
    return jsonify({"success": True})

@app.get("/api/notification-hub/plans")
def api_notification_hub_list():
    from server_python.notification_hub import hub_status, load_plans
    plans = load_plans(NOTIFICATION_HUB_FILE)
    return jsonify({"success": True, "plans": plans, "status": hub_status(plans)})

@app.put("/api/notification-hub/plans")
def api_notification_hub_save():
    body = request.get_json(silent=True) or {}
    plans = body.get("plans")
    if not isinstance(plans, list):
        return jsonify({"success": False, "error": "plans[] required"}), 400
    from server_python.notification_hub import save_plans
    save_plans(NOTIFICATION_HUB_FILE, plans)
    return jsonify({"success": True, "count": len(plans)})

@app.post("/api/notification-hub/run")
def api_notification_hub_run():
    body = request.get_json(silent=True) or {}
    plan_id = str(body.get("planId") or body.get("id") or "").strip()
    from server_python.notification_hub import load_plans, run_plan_now, save_plans
    plans = load_plans(NOTIFICATION_HUB_FILE)
    plan = next((p for p in plans if str(p.get("id")) == plan_id), None)
    if not plan and body.get("plan"):
        plan = body.get("plan")
    if not plan:
        return jsonify({"success": False, "error": "plan not found"}), 404

    from server_python.search_keyword_planner import enrich_video_entry
    enriched_videos = []
    for v in plan.get("videos") or []:
        if isinstance(v, str):
            v = {"url": v, "title": "", "channelName": ""}
        enriched_videos.append(enrich_video_entry(v, CHANNELS_FILE))
    plan = {**plan, "videos": enriched_videos}

    def _fleet_bc(ids: list, path: str, payload: dict) -> dict:
        from server_python import fleet_manager
        return fleet_manager.broadcast(ids, path, payload)

    result = run_plan_now(
        plan,
        trigger_schedule_fn=_trigger_schedule_run_logic,
        fleet_broadcast_fn=_fleet_bc,
        log_fn=_append_log,
    )
    if result.get("error"):
        return jsonify({"success": False, "error": result["error"]}), 400
    inner = result.get("result") or {}
    if inner.get("error"):
        return jsonify({"success": False, "error": inner["error"]}), 400
    for i, p in enumerate(plans):
        if str(p.get("id")) == str(plan.get("id")):
            plans[i] = {**p, "lastRunAt": int(time.time() * 1000)}
            break
    save_plans(NOTIFICATION_HUB_FILE, plans)
    return jsonify({"success": True, **result})

@app.get("/api/schedule/progress")
def api_schedule_progress():
    from server_python.worker_manager import worker_manager
    profile_ids_raw = request.args.get("profileIds", "")
    profile_ids = [p.strip() for p in profile_ids_raw.split(",") if p.strip()]
    raw = worker_manager.get_stats_for_profiles(profile_ids) if profile_ids else worker_manager.get_stats()
    stats = {
        "total":   raw.get("total", 0),
        "running": raw.get("running", 0),
        "done":    raw.get("done", 0),
        "error":   raw.get("error", raw.get("failed", 0)),
        "waiting": raw.get("waiting", raw.get("pending", 0)),
    }
    return jsonify({"stats": stats, **raw})

@app.get("/api/concurrency")
def api_concurrency_get():
    from server_python.worker_manager import worker_manager
    settings = _load(SETTINGS_FILE, {})
    limit = int(settings.get("maxConcurrent", settings.get("ytMaxTotalAgents", 20)))
    stats = worker_manager.get_stats()
    running = stats["running"]
    return jsonify({"limit": limit, "running": running, "available": max(0, limit - running), "workers": stats})

@app.post("/api/concurrency")
def api_concurrency_post():
    body = request.get_json(silent=True) or {}
    settings = _load(SETTINGS_FILE, {})
    settings["ytMaxTotalAgents"] = body.get("maxConcurrent", 6)
    _save(SETTINGS_FILE, settings)
    return jsonify({"success": True})

# ══════════════════════════════════════════════════════════════════════════════
# ENGAGEMENT QUEUE
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/engagement/start")
def api_engagement_start():
    body = request.get_json(silent=True) or {}
    return _engagement_start_core(body)

def _engagement_start_core(body):
    profiles_data = body.get("profiles", [])
    if not profiles_data:
        return jsonify({"code": -1, "message": "profiles required"}), 400

    global_watch_pct   = body.get("watchPct", 85)
    global_ad_skip     = body.get("adSkipEnabled", True)
    global_quality     = body.get("videoQuality", "auto")
    global_ad_delay    = body.get("adSkipDelaySec", body.get("adSkipMaxSec", 10))
    global_ad_delay_max = body.get("adSkipDelayMaxSec", body.get("adSkipMaxSec", 14))
    global_ad_click    = bool(body.get("adClickEnabled", False))
    global_ad_click_v  = int(body.get("adClickVisitSec", 20))
    global_ad_click_dmin = int(body.get("adClickDelayMinSec", 10))
    global_ad_click_dmax = int(body.get("adClickDelayMaxSec", 15))

    job_ids = []
    for p in profiles_data:
        profile_id   = p.get("profileId") or p.get("id") or ""
        profile_name = p.get("profileName") or p.get("name") or "Unknown"
        browser_type = p.get("browserType", "morelogin")
        delay_ms     = int(p.get("delayMs", 0))
        actions      = p.get("actions") or {}
        videos       = p.get("videos") or []
        watch_pct    = p.get("watchPct", global_watch_pct)
        source       = p.get("source", "direct")

        if not profile_id or not videos:
            continue

        from server_python.search_keyword_planner import enrich_video_pool
        videos = enrich_video_pool(videos, CHANNELS_FILE)
        if not videos:
            continue

        job = {
            "id":               str(uuid.uuid4()),
            "profileId":        profile_id,
            "profileName":      profile_name,
            "browserType":      browser_type,
            "status":           "pending",
            "source":           source,
            "scheduledAt":      int(time.time() * 1000) + delay_ms,
            "startedAt":        None,
            "finishedAt":       None,
            "error":            None,
            "log":              [],
            "actions":          actions,
            "videos":           videos,
            "watchPct":         watch_pct,
            "adSkipEnabled":    p.get("adSkipEnabled", global_ad_skip),
            "adSkipDelaySec":   p.get("adSkipDelaySec", global_ad_delay),
            "adSkipDelayMaxSec": p.get("adSkipDelayMaxSec", global_ad_delay_max),
            "adSkipMaxSec":     p.get("adSkipMaxSec", global_ad_delay_max),
            "adClickEnabled":   bool(
                p.get("adClickEnabled", actions.get("adClick", actions.get("adClickEnabled", global_ad_click)))
            ),
            "adClickVisitSec":  int(p.get("adClickVisitSec", global_ad_click_v)),
            "adClickDelayMinSec": int(p.get("adClickDelayMinSec", global_ad_click_dmin)),
            "adClickDelayMaxSec": int(p.get("adClickDelayMaxSec", global_ad_click_dmax)),
            "videoQuality":     global_quality,
            "videoCount":       len(videos),
            "videosOk":         0,
            "videosFailed":     0,
        }
        _engagement_jobs.append(job)
        job_ids.append(job["id"])

        # FIX #9: Trim completed jobs cleanly — no None placeholder trick
        if len(_engagement_jobs) > 200:
            completed = [
                j for j in _engagement_jobs
                if j.get("status") in ("done", "failed", "cancelled", "partial")
            ]
            running = [
                j for j in _engagement_jobs
                if j.get("status") not in ("done", "failed", "cancelled", "partial")
            ]
            # Keep all running + last 100 completed
            _engagement_jobs[:] = running + completed[-100:]

        future = asyncio.run_coroutine_threadsafe(
            _run_engagement_job(job, delay_ms / 1000.0), _loop
        )
        job["_future"] = future

    _append_log("info", "engagement", f"Queued {len(job_ids)} engagement jobs")
    return jsonify({"code": 0, "message": f"Queued {len(job_ids)} engagement jobs", "jobIds": job_ids})


async def _run_engagement_job(job: dict, delay_sec: float = 0.0):
    """
    Engagement job async runner.
    Opens browser → connects CDP → watches each video with full engagement.
    Updates job dict in-place (polled by /api/engagement/status).
    """
    import re as _re
    import random as _rand
    from server_python.agent_manager import YouTubeAgent
    from server_python.providers.morelogin import MoreLoginProvider
    from server_python.providers.multilogin import MultiloginProvider

    profile_id = job["profileId"]
    provider   = None
    # FIX #3: Pre-define agent = None so finally block never hits NameError
    agent: Any = None

    def _job_log(msg: str):
        entry = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "msg": msg}
        job["log"].append(entry)
        if len(job["log"]) > 200:
            job["log"] = job["log"][-200:]
        log.info("[Engagement][%s] %s", profile_id[:8], msg)
        _append_log(
            _level_from_message(msg), "engagement", msg,
            profile_id=profile_id, profile_name=job.get("profileName"),
        )

    try:
        if delay_sec > 0:
            _job_log(f"Starting in {delay_sec:.0f}s…")
            await asyncio.sleep(delay_sec)

        job["status"]    = "running"
        job["startedAt"] = int(time.time() * 1000)
        _job_log("Connecting to browser…")

        browser_type = job.get("browserType", "morelogin")
        provider = (
            MultiloginProvider() if browser_type == "multilogin"
            else MoreLoginProvider()
        )

        start_res = await provider.start_profile(profile_id)
        if start_res.get("code") != 0:
            raise RuntimeError(f"Browser start failed: {start_res.get('message', 'unknown error')}")

        cdp_port_raw = start_res.get("data", {}).get("cdpPort")
        if not cdp_port_raw:
            raise RuntimeError("No CDP port returned by provider")
        cdp_port     = int(cdp_port_raw)
        cdp_endpoint = start_res.get("data", {}).get(
            "cdpEndpoint", f"http://127.0.0.1:{cdp_port}"
        )
        _job_log(f"Browser open | port={cdp_port} | type={browser_type}")

        actions = job.get("actions") or {}
        agent_settings = {
            "videoQuality": job.get("videoQuality", "auto"),
            "honestTest":   actions.get("honestTest", job.get("honestTest", False)),
            "profileName":  job.get("profileName", ""),
        }
        agent = YouTubeAgent(profile_id, cdp_port, agent_settings, log_fn=_job_log)
        await agent.connect_cdp(cdp_endpoint)
        _job_log("nodriver connected ✓")
        await agent.warm_up()

        from server_python.action_registry import sanitize_engagement
        engagement = sanitize_engagement({
            "like":               actions.get("like", False),
            "dislike":            actions.get("dislike", False),
            "subscribe":          actions.get("subscribe", False),
            "bell":               actions.get("bell", False),
            "comment":            actions.get("comment", False),
            "commentText":        actions.get("commentText", ""),
            "descriptionLinks":   actions.get("descriptionLinks", False),
            "descriptionLinkUrl": str(actions.get("descriptionLinkUrl", job.get("descriptionLinkUrl", "")) or ""),
            "descriptionLinkVisitSec": int(actions.get("descriptionLinkVisitSec", job.get("descriptionLinkVisitSec", 120)) or 120),
            "descriptionExpand":  actions.get("descriptionExpand", True),
            "videoQuality":       job.get("videoQuality", "auto"),
            "adSkipEnabled":      job.get("adSkipEnabled", True),
            "adSkipDelaySec":     job.get("adSkipDelaySec", 10),
            "adSkipDelayMaxSec":  job.get("adSkipDelayMaxSec", job.get("adSkipMaxSec", 14)),
            "adSkipMaxSec":       job.get("adSkipMaxSec", job.get("adSkipDelayMaxSec", 14)),
            "adClickEnabled":     bool(job.get("adClickEnabled", False)),
            "adClickDelayMinSec": int(job.get("adClickDelayMinSec", 10)),
            "adClickDelayMaxSec": int(job.get("adClickDelayMaxSec", 15)),
            "adClickVisitSec":    int(job.get("adClickVisitSec", 20)),
            "gmailLoggedIn": bool(
                actions.get("gmailLoggedIn") or actions.get("gmailReady")
                or job.get("gmailLoggedIn") or job.get("gmailReady")
            ),
            "bellMode":         str(actions.get("bellMode", "personalized")),
            "playbackSpeed":    str(actions.get("playbackSpeed", job.get("playbackSpeed", "1x"))),
            "speedChange":      bool(actions.get("speedChange", actions.get("playbackSpeed", "1x") not in ("1x", "1", ""))),
            "captionsEnabled":  bool(actions.get("captionsEnabled", actions.get("captionsToggle", False))),
            "captionsToggle":   bool(actions.get("captionsToggle", actions.get("captionsEnabled", False))),
            # volumePct sirf explicitly set ho to — warna None (volumeMin..Max range chalegi)
            "volumePct":        actions.get("volumePct"),
            "volumeMin":        int(actions.get("volumeMin", job.get("volumeMin", 60)) or 60),
            "volumeMax":        int(actions.get("volumeMax", job.get("volumeMax", 80)) or 80),
            "commentLikeEnabled": bool(actions.get("commentLikeEnabled", False)),
            "commentLikePct":   actions.get("commentLikePct", 0),
            "seekEnabled":      actions.get("seekEnabled", True),
            "seekDirection":    actions.get("seekDirection", "forward"),
            "pauseProbability": actions.get("pauseProbability", 0.05),
            "pauseHoldSec":     actions.get("pauseHoldSec", 0),
            "uniqueTypingPersonality": bool(actions.get("uniqueTypingPersonality", True)),
            "naturalScrollCurves":     bool(actions.get("naturalScrollCurves", True)),
            "scrollActivity":   actions.get("scrollActivity", actions.get("scrollActivityEnabled", True)),
            "qualityChange":    actions.get("qualityChange", actions.get("qualityChangeEnabled", True)),
            "honestTest":       actions.get("honestTest", job.get("honestTest", False)),
            "profileName":      job.get("profileName", ""),
            "useAiComment":     actions.get("useAiComment", True),
            "comment_templates": actions.get("comment_templates") or [],
        })

        videos     = job.get("videos") or []
        watch_pct  = float(job.get("watchPct", 85)) / 100.0
        job_source = (job.get("source") or "direct").strip().lower()
        videos_ok  = 0
        videos_fail = 0

        from server_python.search_keyword_planner import enrich_video_pool
        videos = enrich_video_pool(videos, CHANNELS_FILE)
        job["videos"] = videos

        for i, video in enumerate(videos):
            if job.get("status") != "running":
                _job_log("Job stopped (cancelled or not running)")
                break

            url   = video.get("url", "")
            title = video.get("title", "")
            ch    = video.get("channelName", "")

            m = _re.search(r"[?&]v=([^&]+)", url) or _re.search(r"youtu\.be/([^?&/]+)", url)
            raw_id   = m.group(1) if m else (url.strip() if len(url.strip()) == 11 else "")
            video_id = raw_id[:11] if raw_id else ""

            if not video_id:
                videos_fail += 1
                _job_log(f"✗ Video {i+1}: invalid URL (no video_id) — {url[:60]!r}")
                continue

            source = str(video.get("trafficSource") or job_source).strip().lower() or job_source
            _job_log(f"▶ Video {i+1}/{len(videos)} [{source}]: {title or video_id}")
            job["currentVideoTitle"] = title or video_id
            job["currentVideoUrl"] = url

            try:
                ok = await agent.watch_video_organic(
                    video_id=video_id, title_hint=title, channel_name=ch,
                    watch_pct=watch_pct, engagement=engagement,
                    source=source, session_nonce=f"{job.get('id', '')}|v{i}",
                )
                if ok:
                    videos_ok += 1
                    _job_log(f"✓ Video {i+1}: watched successfully")
                else:
                    videos_fail += 1
                    _job_log(f"✗ Video {i+1}: watch failed")
            except asyncio.CancelledError:
                raise
            except Exception as ve:
                videos_fail += 1
                _job_log(f"✗ Video {i+1} error: {ve}")

            job["videosOk"]     = videos_ok
            job["videosFailed"] = videos_fail

            if i < len(videos) - 1 and job.get("status") == "running":
                gap = _rand.uniform(12.0, 35.0)
                _job_log(f"Gap {gap:.0f}s before next video…")
                await asyncio.sleep(gap)

        job["videosOk"]     = videos_ok
        job["videosFailed"] = videos_fail
        job["finishedAt"]   = int(time.time() * 1000)

        if job.get("status") == "cancelled":
            _job_log(f"Cancelled — {videos_ok} ok, {videos_fail} failed")
        elif videos_fail == 0 and videos_ok > 0:
            job["status"] = "done"
            _job_log(f"✅ All {videos_ok} video(s) done")
            _append_log("success", "engagement", f"[{profile_id[:8]}] Job complete ({videos_ok} videos)")
        elif videos_ok == 0:
            job["status"] = "failed"
            job["error"]  = job.get("error") or f"All {videos_fail} video(s) failed"
            _job_log(f"❌ All videos failed ({videos_fail})")
            _append_log("error", "engagement", f"[{profile_id[:8]}] Job failed — 0 videos watched")
        else:
            job["status"] = "partial"
            job["error"]  = f"{videos_ok} ok, {videos_fail} failed"
            _job_log(f"⚠ Partial: {videos_ok} ok, {videos_fail} failed")
            _append_log("warn", "engagement", f"[{profile_id[:8]}] Partial ({videos_ok}/{videos_ok+videos_fail})")

    except asyncio.CancelledError:
        job["status"] = "cancelled"
        raise
    except Exception as e:
        job["status"]     = "failed"
        job["error"]      = str(e)
        job["finishedAt"] = int(time.time() * 1000)
        _job_log(f"❌ Error: {e}")
        _append_log("error", "engagement", f"[{profile_id[:8]}] Job failed: {e}")
    finally:
        profile_stopped = False
        # FIX #3: agent pre-defined as None above — no NameError possible
        try:
            if agent is not None:
                await agent.close()
        except Exception:
            pass
        if provider:
            try:
                await provider.stop_profile(profile_id)
                profile_stopped = True
            except Exception as stop_exc:
                _job_log(f"Profile stop error: {stop_exc}")
        try:
            from server_python.behavior.youtube.action_audit import ActionAudit
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    "profile_close",
                    selector_used="MoreLogin stop_profile / agent.close()",
                    click_registered=profile_stopped,
                    verified=profile_stopped,
                    reason="browser closed" if profile_stopped else "stop failed",
                )
                path = audit.save()
                ActionAudit.disable()
                _job_log(f"[AUDIT] truth table → {path}")
        except Exception:
            pass
        # Flush any buffered logs on job completion
        _flush_log_buffer()


@app.get("/api/engagement/status")
def api_engagement_status():
    counts = {
        s: sum(1 for j in _engagement_jobs if j.get("status") == s)
        for s in ("pending", "running", "done", "failed", "cancelled", "partial")
    }
    safe_jobs = [{k: v for k, v in j.items() if not k.startswith("_")} for j in _engagement_jobs]
    return jsonify({"code": 0, "data": {"jobs": safe_jobs, "total": len(_engagement_jobs), **counts}})

@app.post("/api/engagement/cancel")
def api_engagement_cancel():
    cancelled_count = 0
    for job in _engagement_jobs:
        if job.get("status") in ("pending", "running"):
            job["status"] = "cancelled"
            cancelled_count += 1
            future = job.get("_future")
            if future and not future.done():
                future.cancel()
    _append_log("warn", "engagement", f"Cancelled {cancelled_count} engagement jobs")
    return jsonify({"code": 0, "cancelled": cancelled_count})

@app.post("/api/engagement/clear")
def api_engagement_clear():
    for job in _engagement_jobs:
        future = job.get("_future")
        if future and not future.done():
            future.cancel()
    count = len(_engagement_jobs)
    _engagement_jobs.clear()
    return jsonify({"code": 0, "cleared": count})

# ══════════════════════════════════════════════════════════════════════════════
# PROFILE RECYCLING
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/recycle/status")
def api_recycle_status():
    return jsonify(_agent_manager.get_recycle_status())

@app.post("/api/recycle/start")
def api_recycle_start():
    body = request.get_json(silent=True) or {}
    profiles = body.get("profiles", [])
    if not profiles:
        return jsonify({"success": False, "error": "profiles required"}), 400
    payload = {
        "profiles": profiles,
        "cooldownMinMinutes": body.get("cooldownMinMinutes", 10),
        "cooldownMaxMinutes": body.get("cooldownMaxMinutes", 30),
    }
    try:
        _agent_manager.start_recycle(payload, log_fn=_append_log)
        fut = _agent_manager._recycle_task
        status = fut.result(timeout=15) if fut else _agent_manager.get_recycle_status()
    except Exception as e:
        log.error("Recycle start failed: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500
    _append_log("success", "recycle", f"24/7 loop started — {len(profiles)} profile(s)")
    return jsonify({"success": True, "status": status})

@app.post("/api/recycle/stop")
def api_recycle_stop():
    body = request.get_json(silent=True) or {}
    slot_id    = body.get("slotId") or None
    profile_id = body.get("profileId") or None
    _agent_manager.stop_recycle(slot_id=slot_id, profile_id=profile_id)
    status = _agent_manager.get_recycle_status()
    if not slot_id and not profile_id:
        _append_log("info", "recycle", "24/7 loop stopped")
    return jsonify({"success": True, "status": status})

@app.post("/api/recycle/pause")
def api_recycle_pause():
    _agent_manager.pause_recycle()
    _append_log("info", "recycle", "24/7 loop paused")
    return jsonify({"success": True, "status": _agent_manager.get_recycle_status()})

@app.post("/api/recycle/resume")
def api_recycle_resume():
    _agent_manager.resume_recycle()
    _append_log("info", "recycle", "24/7 loop resumed")
    return jsonify({"success": True, "status": _agent_manager.get_recycle_status()})

# ══════════════════════════════════════════════════════════════════════════════
# SHUFFLE / WATCH HISTORY
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/shuffle/state")
def api_shuffle_state_get():
    return jsonify(_load(SHUFFLE_FILE, {}))

@app.route("/api/shuffle/state", methods=["POST", "PUT"])
def api_shuffle_state_post():
    body = request.get_json(silent=True) or {}
    data = _load(SHUFFLE_FILE, {})
    data.update(body)
    _save(SHUFFLE_FILE, data)
    return jsonify({"success": True})

@app.route("/api/watch-history/<profile_id>", methods=["GET", "DELETE"])
def api_watch_history(profile_id: str):
    from server_python.watch_history import get_watched_entries, clear_history
    if request.method == "DELETE":
        try:
            clear_history(profile_id)
        except Exception as e:
            log.warning("clear_history error for %s: %s", profile_id[:8], e)
        history = _load(WATCH_HISTORY_FILE, {})
        if profile_id in history:
            del history[profile_id]
        _save(WATCH_HISTORY_FILE, history)
        return jsonify({"code": 0, "message": "Watch history cleared"})

    entries    = get_watched_entries(profile_id)
    legacy     = _load(WATCH_HISTORY_FILE, {})
    legacy_ids = {e.get("videoId") for e in entries}
    for le in legacy.get(profile_id, []):
        if isinstance(le, dict):
            vid = le.get("videoId") or le.get("video_id", "")
            if vid and vid not in legacy_ids:
                entries.append({"videoId": vid, "watchedAt": le.get("watchedAt", 0),
                                 "videoTitle": le.get("videoTitle", le.get("title", ""))})
        elif isinstance(le, str) and le not in legacy_ids:
            entries.append({"videoId": le, "watchedAt": 0, "videoTitle": ""})
    return jsonify({"code": 0, "data": entries, "profileId": profile_id})

# ══════════════════════════════════════════════════════════════════════════════
# ANALYTICS
# ══════════════════════════════════════════════════════════════════════════════

def _analytics_empty_response(filter_name: str) -> dict:
    return {
        "totalViews": 0, "totalWatchTime": 0, "totalSessions": 0,
        "totalLikes": 0, "totalSubscribes": 0, "totalComments": 0,
        "totalAds": 0, "adsSkipped": 0, "adsWatchedFull": 0, "adWatchTime": 0,
        "trafficYouTube": 0, "trafficGoogle": 0, "trafficBing": 0,
        "trafficDirect": 0, "trafficChannel": 0, "trafficBacklink": 0,
        "perProfile": {}, "recentActivity": [], "dailyTrend": [],
        "filter": filter_name,
    }

# FIX #10: datetime imported at top — not repeated inside function
def _filter_events(events: list, filter_name: str) -> list:
    now_ms = time.time() * 1000
    if filter_name == "today":
        today = datetime.date.today()
        start = int(datetime.datetime(today.year, today.month, today.day).timestamp() * 1000)
        return [e for e in events if e.get("time", 0) >= start]
    elif filter_name == "yesterday":
        today     = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        start = int(datetime.datetime(yesterday.year, yesterday.month, yesterday.day).timestamp() * 1000)
        end   = int(datetime.datetime(today.year, today.month, today.day).timestamp() * 1000)
        return [e for e in events if start <= e.get("time", 0) < end]
    elif filter_name == "7d":
        cutoff = (time.time() - 7 * 86400) * 1000
        return [e for e in events if e.get("time", 0) >= cutoff]
    elif filter_name == "30d":
        cutoff = (time.time() - 30 * 86400) * 1000
        return [e for e in events if e.get("time", 0) >= cutoff]
    return events

@app.get("/api/analytics")
def api_analytics():
    filter_name = request.args.get("filter", "today")
    raw    = _load(ANALYTICS_FILE, {"events": [], "perProfile": {}})
    events = raw.get("events", [])
    if not isinstance(events, list):
        events = []
    filtered   = _filter_events(events, filter_name)
    result     = _analytics_empty_response(filter_name)
    per_profile: dict = {}
    daily: dict = {}
    # Per-profile PER-DAY breakdown (read-only aggregation of existing events).
    # Shape: { profileId: { "YYYY-MM-DD": {views, watchTime, likes, subscribes,
    #          comments, ads, adsSkipped} } }. Lets the UI show each profile's
    # own day-by-day report (user request) without any new event recording.
    per_profile_daily: dict = {}

    def _ppd(pid: str, day: str) -> dict:
        d = per_profile_daily.setdefault(pid, {})
        return d.setdefault(day, {
            "date": day, "views": 0, "watchTime": 0.0,
            "likes": 0, "subscribes": 0, "comments": 0,
            "ads": 0, "adsSkipped": 0,
        })

    for e in filtered:
        pid    = e.get("profileId", "")
        action = e.get("action", "")
        val    = float(e.get("value", 1) or 1)
        ts_ms  = e.get("time", 0)
        try:
            day_key = datetime.datetime.fromtimestamp(ts_ms / 1000).strftime("%Y-%m-%d")
        except Exception:
            day_key = "unknown"

        if day_key not in daily:
            daily[day_key] = {"date": day_key, "views": 0, "watchTime": 0}
        if pid not in per_profile:
            per_profile[pid] = {"views": 0, "watchTime": 0, "likes": 0, "subscribes": 0, "comments": 0}

        if action == "view":
            result["totalViews"] += 1; result["totalSessions"] += 1
            per_profile[pid]["views"] += 1; daily[day_key]["views"] += 1
            _ppd(pid, day_key)["views"] += 1
        elif action == "watchTime":
            result["totalWatchTime"] += val
            per_profile[pid]["watchTime"] += val; daily[day_key]["watchTime"] += val
            _ppd(pid, day_key)["watchTime"] += val
        elif action == "like":
            result["totalLikes"] += 1; per_profile[pid]["likes"] += 1
            _ppd(pid, day_key)["likes"] += 1
        elif action == "subscribe":
            result["totalSubscribes"] += 1; per_profile[pid]["subscribes"] += 1
            _ppd(pid, day_key)["subscribes"] += 1
        elif action == "comment":
            result["totalComments"] += 1; per_profile[pid]["comments"] += 1
            _ppd(pid, day_key)["comments"] += 1
        elif action == "ads_total":       result["totalAds"] += 1; _ppd(pid, day_key)["ads"] += int(val)
        elif action == "ads_skipped":     result["adsSkipped"] += 1; _ppd(pid, day_key)["adsSkipped"] += int(val)
        elif action == "ads_watched_full":result["adsWatchedFull"] += 1
        elif action == "ad_watch_time":   result["adWatchTime"] += val
        elif action in ("traffic_youtube-search", "traffic_youtube"): result["trafficYouTube"] += 1
        elif action == "traffic_google":  result["trafficGoogle"] += 1
        elif action == "traffic_bing":    result["trafficBing"] += 1
        elif action in ("traffic_direct", "traffic_direct-fallback"): result["trafficDirect"] += 1
        elif action in ("traffic_channel-page", "traffic_channel"):   result["trafficChannel"] += 1
        elif action in ("traffic_backlink", "traffic_backlink-direct-fallback"): result["trafficBacklink"] += 1

    result["perProfile"]    = per_profile
    result["recentActivity"] = filtered[-50:] if filtered else []
    result["dailyTrend"]    = sorted(daily.values(), key=lambda x: x["date"])
    # Per-profile daily: each profile's days sorted newest-first for the UI.
    result["perProfileDaily"] = {
        pid: sorted(days.values(), key=lambda x: x["date"], reverse=True)
        for pid, days in per_profile_daily.items()
    }
    return jsonify(result)

@app.post("/api/analytics/record")
def api_analytics_record():
    body   = request.get_json(silent=True) or {}
    pid    = body.get("profileId", "")
    action = body.get("action", "")
    value  = body.get("value", 1)
    ts     = body.get("time") or int(time.time() * 1000)
    detail = body.get("detail", "")
    if not pid or not action:
        return jsonify({"error": "profileId and action required"}), 400
    from server_python.analytics_store import record_events
    record_events([{"time": ts, "profileId": pid, "action": action, "value": value, "detail": detail}])
    return jsonify({"success": True})

@app.post("/api/analytics/record-batch")
def api_analytics_record_batch():
    body = request.get_json(silent=True) or {}
    new_events = body.get("events", [])
    if not isinstance(new_events, list) or not new_events:
        return jsonify({"error": "events array required"}), 400
    from server_python.analytics_store import record_events
    record_events(new_events)
    return jsonify({"success": True, "recorded": len(new_events)})

@app.post("/api/analytics/reset-today-engagement")
def api_analytics_reset():
    today = datetime.date.today()
    start = int(datetime.datetime(today.year, today.month, today.day).timestamp() * 1000)
    raw   = _load(ANALYTICS_FILE, {"events": []})
    events = raw.get("events", [])
    if isinstance(events, list):
        engagement_actions = {"like", "subscribe", "comment"}
        raw["events"] = [
            e for e in events
            if not (e.get("time", 0) >= start and e.get("action") in engagement_actions)
        ]
    _save(ANALYTICS_FILE, raw)
    return jsonify({"success": True})

# ══════════════════════════════════════════════════════════════════════════════
# LOGS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/logs")
def api_logs_get():
    level      = request.args.get("level", "")
    source     = request.args.get("source", "")
    profile_id = request.args.get("profileId", "")
    search     = request.args.get("search", "").strip().lower()
    since      = int(request.args.get("since", 0) or 0)
    limit      = int(request.args.get("limit", 200))

    # Flush buffer first so latest logs appear
    _flush_log_buffer()

    file_logs = _load(ACTIVITY_LOG_FILE, [])
    if not isinstance(file_logs, list):
        file_logs = []

    seen_ids: set[str] = set()
    merged: list[dict] = []
    for raw in list(_log_lines) + file_logs:
        if not isinstance(raw, dict):
            continue
        eid = raw.get("id")
        if eid and eid in seen_ids:
            continue
        if eid:
            seen_ids.add(eid)
        merged.append(_normalize_log_entry(raw))

    if since:      merged = [l for l in merged if l["timestamp"] >= since]
    if level:      merged = [l for l in merged if l.get("level") == level]
    if source:     merged = [l for l in merged if l.get("source") == source]
    if profile_id: merged = [l for l in merged if l.get("profileId") == profile_id]
    if search:
        merged = [
            l for l in merged
            if search in (l.get("message") or "").lower()
            or search in (l.get("profileName") or "").lower()
            or search in (l.get("profileId") or "").lower()
        ]

    merged.sort(key=lambda x: x["timestamp"], reverse=True)
    entries = merged[:limit]
    stats = {"info": 0, "warn": 0, "error": 0, "success": 0}
    for l in entries:
        lvl = l.get("level", "info")
        if lvl in stats:
            stats[lvl] += 1
    return jsonify({"entries": entries, "total": len(merged), "filtered": len(entries), "stats": stats})

@app.post("/api/logs")
def api_logs_post():
    body = request.get_json(silent=True) or {}
    _append_log(body.get("level", "info"), body.get("source", "ui"), body.get("message", ""),
                profile_id=body.get("profileId"), profile_name=body.get("profileName"))
    return jsonify({"success": True})

@app.delete("/api/logs")
def api_logs_delete():
    _flush_log_buffer()
    _save(ACTIVITY_LOG_FILE, [])
    _log_lines.clear()
    return jsonify({"success": True})

# ══════════════════════════════════════════════════════════════════════════════
# SETTINGS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/traffic-sources")
def api_traffic_sources_get():
    """List all traffic sources + which are temporarily disabled."""
    from server_python.traffic_source_control import (
        disabled_from_settings,
        list_sources_status,
    )
    data = _load(SETTINGS_FILE, {})
    disabled = disabled_from_settings(data)
    return jsonify({
        "success": True,
        "disabled": sorted(disabled),
        "sources": list_sources_status(disabled),
    })


@app.post("/api/traffic-sources/toggle")
def api_traffic_sources_toggle():
    """Enable/disable one traffic source (saved to user-settings.json)."""
    from server_python.traffic_source_control import (
        ALL_SOURCE_IDS,
        disabled_from_settings,
        list_sources_status,
        normalize_source_id,
    )
    body = request.get_json(silent=True) or {}
    source_id = normalize_source_id(str(body.get("sourceId") or body.get("id") or ""))
    if source_id not in ALL_SOURCE_IDS:
        return jsonify({"success": False, "error": f"Unknown source: {source_id}"}), 400
    enabled = body.get("enabled")
    if enabled is None:
        enabled = not (source_id in disabled_from_settings(_load(SETTINGS_FILE, {})))
    else:
        enabled = bool(enabled)

    data = _load(SETTINGS_FILE, {})
    disabled = disabled_from_settings(data)
    if enabled:
        disabled.discard(source_id)
    else:
        disabled.add(source_id)
    data["disabledTrafficSources"] = sorted(disabled)
    _save(SETTINGS_FILE, data)
    return jsonify({
        "success": True,
        "disabled": sorted(disabled),
        "sources": list_sources_status(disabled),
    })


@app.get("/api/settings")
def api_settings_get():
    data = _load(SETTINGS_FILE, {})
    data.setdefault("disabledTrafficSources", [])
    data.setdefault("proxyServer",    os.getenv("PROXY_SERVER", "us.smartproxy.net"))
    data.setdefault("proxyPort",      int(os.getenv("PROXY_PORT", 3120)))
    data.setdefault("proxyPassword",  os.getenv("PROXY_PASSWORD", ""))
    data.setdefault("proxyPrefix",    os.getenv("PROXY_PREFIX", ""))
    data.setdefault("moreloginApiKey", os.getenv("MORELOGIN_API_KEY", ""))
    data.setdefault("moreloginPort",  int(os.getenv("MORELOGIN_PORT", 40000)))
    data.setdefault("multiloginToken", os.getenv("MULTILOGIN_TOKEN", ""))
    data.setdefault("browserProvider", os.getenv("BROWSER_PROVIDER", "multilogin"))
    return jsonify({"success": True, "settings": data})

# Settings keys that must not be wiped when UI sends empty string (localStorage drift).
_SETTINGS_SECRET_KEYS = frozenset({
    "multiloginToken", "multiloginPassword", "moreloginApiKey",
    "proxyPassword", "anthropicApiKey", "telegramBotToken", "smtpPass",
    "nvidiaApiKey",
})


@app.post("/api/settings")
def api_settings_post():
    body = request.get_json(silent=True) or {}
    data = _load(SETTINGS_FILE, {})
    for key, val in body.items():
        if key in _SETTINGS_SECRET_KEYS and (val is None or str(val).strip() == ""):
            continue
        data[key] = val
    _save(SETTINGS_FILE, data)
    if "moreloginApiKey"  in body and str(body["moreloginApiKey"]).strip():
        os.environ["MORELOGIN_API_KEY"]  = body["moreloginApiKey"]
    if "multiloginToken"  in body and str(body["multiloginToken"]).strip():
        os.environ["MULTILOGIN_TOKEN"]   = body["multiloginToken"]
    if "multiloginEmail"  in body and str(body["multiloginEmail"]).strip():
        os.environ["MULTILOGIN_EMAIL"]   = body["multiloginEmail"]
    if "multiloginPassword" in body and str(body["multiloginPassword"]).strip():
        os.environ["MULTILOGIN_PASSWORD"] = body["multiloginPassword"]
    if "multiloginFolderId" in body and str(body["multiloginFolderId"]).strip():
        os.environ["MULTILOGIN_FOLDER_ID"] = body["multiloginFolderId"]
    if "proxyPassword"    in body and str(body["proxyPassword"]).strip():
        os.environ["PROXY_PASSWORD"]     = body["proxyPassword"]
    if "proxyPrefix"      in body and str(body["proxyPrefix"]).strip():
        os.environ["PROXY_PREFIX"]       = body["proxyPrefix"]
    if "proxyServer"      in body and str(body["proxyServer"]).strip():
        from server_python.smart_proxy import normalize_proxy_server
        os.environ["PROXY_SERVER"] = normalize_proxy_server(str(body["proxyServer"]))
        if "proxy.smartproxy" in str(body["proxyServer"]).lower():
            data["proxyServer"] = "us.smartproxy.net"
    if "proxyPort"        in body and str(body["proxyPort"]).strip():
        os.environ["PROXY_PORT"]         = str(body["proxyPort"])
    if "defaultProxyLife" in body and str(body["defaultProxyLife"]).strip():
        os.environ["DEFAULT_PROXY_LIFE"] = str(body["defaultProxyLife"])
    if "browserProvider"  in body and str(body["browserProvider"]).strip():
        os.environ["BROWSER_PROVIDER"]   = body["browserProvider"]
    try:
        from server_python.smart_proxy import reset_proxy_manager
        reset_proxy_manager()
    except Exception:
        pass
    # AI tiered-model settings changed? reload cache so it takes effect live.
    if any(k in body for k in (
        "aiTieredModelsEnabled", "aiModelHaiku", "aiModelSonnet",
        "aiModelOpus", "aiModelDefault",
    )):
        try:
            from server_python.ai_model_config import reload_config
            reload_config()
        except Exception:
            pass
    _append_log("info", "settings", "Settings updated")
    return jsonify({"success": True, "settings": data})

@app.get("/api/ai-model")
def api_ai_model_get():
    """Current tiered-model config + tier guide (for the Settings UI)."""
    try:
        from server_python.ai_model_config import get_model_config_summary, DEFAULT_MODELS
        return jsonify({"success": True, "config": get_model_config_summary(), "defaults": DEFAULT_MODELS})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Self-Healing Selectors (Level 2) ──────────────────────────────────────────
@app.get("/api/selectors")
def api_selectors_status():
    """Current selector keys: V2 count + override count (Self-Healing page)."""
    try:
        from server_python import selector_healer
        return jsonify({"success": True, **selector_healer.get_status()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.post("/api/selectors/apply")
def api_selectors_apply():
    """Add/replace selectors for a key (manual edit OR confirmed AI heal)."""
    body = request.get_json(silent=True) or {}
    key  = (body.get("key") or "").strip()
    sels = body.get("selectors") or []
    mode = (body.get("mode") or "prepend").strip()
    if not key or not isinstance(sels, list):
        return jsonify({"success": False, "error": "key + selectors[] required"}), 400
    try:
        from server_python import selector_healer
        return jsonify(selector_healer.apply_override(key, [str(s) for s in sels], mode))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.post("/api/selectors/remove")
def api_selectors_remove():
    body = request.get_json(silent=True) or {}
    key  = (body.get("key") or "").strip()
    sel  = body.get("selector")
    try:
        from server_python import selector_healer
        return jsonify(selector_healer.remove_override(key, sel))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.post("/api/selectors/heal")
def api_selectors_heal():
    """Ask AI (Opus tier) to PROPOSE new selectors. Does NOT auto-apply."""
    body = request.get_json(silent=True) or {}
    key  = (body.get("key") or "").strip()
    desc = (body.get("description") or "").strip()
    dom  = body.get("domDump") or ""
    shot = body.get("screenshotB64")
    if not key:
        return jsonify({"success": False, "error": "key required"}), 400
    try:
        from server_python import selector_healer
        # Ad-skip heal: failure ke waqt ka REAL DOM dump auto-feed karo —
        # AI ko exact failing page ka snapshot milta hai, generic guess nahi
        if key == "ad_skip_button" and not dom:
            try:
                from server_python.ad_skip_failure_tracker import latest_dom_dump
                dom = latest_dom_dump()
            except Exception:
                pass
        return jsonify(selector_healer.ai_propose_selectors(key, desc, dom, shot))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.get("/api/selectors/history")
def api_selectors_history():
    try:
        from server_python import selector_healer
        return jsonify({"success": True, "history": selector_healer.get_heal_history(30)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Fleet (multi-laptop) ──────────────────────────────────────────────────────
@app.get("/api/agent/info")
def api_agent_info():
    """
    THIS laptop's identity + FULL profile list (provider) merged with live
    running status (workers). Called by fleet controllers.
    """
    import socket as _socket
    info = {"hostname": _socket.gethostname(), "profilesTotal": 0, "running": 0, "profiles": []}

    # 1) running-worker map: profileId -> {status, video}
    worker_map: dict = {}
    try:
        from server_python.worker_manager import worker_manager
        statuses = worker_manager.get_all_statuses()
        if isinstance(statuses, dict):
            statuses = list(statuses.values())
        for w in (statuses or []):
            pid = w.get("profileId") or w.get("id")
            if pid:
                worker_map[str(pid)] = {
                    "status": str(w.get("status", "")).lower(),
                    "video": w.get("currentVideo") or w.get("videoTitle") or "",
                }
    except Exception as e:
        log.debug("agent/info workers: %s", e)

    # 1b) live engagement jobs on THIS laptop
    engagement_map: dict = {}
    try:
        for job in _engagement_jobs:
            st = str(job.get("status", "")).lower()
            if st not in ("pending", "running"):
                continue
            pid = str(job.get("profileId") or "")
            if not pid:
                continue
            live_title = str(job.get("currentVideoTitle") or "").strip()
            live_url = str(job.get("currentVideoUrl") or "").strip()
            video_label = live_title or live_url
            if not video_label and st == "pending":
                video_label = "Starting…"
            engagement_map[pid] = {
                "status": "running" if st == "running" else "starting",
                "video": video_label,
            }
    except Exception as e:
        log.debug("agent/info engagement merge: %s", e)

    # 2) full profile list from the browser provider (same as Profiles page).
    #    Provider name from settings (source of truth) → env → default.
    profiles_out: list = []
    try:
        _sdata = _load(SETTINGS_FILE, {})
        provider_name = _sdata.get("browserProvider") or os.getenv("BROWSER_PROVIDER") or "multilogin"
        if provider_name == "all":
            provider_name = "multilogin"
        provider = _get_provider(provider_name)
        plist = run_async(provider.list_profiles(1, 100))
        for p in (plist or []):
            pid = str(p.get("id") or p.get("envId") or "")
            wk = worker_map.get(pid, {})
            ek = engagement_map.get(pid, {})
            running_states = ("running", "watching", "connecting", "starting")
            wk_st = wk.get("status", "")
            ek_st = ek.get("status", "")
            is_running = (
                wk_st in running_states
                or ek_st in running_states
                or str(p.get("status", "")).lower() in running_states
            )
            video = ek.get("video") or wk.get("video") or ""
            profiles_out.append({
                "id": pid, "name": p.get("name") or pid,
                "status": "running" if is_running else "idle",
                "video": video,
            })
    except Exception as e:
        # provider unreachable → fall back to whatever workers we saw
        log.warning("agent/info provider list failed: %s", e)
        info["providerError"] = str(e)[:200]
        for pid, wk in worker_map.items():
            ek = engagement_map.get(pid, {})
            profiles_out.append({
                "id": pid, "name": pid,
                "status": ek.get("status") or wk.get("status", "idle"),
                "video": ek.get("video") or wk.get("video", ""),
            })
        for pid, ek in engagement_map.items():
            if pid not in worker_map:
                profiles_out.append({
                    "id": pid,
                    "name": ek.get("profileName") or pid,
                    "status": ek.get("status", "running"),
                    "video": ek.get("video", ""),
                })

    info["profiles"] = profiles_out
    info["profilesTotal"] = len(profiles_out)
    info["running"] = sum(1 for p in profiles_out if p["status"] == "running")
    info["ts"] = int(time.time())
    return jsonify(info)

@app.post("/api/agent/run-engagement")
def api_agent_run_engagement():
    """
    Fleet command receiver: build a LOCAL engagement run from the fleet config
    using THIS laptop's own profiles, then start it. Controllers broadcast here.
    """
    import random as _rand
    from server_python.fleet_engagement import (
        assign_profile_videos,
        fleet_keys_to_actions,
        load_comment_templates,
        per_profile_traffic_to_source,
        resolve_video_pool,
        traffic_to_source,
    )
    from server_python.search_keyword_planner import enrich_video_pool

    body = request.get_json(silent=True) or {}
    kind = str(body.get("kind") or "engagement").strip().lower()
    links = [str(v).strip() for v in (body.get("videos") or []) if str(v).strip()]
    channel_ids = [str(c) for c in (body.get("channelIds") or []) if str(c).strip()]
    pool = enrich_video_pool(resolve_video_pool(links, channel_ids, CHANNELS_FILE), CHANNELS_FILE)
    if not pool:
        return jsonify({"success": False, "error": "Koi video nahi — manual link ya channel select karo"}), 400

    watch_min = int(body.get("watchMin", 80))
    watch_max = int(body.get("watchMax", 100))
    if watch_max < watch_min:
        watch_max = watch_min
    gap_min = int(body.get("gapMin", 10))
    gap_max = int(body.get("gapMax", max(gap_min, 25)))
    if gap_max < gap_min:
        gap_max = gap_min
    vol_min = int(body.get("volMin", 60))
    vol_max = int(body.get("volMax", 80))
    quality = str(body.get("quality") or "auto")
    smart_comment = bool(body.get("smartComment", True))
    assign_mode = str(body.get("assignMode") or "shuffle")
    traffic_raw = str(body.get("traffic") or "")
    default_acts = set(body.get("actions") or [])
    per_prof = body.get("perProfileActions") or {}
    per_prof_traffic = body.get("perProfileTraffic") or {}
    sel_ids = set(str(x) for x in (body.get("selectedProfileIds") or []) if str(x).strip())
    run_all_if_empty = bool(body.get("runAllIfEmpty", False))
    explicit_selection = "selectedProfileIds" in body

    comment_templates = load_comment_templates(COMMENTS_FILE)

    try:
        _sdata = _load(SETTINGS_FILE, {})
        provider_name = _sdata.get("browserProvider") or os.getenv("BROWSER_PROVIDER") or "multilogin"
        if provider_name == "all":
            provider_name = "multilogin"
        provider = _get_provider(provider_name)
        plist = run_async(provider.list_profiles(1, 100))
    except Exception as e:
        return jsonify({"success": False, "error": f"profiles load failed: {e}"}), 500

    eligible: list[tuple[str, dict]] = []
    for p in (plist or []):
        pid = str(p.get("id") or p.get("envId") or "")
        if not pid:
            continue
        if sel_ids and pid not in sel_ids:
            continue
        eligible.append((pid, p))

    if not eligible and run_all_if_empty and not explicit_selection:
        for p in (plist or []):
            pid = str(p.get("id") or p.get("envId") or "")
            if pid:
                eligible.append((pid, p))

    if not eligible:
        return jsonify({"success": False, "error": "Koi matching profile nahi mila"}), 400

    profile_ids = [pid for pid, _ in eligible]
    if kind == "shuffle":
        assigned = assign_profile_videos(profile_ids, pool, assign_mode, _rand)
    else:
        assigned = {pid: list(pool) for pid in profile_ids}

    profiles_payload = []
    cumulative_delay = 0
    global_ad_skip = True
    for i, (pid, p) in enumerate(eligible):
        raw_keys = per_prof.get(pid, list(default_acts))
        keys = set(raw_keys) if isinstance(raw_keys, (list, set, tuple)) else set(default_acts)
        comment_text = ""
        if "comment" in keys and not smart_comment and comment_templates:
            comment_text = _rand.choice(comment_templates)
        actions = fleet_keys_to_actions(
            keys,
            quality=quality,
            vol_min=vol_min,
            vol_max=vol_max,
            comment_text=comment_text,
            smart_comment=smart_comment,
        )
        if comment_templates:
            actions["comment_templates"] = comment_templates
        global_ad_skip = global_ad_skip and bool(actions.get("adSkipEnabled", True))

        prof_traffic = str(per_prof_traffic.get(pid) or traffic_raw)
        source = per_profile_traffic_to_source(prof_traffic, _rand) if prof_traffic else traffic_to_source(traffic_raw, _rand)

        prof_videos = assigned.get(pid) or list(pool)
        if i > 0:
            cumulative_delay += _rand.randint(gap_min, gap_max) * 1000

        profiles_payload.append({
            "profileId": pid,
            "profileName": p.get("name") or pid,
            "browserType": p.get("browserType") or provider_name,
            "delayMs": cumulative_delay,
            "source": source,
            "actions": actions,
            "videos": prof_videos,
            "watchPct": _rand.randint(watch_min, watch_max),
        })

    ad_delay_min = int(body.get("adSkipDelaySec", 10))
    ad_delay_max = int(body.get("adSkipDelayMaxSec", 14))
    if ad_delay_max < ad_delay_min:
        ad_delay_max = ad_delay_min

    result = _engagement_start_core({
        "profiles": profiles_payload,
        "watchPct": _rand.randint(watch_min, watch_max),
        "adSkipEnabled": global_ad_skip,
        "adSkipDelaySec": ad_delay_min,
        "adSkipDelayMaxSec": ad_delay_max,
        "adSkipMaxSec": int(body.get("adSkipMaxSec", ad_delay_max)),
        "adClickEnabled": bool(body.get("adClickEnabled", False)),
        "adClickVisitSec": int(body.get("adClickVisitSec", 20)),
        "adClickDelayMinSec": int(body.get("adClickDelayMinSec", 10)),
        "adClickDelayMaxSec": int(body.get("adClickDelayMaxSec", 15)),
        "videoQuality": quality,
        "volumeMin": vol_min,
        "volumeMax": vol_max,
    })
    try:
        return result
    except Exception:
        return jsonify({"success": True, "started": len(profiles_payload)})

@app.post("/api/agent/stop")
def api_agent_stop():
    """
    Fleet command receiver: stop running engagement/workers on THIS laptop.
    Body: { profileIds:[], selectedProfileIds:[], stopAll:true }
    """
    body = request.get_json(silent=True) or {}
    sel_ids = {
        str(x).strip()
        for x in (body.get("profileIds") or body.get("selectedProfileIds") or [])
        if str(x).strip()
    }
    stop_all = bool(body.get("stopAll", False))
    if not stop_all and not sel_ids:
        stop_all = True

    cancelled = 0
    for job in _engagement_jobs:
        if job.get("status") not in ("pending", "running"):
            continue
        pid = str(job.get("profileId") or "")
        if stop_all or pid in sel_ids:
            job["status"] = "cancelled"
            cancelled += 1
            future = job.get("_future")
            if future and not future.done():
                future.cancel()

    stopped_workers = 0
    from server_python.worker_manager import worker_manager
    statuses = worker_manager.get_all_statuses()
    if isinstance(statuses, dict):
        statuses = list(statuses.values())
    running_states = ("running", "watching", "connecting", "starting")
    for w in (statuses or []):
        pid = str(w.get("profileId") or w.get("id") or "")
        if not pid:
            continue
        st = str(w.get("status", "")).lower()
        if st not in running_states:
            continue
        if stop_all or pid in sel_ids:
            asyncio.run_coroutine_threadsafe(worker_manager.stop_worker(pid), _loop)
            stopped_workers += 1

    _append_log(
        "warn", "fleet",
        f"Agent stop | jobs={cancelled} workers={stopped_workers} stop_all={stop_all}",
    )
    return jsonify({
        "success": True,
        "cancelledJobs": cancelled,
        "stoppedWorkers": stopped_workers,
        "stopAll": stop_all,
    })

@app.get("/api/fleet/this-laptop")
def api_fleet_this_laptop():
    """THIS laptop's own connection info (address + API key) for the Fleet page."""
    from server_python import fleet_manager
    return jsonify({"success": True, **fleet_manager.get_this_laptop()})

@app.post("/api/fleet/this-laptop/regenerate")
def api_fleet_regenerate_key():
    from server_python import fleet_manager
    return jsonify({"success": True, "apiKey": fleet_manager.regenerate_agent_key()})

@app.get("/api/fleet/machines")
def api_fleet_machines_get():
    from server_python import fleet_manager
    return jsonify({"success": True, "machines": fleet_manager.list_machines()})

@app.post("/api/fleet/machines")
def api_fleet_machines_add():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    addr = (body.get("address") or "").strip()
    key  = (body.get("apiKey") or "").strip()
    if not addr:
        return jsonify({"success": False, "error": "address required"}), 400
    from server_python import fleet_manager
    return jsonify({"success": True, "machine": fleet_manager.add_machine(name, addr, key)})

@app.delete("/api/fleet/machines/<mid>")
def api_fleet_machines_remove(mid: str):
    from server_python import fleet_manager
    return jsonify({"success": fleet_manager.remove_machine(mid)})

@app.get("/api/fleet/status")
def api_fleet_status():
    from server_python import fleet_manager
    return jsonify({"success": True, **fleet_manager.get_fleet_status()})

@app.post("/api/fleet/test-connection")
def api_fleet_test_connection():
    body = request.get_json(silent=True) or {}
    address = (body.get("address") or "").strip()
    api_key = (body.get("apiKey") or "").strip()
    if not address:
        return jsonify({"success": False, "error": "address required"}), 400
    from server_python import fleet_manager
    result = fleet_manager.test_connection(address, api_key)
    return jsonify({"success": bool(result.get("ok")), **result})

@app.post("/api/fleet/broadcast")
def api_fleet_broadcast():
    """Fan-out a POST to selected machines. body: {machineIds, path, payload}."""
    body = request.get_json(silent=True) or {}
    ids  = body.get("machineIds") or []
    path = (body.get("path") or "").strip()
    payload = body.get("payload") or {}
    if not isinstance(ids, list) or not path.startswith("/api/"):
        return jsonify({"success": False, "error": "machineIds[] + valid path required"}), 400
    from server_python import fleet_manager
    return jsonify({"success": True, **fleet_manager.broadcast(ids, path, payload)})

@app.post("/api/settings/test/morelogin")
def api_settings_test_morelogin():
    body    = request.get_json(silent=True) or {}
    api_key = body.get("apiKey") or os.getenv("MORELOGIN_API_KEY", "")
    port    = int(body.get("port") or os.getenv("MORELOGIN_PORT", 40000))
    try:
        provider = MoreLoginProvider(api_key=api_key, port=port)
        profiles = run_async(provider.list_profiles())
        return jsonify({"success": True, "message": f"Connected! {len(profiles)} profiles found."})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.post("/api/settings/test/multilogin")
def api_settings_test_multilogin():
    body = request.get_json(silent=True) or {}
    try:
        provider = MultiloginProvider(
            token=body.get("multiloginToken") or body.get("token") or os.getenv("MULTILOGIN_TOKEN", ""),
            email=body.get("multiloginEmail") or body.get("email") or os.getenv("MULTILOGIN_EMAIL", ""),
            password=body.get("multiloginPassword") or body.get("password") or os.getenv("MULTILOGIN_PASSWORD", ""),
            folder_id=body.get("multiloginFolderId") or body.get("folderId") or os.getenv("MULTILOGIN_FOLDER_ID", ""),
        )
        profiles = run_async(provider.list_profiles())
        return jsonify({"success": True, "message": f"Connected! {len(profiles)} profiles found."})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.post("/api/settings/multilogin/fetch-token")
def api_multilogin_fetch_token():
    body     = request.get_json(silent=True) or {}
    email    = body.get("multiloginEmail") or body.get("email", "")
    password = body.get("multiloginPassword") or body.get("password", "")
    try:
        provider = MultiloginProvider(
            email=email or os.getenv("MULTILOGIN_EMAIL", ""),
            password=password or os.getenv("MULTILOGIN_PASSWORD", ""),
            folder_id=body.get("multiloginFolderId") or os.getenv("MULTILOGIN_FOLDER_ID", ""),
        )
        token = run_async(provider.fetch_token(email, password))
        data = _load(SETTINGS_FILE, {})
        data["multiloginToken"] = token
        if email:
            data["multiloginEmail"] = email
        if password:
            data["multiloginPassword"] = password
        _save(SETTINGS_FILE, data)
        os.environ["MULTILOGIN_TOKEN"] = token
        preview = f"{token[:12]}…{token[-6:]}" if len(token) > 24 else "saved"
        return jsonify({
            "success": True,
            "ok": True,
            "token": token,
            "tokenPreview": preview,
            "message": "Automation token saved (720h)",
        })
    except Exception as e:
        return jsonify({"success": False, "ok": False, "message": str(e)})

# ══════════════════════════════════════════════════════════════════════════════
# NOTIFICATIONS TEST
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/notifications/test")
def api_notifications_test():
    import urllib.request as _ur
    body      = request.get_json(silent=True) or {}
    bot_token = body.get("telegramBotToken") or os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id   = body.get("telegramChatId")   or os.getenv("TELEGRAM_CHAT_ID", "")
    if not bot_token or not chat_id:
        return jsonify({"success": False, "message": "Telegram bot token aur chat ID required hai"})
    try:
        url     = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = json.dumps({"chat_id": chat_id, "text": "✅ MMB Agent notification test successful!"}).encode()
        req     = _ur.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with _ur.urlopen(req, timeout=10) as r:
            r.read()
        return jsonify({"success": True, "message": "Test message sent!"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

# ══════════════════════════════════════════════════════════════════════════════
# PROVIDER PING
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/providers/ping")
def api_providers_ping():
    import socket
    provider = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "multilogin")).lower()
    host     = "127.0.0.1"
    port     = 45001 if provider == "multilogin" else int(os.getenv("MORELOGIN_PORT", 40000))
    try:
        s = socket.create_connection((host, port), timeout=3)
        s.close()
        return jsonify({"code": 0, "message": f"{provider} launcher connected on port {port}"})
    except Exception as e:
        return jsonify({"code": -1, "message": f"{provider} launcher not reachable on port {port}: {str(e)}"})

# ══════════════════════════════════════════════════════════════════════════════
# COOKIES
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/cookies/status", methods=["GET", "POST"])
def api_cookies_status():
    return jsonify({"code": 0, "status": "ok", "message": "Backend running", "sets": [], "total": 0})

@app.post("/api/cookies/import")
def api_cookies_import():
    body        = request.get_json(silent=True) or {}
    cookies_arr = body.get("cookies", [])
    label       = body.get("label") or f"Set {int(time.time())}"
    pool        = _load(COOKIES_POOL_FILE, {"sets": []})
    sets        = pool.get("sets", [])
    set_id      = f"set_{str(uuid.uuid4())[:8]}"
    sets.append({"id": set_id, "label": label,
                 "importedAt": int(time.time() * 1000),
                 "cookies": cookies_arr, "count": len(cookies_arr)})
    pool["sets"] = sets
    _save(COOKIES_POOL_FILE, pool)
    return jsonify({"success": True, "count": len(cookies_arr), "poolSize": len(sets)})

@app.post("/api/cookies/clear")
def api_cookies_clear():
    _save(COOKIES_POOL_FILE, {"sets": []})
    return jsonify({"code": 0, "message": "Cleared", "success": True})

@app.get("/api/cookies/metadata")
def api_cookies_metadata():
    pool = _load(COOKIES_POOL_FILE, {"sets": []})
    sets = pool.get("sets", [])
    return jsonify({"code": 0, "metadata": {
        "totalSets": len(sets),
        "totalCookies": sum(s.get("count", 0) for s in sets),
    }})

@app.route("/api/cookies/set/<set_id>", methods=["GET", "DELETE"])
def api_cookies_set(set_id: str):
    pool = _load(COOKIES_POOL_FILE, {"sets": []})
    sets = pool.get("sets", [])
    if request.method == "DELETE":
        pool["sets"] = [s for s in sets if s.get("id") != set_id]
        _save(COOKIES_POOL_FILE, pool)
        return jsonify({"success": True, "message": f"Deleted cookie set {set_id}"})
    curr = next((s for s in sets if s.get("id") == set_id), None)
    if not curr:
        return jsonify({"error": "Set not found"}), 404
    return jsonify(curr)

# ══════════════════════════════════════════════════════════════════════════════
# PROXY
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/proxy/check")
def api_proxy_check():
    from server_python.smart_proxy import get_proxy_manager, normalize_proxy_server
    body   = request.get_json(silent=True) or {}
    server = normalize_proxy_server(body.get("server") or os.getenv("PROXY_SERVER", ""))
    port   = int(body.get("port") or os.getenv("PROXY_PORT", 3120))
    user   = body.get("username")
    passwd = body.get("password", os.getenv("PROXY_PASSWORD", ""))
    if not user:
        user = get_proxy_manager().get_proxy_config("health-check")["username"]
    if not server or not passwd:
        return jsonify({"success": False, "error": "server and password required"})
    proxy_url = f"http://{user}:{passwd}@{server}:{port}"
    start = time.time()
    try:
        import requests
        proxies = {"http": proxy_url, "https": proxy_url}
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}
        ip = city = country = None
        last_err = ""
        for url in ("http://ip-api.com/json/?fields=status,query,country,city", "http://ip-api.com/json"):
            try:
                r = requests.get(url, proxies=proxies, timeout=25, headers=headers)
                if r.status_code != 200:
                    last_err = f"HTTP {r.status_code}"; continue
                data = r.json()
                if data.get("status") == "success":
                    ip = data.get("query"); city = data.get("city"); country = data.get("country"); break
            except Exception as e:
                last_err = str(e)
        if not ip:
            try:
                r = requests.get("http://ifconfig.me/ip", proxies=proxies, timeout=20, headers=headers)
                if r.status_code == 200 and r.text.strip():
                    ip = r.text.strip().split()[0]
            except Exception as e:
                last_err = str(e)
        speed = int((time.time() - start) * 1000)
        if not ip:
            return jsonify({"success": False, "error": last_err or "proxy check failed", "speed": speed})
        return jsonify({"success": True, "ip": ip, "city": city, "country": country,
                        "speed": speed, "username": user, "server": server})
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "speed": int((time.time() - start) * 1000)})

@app.post("/api/proxy/rotate")
def api_proxy_rotate():
    return jsonify({"code": 0, "message": "Proxy rotated"})

# ══════════════════════════════════════════════════════════════════════════════
# CHANNELS / COMMENTS / PROFILE CONFIGS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/channels-data")
def api_channels_get():
    data = _load(CHANNELS_FILE, {"channels": [], "videos": [], "playlists": []})
    data.setdefault("channels", []); data.setdefault("videos", []); data.setdefault("playlists", [])
    return jsonify(data)

@app.route("/api/channels-data", methods=["POST", "PUT"])
def api_channels_post():
    _save(CHANNELS_FILE, request.get_json(silent=True) or {})
    return jsonify({"success": True})

@app.get("/api/comments")
def api_comments_get():
    data = _load(COMMENTS_FILE, [])
    comments = data if isinstance(data, list) else (data.get("comments") or data.get("templates") or [])
    return jsonify({"success": True, "comments": comments})

@app.route("/api/comments", methods=["POST", "PUT"])
def api_comments_post():
    body     = request.get_json(silent=True) or {}
    comments = body.get("comments", body.get("templates", []))
    _save(COMMENTS_FILE, {"comments": comments})
    return jsonify({"success": True})

@app.post("/api/comments/ai-generate")
def api_comments_ai_generate():
    body = request.get_json(silent=True) or {}
    try:
        count = max(1, min(50, int(body.get("count", 10))))
    except Exception:
        count = 10
    topic    = str(body.get("topic", "")).strip() or "general YouTube video"
    channel  = str(body.get("channel", "")).strip()
    category = str(body.get("category", "general")).strip() or "general"
    try:
        from server_python.ai_brain import is_available, _call
    except Exception as e:
        return jsonify({"success": False, "error": f"AI module load failed: {e}"}), 500
    if not is_available():
        return jsonify({"success": False, "error": "AI not configured — set ANTHROPIC_API_KEY in .env"}), 400
    prompt = (
        f'Generate exactly {count} short YouTube comments for this topic: "{topic}"'
        + (f' on channel "{channel}"' if channel else "")
        + ".\n\nRules:\n- Each comment: 1-2 sentences max\n"
        "- Sound like real viewers, NOT bots — varied tone, perspectives, lengths\n"
        "- Mix: positive, curious, questioning, encouraging, casual\n"
        "- No hashtags, no excessive emojis (max 1 per comment, occasional)\n"
        "- Each comment on its own line\n"
        "- NO numbering, NO quotes, NO bullets — just plain text lines\n"
        "Output ONLY the comments, one per line."
    )
    raw = _call(prompt, max_tokens=count * 60)
    if not raw:
        return jsonify({"success": False, "error": "AI returned no content"}), 502
    import re as _re
    lines = []
    for line in raw.split("\n"):
        s = line.strip()
        if not s:
            continue
        s = _re.sub(r"^[\d]+[\.)\s]+", "", s)
        s = _re.sub(r"^[-*•]\s*", "", s)
        s = s.strip(' "\'`')
        if len(s) >= 5:
            lines.append(s)
    lines = lines[:count]
    if not lines:
        return jsonify({"success": False, "error": "AI output could not be parsed"}), 502
    base_id = int(time.time() * 1000)
    new_templates = [
        {"id": str(base_id + i), "text": text, "category": category, "usedCount": 0}
        for i, text in enumerate(lines)
    ]
    _append_log("success", "comments", f"AI generated {len(new_templates)} comments (topic: {topic[:40]})")
    return jsonify({"success": True, "templates": new_templates, "count": len(new_templates)})

@app.get("/api/profile-configs")
def api_profile_configs_get():
    data    = _load(SETTINGS_FILE, {})
    configs = data.get("profileConfigs", [])
    configs_dict = {c["id"]: c for c in configs if "id" in c} if isinstance(configs, list) else configs
    return jsonify({"success": True, "configs": configs_dict})

@app.get("/api/profile-config/<profile_id>")
def api_profile_config_get(profile_id: str):
    data    = _load(SETTINGS_FILE, {})
    configs = data.get("profileConfigs", [])
    return jsonify(next((c for c in configs if c.get("id") == profile_id), {}))

@app.route("/api/profile-config/<profile_id>", methods=["POST", "PUT"])
def api_profile_config_post(profile_id: str):
    body    = request.get_json(silent=True) or {}
    data    = _load(SETTINGS_FILE, {})
    configs = data.get("profileConfigs", [])
    idx     = next((i for i, c in enumerate(configs) if c.get("id") == profile_id), None)
    body["id"] = profile_id
    if idx is not None:
        configs[idx] = body
    else:
        configs.append(body)
    data["profileConfigs"] = configs
    _save(SETTINGS_FILE, data)
    return jsonify({"success": True})

# ══════════════════════════════════════════════════════════════════════════════
# BACKLINKS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/backlinks")
def api_backlinks_get():
    return jsonify(_load(BACKLINKS_FILE, {"links": [], "manualAssign": {}}))

@app.post("/api/backlinks")
def api_backlinks_post():
    _save(BACKLINKS_FILE, request.get_json(silent=True) or {})
    return jsonify({"success": True})

# ══════════════════════════════════════════════════════════════════════════════
# ORCHESTRATOR STATUS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/orchestrator/status")
def api_orchestrator_status():
    try:
        from server_python.orchestrator import Orchestrator, HOURLY_WEIGHTS
        hour   = datetime.datetime.now().hour
        weight = HOURLY_WEIGHTS.get(hour, 0.5)
        ram_info = {}
        try:
            import psutil
            vm = psutil.virtual_memory()
            ram_info = {"percent": round(vm.percent, 1),
                        "available_gb": round(vm.available / 1e9, 2),
                        "total_gb": round(vm.total / 1e9, 2)}
        except ImportError:
            ram_info = {"percent": None, "note": "psutil not installed"}
        return jsonify({"current_hour": hour, "hour_weight": weight, "peak_hour": 19,
                        "ram": ram_info, "hourly_weights": HOURLY_WEIGHTS})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ══════════════════════════════════════════════════════════════════════════════
# GMAIL LOGIN MANAGER
# ══════════════════════════════════════════════════════════════════════════════

_gmail_jobs: list    = []
_gmail_running: bool = False


async def _automate_gmail_login(profile_id: str, email: str, password: str) -> tuple[bool, str, str]:
    """
    Automate Gmail login inside Chrome profile via CDP/nodriver.
    FIX #4: uc.cdp.input → correct nodriver cdp.input_ path
    FIX #7: tab.url → JS evaluate (nodriver tab has no .url property)
    FIX #8: uc.Browser.create() → correct uc.start() API
    """
    import nodriver as uc
    from nodriver import cdp
    from server_python.providers.morelogin import MoreLoginProvider
    from server_python.providers.multilogin import MultiloginProvider

    provider_name = _load(SETTINGS_FILE, {}).get("browserProvider", "multilogin")
    provider = MultiloginProvider() if provider_name == "multilogin" else MoreLoginProvider()

    try:
        start_res = await provider.start_profile(profile_id)
        cdp_port = (
            (start_res.get("data") or {}).get("cdpPort")
            or start_res.get("cdp_port")
            or start_res.get("port")
        )
        if not cdp_port:
            return False, "error", "Failed to retrieve browser debug CDP port"
    except Exception as e:
        return False, "error", f"Browser failed to start: {e}"

    try:
        # FIX #8: correct nodriver connect API (not uc.Browser.create)
        browser = await uc.start(host="127.0.0.1", port=int(cdp_port), headless=False)
        tab = browser.tabs[0] if browser.tabs else await browser.get("about:blank")
    except Exception as e:
        return False, "error", f"Could not connect nodriver CDP: {e}"

    try:
        await tab.get("https://accounts.google.com/ServiceLogin?hl=en")
        await asyncio.sleep(3)

        # FIX #7: tab.url doesn't exist in nodriver — use JS evaluate
        current_url = await tab.evaluate("location.href", return_by_value=True)
        url = str(getattr(current_url, "value", current_url) or "")

        if "myaccount.google.com" in url or "google.com" not in url:
            await provider.stop_profile(profile_id)
            return True, "success", "Already logged in ✓"

        email_input = await tab.select("input[type='email']")
        if not email_input:
            pass_input = await tab.select("input[type='password']")
            if not pass_input:
                await provider.stop_profile(profile_id)
                return False, "error", "Could not locate email/password field"
        else:
            await email_input.send_keys(email)
            await asyncio.sleep(1)
            next_btn = await tab.select("#identifierNext")
            if next_btn:
                await next_btn.click()
            else:
                # FIX #4: correct cdp module path
                await tab.send(cdp.input_.dispatch_key_event(
                    type_="rawKeyDown", windows_virtual_key_code=13
                ))

        await asyncio.sleep(4)

        # FIX #7: re-check URL via JS
        current_url = await tab.evaluate("location.href", return_by_value=True)
        url = str(getattr(current_url, "value", current_url) or "")

        if "challenge/phone" in url:
            return False, "needs_phone", "Requires Phone/OTP verification — Please complete manually in the browser window"
        elif "challenge/captcha" in url:
            return False, "captcha", "Google CAPTCHA triggered — Please solve manually in the browser window"

        pass_input = await tab.select("input[type='password']")
        if not pass_input:
            await provider.stop_profile(profile_id)
            return False, "error", "Password input field not found"

        await pass_input.send_keys(password)
        await asyncio.sleep(1)
        next_btn = await tab.select("#passwordNext")
        if next_btn:
            await next_btn.click()
        else:
            # FIX #4: correct cdp module path
            await tab.send(cdp.input_.dispatch_key_event(
                type_="rawKeyDown", windows_virtual_key_code=13
            ))

        await asyncio.sleep(6)

        # FIX #7: check URL via JS
        current_url = await tab.evaluate("location.href", return_by_value=True)
        url = str(getattr(current_url, "value", current_url) or "")

        if "challenge/phone" in url or "challenge/sms" in url:
            return False, "needs_phone", "OTP verification required — Please complete manually in browser window"
        elif "challenge/pwd" in url or "wrongpassword" in url:
            await provider.stop_profile(profile_id)
            return False, "wrong_password", "Wrong password provided!"
        elif "challenge" in url:
            return False, "blocked", "Security Challenge/Blocked — Please review in opened browser"

        await provider.stop_profile(profile_id)
        return True, "success", "Successfully logged in ✓"

    except Exception as e:
        try:
            await provider.stop_profile(profile_id)
        except Exception:
            pass
        return False, "error", f"Login automation error: {e}"


async def _run_gmail_jobs_task():
    global _gmail_running, _gmail_jobs
    try:
        while _gmail_running:
            pending = [j for j in _gmail_jobs if j.get("status") in ("pending", "retry")]
            if not pending:
                _gmail_running = False
                break
            job = pending[0]
            job["status"]  = "running"
            job["message"] = "Starting login automation..."
            success, status_type, msg = await _automate_gmail_login(
                job.get("profileId"), job.get("email"), job.get("password")
            )
            job["status"]  = status_type
            job["message"] = msg
            await asyncio.sleep(5)
    except Exception as e:
        print(f"Error in Gmail jobs task: {e}")
    finally:
        _gmail_running = False

@app.get("/api/gmail-login/status")
def api_gmail_status():
    return jsonify({"code": 0, "data": {"jobs": _gmail_jobs, "running": _gmail_running}})

@app.post("/api/gmail-login/start")
def api_gmail_start():
    global _gmail_jobs, _gmail_running
    body = request.get_json(silent=True) or {}
    _gmail_jobs = []
    for cred in body.get("credentials", []):
        pid = cred.get("profileId", ""); email = cred.get("email", ""); pwd = cred.get("password", "")
        if pid and email and pwd:
            _gmail_jobs.append({"profileId": pid, "email": email, "password": pwd,
                                 "status": "pending", "message": "Waiting to start..."})
    if _gmail_jobs:
        _gmail_running = True
        asyncio.run_coroutine_threadsafe(_run_gmail_jobs_task(), _loop)
        return jsonify({"code": 0, "ok": True, "message": "Gmail login task started"})
    return jsonify({"code": 0, "ok": False, "error": "No valid profiles/credentials provided"})

@app.post("/api/gmail-login/stop")
def api_gmail_stop():
    global _gmail_running
    _gmail_running = False
    return jsonify({"code": 0, "success": True})

@app.post("/api/gmail-login/clear")
def api_gmail_clear():
    _gmail_jobs.clear()
    return jsonify({"code": 0, "success": True})

@app.post("/api/gmail-login/mark-done/<job_id>")
def api_gmail_mark_done(job_id: str):
    for j in _gmail_jobs:
        if j.get("profileId") == job_id:
            j["status"] = "success"; j["message"] = "Logged in successfully ✓"
    return jsonify({"code": 0, "success": True})

@app.post("/api/gmail-login/retry/<job_id>")
def api_gmail_retry(job_id: str):
    global _gmail_running
    for j in _gmail_jobs:
        if j.get("profileId") == job_id:
            j["status"] = "retry"; j["message"] = "Retrying login..."
    if not _gmail_running:
        _gmail_running = True
        asyncio.run_coroutine_threadsafe(_run_gmail_jobs_task(), _loop)
    return jsonify({"code": 0, "success": True})

@app.post("/api/gmail-login/skip/<job_id>")
def api_gmail_skip(job_id: str):
    for j in _gmail_jobs:
        if j.get("profileId") == job_id:
            j["status"] = "skipped"; j["message"] = "Skipped by user"
    return jsonify({"code": 0, "success": True})

# ══════════════════════════════════════════════════════════════════════════════
# MISC ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/android-devices")
def api_android_devices():
    return jsonify({"code": 0, "devices": []})

@app.get("/api/history/<profile_id>")
def api_history(profile_id: str):
    history = _load(WATCH_HISTORY_FILE, {})
    return jsonify({"code": 0, "history": history.get(profile_id, [])})

@app.post("/api/manual/start")
def api_manual_start():
    body = request.get_json(silent=True) or {}
    profile_id = body.get("profileId", "")
    _workers[profile_id] = {"profileId": profile_id, "status": "pending", "startedAt": int(time.time() * 1000)}
    return jsonify({"code": 0, "message": f"Profile {profile_id} queued"})

@app.post("/api/manual/batch")
def api_manual_batch():
    body = request.get_json(silent=True) or {}
    pids = list(body.get("profileIds", []))
    for p in body.get("profiles", []):
        pid = p.get("profileId") or p.get("id", "")
        if pid and pid not in pids:
            pids.append(pid)
    for pid in pids:
        _workers[pid] = {"profileId": pid, "status": "pending", "startedAt": int(time.time() * 1000)}
    return jsonify({"code": 0, "message": f"Queued {len(pids)} profiles"})

@app.post("/api/workers/clear-completed")
def api_workers_clear_completed():
    from server_python.worker_manager import worker_manager
    worker_manager.clear_completed()
    return jsonify({"code": 0})

@app.post("/api/workers/stop/<profile_id>")
def api_workers_stop(profile_id: str):
    from server_python.worker_manager import worker_manager
    asyncio.run_coroutine_threadsafe(worker_manager.stop_worker(profile_id), _loop)
    return jsonify({"code": 0})

# ══════════════════════════════════════════════════════════════════════════════
# ACCOUNTS (Gmail creation via 5sim OTP)
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/accounts/create")
def api_accounts_create():
    body       = request.get_json(silent=True) or {}
    profile_id = body.get("profileId") or body.get("profile_id")
    country    = body.get("country", "usa")
    if not profile_id:
        return jsonify({"success": False, "error": "profileId required"}), 400
    provider_name = body.get("provider") or os.getenv("BROWSER_PROVIDER", "morelogin")

    async def _do_create():
        import nodriver as uc
        from server_python.account_manager import get_account_manager
        mgr      = get_account_manager()
        provider = _get_provider(provider_name)
        result   = await provider.start_profile(profile_id)
        debug_port = (
            (result.get("data") or {}).get("cdpPort")
            or result.get("remoteDebuggingPort")
            or result.get("cdp_port")
        )
        if not debug_port:
            return {"success": False, "error": "Could not get debug port from browser"}
        # FIX #8: correct uc.start() API
        browser = await uc.start(host="127.0.0.1", port=int(debug_port), headless=False)
        tab     = browser.tabs[0] if browser.tabs else await browser.get("about:blank")
        account = await mgr.create_gmail_account(tab, profile_id, country)
        try:
            await browser.stop()
        except Exception:
            pass
        if account:
            return {"success": True, "account": account.to_dict()}
        return {"success": False, "error": "Account creation failed — check logs"}

    try:
        _append_log("info", "accounts", f"Gmail creation started for {profile_id[:8]}")
        # FIX #6: longer timeout for account creation (120s)
        result = run_async(_do_create(), timeout=120.0)
        if result.get("success"):
            _append_log("info", "accounts",
                        f"Gmail created: {result['account'].get('email')} for {profile_id[:8]}")
        else:
            _append_log("warn", "accounts",
                        f"Gmail creation failed for {profile_id[:8]}: {result.get('error')}")
        return jsonify(result)
    except Exception as e:
        log.error("accounts/create error: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500

@app.get("/api/accounts/list")
def api_accounts_list():
    try:
        from server_python.account_manager import get_account_manager
        mgr      = get_account_manager()
        accounts = mgr.list_accounts()
        return jsonify({"success": True, "accounts": accounts, "total": len(accounts)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "accounts": [], "total": 0}), 500

@app.get("/api/accounts/<profile_id>")
def api_accounts_get(profile_id: str):
    try:
        from server_python.account_manager import get_account_manager
        account = get_account_manager().load_account(profile_id)
        if account:
            return jsonify({"success": True, "account": account.to_dict()})
        return jsonify({"success": False, "error": "No account found for this profile"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.get("/api/accounts/balance")
def api_accounts_balance():
    async def _get_balance():
        from server_python.account_manager import FiveSimClient
        return await FiveSimClient().get_balance()
    try:
        balance = run_async(_get_balance())
        if balance is not None:
            return jsonify({"success": True, "balance": balance, "currency": "USD",
                            "message": f"5sim balance: ${balance:.2f}"})
        return jsonify({"success": False, "error": "Could not fetch balance — check FIVESIM_API_KEY"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ── Profiles extended ─────────────────────────────────────────────────────────
@app.post("/api/profiles/create-full")
def api_profiles_create_full():
    from server_python.profile_creator import create_full_profile
    body = request.get_json(silent=True) or {}
    _load_settings_to_env()
    try:
        result = run_async(create_full_profile(body))
        if result.get("code") == 0:
            d = result.get("data") or {}
            _append_log("success", "profiles",
                        f"Profile created: {d.get('name')} via {d.get('browserType')} "
                        f"(antidetect: {d.get('antidetect', {}).get('engine', 'ok')})")
        else:
            _append_log("error", "profiles", f"Create failed: {result.get('message')}")
        return jsonify(result)
    except Exception as e:
        log.error("create-full error: %s", e)
        _append_log("error", "profiles", f"Create-full error: {e}")
        return jsonify({"code": -1, "message": str(e), "data": None})

@app.post("/api/profiles/recreate")
def api_profiles_recreate():
    body = request.get_json(silent=True) or {}
    return jsonify({"code": 0, "message": "Recreate queued", "profileId": body.get("profileId", "")})

# ── Update system ─────────────────────────────────────────────────────────────
@app.get("/api/update/version")
def api_update_version():
    return jsonify({"code": 0, "current": "2.0.0-py", "latest": "2.0.0-py", "hasUpdate": False})

@app.post("/api/update/run")
def api_update_run():
    return jsonify({"code": 0, "message": "Already latest"})

@app.post("/api/update/push")
def api_update_push():
    return jsonify({"code": 0, "message": "Push update not available"})

# ── YouTube InnerTube proxy ───────────────────────────────────────────────────
@app.get("/api/youtube/feed")
def api_youtube_feed():
    import urllib.request
    import urllib.parse

    channel_id = request.args.get("channel_id", "").strip()
    if not channel_id:
        return jsonify({"error": "channel_id required"}), 400

    browse_id = channel_id if channel_id.startswith("UC") else (
        channel_id if channel_id.startswith("@") else f"@{channel_id}"
    )

    def _innertube_browse(bid: str, params: str | None = None) -> dict:
        body: dict = {
            "browseId": bid,
            "context": {"client": {"clientName": "WEB", "clientVersion": "2.20240101.00.00",
                                   "hl": "en", "gl": "US"}},
        }
        if params:
            body["params"] = params
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/browse",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36",
                     "Accept-Language": "en-US,en;q=0.9",
                     "Origin": "https://www.youtube.com",
                     "Referer": "https://www.youtube.com/"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8", errors="ignore"))

    try:
        meta_data = _innertube_browse(browse_id)
        try:
            videos_data = _innertube_browse(browse_id, "EgZ2aWRlb3M%3D")
            if "contents" in videos_data:
                meta_data["contents"] = videos_data["contents"]
        except Exception as ve:
            log.warning("[YouTube/feed] Videos tab fetch failed (non-fatal): %s", ve)
        return jsonify(meta_data)
    except Exception as e:
        log.error("[YouTube/feed] InnerTube error: %s", e)
        return jsonify({"error": str(e)}), 502

@app.get("/api/youtube/playlist")
def api_youtube_playlist():
    return jsonify({"code": 0, "videos": [], "playlistId": request.args.get("list", "")})

# ══════════════════════════════════════════════════════════════════════════════
# MASTERMIND — campaign + plan persistence + execute routes
# (imports above, before timer loop)
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/mastermind/state")
def api_mastermind_state():
    if not _MASTERMIND_OK:
        return jsonify({"error": "mastermind store unavailable"}), 503
    payload = _mastermind_get_state()
    payload["execution"] = _mastermind_exec_status()
    return jsonify(payload)


@app.get("/api/mastermind/execute/status")
def api_mastermind_execute_status():
    if not _MASTERMIND_OK:
        return jsonify({"error": "mastermind executor unavailable"}), 503
    return jsonify(_mastermind_exec_status())


@app.post("/api/mastermind/execute/start")
def api_mastermind_execute_start():
    if not _MASTERMIND_OK:
        return jsonify({"success": False, "error": "mastermind executor unavailable"}), 503
    body = request.get_json(silent=True) or {}
    plan = body.get("plan")
    plan_name = str(body.get("name") or "").strip()
    if not isinstance(plan, dict):
        state = _mastermind_get_state()
        latest = state.get("latestPlan") or {}
        plan = latest.get("plan")
        plan_name = plan_name or str(latest.get("name") or "")
    if not isinstance(plan, dict):
        return jsonify({"success": False, "error": "Plan required — pehle plan generate/save karo"}), 400
    result = _mastermind_exec_start(plan, plan_name)
    if not result.get("success"):
        return jsonify(result), 400
    _append_log(
        "success",
        "mastermind",
        f'Plan run started — {result.get("totalSlots", 0)} slots ({result.get("planDayKey", "")})',
    )
    return jsonify(result)


@app.post("/api/mastermind/execute/stop")
def api_mastermind_execute_stop():
    if not _MASTERMIND_OK:
        return jsonify({"success": False, "error": "mastermind executor unavailable"}), 503
    result = _mastermind_exec_stop()
    _append_log("warn", "mastermind", "Plan execution stopped by user")
    return jsonify(result)


@app.post("/api/mastermind/campaign")
def api_mastermind_campaign_save():
    if not _MASTERMIND_OK:
        return jsonify({"success": False, "error": "mastermind store unavailable"}), 503
    body = request.get_json(silent=True) or {}
    result = _mastermind_save_campaign(body)
    if not result.get("success"):
        return jsonify(result), 400
    return jsonify(result)


@app.post("/api/mastermind/plan")
def api_mastermind_plan_save():
    if not _MASTERMIND_OK:
        return jsonify({"success": False, "error": "mastermind store unavailable"}), 503
    body = request.get_json(silent=True) or {}
    result = _mastermind_save_plan(body)
    if not result.get("success"):
        return jsonify(result), 400
    return jsonify(result)


@app.get("/api/mastermind/scheduled")
def api_mastermind_scheduled_list():
    if not _MASTERMIND_OK:
        return jsonify({"error": "mastermind store unavailable"}), 503
    return jsonify({"plans": _mastermind_list_scheduled()})


@app.post("/api/mastermind/scheduled")
def api_mastermind_scheduled_save():
    if not _MASTERMIND_OK:
        return jsonify({"success": False, "error": "mastermind store unavailable"}), 503
    body = request.get_json(silent=True) or {}
    result = _mastermind_save_scheduled(body)
    if not result.get("success"):
        return jsonify(result), 400
    return jsonify(result)


@app.delete("/api/mastermind/scheduled/<plan_id>")
def api_mastermind_scheduled_delete(plan_id: str):
    if not _MASTERMIND_OK:
        return jsonify({"success": False, "error": "mastermind store unavailable"}), 503
    return jsonify(_mastermind_delete_scheduled(plan_id))

# ── V2 Dashboard ──────────────────────────────────────────────────────────────
try:
    from dashboard.app import register_dashboard
    register_dashboard(app)
    log.info("V2 Dashboard registered — visit http://localhost:%d/dashboard", PORT)
except Exception as _dash_err:
    log.warning("V2 Dashboard not loaded: %s", _dash_err)

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    log.info("MMB Python Server starting on port %d ...", PORT)
    log.info("Provider: %s", os.getenv("BROWSER_PROVIDER", "morelogin"))
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
