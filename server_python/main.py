"""
MMB AGENT 24/7 — Python Backend Server
=======================================
Node.js + Playwright ki jagah Python + nodriver.
Port 3100 pe chalta hai — React frontend same rahega.

Run: python server_python/main.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
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
import sys
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
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
WATCH_HISTORY_FILE   = ROOT / "watch_history.json"
CHANNELS_FILE        = ROOT / "channels_data.json"
ACTIVITY_LOG_FILE    = ROOT / "activity_logs.json"
AGENT_STATES_FILE    = ROOT / "agent_states.json"
ANALYTICS_FILE       = ROOT / "analytics_data.json"
SCHEDULES_FILE       = ROOT / "schedules_data.json"
SHUFFLE_FILE         = ROOT / "shuffle_data.json"
RECYCLE_FILE         = ROOT / "recycle_state.json"
HEALTH_FILE          = ROOT / "health_stats.json"
COMMENTS_FILE        = ROOT / "comments_data.json"
SETTINGS_FILE        = ROOT / "user-settings.json"

# ── In-memory state ───────────────────────────────────────────────────────────
_workers: dict[str, dict] = {}          # profileId → worker status
_engagement_jobs: list[dict] = []       # engagement queue
_log_lines: list[dict] = []             # live log buffer (max 2000)

# ── Import agent manager ──────────────────────────────────────────────────────
from server_python.agent_manager import AgentManager
from server_python.providers.morelogin import MoreLoginProvider
from server_python.providers.multilogin import MultiloginProvider

_agent_manager = AgentManager()

# ── Async event loop (runs in background thread) ──────────────────────────────
_loop = asyncio.new_event_loop()
_agent_manager.set_loop(_loop)

def _start_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_forever()

Thread(target=_start_loop, args=(_loop,), daemon=True).start()

def run_async(coro):
    """Run coroutine in background asyncio loop, return result synchronously."""
    fut = asyncio.run_coroutine_threadsafe(coro, _loop)
    return fut.result(timeout=60)

# ── Helper: load / save JSON ──────────────────────────────────────────────────
def _load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}

def _save(path: Path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)

# ── Load user-settings.json into env vars at startup ─────────────────────────
# Ensures MultiloginProvider/MoreLoginProvider picks up saved credentials
# even when .env doesn't have them explicitly.
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

# SmartProxy US residential — never use proxy.smartproxy.net for this account
if "proxy.smartproxy" in os.getenv("PROXY_SERVER", "").lower():
    os.environ["PROXY_SERVER"] = "us.smartproxy.net"
    log.warning("PROXY_SERVER corrected: proxy.smartproxy.net → us.smartproxy.net")

def _append_log(level: str, source: str, message: str):
    entry = {
        "id": str(uuid.uuid4())[:8],
        "level": level,
        "source": source,
        "message": message,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _log_lines.append(entry)
    if len(_log_lines) > 2000:
        del _log_lines[:-2000]
    # Also append to file
    logs = _load(ACTIVITY_LOG_FILE, [])
    if isinstance(logs, list):
        logs.append(entry)
        if len(logs) > 5000:
            logs = logs[-5000:]
        _save(ACTIVITY_LOG_FILE, logs)

def _init_recycle_engine():
    from server_python.recycle_engine import recycle_engine

    recycle_engine.configure(_loop, log_fn=_append_log, root=ROOT)
    saved = _load(RECYCLE_FILE, {})
    if saved.get("enabled"):
        asyncio.run_coroutine_threadsafe(recycle_engine.restore(saved), _loop)

_init_recycle_engine()

# ── Auth middleware ───────────────────────────────────────────────────────────
@app.before_request
def _check_auth():
    if request.method == "OPTIONS":
        return
    # Read-only status endpoints — Sidebar/Dashboard health checks (local app)
    if request.path in ("/api/health", "/api/cookies/status"):
        return
    key = (
        request.headers.get("x-api-key")
        or request.headers.get("X-MMB-Token")
        or request.args.get("api_key")
    )
    if key != API_KEY:
        return jsonify({"error": "Unauthorized"}), 401

# ══════════════════════════════════════════════════════════════════════════════
# HEALTH
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/health")
def api_health():
    from server_python.worker_manager import worker_manager
    w_stats = worker_manager.get_stats()
    schedules_data = _load(SCHEDULES_FILE, {"schedules": []})
    # schedules_data can be a list (old format) or dict with "schedules" key or other
    if isinstance(schedules_data, list):
        schedule_list = schedules_data
    elif isinstance(schedules_data, dict):
        schedule_list = schedules_data.get("schedules", [])
        if not isinstance(schedule_list, list):
            schedule_list = []
    else:
        schedule_list = []
    active_schedules = sum(1 for s in schedule_list if isinstance(s, dict) and s.get("status") in ("running", "scheduled", "countdown"))
    eng_counts = {s: sum(1 for j in _engagement_jobs if j.get("status") == s)
                  for s in ("pending", "running", "done", "failed", "cancelled", "partial")}
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
            "limit": int(settings.get("ytMaxTotalAgents", 6)),
            "running": w_stats.get("running", 0),
            "available": max(0, int(settings.get("ytMaxTotalAgents", 6)) - w_stats.get("running", 0)),
        },
    })

# ══════════════════════════════════════════════════════════════════════════════
# PROFILES
# ══════════════════════════════════════════════════════════════════════════════

def _get_provider(name: str):
    n = (name or "").lower()
    if n == "multilogin":
        return MultiloginProvider()
    return MoreLoginProvider()

@app.route("/api/profiles/list", methods=["GET", "POST"])
def api_profiles_list():
    provider_name = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "morelogin"))
    body = request.get_json(silent=True) or {}
    page      = int(body.get("pageNo", 1))
    page_size = int(body.get("pageSize", 100))
    try:
        provider = _get_provider(provider_name)
        profiles = run_async(provider.list_profiles(page, page_size))
        return jsonify({
            "code": 0,
            "message": f"Fetched {len(profiles)} profiles",
            "data": {
                "profiles":  profiles,
                "total":     len(profiles),
                "page":      page,
                "pageSize":  page_size,
            },
        })
    except Exception as e:
        log.error("profiles/list error: %s", e)
        return jsonify({
            "code": -1,
            "message": str(e),
            "data": {"profiles": [], "total": 0, "page": 1, "pageSize": page_size},
        }), 200

@app.route("/api/profiles/list-all", methods=["GET", "POST"])
def api_profiles_list_all():
    body = request.get_json(silent=True) or {}
    page      = int(body.get("pageNo", 1))
    page_size = int(body.get("pageSize", 100))
    provider_name = os.getenv("BROWSER_PROVIDER", "morelogin")
    try:
        provider = _get_provider(provider_name)
        profiles = run_async(provider.list_profiles(page, page_size))
        return jsonify({
            "code": 0,
            "message": f"Fetched {len(profiles)} profiles",
            "data": {
                "profiles":  profiles,
                "total":     len(profiles),
                "page":      page,
                "pageSize":  page_size,
            },
        })
    except Exception as e:
        _append_log("error", "profiles", f"Profile list failed: {e}")
        return jsonify({
            "code": -1,
            "message": str(e),
            "data": {"profiles": [], "total": 0},
        }), 200

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
# WORKERS (running agents) — WorkerManager se live data
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/workers")
def api_workers():
    from server_python.worker_manager import worker_manager
    statuses = worker_manager.get_all_statuses()
    stats    = worker_manager.get_stats()
    return jsonify({"workers": statuses, "stats": stats})

# ══════════════════════════════════════════════════════════════════════════════
# SCHEDULES
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/schedules")
def api_schedules_get():
    raw = _load(SCHEDULES_FILE, {"schedules": []})
    # Handle legacy list format
    if isinstance(raw, list):
        data = {"schedules": raw}
    else:
        data = raw
    if not isinstance(data.get("schedules"), list):
        data["schedules"] = []
    return jsonify(data)

@app.route("/api/schedules", methods=["POST", "PUT"])
def api_schedules_post():
    body = request.get_json(silent=True) or {}
    raw = _load(SCHEDULES_FILE, {"schedules": []})
    # Handle legacy list format
    if isinstance(raw, list):
        data = {"schedules": raw}
    else:
        data = raw
    schedules = data.get("schedules", [])
    if not isinstance(schedules, list):
        schedules = []

    # PUT with a "schedules" array = full replace (syncSchedulesToServer)
    if request.method == "PUT" and "schedules" in body:
        data["schedules"] = body["schedules"]
        _save(SCHEDULES_FILE, data)
        return jsonify({"success": True, "count": len(body["schedules"])})

    # POST = upsert single schedule by id
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
    return jsonify({"timers": []})

@app.post("/api/schedule/timer/set")
def api_schedule_timer_set():
    return jsonify({"success": True})

@app.post("/api/schedule/timer/cancel")
def api_schedule_timer_cancel():
    return jsonify({"success": True})

# ══════════════════════════════════════════════════════════════════════════════
# SCHEDULE RUN — Main automation trigger (MMB-Agent-v2 + nodriver)
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/schedule/run")
def api_schedule_run():
    """
    Schedule / Shuffle run — har profile ke liye ek async worker spawn karo.
    Worker: MoreLogin/Multilogin → nodriver CDP → YouTubeAgent (same as Engagement).
    """
    from server_python.worker_manager import worker_manager
    import random as _random

    body     = request.get_json(silent=True) or {}
    schedule = body.get("schedule")
    if not schedule:
        return jsonify({"error": "schedule required"}), 400

    selected_profiles = schedule.get("selectedProfiles", [])
    if not selected_profiles:
        return jsonify({"error": "selectedProfiles required"}), 400

    assignment_mode  = schedule.get("assignmentMode", "same-all")
    same_for_all     = schedule.get("sameForAll", [])
    per_profile_data = schedule.get("perProfile", [])
    profile_configs  = schedule.get("profileConfigs", [])

    # Concurrency limit check
    settings = _load(SETTINGS_FILE, {})
    max_concurrent = int(settings.get("maxConcurrent", settings.get("ytMaxTotalAgents", 20)))
    current_stats  = worker_manager.get_stats()
    current_running = current_stats["running"]

    if current_running >= max_concurrent:
        return jsonify({
            "error": f"Max concurrent limit reached ({max_concurrent}). Currently {current_running} running.",
            "running": current_running,
            "limit": max_concurrent,
        }), 429

    spawned = 0
    skipped = 0

    for i, profile_id in enumerate(selected_profiles):
        # Videos nikalo
        videos = []
        if assignment_mode == "same-all":
            for cs in same_for_all:
                for v in cs.get("videos", []):
                    videos.append({
                        **v,
                        "channelName": cs.get("channelName", ""),
                    })
        else:
            pa = next(
                (p for p in per_profile_data if p.get("profileId") == profile_id),
                None,
            )
            if pa:
                for cs in pa.get("channelSelections", []):
                    for v in cs.get("videos", []):
                        videos.append({
                            **v,
                            "channelName": cs.get("channelName", ""),
                        })

        if not videos:
            skipped += 1
            _append_log("warn", "scheduler",
                        f"Profile {profile_id[-6:]} skipped — no videos")
            continue

        # Profile config nikalo
        pc = next(
            (p for p in profile_configs if p.get("profileId") == profile_id),
            {},
        )
        config = {
            # ── Core ──
            "browserType":       pc.get("browserType", settings.get("browserProvider", "multilogin")),
            "watchTimeMin":      int(pc.get("watchTimeMin", settings.get("ytWatchTimeMin", 40))),
            "watchTimeMax":      int(pc.get("watchTimeMax", settings.get("ytWatchTimeMax", 100))),
            "tabDelayMin":       int(schedule.get("tabDelayMin", 30)),
            "tabDelayMax":       int(schedule.get("tabDelayMax", 120)),
            "trafficPreference": pc.get("trafficPreference", "custom"),
            # ── Engagement actions ──
            "likeEnabled":       pc.get("likeEnabled", False),
            "subscribeEnabled":  pc.get("subscribeEnabled", False),
            "commentEnabled":    pc.get("commentEnabled", False),
            "bellEnabled":       pc.get("bellEnabled", False),
            "dislikeEnabled":    pc.get("dislikeEnabled", False),
            "descriptionLinks":  pc.get("descriptionLinks", False),
            "descriptionExpand": pc.get("descriptionExpand", True),
            "commentText":       pc.get("commentText", ""),
            # ── Playback ──
            "videoQuality":      pc.get("videoQuality", settings.get("ytVideoQuality", "auto")),
            "volumePct":         int(pc.get("volumePct", 75)),
            "adSkipEnabled":     pc.get("adSkipEnabled", True),
            "adSkipAfterSec":    int(pc.get("adSkipAfterSec", 5)),
            "midRollAdWaitSec":  int(pc.get("midRollAdWaitSec", 10)),
            # ── Human behavior ──
            "seekEnabled":       pc.get("seekEnabled", True),
            "seekDirection":     pc.get("seekDirection", "forward"),
            "pauseProbability":  float(pc.get("pauseProbability", 0.05)),
            "uniqueTypingPersonality": pc.get("uniqueTypingPersonality", True),
            "naturalScrollCurves":     pc.get("naturalScrollCurves", True),
            "scrollActivity":    pc.get("scrollActivity", True),
            "qualityChange":     pc.get("qualityChange", pc.get("qualityChangeEnabled", True)),
            "playbackSpeed":     pc.get("playbackSpeed", "1x"),
            "speedChange":       pc.get("speedChange", False),
            "captionsEnabled":   pc.get("captionsEnabled", False),
            "captionsToggle":    pc.get("captionsToggle", False),
            "trafficSource":     pc.get("trafficSource", "direct"),
        }

        # Staggered start delay
        delay_min = int(schedule.get("profileDelayMin", 5))
        delay_max = int(schedule.get("profileDelayMax", 20))
        start_delay = _random.randint(delay_min, delay_max) + (i * 3)

        profile_name = f"Profile-{profile_id[-4:]}"

        # Async worker spawn karo
        asyncio.run_coroutine_threadsafe(
            worker_manager.start_worker(
                profile_id, profile_name, videos, config, start_delay
            ),
            _loop,
        )
        spawned += 1

    schedule_name = schedule.get("name", "Schedule")
    _append_log("success", "scheduler",
                f'Started "{schedule_name}" — {spawned} worker(s) spawned'
                + (f", {skipped} skipped (no videos)" if skipped else ""))

    return jsonify({
        "success":        True,
        "workersSpawned": spawned,
        "skippedNoVideos": skipped,
        "message":        f'Schedule "{schedule_name}" started with {spawned} worker(s).',
        "limit":          max_concurrent,
        "running":        current_running,
    })

@app.post("/api/schedule/stop")
def api_schedule_stop():
    from server_python.worker_manager import worker_manager
    body = request.get_json(silent=True) or {}
    schedule_id  = body.get("scheduleId", "")
    profile_ids  = body.get("profileIds", [])

    if profile_ids:
        # Specific profiles band karo
        worker_manager.stop_schedule_workers(profile_ids)
    else:
        # Sab band karo
        asyncio.run_coroutine_threadsafe(worker_manager.stop_all(), _loop)

    _append_log("warn", "scheduler", f"Schedule stopped | id={schedule_id}")
    return jsonify({"success": True})

@app.get("/api/schedule/progress")
def api_schedule_progress():
    from server_python.worker_manager import worker_manager
    profile_ids_raw = request.args.get("profileIds", "")
    profile_ids = [p.strip() for p in profile_ids_raw.split(",") if p.strip()]
    if profile_ids:
        raw = worker_manager.get_stats_for_profiles(profile_ids)
    else:
        raw = worker_manager.get_stats()
    # Frontend (fetchScheduleProgress) expects { stats: { total, running, done, error, waiting } }
    stats = {
        "total":   raw.get("total",   0),
        "running": raw.get("running", 0),
        "done":    raw.get("done",    0),
        "error":   raw.get("error",   raw.get("failed", 0)),
        "waiting": raw.get("waiting", raw.get("pending", 0)),
    }
    return jsonify({"stats": stats, **raw})

@app.get("/api/concurrency")
def api_concurrency_get():
    from server_python.worker_manager import worker_manager
    settings = _load(SETTINGS_FILE, {})
    limit    = int(settings.get("maxConcurrent", settings.get("ytMaxTotalAgents", 20)))
    stats    = worker_manager.get_stats()
    running  = stats["running"]
    return jsonify({
        "limit":     limit,
        "running":   running,
        "available": max(0, limit - running),
        "workers":   stats,
    })

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
    body             = request.get_json(silent=True) or {}
    profiles_data    = body.get("profiles", [])
    if not profiles_data:
        return jsonify({"code": -1, "message": "profiles required"}), 400

    global_watch_pct = body.get("watchPct", 85)
    global_ad_skip   = body.get("adSkipEnabled", True)
    global_quality   = body.get("videoQuality", "auto")
    global_ad_delay  = body.get("adSkipDelaySec", 5)
    global_ad_delay_max = body.get("adSkipDelayMaxSec", 15)

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

        job = {
            "id":           str(uuid.uuid4()),
            "profileId":    profile_id,
            "profileName":  profile_name,
            "browserType":  browser_type,
            "status":       "pending",
            "source":       source,
            "scheduledAt":  int(time.time() * 1000) + delay_ms,
            "startedAt":    None,
            "finishedAt":   None,
            "error":        None,
            "log":          [],
            "actions":      actions,
            "videos":       videos,
            "watchPct":     watch_pct,
            "adSkipEnabled": global_ad_skip,
            "adSkipDelaySec": global_ad_delay,
            "adSkipDelayMaxSec": global_ad_delay_max,
            "videoQuality": global_quality,
            "videoCount":   len(videos),
            "videosOk":     0,
            "videosFailed": 0,
        }
        _engagement_jobs.append(job)
        job_ids.append(job["id"])

        # Auto-trim old completed jobs to prevent memory leak (keep max 200)
        if len(_engagement_jobs) > 200:
            # Remove oldest done/failed/cancelled jobs
            done_indices = [i for i, j in enumerate(_engagement_jobs)
                           if j.get("status") in ("done", "failed", "cancelled", "partial")]
            for idx in done_indices[:len(_engagement_jobs) - 150]:
                _engagement_jobs[idx] = None  # type: ignore
            _engagement_jobs[:] = [j for j in _engagement_jobs if j is not None]

        # Fire async execution with stagger delay — store task ref for cancellation
        future = asyncio.run_coroutine_threadsafe(
            _run_engagement_job(job, delay_ms / 1000.0),
            _loop,
        )
        job["_future"] = future

    _append_log("info", "engagement", f"Queued {len(job_ids)} engagement jobs")
    return jsonify({"code": 0, "message": f"Queued {len(job_ids)} engagement jobs", "jobIds": job_ids})


async def _run_engagement_job(job: dict, delay_sec: float = 0.0):
    """
    Engagement job async runner.
    Opens browser → connects CDP → watches each video with full engagement actions.
    Updates job dict in-place (polled by /api/engagement/status).
    """
    import re as _re
    import random as _rand

    from server_python.agent_manager import YouTubeAgent
    from server_python.providers.morelogin  import MoreLoginProvider
    from server_python.providers.multilogin import MultiloginProvider

    profile_id = job["profileId"]
    provider   = None

    def _job_log(msg: str):
        entry = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "msg": msg}
        job["log"].append(entry)
        log.info("[Engagement][%s] %s", profile_id[:8], msg)

    try:
        # ── Stagger delay ──────────────────────────────────────────────────────
        if delay_sec > 0:
            _job_log(f"Starting in {delay_sec:.0f}s…")
            await asyncio.sleep(delay_sec)

        job["status"]    = "running"
        job["startedAt"] = int(time.time() * 1000)
        _job_log("Connecting to browser…")
        _append_log("info", "engagement", f"[{profile_id[:8]}] Job started")

        # ── Open browser ───────────────────────────────────────────────────────
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

        # ── Create agent + connect ─────────────────────────────────────────────
        actions = job.get("actions") or {}
        agent_settings = {
            "videoQuality": job.get("videoQuality", "auto"),
            "honestTest": actions.get("honestTest", job.get("honestTest", False)),
            "profileName": job.get("profileName", ""),
        }
        # Pass _job_log so ALL internal agent logs appear in the UI job card
        agent = YouTubeAgent(profile_id, cdp_port, agent_settings, log_fn=_job_log)
        await agent.connect_cdp(cdp_endpoint)
        _job_log("nodriver connected ✓")
        await agent.warm_up()

        # ── Build engagement dict — FULL settings pass-through ────────────────
        engagement = {
            # Core engagement actions (from EngagementPage per-profile overrides)
            "like":              actions.get("like", False),
            "dislike":           actions.get("dislike", False),
            "subscribe":         actions.get("subscribe", False),
            "bell":              actions.get("bell", False),
            "comment":           actions.get("comment", False),
            "commentText":       actions.get("commentText", ""),
            "descriptionLinks":  actions.get("descriptionLinks", False),
            "descriptionExpand": actions.get("descriptionExpand", True),
            # Playback settings
            "videoQuality":      job.get("videoQuality", "auto"),
            "adSkipEnabled":     job.get("adSkipEnabled", True),
            "adSkipDelaySec":    job.get("adSkipDelaySec", 5),
            "adSkipDelayMaxSec": job.get("adSkipDelayMaxSec", 15),
            "volumePct":         actions.get("volumePct", 75),
            "commentLikePct":    actions.get("commentLikePct", 0),
            # Human behavior settings
            "seekEnabled":       actions.get("seekEnabled", True),
            "seekDirection":     actions.get("seekDirection", "forward"),
            "pauseProbability":  actions.get("pauseProbability", 0.05),
            "pauseHoldSec":      actions.get("pauseHoldSec", 0),
            "uniqueTypingPersonality": True,
            "naturalScrollCurves":     True,
            "scrollActivity":    actions.get("scrollActivity", True),
            "qualityChange":     actions.get("qualityChange", actions.get("qualityChangeEnabled", True)),
            "playbackSpeed":     actions.get("playbackSpeed", job.get("playbackSpeed", "1x")),
            "speedChange":       actions.get("speedChange", False),
            "captionsEnabled":   actions.get("captionsEnabled", False),
            "captionsToggle":    actions.get("captionsToggle", False),
            "honestTest":        actions.get("honestTest", job.get("honestTest", False)),
            "profileName":       job.get("profileName", ""),
        }

        # ── Watch each video ───────────────────────────────────────────────────
        videos    = job.get("videos") or []
        watch_pct = float(job.get("watchPct", 85)) / 100.0
        source    = (job.get("source") or "direct").strip().lower()
        videos_ok = 0
        videos_fail = 0

        for i, video in enumerate(videos):
            if job.get("status") != "running":
                _job_log("Job stopped (cancelled or not running)")
                break

            url   = video.get("url", "")
            title = video.get("title", "")
            ch    = video.get("channelName", "")

            # Extract video_id from YouTube URL (supports youtube.com and youtu.be)
            m = _re.search(r"[?&]v=([^&]+)", url) or _re.search(r"youtu\.be/([^?&/]+)", url)
            raw_id = m.group(1) if m else (url.strip() if len(url.strip()) == 11 else "")
            video_id = raw_id[:11] if raw_id else ""

            if not video_id:
                videos_fail += 1
                _job_log(f"✗ Video {i+1}: invalid URL (no video_id) — {url[:60]!r}")
                continue

            _job_log(f"▶ Video {i+1}/{len(videos)} [{source}]: {title or video_id}")

            try:
                ok = await agent.watch_video_organic(
                    video_id=video_id,
                    title_hint=title,
                    channel_name=ch,
                    watch_pct=watch_pct,
                    engagement=engagement,
                    source=source,
                    session_nonce=f"{job.get('id', '')}|v{i}",
                )
                if ok:
                    videos_ok += 1
                    _job_log(f"✓ Video {i+1}: watched successfully")
                else:
                    videos_fail += 1
                    _job_log(f"✗ Video {i+1}: watch failed (see logs above)")
            except asyncio.CancelledError:
                raise
            except Exception as ve:
                videos_fail += 1
                _job_log(f"✗ Video {i+1} error: {ve}")

            job["videosOk"] = videos_ok
            job["videosFailed"] = videos_fail

            # Inter-video human delay
            if i < len(videos) - 1 and job.get("status") == "running":
                gap = _rand.uniform(12.0, 35.0)
                _job_log(f"Gap {gap:.0f}s before next video…")
                await asyncio.sleep(gap)

        job["videosOk"] = videos_ok
        job["videosFailed"] = videos_fail
        job["finishedAt"] = int(time.time() * 1000)

        if job.get("status") == "cancelled":
            _job_log(f"Cancelled — {videos_ok} ok, {videos_fail} failed")
            _append_log("warn", "engagement", f"[{profile_id[:8]}] Job cancelled")
        elif videos_fail == 0 and videos_ok > 0:
            job["status"] = "done"
            _job_log(f"✅ All {videos_ok} video(s) done")
            _append_log("success", "engagement", f"[{profile_id[:8]}] Job complete ({videos_ok} videos)")
        elif videos_ok == 0:
            job["status"] = "failed"
            job["error"] = job.get("error") or f"All {videos_fail} video(s) failed"
            _job_log(f"❌ All videos failed ({videos_fail})")
            _append_log("error", "engagement", f"[{profile_id[:8]}] Job failed — 0 videos watched")
        else:
            job["status"] = "partial"
            job["error"] = f"{videos_ok} ok, {videos_fail} failed"
            _job_log(f"⚠ Partial: {videos_ok} ok, {videos_fail} failed")
            _append_log("warn", "engagement", f"[{profile_id[:8]}] Partial ({videos_ok}/{videos_ok + videos_fail})")

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
        # Close agent (nodriver session) BEFORE stopping browser provider
        try:
            if 'agent' in locals() and agent is not None:
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
            from behavior.youtube.action_audit import ActionAudit
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


@app.get("/api/engagement/status")
def api_engagement_status():
    jobs = _engagement_jobs
    counts = {s: sum(1 for j in jobs if j.get("status") == s)
              for s in ("pending", "running", "done", "failed", "cancelled", "partial")}
    # Strip non-serializable keys (_future) before returning
    safe_jobs = [{k: v for k, v in j.items() if not k.startswith("_")} for j in jobs]
    return jsonify({"code": 0, "data": {
        "jobs": safe_jobs,
        "total": len(jobs),
        **counts,
    }})

@app.post("/api/engagement/cancel")
def api_engagement_cancel():
    cancelled_count = 0
    for job in _engagement_jobs:
        if job.get("status") in ("pending", "running"):
            job["status"] = "cancelled"
            cancelled_count += 1
            # Actually cancel the running async task
            future = job.get("_future")
            if future and not future.done():
                future.cancel()
    _append_log("warn", "engagement", f"Cancelled {cancelled_count} engagement jobs")
    return jsonify({"code": 0, "cancelled": cancelled_count})

@app.post("/api/engagement/clear")
def api_engagement_clear():
    # Cancel any still-running tasks first
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
    status = _agent_manager.get_recycle_status()
    return jsonify(status)

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
        if fut:
            status = fut.result(timeout=15)
        else:
            status = _agent_manager.get_recycle_status()
    except Exception as e:
        log.error("Recycle start failed: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500

    _append_log("success", "recycle", f"24/7 loop started — {len(profiles)} profile(s)")
    return jsonify({"success": True, "status": status})

@app.post("/api/recycle/stop")
def api_recycle_stop():
    body = request.get_json(silent=True) or {}
    slot_id = body.get("slotId") or None
    profile_id = body.get("profileId") or None
    _agent_manager.stop_recycle(slot_id=slot_id, profile_id=profile_id)
    status = _agent_manager.get_recycle_status()
    if not slot_id and not profile_id:
        _append_log("info", "recycle", "24/7 loop stopped")
    return jsonify({"success": True, "status": status})

@app.post("/api/recycle/pause")
def api_recycle_pause():
    _agent_manager.pause_recycle()
    status = _agent_manager.get_recycle_status()
    _append_log("info", "recycle", "24/7 loop paused")
    return jsonify({"success": True, "status": status})

@app.post("/api/recycle/resume")
def api_recycle_resume():
    _agent_manager.resume_recycle()
    status = _agent_manager.get_recycle_status()
    _append_log("info", "recycle", "24/7 loop resumed")
    return jsonify({"success": True, "status": status})

# ══════════════════════════════════════════════════════════════════════════════
# SHUFFLE / WATCH HISTORY
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/shuffle/state")
def api_shuffle_state_get():
    data = _load(SHUFFLE_FILE, {})
    return jsonify(data)

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
        # Clear per-profile history file (data/watch_history/*.json)
        try:
            clear_history(profile_id)
        except Exception as e:
            log.warning("clear_history error for %s: %s", profile_id[:8], e)
        # Also clear from watch_history.json (legacy flat dict)
        history = _load(WATCH_HISTORY_FILE, {})
        if profile_id in history:
            del history[profile_id]
            _save(WATCH_HISTORY_FILE, history)
        return jsonify({"code": 0, "message": "Watch history cleared"})

    # GET — return entries in format VideoShufflePage expects:
    # { code: 0, data: [{videoId, watchedAt, videoTitle}, ...] }
    entries = get_watched_entries(profile_id)
    # Also merge any legacy entries from flat watch_history.json
    legacy = _load(WATCH_HISTORY_FILE, {})
    legacy_entries = legacy.get(profile_id, [])
    legacy_ids = {e.get("videoId") for e in entries}
    for le in legacy_entries:
        if isinstance(le, dict):
            vid = le.get("videoId") or le.get("video_id", "")
            if vid and vid not in legacy_ids:
                entries.append({
                    "videoId": vid,
                    "watchedAt": le.get("watchedAt", 0),
                    "videoTitle": le.get("videoTitle", le.get("title", "")),
                })
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

def _filter_events(events: list, filter_name: str) -> list:
    """Filter events list by time range."""
    now = time.time() * 1000  # ms
    if filter_name == "today":
        import datetime
        today = datetime.date.today()
        start = int(datetime.datetime(today.year, today.month, today.day).timestamp() * 1000)
        return [e for e in events if e.get("time", 0) >= start]
    elif filter_name == "yesterday":
        import datetime
        today = datetime.date.today()
        import datetime as dt
        yesterday = today - dt.timedelta(days=1)
        start = int(datetime.datetime(yesterday.year, yesterday.month, yesterday.day).timestamp() * 1000)
        end   = int(datetime.datetime(today.year, today.month, today.day).timestamp() * 1000)
        return [e for e in events if start <= e.get("time", 0) < end]
    elif filter_name == "7d":
        cutoff = (time.time() - 7 * 86400) * 1000
        return [e for e in events if e.get("time", 0) >= cutoff]
    elif filter_name == "30d":
        cutoff = (time.time() - 30 * 86400) * 1000
        return [e for e in events if e.get("time", 0) >= cutoff]
    return events  # "all"

@app.get("/api/analytics")
def api_analytics():
    filter_name = request.args.get("filter", "today")
    raw = _load(ANALYTICS_FILE, {"events": [], "perProfile": {}})
    events = raw.get("events", [])
    if not isinstance(events, list):
        events = []

    filtered = _filter_events(events, filter_name)

    # Aggregate
    result = _analytics_empty_response(filter_name)
    per_profile: dict = {}
    daily: dict = {}

    for e in filtered:
        pid     = e.get("profileId", "")
        action  = e.get("action", "")
        val     = float(e.get("value", 1) or 1)
        ts_ms   = e.get("time", 0)

        # Daily trend key (YYYY-MM-DD)
        try:
            import datetime
            day_key = datetime.datetime.fromtimestamp(ts_ms / 1000).strftime("%Y-%m-%d")
        except Exception:
            day_key = "unknown"

        if day_key not in daily:
            daily[day_key] = {"date": day_key, "views": 0, "watchTime": 0}

        if pid not in per_profile:
            per_profile[pid] = {"views": 0, "watchTime": 0, "likes": 0, "subscribes": 0, "comments": 0}

        if action == "view":
            result["totalViews"]   += 1
            result["totalSessions"] += 1
            per_profile[pid]["views"] += 1
            daily[day_key]["views"]   += 1
        elif action == "watchTime":
            result["totalWatchTime"]    += val
            per_profile[pid]["watchTime"] += val
            daily[day_key]["watchTime"]   += val
        elif action == "like":
            result["totalLikes"] += 1
            per_profile[pid]["likes"] += 1
        elif action == "subscribe":
            result["totalSubscribes"] += 1
            per_profile[pid]["subscribes"] += 1
        elif action == "comment":
            result["totalComments"] += 1
            per_profile[pid]["comments"] += 1
        elif action == "ads_total":
            result["totalAds"] += 1
        elif action == "ads_skipped":
            result["adsSkipped"] += 1
        elif action == "ads_watched_full":
            result["adsWatchedFull"] += 1
        elif action == "ad_watch_time":
            result["adWatchTime"] += val
        elif action in ("traffic_youtube-search", "traffic_youtube"):
            result["trafficYouTube"] += 1
        elif action == "traffic_google":
            result["trafficGoogle"] += 1
        elif action == "traffic_bing":
            result["trafficBing"] += 1
        elif action in ("traffic_direct", "traffic_direct-fallback"):
            result["trafficDirect"] += 1
        elif action in ("traffic_channel-page", "traffic_channel"):
            result["trafficChannel"] += 1
        elif action in ("traffic_backlink", "traffic_backlink-direct-fallback"):
            result["trafficBacklink"] += 1

    result["perProfile"]    = per_profile
    result["recentActivity"] = filtered[-50:] if filtered else []
    result["dailyTrend"]    = sorted(daily.values(), key=lambda x: x["date"])
    return jsonify(result)

@app.post("/api/analytics/record")
def api_analytics_record():
    """Bot calls this after each video watch to record events."""
    body   = request.get_json(silent=True) or {}
    pid    = body.get("profileId", "")
    action = body.get("action", "")
    value  = body.get("value", 1)
    ts     = body.get("time") or int(time.time() * 1000)
    detail = body.get("detail", "")

    if not pid or not action:
        return jsonify({"error": "profileId and action required"}), 400

    from server_python.analytics_store import record_events
    record_events([{
        "time": ts, "profileId": pid, "action": action,
        "value": value, "detail": detail,
    }])
    return jsonify({"success": True})

@app.post("/api/analytics/record-batch")
def api_analytics_record_batch():
    """Batch record multiple events at once."""
    body   = request.get_json(silent=True) or {}
    new_events = body.get("events", [])
    if not isinstance(new_events, list) or not new_events:
        return jsonify({"error": "events array required"}), 400

    from server_python.analytics_store import record_events
    record_events(new_events)
    return jsonify({"success": True, "recorded": len(new_events)})

@app.post("/api/analytics/reset-today-engagement")
def api_analytics_reset():
    """Reset today's events (engagement only)."""
    import datetime
    today = datetime.date.today()
    start = int(datetime.datetime(today.year, today.month, today.day).timestamp() * 1000)
    raw = _load(ANALYTICS_FILE, {"events": []})
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
    level  = request.args.get("level", "")
    source = request.args.get("source", "")
    limit  = int(request.args.get("limit", 200))

    logs = _load(ACTIVITY_LOG_FILE, [])
    if not isinstance(logs, list):
        logs = []

    if level:
        logs = [l for l in logs if l.get("level") == level]
    if source:
        logs = [l for l in logs if l.get("source") == source]

    entries = logs[-limit:]
    # Count by level for stats
    stats = {"info": 0, "warn": 0, "error": 0, "success": 0}
    for l in entries:
        lvl = l.get("level", "info")
        if lvl in stats:
            stats[lvl] += 1

    return jsonify({
        "entries":  entries,           # frontend expects 'entries' not 'logs'
        "total":    len(logs),
        "filtered": len(entries),
        "stats":    stats,
    })

@app.post("/api/logs")
def api_logs_post():
    body = request.get_json(silent=True) or {}
    _append_log(
        body.get("level", "info"),
        body.get("source", "ui"),
        body.get("message", ""),
    )
    return jsonify({"success": True})

@app.delete("/api/logs")
def api_logs_delete():
    _save(ACTIVITY_LOG_FILE, [])
    _log_lines.clear()
    return jsonify({"success": True})

# ══════════════════════════════════════════════════════════════════════════════
# SETTINGS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/settings")
def api_settings_get():
    data = _load(SETTINGS_FILE, {})
    # Merge .env values
    data.setdefault("proxyServer",     os.getenv("PROXY_SERVER", "us.smartproxy.net"))
    data.setdefault("proxyPort",       int(os.getenv("PROXY_PORT", 3120)))
    data.setdefault("proxyPassword",   os.getenv("PROXY_PASSWORD", ""))
    data.setdefault("proxyPrefix",     os.getenv("PROXY_PREFIX", ""))
    data.setdefault("moreloginApiKey", os.getenv("MORELOGIN_API_KEY", ""))
    data.setdefault("moreloginPort",   int(os.getenv("MORELOGIN_PORT", 40000)))
    data.setdefault("multiloginToken", os.getenv("MULTILOGIN_TOKEN", ""))
    data.setdefault("browserProvider", os.getenv("BROWSER_PROVIDER", "multilogin"))
    # Frontend fetchSettingsFromServer expects: { success: true, settings: {...} }
    return jsonify({"success": True, "settings": data})

@app.post("/api/settings")
def api_settings_post():
    body = request.get_json(silent=True) or {}
    data = _load(SETTINGS_FILE, {})
    data.update(body)
    _save(SETTINGS_FILE, data)
    # Never wipe .env secrets when UI sends empty strings (e.g. masked key fields)
    if "moreloginApiKey" in body and str(body["moreloginApiKey"]).strip():
        os.environ["MORELOGIN_API_KEY"] = body["moreloginApiKey"]
    if "multiloginToken" in body and str(body["multiloginToken"]).strip():
        os.environ["MULTILOGIN_TOKEN"] = body["multiloginToken"]
    if "proxyPassword" in body and str(body["proxyPassword"]).strip():
        os.environ["PROXY_PASSWORD"] = body["proxyPassword"]
    if "proxyPrefix" in body and str(body["proxyPrefix"]).strip():
        os.environ["PROXY_PREFIX"] = body["proxyPrefix"]
    if "proxyServer" in body and str(body["proxyServer"]).strip():
        from server_python.smart_proxy import normalize_proxy_server
        os.environ["PROXY_SERVER"] = normalize_proxy_server(str(body["proxyServer"]))
        if body.get("proxyServer") and "proxy.smartproxy" in str(body["proxyServer"]).lower():
            data["proxyServer"] = "us.smartproxy.net"
    if "proxyPort" in body and str(body["proxyPort"]).strip():
        os.environ["PROXY_PORT"] = str(body["proxyPort"])
    if "defaultProxyLife" in body and str(body["defaultProxyLife"]).strip():
        os.environ["DEFAULT_PROXY_LIFE"] = str(body["defaultProxyLife"])
    try:
        from server_python.smart_proxy import reset_proxy_manager
        reset_proxy_manager()
    except Exception:
        pass
    if "browserProvider" in body and str(body["browserProvider"]).strip():
        os.environ["BROWSER_PROVIDER"] = body["browserProvider"]
    _append_log("info", "settings", "Settings updated")
    return jsonify({"success": True, "settings": data})

@app.post("/api/settings/test/morelogin")
def api_settings_test_morelogin():
    body = request.get_json(silent=True) or {}
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
    token = body.get("token") or os.getenv("MULTILOGIN_TOKEN", "")
    try:
        provider = MultiloginProvider(token=token)
        profiles = run_async(provider.list_profiles())
        return jsonify({"success": True, "message": f"Connected! {len(profiles)} profiles found."})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

@app.post("/api/settings/multilogin/fetch-token")
def api_multilogin_fetch_token():
    body = request.get_json(silent=True) or {}
    email    = body.get("email", "")
    password = body.get("password", "")
    try:
        provider = MultiloginProvider()
        token = run_async(provider.fetch_token(email, password))
        return jsonify({"success": True, "token": token})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

# ══════════════════════════════════════════════════════════════════════════════
# NOTIFICATIONS TEST
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/notifications/test")
def api_notifications_test():
    body = request.get_json(silent=True) or {}
    bot_token = body.get("telegramBotToken") or os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id   = body.get("telegramChatId")   or os.getenv("TELEGRAM_CHAT_ID", "")
    if not bot_token or not chat_id:
        return jsonify({"success": False, "message": "Telegram bot token aur chat ID required hai"})
    import urllib.request as _ur
    try:
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = json.dumps({"chat_id": chat_id, "text": "✅ MMB Agent notification test successful!"}).encode()
        req = _ur.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with _ur.urlopen(req, timeout=10) as r:
            r.read()
        return jsonify({"success": True, "message": "Test message sent!"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

# ══════════════════════════════════════════════════════════════════════════════
# PROVIDER PING — Sidebar "Browser: Connected/Disconnected" check
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/providers/ping")
def api_providers_ping():
    """Multilogin/MoreLogin local launcher ping karo."""
    import socket
    provider = request.args.get("provider", os.getenv("BROWSER_PROVIDER", "multilogin")).lower()

    if provider == "multilogin":
        # Multilogin launcher port 45001
        host, port = "127.0.0.1", 45001
    else:
        # MoreLogin port 40000
        host = "127.0.0.1"
        port = int(os.getenv("MORELOGIN_PORT", 40000))

    try:
        s = socket.create_connection((host, port), timeout=3)
        s.close()
        return jsonify({"code": 0, "message": f"{provider} launcher connected on port {port}"})
    except Exception as e:
        return jsonify({"code": -1, "message": f"{provider} launcher not reachable on port {port}: {str(e)}"})


# ══════════════════════════════════════════════════════════════════════════════
# COOKIES STATUS — Settings page "Backend offline" check
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/cookies/status", methods=["GET", "POST"])
def api_cookies_status():
    # Frontend checks cookiePool.sets.length — sets array zaroori hai
    return jsonify({
        "code": 0,
        "status": "ok",
        "message": "Backend running",
        "sets": [],           # Cookie sets list (empty = no cookies imported yet)
        "total": 0,
    })

# ══════════════════════════════════════════════════════════════════════════════
# PROXY CHECK
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
        for url in (
            "http://ip-api.com/json/?fields=status,query,country,city",
            "http://ip-api.com/json",
        ):
            try:
                r = requests.get(url, proxies=proxies, timeout=25, headers=headers)
                if r.status_code != 200:
                    last_err = f"HTTP {r.status_code}"
                    continue
                data = r.json()
                if data.get("status") == "success":
                    ip = data.get("query")
                    city = data.get("city")
                    country = data.get("country")
                    break
            except Exception as e:
                last_err = str(e)
        if not ip:
            try:
                r = requests.get(
                    "http://ifconfig.me/ip",
                    proxies=proxies,
                    timeout=20,
                    headers=headers,
                )
                if r.status_code == 200 and r.text.strip():
                    ip = r.text.strip().split()[0]
            except Exception as e:
                last_err = str(e)
        speed = int((time.time() - start) * 1000)
        if not ip:
            return jsonify({"success": False, "error": last_err or "proxy check failed", "speed": speed})
        return jsonify({
            "success": True,
            "ip": ip,
            "city": city,
            "country": country,
            "speed": speed,
            "username": user,
            "server": server,
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "speed": int((time.time() - start) * 1000)})

# ══════════════════════════════════════════════════════════════════════════════
# CHANNELS / COMMENTS / PROFILE CONFIGS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/channels-data")
def api_channels_get():
    data = _load(CHANNELS_FILE, {"channels": [], "videos": [], "playlists": []})
    data.setdefault("channels", [])
    data.setdefault("videos", [])
    data.setdefault("playlists", [])
    return jsonify(data)

@app.route("/api/channels-data", methods=["POST", "PUT"])
def api_channels_post():
    body = request.get_json(silent=True) or {}
    _save(CHANNELS_FILE, body)
    return jsonify({"success": True})

@app.get("/api/comments")
def api_comments_get():
    data = _load(COMMENTS_FILE, [])
    if isinstance(data, list):
        comments = data
    else:
        comments = data.get("comments") or data.get("templates") or []
    return jsonify({"success": True, "comments": comments})

@app.route("/api/comments", methods=["POST", "PUT"])
def api_comments_post():
    body = request.get_json(silent=True) or {}
    comments = body.get("comments", body.get("templates", []))
    _save(COMMENTS_FILE, {"comments": comments})
    return jsonify({"success": True})

@app.get("/api/profile-configs")
def api_profile_configs_get():
    data = _load(SETTINGS_FILE, {})
    configs = data.get("profileConfigs", [])
    # Convert list → dict keyed by id (frontend expects data.configs object)
    if isinstance(configs, list):
        configs_dict = {c["id"]: c for c in configs if "id" in c}
    else:
        configs_dict = configs
    return jsonify({"success": True, "configs": configs_dict})

@app.get("/api/profile-config/<profile_id>")
def api_profile_config_get(profile_id: str):
    data = _load(SETTINGS_FILE, {})
    configs = data.get("profileConfigs", [])
    cfg = next((c for c in configs if c.get("id") == profile_id), {})
    return jsonify(cfg)

@app.post("/api/profile-config/<profile_id>")
def api_profile_config_post(profile_id: str):
    body = request.get_json(silent=True) or {}
    data = _load(SETTINGS_FILE, {})
    configs = data.get("profileConfigs", [])
    idx = next((i for i, c in enumerate(configs) if c.get("id") == profile_id), None)
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

BACKLINKS_FILE = ROOT / "backlinks_data.json"

@app.get("/api/backlinks")
def api_backlinks_get():
    return jsonify(_load(BACKLINKS_FILE, {"links": [], "manualAssign": {}}))

@app.post("/api/backlinks")
def api_backlinks_post():
    body = request.get_json(silent=True) or {}
    _save(BACKLINKS_FILE, body)
    return jsonify({"success": True})

@app.get("/api/orchestrator/status")
def api_orchestrator_status():
    """Return current hour weight + RAM info for UI display."""
    try:
        from server_python.orchestrator import Orchestrator, HOURLY_WEIGHTS
        import datetime
        hour = datetime.datetime.now().hour
        weight = HOURLY_WEIGHTS.get(hour, 0.5)
        ram_info = {}
        try:
            import psutil
            vm = psutil.virtual_memory()
            ram_info = {
                "percent": round(vm.percent, 1),
                "available_gb": round(vm.available / 1e9, 2),
                "total_gb": round(vm.total / 1e9, 2),
            }
        except ImportError:
            ram_info = {"percent": None, "note": "psutil not installed"}
        return jsonify({
            "current_hour": hour,
            "hour_weight": weight,
            "peak_hour": 19,
            "ram": ram_info,
            "hourly_weights": HOURLY_WEIGHTS,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# MISSING ENDPOINTS — Saare stubs (frontend crash rokne ke liye)
# ══════════════════════════════════════════════════════════════════════════════

# ── Android devices ───────────────────────────────────────────────────────────
@app.get("/api/android-devices")
def api_android_devices():
    return jsonify({"code": 0, "devices": []})

# ── Cookies (extended) ────────────────────────────────────────────────────────
@app.post("/api/cookies/import")
def api_cookies_import():
    return jsonify({"code": 0, "message": "Not implemented"})

@app.post("/api/cookies/clear")
def api_cookies_clear():
    return jsonify({"code": 0, "message": "Cleared"})

@app.get("/api/cookies/metadata")
def api_cookies_metadata():
    return jsonify({"code": 0, "metadata": {}})

@app.route("/api/cookies/set/<set_id>", methods=["GET", "DELETE"])
def api_cookies_set(set_id: str):
    return jsonify({"code": 0})

# ── Gmail Login Manager ───────────────────────────────────────────────────────
_gmail_jobs: list = []

@app.get("/api/gmail-login/status")
def api_gmail_status():
    return jsonify({"code": 0, "data": {"jobs": _gmail_jobs, "running": False}})

@app.post("/api/gmail-login/start")
def api_gmail_start():
    return jsonify({"code": 0, "message": "Gmail login not implemented yet"})

@app.post("/api/gmail-login/stop")
def api_gmail_stop():
    return jsonify({"code": 0})

@app.post("/api/gmail-login/clear")
def api_gmail_clear():
    _gmail_jobs.clear()
    return jsonify({"code": 0})

@app.post("/api/gmail-login/mark-done/<job_id>")
def api_gmail_mark_done(job_id: str):
    return jsonify({"code": 0})

@app.post("/api/gmail-login/retry/<job_id>")
def api_gmail_retry(job_id: str):
    return jsonify({"code": 0})

@app.post("/api/gmail-login/skip/<job_id>")
def api_gmail_skip(job_id: str):
    return jsonify({"code": 0})

# ── Watch History (alternate path) ───────────────────────────────────────────
@app.get("/api/history/<profile_id>")
def api_history(profile_id: str):
    history = _load(WATCH_HISTORY_FILE, {})
    return jsonify({"code": 0, "history": history.get(profile_id, [])})

# ── Manual Control ────────────────────────────────────────────────────────────
@app.post("/api/manual/start")
def api_manual_start():
    body = request.get_json(silent=True) or {}
    profile_id = body.get("profileId", "")
    _workers[profile_id] = {"profileId": profile_id, "status": "pending", "startedAt": int(time.time() * 1000)}
    return jsonify({"code": 0, "message": f"Profile {profile_id} queued"})

@app.post("/api/manual/batch")
def api_manual_batch():
    body = request.get_json(silent=True) or {}
    profiles = body.get("profiles", [])
    for p in profiles:
        pid = p.get("profileId") or p.get("id", "")
        if pid:
            _workers[pid] = {"profileId": pid, "status": "pending", "startedAt": int(time.time() * 1000)}
    return jsonify({"code": 0, "message": f"Queued {len(profiles)} profiles"})

# ── Workers extended ─────────────────────────────────────────────────────────
@app.post("/api/workers/clear-completed")
def api_workers_clear_completed():
    from server_python.worker_manager import worker_manager
    worker_manager.clear_completed()
    return jsonify({"code": 0})

@app.post("/api/workers/stop/<profile_id>")
def api_workers_stop(profile_id: str):
    from server_python.worker_manager import worker_manager
    asyncio.run_coroutine_threadsafe(
        worker_manager.stop_worker(profile_id), _loop
    )
    return jsonify({"code": 0})

# ── Proxy rotate ──────────────────────────────────────────────────────────────
@app.post("/api/proxy/rotate")
def api_proxy_rotate():
    return jsonify({"code": 0, "message": "Proxy rotated"})

# ══════════════════════════════════════════════════════════════════════════════
# ACCOUNTS (Gmail auto-creation via 5sim OTP)
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/accounts/create")
def api_accounts_create():
    """
    Create a Gmail account for a profile using 5sim OTP.
    Body: { "profileId": "...", "country": "usa" }
    Requires the profile's browser tab to already be open (via MoreLogin/Multilogin).
    """
    body       = request.get_json(silent=True) or {}
    profile_id = body.get("profileId") or body.get("profile_id")
    country    = body.get("country", "usa")

    if not profile_id:
        return jsonify({"success": False, "error": "profileId required"}), 400

    provider_name = schedule_provider = (
        body.get("provider") or os.getenv("BROWSER_PROVIDER", "morelogin")
    )

    async def _do_create():
        from server_python.account_manager import get_account_manager
        from server_python.agent_manager import AgentManager
        mgr      = get_account_manager()
        provider = _get_provider(provider_name)

        # Start profile browser
        result = await provider.start_profile(profile_id)
        debug_port = (
            result.get("data", {}).get("remoteDebuggingPort")
            or result.get("remoteDebuggingPort")
        )
        if not debug_port:
            return {"success": False, "error": "Could not get debug port from browser"}

        import nodriver as uc
        browser = await uc.Browser.create(browser_args=[f"--remote-debugging-port={debug_port}"])
        tab     = await browser.get("about:blank")

        account = await mgr.create_gmail_account(tab, profile_id, country)

        try:
            await browser.close()
        except Exception:
            pass

        if account:
            return {"success": True, "account": account.to_dict()}
        return {"success": False, "error": "Account creation failed — check logs"}

    try:
        _append_log("info", "accounts", f"Gmail creation started for {profile_id[:8]}")
        result = run_async(_do_create())
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
    """List all created Gmail accounts."""
    try:
        from server_python.account_manager import get_account_manager
        mgr      = get_account_manager()
        accounts = mgr.list_accounts()
        return jsonify({
            "success": True,
            "accounts": accounts,
            "total":    len(accounts),
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "accounts": [], "total": 0}), 500


@app.get("/api/accounts/<profile_id>")
def api_accounts_get(profile_id: str):
    """Get saved account for a specific profile."""
    try:
        from server_python.account_manager import get_account_manager
        mgr     = get_account_manager()
        account = mgr.load_account(profile_id)
        if account:
            return jsonify({"success": True, "account": account.to_dict()})
        return jsonify({"success": False, "error": "No account found for this profile"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.get("/api/accounts/balance")
def api_accounts_balance():
    """Check 5sim wallet balance."""
    async def _get_balance():
        from server_python.account_manager import FiveSimClient
        client  = FiveSimClient()
        balance = await client.get_balance()
        return balance

    try:
        balance = run_async(_get_balance())
        if balance is not None:
            return jsonify({
                "success": True,
                "balance": balance,
                "currency": "USD",
                "message": f"5sim balance: ${balance:.2f}",
            })
        return jsonify({
            "success": False,
            "error": "Could not fetch balance — check FIVESIM_API_KEY",
        })
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
            _append_log(
                "success",
                "profiles",
                f"Profile created: {d.get('name')} via {d.get('browserType')} "
                f"(antidetect: {d.get('antidetect', {}).get('engine', 'ok')})",
            )
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

# ── Update system ──────────────────────────────────────────────────────────────
@app.get("/api/update/version")
def api_update_version():
    return jsonify({"code": 0, "current": "2.0.0-py", "latest": "2.0.0-py", "hasUpdate": False})

@app.post("/api/update/run")
def api_update_run():
    return jsonify({"code": 0, "message": "Already latest"})

@app.post("/api/update/push")
def api_update_push():
    return jsonify({"code": 0, "message": "Push update not available"})

# ── YouTube InnerTube proxy ────────────────────────────────────────────────────
@app.get("/api/youtube/feed")
def api_youtube_feed():
    """
    Fetch real channel data via YouTube InnerTube browse API (no API key needed).
    Returns raw InnerTube JSON — frontend parseInnerTubeResponse() handles parsing.
    """
    import urllib.request
    import urllib.parse
    import json as _json

    channel_id = request.args.get("channel_id", "").strip()
    if not channel_id:
        return jsonify({"error": "channel_id required"}), 400

    import asyncio as _asyncio

    if channel_id.startswith("UC"):
        browse_id = channel_id
    elif channel_id.startswith("@"):
        browse_id = channel_id
    else:
        browse_id = f"@{channel_id}"

    def _innertube_browse(bid: str, params: str | None = None) -> dict:
        body: dict = {
            "browseId": bid,
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": "2.20240101.00.00",
                    "hl": "en",
                    "gl": "US",
                }
            }
        }
        if params:
            body["params"] = params

        data_bytes = _json.dumps(body).encode()
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/browse",
            data=data_bytes,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
                "Origin": "https://www.youtube.com",
                "Referer": "https://www.youtube.com/",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return _json.loads(resp.read().decode("utf-8", errors="ignore"))

    try:
        # Step 1: Get channel metadata (no params = channel home page)
        meta_data = _innertube_browse(browse_id)

        # Step 2: Get Videos tab — params = EgZ2aWRlb3M%3D (base64 of videos tab selector)
        try:
            videos_data = _innertube_browse(browse_id, "EgZ2aWRlb3M%3D")
            # Merge videos tab contents into meta_data so frontend sees everything
            if "contents" in videos_data:
                meta_data["contents"] = videos_data["contents"]
        except Exception as ve:
            log.warning(f"[YouTube/feed] Videos tab fetch failed (non-fatal): {ve}")

        return jsonify(meta_data)
    except Exception as e:
        log.error(f"[YouTube/feed] InnerTube error: {e}")
        return jsonify({"error": str(e)}), 502


@app.get("/api/youtube/playlist")
def api_youtube_playlist():
    playlist_id = request.args.get("list", "")
    return jsonify({"code": 0, "videos": [], "playlistId": playlist_id})

# ── V2 Dashboard (Tailwind + Alpine + HTMX) ───────────────────────────────────
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
