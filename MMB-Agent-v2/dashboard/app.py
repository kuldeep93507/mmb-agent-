"""
MMB Channel Dashboard — Flask web UI
Run: python dashboard/app.py
Open: http://localhost:5000
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

# Project root on path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

JOBS_FILE             = ROOT / "data" / "jobs.json"
CHANNELS_FILE         = ROOT / "data" / "channels.json"
VIDEOS_FILE           = ROOT / "data" / "videos.json"
WATCH_HISTORY_FILE    = ROOT / "data" / "watch_history.json"
BOT_STATUS_FILE       = ROOT / "data" / "bot_status.json"
MANAGED_PROFILES_FILE = ROOT / "data" / "managed_profiles.json"
ORC_PROFILES_FILE     = ROOT / "data" / "orchestrator_profiles.json"
LOGS_DIR              = ROOT / "logs"

# ── Bot Process State (in-memory, per Flask process) ─────────────────────────
_bot_lock    = threading.Lock()
_bot_proc: subprocess.Popen | None = None
_bot_start_time: float = 0.0
_bot_log_lines: list[str] = []          # last 200 live log lines (stdout+stderr)
_BOT_ENTRY   = ROOT / "run_bot.py"      # default entry point
_BOT_CMD_MAX_LINES = 200


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_json(path, default=None):
    """Load any JSON file atomically. Returns default on missing/corrupt."""
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default if default is not None else {}


def _save_json_atomic(path, data: dict) -> None:
    """Atomic save: tmp → replace (crash-safe)."""
    import os as _os
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    _os.replace(tmp, path)


def _load_jobs() -> dict:
    return _load_json(JOBS_FILE, {"jobs": [], "profiles": []})


def _save_jobs(data: dict) -> None:
    _save_json_atomic(JOBS_FILE, data)


def _fetch_rss_videos(channel_id: str) -> list[dict]:
    """Fetch latest videos from YouTube RSS feed."""
    import urllib.request
    import xml.etree.ElementTree as ET
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            xml_data = resp.read()
        root = ET.fromstring(xml_data)
        ns = {
            "atom": "http://www.w3.org/2005/Atom",
            "yt":   "http://www.youtube.com/xml/schemas/2015",
            "media":"http://search.yahoo.com/mrss/",
        }
        videos = []
        for entry in root.findall("atom:entry", ns):
            vid_id = (entry.findtext("yt:videoId", namespaces=ns) or "").strip()
            title  = (entry.findtext("atom:title", namespaces=ns) or "").strip()
            link_el = entry.find("atom:link[@rel='alternate']", ns)
            link = link_el.get("href", "") if link_el is not None else ""
            published = (entry.findtext("atom:published", namespaces=ns) or "")[:10]
            videos.append({
                "video_id": vid_id,
                "title": title,
                "url": link,
                "published": published,
            })
        return videos
    except Exception as e:
        return [{"error": str(e)}]


def _scan_channel_rss(channel_url: str) -> dict:
    """Resolve channel URL → channel_id → fetch RSS videos."""
    import re, urllib.request
    channel_id = ""

    # Try to extract channel_id from URL directly
    match = re.search(r"channel/(UC[\w-]+)", channel_url)
    if match:
        channel_id = match.group(1)
    else:
        # Fetch channel page and extract from meta/canonical
        try:
            req = urllib.request.Request(
                channel_url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
            match = re.search(r'"channelId"\s*:\s*"(UC[\w-]+)"', html)
            if not match:
                match = re.search(r'channel/(UC[\w-]+)', html)
            if match:
                channel_id = match.group(1)
        except Exception as e:
            return {"error": f"Channel page fetch failed: {e}"}

    if not channel_id:
        return {"error": "Could not extract channel_id from URL"}

    videos = _fetch_rss_videos(channel_id)
    return {"channel_id": channel_id, "videos": videos}


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/jobs")
def api_jobs():
    data = _load_jobs()
    return jsonify(data)


@app.route("/api/jobs/<job_id>/toggle", methods=["POST"])
def api_toggle_job(job_id: str):
    data = _load_jobs()
    for job in data.get("jobs", []):
        if job["id"] == job_id:
            job["enabled"] = not job.get("enabled", True)
            _save_jobs(data)
            return jsonify({"ok": True, "enabled": job["enabled"]})
    return jsonify({"ok": False, "error": "Job not found"}), 404


@app.route("/api/jobs/<job_id>/views", methods=["POST"])
def api_set_views(job_id: str):
    body = request.get_json(force=True) or {}
    target = int(body.get("target_views", 0))
    data = _load_jobs()
    for job in data.get("jobs", []):
        if job["id"] == job_id:
            job["target_views"] = target
            _save_jobs(data)
            return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Job not found"}), 404


@app.route("/api/scan_channel", methods=["POST"])
def api_scan_channel():
    body = request.get_json(force=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "url required"}), 400
    result = _scan_channel_rss(url)

    # Auto-save channel to channels.json (T2-01 DB) if we got a channel_id
    if result.get("channel_id") and not result.get("error"):
        try:
            import re
            from services.channel_manager import ChannelManager
            m = re.search(r"@([\w.-]+)", url)
            handle = f"@{m.group(1)}" if m else ""
            ch_name = m.group(1) if m else ""
            ChannelManager().add_channel(
                result["channel_id"],
                name=ch_name,
                handle=handle,
                url=url,
                enabled=True,
            )
        except Exception:
            pass  # non-fatal

    return jsonify(result)


@app.route("/api/add_video", methods=["POST"])
def api_add_video():
    """
    Add a video from RSS scan result.
    Writes to BOTH jobs.json AND videos.json (T2-01 DB).
    Also saves the channel to channels.json if not already there.
    """
    body = request.get_json(force=True) or {}
    video_id     = body.get("video_id", "").strip()
    title        = body.get("title", "").strip()
    channel_id   = body.get("channel_id", "").strip()
    channel_name = body.get("channel_name", "").strip()
    channel_url  = body.get("channel_url", "").strip()

    if not video_id or not title:
        return jsonify({"error": "video_id and title required"}), 400

    # ── Write to jobs.json ────────────────────────────────────────────────
    data = _load_jobs()
    existing_ids = {j["video_id"] for j in data.get("jobs", [])}
    if video_id in existing_ids:
        return jsonify({"ok": False, "error": "Video already in jobs"})

    new_job = {
        "id":             f"job-{video_id}",
        "video_id":       video_id,
        "channel_name":   channel_name,
        "channel_id":     channel_id,
        "channel_url":    channel_url,
        "title_hint":     title,
        "search_keywords": title.lower(),
        "target_views":   6,
        "enabled":        True,
        "watch_time": {
            "mode": "smart", "smart_min_pct": 0.40, "smart_max_pct": 0.60,
            "min_seconds": 90, "max_seconds": 300,
        },
        "engagement": {
            "like":         {"enabled": True,  "probability": 0.85},
            "dislike":      {"enabled": False},
            "subscribe":    {"enabled": True,  "probability": 0.30},
            "bell":         {"enabled": True,  "probability": 0.50},
            "comment":      {"enabled": True,  "probability": 0.40, "comment_templates": [
                "Great video! Very helpful content.",
                "Thanks for sharing this amazing insight!",
                "Subscribed! This channel is amazing.",
            ]},
            "autoplay_off": {"enabled": True,  "must_do": True},
            "ads_skip":     {"enabled": True,  "must_do": True, "skip_after_seconds": 5},
            "quality":      {"enabled": True,  "target": "360p"},
            "description":  {"enabled": False},
        },
    }
    data.setdefault("jobs", []).append(new_job)
    _save_jobs(data)

    # ── Write to videos.json (T2-01 DB) ───────────────────────────────────
    try:
        from services.channel_manager import ChannelManager
        cm = ChannelManager()
        cm.add_video(
            video_id,
            title=title,
            channel_id=channel_id,
            url=f"https://www.youtube.com/watch?v={video_id}",
            enabled=True,
            priority=5,
        )
        # Also save channel to channels.json if channel_id known
        if channel_id:
            cm.add_channel(
                channel_id,
                name=channel_name,
                handle="",
                url=channel_url or f"https://www.youtube.com/channel/{channel_id}",
                enabled=True,
            )
    except Exception:
        pass  # DB write non-fatal — jobs.json already saved above

    return jsonify({"ok": True, "job": new_job})


@app.route("/api/delete_job/<job_id>", methods=["DELETE"])
def api_delete_job(job_id: str):
    data = _load_jobs()
    before = len(data.get("jobs", []))
    data["jobs"] = [j for j in data.get("jobs", []) if j["id"] != job_id]
    if len(data["jobs"]) < before:
        _save_jobs(data)
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Not found"}), 404


@app.route("/api/logs")
def api_logs():
    """Return last 100 lines of most recent log file."""
    if not LOGS_DIR.exists():
        return jsonify({"lines": []})
    log_files = sorted(LOGS_DIR.glob("*.log"), key=os.path.getmtime, reverse=True)
    if not log_files:
        return jsonify({"lines": []})
    lines = log_files[0].read_text(encoding="utf-8", errors="ignore").splitlines()
    return jsonify({"file": log_files[0].name, "lines": lines[-100:]})


# ── T2-01 DB endpoints ─────────────────────────────────────────────────────────

@app.route("/api/channels_db")
def api_channels_db():
    """Return all channels from channels.json."""
    data = _load_json(CHANNELS_FILE, {"channels": []})
    return jsonify(data)


@app.route("/api/videos_db")
def api_videos_db():
    """Return all videos from videos.json."""
    data = _load_json(VIDEOS_FILE, {"videos": []})
    return jsonify(data)


@app.route("/api/videos_db/<video_id>/toggle", methods=["POST"])
def api_toggle_video_db(video_id: str):
    """Toggle enabled/disabled for a video in videos.json."""
    try:
        from services.channel_manager import ChannelManager
        cm = ChannelManager()
        vid = cm.get_video(video_id)
        if not vid:
            return jsonify({"ok": False, "error": "Video not found in DB"}), 404
        new_state = not vid.get("enabled", True)
        cm.enable_disable_video(video_id, enabled=new_state)
        return jsonify({"ok": True, "enabled": new_state})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/videos_db/<video_id>/priority", methods=["POST"])
def api_set_video_priority(video_id: str):
    """Set priority for a video in videos.json (1=highest)."""
    body = request.get_json(force=True) or {}
    try:
        priority = int(body.get("priority", 5))
        from services.channel_manager import ChannelManager
        ok = ChannelManager().set_priority(video_id, priority)
        return jsonify({"ok": ok})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/sync_jobs", methods=["POST"])
def api_sync_jobs():
    """
    Sync videos.json → jobs.json.
    Creates job entries for all enabled videos not already in jobs.json.
    Returns count of added/skipped.
    """
    try:
        from services.channel_manager import ChannelManager
        body = request.get_json(force=True) or {}
        overwrite = bool(body.get("overwrite", False))
        result = ChannelManager().sync_to_jobs(JOBS_FILE, overwrite_existing=overwrite)
        return jsonify({"ok": True, **result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── T2-03 Watch History endpoint ───────────────────────────────────────────────

@app.route("/api/watch_history")
def api_watch_history():
    """
    Return watch history summary per profile.
    Each entry: {profile_id, total_watches, liked, commented, subscribed,
                 last_video_id, last_title, last_watched_at}
    """
    data = _load_json(WATCH_HISTORY_FILE, {"profiles": {}})
    profiles_raw = data.get("profiles", {})

    summary = []
    for profile_id, entries in profiles_raw.items():
        if not isinstance(entries, list) or not entries:
            continue
        total    = len(entries)
        liked    = sum(1 for e in entries if e.get("liked"))
        commented = sum(1 for e in entries if e.get("commented"))
        subscribed = sum(1 for e in entries if e.get("subscribed"))
        last     = entries[-1] if entries else {}
        total_sec = sum(int(e.get("watch_time_sec", 0)) for e in entries)
        summary.append({
            "profile_id":     profile_id,
            "profile_short":  profile_id[:8],
            "total_watches":  total,
            "total_watch_min": round(total_sec / 60, 1),
            "liked":          liked,
            "commented":      commented,
            "subscribed":     subscribed,
            "like_rate":      round(liked / total * 100) if total else 0,
            "comment_rate":   round(commented / total * 100) if total else 0,
            "last_video_id":  last.get("video_id", ""),
            "last_title":     last.get("title", ""),
            "last_watched_at": last.get("watched_at", ""),
        })

    # Sort by most recently active
    summary.sort(key=lambda x: x["last_watched_at"], reverse=True)
    return jsonify({"profiles": summary, "total_profiles": len(summary)})


@app.route("/api/watch_history/<profile_id>")
def api_watch_history_profile(profile_id: str):
    """
    Return full watch history for a single profile (most recent first).
    Query param: ?limit=50 (default 50, max 200)
    """
    limit = min(int(request.args.get("limit", 50)), 200)
    data = _load_json(WATCH_HISTORY_FILE, {"profiles": {}})
    entries = data.get("profiles", {}).get(profile_id, [])
    # Most recent first
    entries = list(reversed(entries[-limit:]))
    total_sec = sum(int(e.get("watch_time_sec", 0)) for e in entries)
    return jsonify({
        "profile_id":    profile_id,
        "total_entries": len(entries),
        "total_watch_min": round(total_sec / 60, 1),
        "entries": entries,
    })


# ── Bot Control Helpers ────────────────────────────────────────────────────────

def _bot_is_running() -> bool:
    """True if the bot subprocess is alive."""
    global _bot_proc
    if _bot_proc is None:
        return False
    return _bot_proc.poll() is None


def _stream_bot_output(proc: subprocess.Popen) -> None:
    """Background thread: read bot stdout+stderr into _bot_log_lines."""
    global _bot_log_lines
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\n\r") if isinstance(raw, str) else raw.decode("utf-8", errors="replace").rstrip()
            with _bot_lock:
                _bot_log_lines.append(line)
                if len(_bot_log_lines) > _BOT_CMD_MAX_LINES:
                    _bot_log_lines = _bot_log_lines[-_BOT_CMD_MAX_LINES:]
    except Exception:
        pass


def _read_profile_statuses() -> list[dict]:
    """
    Read per-profile status.
    Priority: bot_status.json (written by Orchestrator) → logs fallback.
    """
    # 1. Try bot_status.json
    if BOT_STATUS_FILE.exists():
        try:
            data = json.loads(BOT_STATUS_FILE.read_text(encoding="utf-8"))
            profiles = data.get("profiles", [])
            if profiles:
                return profiles
        except Exception:
            pass

    # 2. Fallback: infer from watch_history.json (last activity per profile)
    wh = _load_json(WATCH_HISTORY_FILE, {"profiles": {}})
    profiles_raw = wh.get("profiles", {})
    result = []
    for pid, entries in profiles_raw.items():
        if not isinstance(entries, list) or not entries:
            continue
        last = entries[-1] if entries else {}
        result.append({
            "profile_id":   pid,
            "profile_short": pid[:8],
            "status":       "idle",
            "last_action":  f"Watched: {last.get('title','—')[:40]}",
            "last_seen":    last.get("watched_at", ""),
            "current_video": last.get("title", ""),
        })
    return result


# ── Bot Control Endpoints ──────────────────────────────────────────────────────

@app.route("/api/bot/status")
def api_bot_status():
    """Return current bot status."""
    global _bot_proc, _bot_start_time, _bot_log_lines
    running = _bot_is_running()
    uptime_sec = int(time.time() - _bot_start_time) if running and _bot_start_time else 0
    with _bot_lock:
        lines = list(_bot_log_lines[-50:])
    return jsonify({
        "running":      running,
        "pid":          _bot_proc.pid if running and _bot_proc else None,
        "uptime_sec":   uptime_sec,
        "log_lines":    lines,
        "profiles":     _read_profile_statuses(),
    })


@app.route("/api/bot/start", methods=["POST"])
def api_bot_start():
    """Start the bot subprocess."""
    global _bot_proc, _bot_start_time, _bot_log_lines

    with _bot_lock:
        if _bot_is_running():
            return jsonify({"ok": False, "error": "Bot is already running", "pid": _bot_proc.pid})

    body    = request.get_json(force=True) or {}
    entry   = body.get("entry", str(_BOT_ENTRY))
    python  = sys.executable

    if not Path(entry).exists():
        return jsonify({"ok": False, "error": f"Entry file not found: {entry}"}), 400

    try:
        with _bot_lock:
            _bot_log_lines = []
            proc = subprocess.Popen(
                [python, entry],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
            _bot_proc       = proc
            _bot_start_time = time.time()

        # Stream output in background thread
        t = threading.Thread(target=_stream_bot_output, args=(proc,), daemon=True)
        t.start()

        return jsonify({"ok": True, "pid": proc.pid, "entry": entry})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/bot/stop", methods=["POST"])
def api_bot_stop():
    """Stop the bot subprocess (SIGTERM first, then SIGKILL after 5s)."""
    global _bot_proc

    with _bot_lock:
        proc = _bot_proc
        if proc is None or proc.poll() is not None:
            return jsonify({"ok": False, "error": "Bot is not running"})

    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
        with _bot_lock:
            _bot_proc = None
        return jsonify({"ok": True, "stopped": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/bot/logs")
def api_bot_logs():
    """Return recent live log lines from the running bot."""
    limit = min(int(request.args.get("limit", 100)), 200)
    with _bot_lock:
        lines = list(_bot_log_lines[-limit:])
    # Fallback: read from log files
    if not lines and LOGS_DIR.exists():
        log_files = sorted(LOGS_DIR.glob("*.log"), key=os.path.getmtime, reverse=True)
        if log_files:
            lines = log_files[0].read_text(encoding="utf-8", errors="ignore").splitlines()[-limit:]
    return jsonify({"lines": lines, "count": len(lines)})


# ── Profiles Endpoints ─────────────────────────────────────────────────────────

@app.route("/api/profiles")
def api_profiles():
    """
    Return all managed profiles merged with orchestrator stats.
    Source: managed_profiles.json + orchestrator_profiles.json
    """
    managed  = _load_json(MANAGED_PROFILES_FILE, [])
    orc_list = _load_json(ORC_PROFILES_FILE, [])
    wh_data  = _load_json(WATCH_HISTORY_FILE, {"profiles": {}})

    # Build orc lookup by profile_id
    orc_map = {p["profile_id"]: p for p in orc_list if isinstance(p, dict)}
    wh_map  = {pid: entries for pid, entries in wh_data.get("profiles", {}).items()}

    result = []
    seen = set()
    for p in managed if isinstance(managed, list) else []:
        pid = p.get("profile_id", "")
        if not pid or pid in seen:
            continue
        seen.add(pid)

        orc = orc_map.get(pid, {})
        entries = wh_map.get(pid, [])

        # Compute watch history stats
        wh_total    = len(entries)
        wh_liked    = sum(1 for e in entries if e.get("liked"))
        wh_time_min = round(sum(int(e.get("watch_time_sec", 0)) for e in entries) / 60, 1)

        # Last error — clean whitespace
        last_err = (p.get("last_error") or "").strip().replace("\n", " ").replace("  ", " ")
        if len(last_err) > 180:
            last_err = last_err[:180] + "…"

        result.append({
            "profile_id":       pid,
            "label":            p.get("label", pid[:8]),
            "platform":         p.get("platform", "unknown"),
            "provider":         p.get("provider", "multilogin"),
            "country_code":     p.get("country_code", "US"),
            "group":            p.get("group", "default"),
            "health":           p.get("health", "IDLE"),
            "health_reason":    p.get("health_reason", ""),
            "cooldown_until":   p.get("cooldown_until"),
            # Views
            "total_views":      p.get("total_views", 0),
            "successful_views": p.get("successful_views", 0),
            "failed_views":     p.get("failed_views", 0),
            "daily_views":      orc.get("daily_views", p.get("daily_views", 0)),
            # Times
            "last_used_at":     p.get("last_used_at", ""),
            "created_at":       p.get("created_at", ""),
            # Error
            "last_error":       last_err,
            # Proxy
            "proxy_host":       p.get("proxy_host", ""),
            "proxy_port":       p.get("proxy_port", 0),
            "proxy_user":       p.get("proxy_user", ""),
            "proxy_type":       p.get("proxy_type", "http"),
            "has_proxy":        bool(p.get("proxy_host", "")),
            # Watch history
            "wh_total":         wh_total,
            "wh_liked":         wh_liked,
            "wh_time_min":      wh_time_min,
            "like_rate":        round(wh_liked / wh_total * 100) if wh_total else 0,
        })

    # Also add orc-only profiles not in managed
    for pid, orc in orc_map.items():
        if pid not in seen:
            result.append({
                "profile_id":    pid,
                "label":         pid[:8],
                "platform":      orc.get("platform", "unknown"),
                "provider":      orc.get("provider", "multilogin"),
                "country_code":  orc.get("country_code", "US"),
                "group":         "default",
                "health":        "IDLE",
                "health_reason": "",
                "cooldown_until": None,
                "total_views":   orc.get("total_views", 0),
                "successful_views": 0,
                "failed_views":  0,
                "daily_views":   orc.get("daily_views", 0),
                "last_used_at":  orc.get("last_used_at", ""),
                "created_at":    orc.get("created_at", ""),
                "last_error":    "",
                "proxy_host":    "", "proxy_port": 0,
                "proxy_user":    "", "proxy_type": "http",
                "has_proxy":     False,
                "wh_total": 0, "wh_liked": 0,
                "wh_time_min": 0.0, "like_rate": 0,
            })

    # Sort: errors first, then by last_used_at desc
    result.sort(key=lambda x: (
        0 if "ERROR" in x["health"].upper() else 1,
        x["last_used_at"]
    ), reverse=False)

    return jsonify({"profiles": result, "total": len(result)})


@app.route("/api/profiles/<profile_id>/proxy", methods=["POST"])
def api_set_proxy(profile_id: str):
    """Update proxy config for a profile in managed_profiles.json."""
    body = request.get_json(force=True) or {}
    managed = _load_json(MANAGED_PROFILES_FILE, [])
    if not isinstance(managed, list):
        return jsonify({"ok": False, "error": "managed_profiles.json invalid"}), 500

    found = False
    for p in managed:
        if p.get("profile_id") == profile_id:
            p["proxy_host"] = body.get("proxy_host", "").strip()
            p["proxy_port"] = int(body.get("proxy_port", 0) or 0)
            p["proxy_user"] = body.get("proxy_user", "").strip()
            p["proxy_pass"] = body.get("proxy_pass", "").strip()
            p["proxy_type"] = body.get("proxy_type", "http").strip()
            found = True
            break

    if not found:
        return jsonify({"ok": False, "error": "Profile not found"}), 404

    _save_json_atomic(MANAGED_PROFILES_FILE, managed)
    return jsonify({"ok": True})


@app.route("/api/profiles/<profile_id>/reset_error", methods=["POST"])
def api_reset_error(profile_id: str):
    """Clear last_error and set health to IDLE for a profile."""
    managed = _load_json(MANAGED_PROFILES_FILE, [])
    if not isinstance(managed, list):
        return jsonify({"ok": False, "error": "Invalid file"}), 500

    found = False
    for p in managed:
        if p.get("profile_id") == profile_id:
            p["last_error"]    = ""
            p["health"]        = "IDLE"
            p["health_reason"] = ""
            found = True
            break

    if not found:
        return jsonify({"ok": False, "error": "Profile not found"}), 404

    _save_json_atomic(MANAGED_PROFILES_FILE, managed)
    return jsonify({"ok": True})


@app.route("/api/profiles/<profile_id>/reset_views", methods=["POST"])
def api_reset_views(profile_id: str):
    """Reset daily_views counter for a profile."""
    managed = _load_json(MANAGED_PROFILES_FILE, [])
    orc_list = _load_json(ORC_PROFILES_FILE, [])
    changed = False

    if isinstance(managed, list):
        for p in managed:
            if p.get("profile_id") == profile_id:
                p["daily_views"] = 0
                p["usage_date"]  = None
                changed = True
                break
        if changed:
            _save_json_atomic(MANAGED_PROFILES_FILE, managed)

    if isinstance(orc_list, list):
        for p in orc_list:
            if p.get("profile_id") == profile_id:
                p["daily_views"] = 0
                p["usage_date"]  = None
                break
        _save_json_atomic(ORC_PROFILES_FILE, orc_list)

    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
# VIEW SCHEDULER — /scheduler page
# ══════════════════════════════════════════════════════════════════════════════

SCHEDULE_FILE = ROOT / "data" / "view_schedule.json"

# In-memory scheduler state
_scheduler_lock   = threading.Lock()
_scheduler_active = False          # True = running
_scheduler_paused = False          # True = paused
_scheduler_thread = None
_scheduler_log    : list[str] = []
_scheduler_stats  = {
    "views_done": 0,
    "views_total": 0,
    "current_hour": 0,
    "current_profile": "",
    "eta_minutes": 0,
    "started_at": "",
}


def _sched_log(msg: str):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    with _scheduler_lock:
        _scheduler_log.append(line)
        if len(_scheduler_log) > 300:
            _scheduler_log = _scheduler_log[-300:]


def _build_schedule(
    total_views: int,
    duration_hours: int,
    views_per_hour_min: int,
    views_per_hour_max: int,
    profile_count: int,
    start_time_str: str,     # "HH:MM"
    stagger_seconds: int,
) -> list[dict]:
    """
    Build hourly schedule slots.
    Returns list of hour slots: [{hour, start_time, views_this_hour, slots:[{profile_idx, start_offset_sec, watch_pct}]}]
    """
    import math, random

    # Parse start time
    try:
        sh, sm = map(int, start_time_str.split(":"))
    except Exception:
        sh, sm = 0, 0

    base_epoch = time.time()
    # Find today's epoch for start_time
    import datetime
    now = datetime.datetime.now()
    start_dt = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    if start_dt < now:
        start_dt += datetime.timedelta(days=1)
    base_ts = start_dt.timestamp()

    remaining = total_views
    slots_out = []

    for h in range(duration_hours):
        if remaining <= 0:
            break

        # How many views this hour
        target_this_hour = min(
            remaining,
            random.randint(views_per_hour_min, views_per_hour_max)
        )
        # Don't exceed profile count
        target_this_hour = min(target_this_hour, profile_count)

        hour_start_ts = base_ts + h * 3600
        hour_label = time.strftime("%H:%M", time.localtime(hour_start_ts))

        # Build per-profile slots within this hour
        profile_slots = []
        used_profiles = random.sample(range(profile_count), target_this_hour)

        for i, prof_idx in enumerate(used_profiles):
            # Spread within the hour with stagger
            offset_sec = i * stagger_seconds
            # Add small jitter ±15s
            jitter = random.randint(-15, 15)
            offset_sec = max(0, offset_sec + jitter)
            # Keep within hour
            offset_sec = min(offset_sec, 3550)

            slot_ts = hour_start_ts + offset_sec
            slot_time = time.strftime("%H:%M:%S", time.localtime(slot_ts))

            # Per-profile random watch percentage (55%-92%)
            watch_pct = round(random.uniform(0.55, 0.92), 3)
            # Small gaussian jitter ±5%
            watch_pct = round(min(0.97, max(0.40, watch_pct + random.gauss(0, 0.05))), 3)

            profile_slots.append({
                "profile_idx":  prof_idx,
                "profile_label": f"P{prof_idx + 1:03d}",
                "run_at_ts":    slot_ts,
                "run_at_time":  slot_time,
                "watch_pct":    watch_pct,
                "offset_sec":   offset_sec,
            })

        # Sort by run_at_ts
        profile_slots.sort(key=lambda x: x["run_at_ts"])

        slots_out.append({
            "hour":           h + 1,
            "hour_start":     hour_label,
            "views_this_hour": target_this_hour,
            "slots":          profile_slots,
        })

        remaining -= target_this_hour

    return slots_out


@app.route("/scheduler")
def scheduler_page():
    return render_template("scheduler.html")


@app.route("/api/scheduler/build", methods=["POST"])
def api_scheduler_build():
    """Build a view schedule from user inputs. Returns the schedule."""
    body = request.get_json(force=True) or {}
    try:
        total_views        = int(body.get("total_views", 1000))
        duration_hours     = int(body.get("duration_hours", 12))
        views_per_hour_min = int(body.get("views_per_hour_min", 70))
        views_per_hour_max = int(body.get("views_per_hour_max", 100))
        profile_count      = int(body.get("profile_count", 100))
        start_time         = str(body.get("start_time", "10:00"))
        stagger_seconds    = int(body.get("stagger_seconds", 30))
        channel_name       = str(body.get("channel_name", ""))
        video_id           = str(body.get("video_id", ""))

        schedule = _build_schedule(
            total_views=total_views,
            duration_hours=duration_hours,
            views_per_hour_min=views_per_hour_min,
            views_per_hour_max=views_per_hour_max,
            profile_count=profile_count,
            start_time_str=start_time,
            stagger_seconds=stagger_seconds,
        )

        # Total delivered
        total_scheduled = sum(s["views_this_hour"] for s in schedule)

        # Save to file
        save_data = {
            "config": body,
            "schedule": schedule,
            "total_scheduled": total_scheduled,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "channel_name": channel_name,
            "video_id": video_id,
        }
        _save_json_atomic(SCHEDULE_FILE, save_data)

        return jsonify({
            "ok": True,
            "schedule": schedule,
            "total_scheduled": total_scheduled,
            "hours": len(schedule),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/scheduler/status")
def api_scheduler_status():
    with _scheduler_lock:
        return jsonify({
            "active":  _scheduler_active,
            "paused":  _scheduler_paused,
            "stats":   dict(_scheduler_stats),
            "log":     list(_scheduler_log[-50:]),
        })


@app.route("/api/scheduler/start", methods=["POST"])
def api_scheduler_start():
    global _scheduler_active, _scheduler_paused, _scheduler_thread, _scheduler_stats

    with _scheduler_lock:
        if _scheduler_active:
            return jsonify({"ok": False, "error": "Scheduler already running"})

    # Load saved schedule
    data = _load_json(SCHEDULE_FILE, {})
    if not data.get("schedule"):
        return jsonify({"ok": False, "error": "No schedule found. Build first."}), 400

    schedule = data["schedule"]
    total = data.get("total_scheduled", 0)

    with _scheduler_lock:
        _scheduler_active = True
        _scheduler_paused = False
        _scheduler_stats.update({
            "views_done": 0,
            "views_total": total,
            "current_hour": 0,
            "current_profile": "",
            "started_at": time.strftime("%H:%M:%S"),
        })
        _scheduler_log.clear()

    def _run():
        global _scheduler_active, _scheduler_paused, _scheduler_stats
        _sched_log(f"Scheduler started | {total} views planned")

        for hour_slot in schedule:
            with _scheduler_lock:
                if not _scheduler_active:
                    break
                _scheduler_stats["current_hour"] = hour_slot["hour"]

            _sched_log(f"Hour {hour_slot['hour']} | {hour_slot['hour_start']} | {hour_slot['views_this_hour']} views")

            for slot in hour_slot["slots"]:
                # Check stop
                with _scheduler_lock:
                    if not _scheduler_active:
                        break

                # Handle pause
                while True:
                    with _scheduler_lock:
                        paused = _scheduler_paused
                        active = _scheduler_active
                    if not active:
                        break
                    if not paused:
                        break
                    time.sleep(1)

                with _scheduler_lock:
                    if not _scheduler_active:
                        break

                # Wait until slot time
                now_ts = time.time()
                wait_sec = slot["run_at_ts"] - now_ts
                if wait_sec > 0:
                    _sched_log(f"  Waiting {wait_sec:.0f}s → {slot['run_at_time']} | {slot['profile_label']}")
                    # Sleep in small chunks to allow stop/pause
                    slept = 0
                    while slept < wait_sec:
                        with _scheduler_lock:
                            if not _scheduler_active:
                                break
                            if _scheduler_paused:
                                break
                        time.sleep(min(2, wait_sec - slept))
                        slept += 2

                with _scheduler_lock:
                    if not _scheduler_active:
                        break
                    _scheduler_stats["current_profile"] = slot["profile_label"]

                _sched_log(f"  ▶ Running {slot['profile_label']} | watch={slot['watch_pct']*100:.0f}%")

                # TODO: here call Orchestrator to run this profile
                # For now: simulate with sleep (replace with actual bot call)
                time.sleep(1)

                with _scheduler_lock:
                    _scheduler_stats["views_done"] += 1
                    done = _scheduler_stats["views_done"]

                _sched_log(f"  ✓ Done {slot['profile_label']} | total={done}/{total}")

        with _scheduler_lock:
            _scheduler_active = False
            _scheduler_stats["current_profile"] = ""

        _sched_log("Scheduler finished.")

    _scheduler_thread = threading.Thread(target=_run, daemon=True)
    _scheduler_thread.start()

    return jsonify({"ok": True, "total": total})


@app.route("/api/scheduler/pause", methods=["POST"])
def api_scheduler_pause():
    global _scheduler_paused
    with _scheduler_lock:
        if not _scheduler_active:
            return jsonify({"ok": False, "error": "Not running"})
        _scheduler_paused = not _scheduler_paused
        state = "paused" if _scheduler_paused else "resumed"
    _sched_log(f"Scheduler {state}.")
    return jsonify({"ok": True, "paused": _scheduler_paused})


@app.route("/api/scheduler/stop", methods=["POST"])
def api_scheduler_stop():
    global _scheduler_active, _scheduler_paused
    with _scheduler_lock:
        _scheduler_active = False
        _scheduler_paused = False
    _sched_log("Scheduler stopped by user.")
    return jsonify({"ok": True})


# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    print("=" * 50)
    print("  MMB Agent Dashboard")
    print("  http://localhost:5000")
    print("  View Scheduler: http://localhost:5000/scheduler")
    print("=" * 50)
    app.run(debug=False, port=5000, use_reloader=False)
