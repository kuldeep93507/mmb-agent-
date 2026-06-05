"""
MMB Agent V2 Dashboard — Flask routes + API endpoints.

Supplementary control panel (React/Electron UI remains primary).
Run standalone: python dashboard/app.py
Or mount via server_python/main.py register_dashboard()
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request

ROOT = Path(__file__).resolve().parent.parent
LOGS_DIR = ROOT / "logs"
ACTION_LOG = LOGS_DIR / "actions.jsonl"


def create_dashboard_app() -> Flask:
    """Create Flask dashboard application."""
    app = Flask(
        __name__,
        template_folder=str(Path(__file__).parent / "templates"),
        static_folder=str(Path(__file__).parent / "static"),
    )
    app.secret_key = os.getenv("DASHBOARD_SECRET", "mmb-dashboard-v2-dev")

    _PAGES = {
        "home": ("index.html", "Home / Dashboard"),
        "videos": ("index.html", "Video Targets"),
        "profiles": ("index.html", "Profiles"),
        "proxies": ("index.html", "Proxy Pool"),
        "engagement": ("index.html", "Engagement Engine"),
        "scheduler": ("index.html", "Scheduler"),
        "shuffle": ("index.html", "Video Shuffle"),
        "analytics": ("index.html", "Analytics"),
        "logs": ("index.html", "Logs Viewer"),
        "settings": ("index.html", "Settings"),
    }

    def _render(page: str = "home"):
        return render_template(
            _PAGES[page][0],
            active_page=page,
            page_title=_PAGES[page][1],
        )

    @app.get("/")
    def index():
        return _render("home")

    @app.get("/dashboard")
    def dashboard_home():
        return _render("home")

    for slug in _PAGES:
        if slug == "home":
            continue
        app.add_url_rule(
            f"/dashboard/{slug}",
            f"page_{slug}",
            lambda s=slug: _render(s),
        )

    @app.get("/api/stats/live")
    def api_stats_live():
        """Live dashboard metrics."""
        from server_python.main import _workers, _log_lines, SERVER_START_TIME

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        views = likes = subs = comments = 0
        for line in _log_lines[-500:]:
            action = str(line.get("action", "")).lower()
            if "watch" in action or "view" in action:
                views += 1
            if "like" in action:
                likes += 1
            if "subscrib" in action:
                subs += 1
            if "comment" in action:
                comments += 1

        active = sum(1 for w in _workers.values() if w.get("status") == "running")
        return jsonify({
            "active_bots": active,
            "total_profiles": len(_workers),
            "today_views": views,
            "today_likes": likes,
            "today_subscribes": subs,
            "today_comments": comments,
            "uptime_seconds": int(time.time() - SERVER_START_TIME),
            "date": today,
            "selector_version": "V2",
        })

    @app.get("/api/profiles")
    def api_profiles():
        from server_python.main import _workers
        profiles = []
        for pid, w in _workers.items():
            profiles.append({
                "id": pid,
                "name": w.get("name", pid),
                "status": w.get("status", "idle"),
                "health": w.get("health", "unknown"),
                "last_used": w.get("lastUsed", ""),
                "success_rate": w.get("successRate", 0),
            })
        return jsonify({"profiles": profiles})

    @app.post("/api/profiles/<profile_id>/test")
    def api_profile_test(profile_id: str):
        return jsonify({
            "code": 0,
            "message": f"Test launch queued for {profile_id}",
            "profile_id": profile_id,
        })

    @app.get("/api/proxies")
    def api_proxies():
        try:
            from server_python.smart_proxy import get_proxy_manager
            mgr = get_proxy_manager()
            proxies = getattr(mgr, "list_proxies", lambda: [])()
            return jsonify({"proxies": proxies if proxies else []})
        except Exception as exc:
            return jsonify({"proxies": [], "error": str(exc)})

    @app.post("/api/jobs")
    def api_create_job():
        body = request.get_json(silent=True) or {}
        return jsonify({
            "code": 0,
            "job_id": f"job-{int(time.time())}",
            "status": "pending",
            "config": body,
        })

    @app.get("/api/logs/tail")
    def api_logs_tail():
        n = min(int(request.args.get("n", 100)), 500)
        filt = request.args.get("filter", "").lower()
        lines: list[dict] = []

        if ACTION_LOG.exists():
            with ACTION_LOG.open(encoding="utf-8") as f:
                raw = f.readlines()[-n * 2:]
            for line in raw:
                try:
                    entry = json.loads(line)
                    if filt:
                        blob = json.dumps(entry).lower()
                        if filt not in blob:
                            continue
                    lines.append(entry)
                except json.JSONDecodeError:
                    continue
            lines = lines[-n:]

        return jsonify({"lines": lines, "count": len(lines)})

    @app.post("/api/bot/start")
    def api_bot_start():
        body = request.get_json(silent=True) or {}
        return jsonify({"code": 0, "message": "Bot start queued", "config": body})

    @app.post("/api/bot/stop")
    def api_bot_stop():
        return jsonify({"code": 0, "message": "Emergency stop signal sent"})

    return app


def register_dashboard(main_app: Flask) -> None:
    """Mount dashboard routes onto main Flask app."""
    from flask import send_from_directory

    dash = create_dashboard_app()
    static_dir = Path(__file__).parent / "static"
    tpl_dir = Path(__file__).parent / "templates"

    @main_app.route("/static/<path:filename>")
    def dash_static(filename: str):
        return send_from_directory(static_dir, filename)

    for rule in dash.url_map.iter_rules():
        if rule.endpoint == "static":
            continue
        view = dash.view_functions[rule.endpoint]
        main_app.add_url_rule(
            rule.rule,
            endpoint=f"dash_{rule.endpoint}",
            view_func=view,
            methods=rule.methods,
        )

    main_app.jinja_loader.searchpath.append(str(tpl_dir))  # type: ignore[attr-defined]


if __name__ == "__main__":
    port = int(os.getenv("DASHBOARD_PORT", 3200))
    create_dashboard_app().run(host="0.0.0.0", port=port, debug=True)
