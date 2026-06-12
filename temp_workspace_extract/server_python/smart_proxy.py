"""
SmartProxy Manager — Per-profile proxy rotation for MMB AGENT 24/7

Residential username format (SmartProxy dashboard):
    {prefix}_area-US_state-{STATE}_life-{life}_session-{sessionId}

Credentials from .env / Settings:
    PROXY_SERVER=us.smartproxy.net
    PROXY_PORT=3120
    PROXY_PASSWORD=...
    PROXY_PREFIX=smart-pwgbkxcy3lyi
    DEFAULT_PROXY_LIFE=4hr (or seconds e.g. 120)

FIXED:
  ✅ Bug #1: asyncio.get_event_loop() → asyncio.get_running_loop()
             (deprecated Python 3.10+, raises DeprecationWarning in 3.12)
  ✅ Bug #2: Socket connection wrapped with proper timeout handling
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import random
import re
import string
import time
from typing import Optional

log = logging.getLogger("mmb.smart_proxy")

# Residential US endpoint (NOT proxy.smartproxy.net — breaks this account)
SMARTPROXY_HOST = "us.smartproxy.net"

# US states — SmartProxy uses full names in username
US_STATES: list[str] = [
    "ALASKA", "ARIZONA", "CALIFORNIA", "COLORADO", "FLORIDA", "GEORGIA",
    "ILLINOIS", "NEWYORK", "OHIO", "TEXAS", "WASHINGTON", "NEVADA",
    "OREGON", "MICHIGAN", "PENNSYLVANIA", "VIRGINIA", "NORTH_CAROLINA",
]

PROXY_LIVES = ("1hr", "2hr", "4hr", "8hr", "24hr")


def _life_to_seconds(life: str) -> int:
    """Parse life token for session expiry (4hr, 120, 300, etc.)."""
    s = str(life or "4hr").strip().lower()
    if s.endswith("hr"):
        try:
            return int(s[:-2]) * 3600
        except ValueError:
            return 14400
    if s.endswith("min"):
        try:
            return int(s[:-3]) * 60
        except ValueError:
            return 300
    try:
        return max(60, int(s))
    except ValueError:
        return 14400


def _normalize_proxy_server(raw: str) -> str:
    """Force us.smartproxy.net — proxy.smartproxy.net breaks this account."""
    s = (raw or "").strip().lower()
    if not s or "proxy.smartproxy" in s:
        return SMARTPROXY_HOST
    return raw.strip()


def _load_creds() -> dict:
    return {
        "server":   _normalize_proxy_server(os.getenv("PROXY_SERVER", SMARTPROXY_HOST)),
        "port":     int(os.getenv("PROXY_PORT", "3120")),
        "password": os.getenv("PROXY_PASSWORD", ""),
        "prefix":   os.getenv("PROXY_PREFIX", "").strip(),
        "life":     os.getenv("DEFAULT_PROXY_LIFE", "120").strip() or "120",
    }


def _random_session_id(length: int = 11) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def _pick_state(profile_id: str) -> str:
    """Deterministic US state per profile (full name for SmartProxy username)."""
    h = hashlib.sha256(profile_id.encode()).hexdigest()
    return US_STATES[int(h[:8], 16) % len(US_STATES)]


def _parse_state_from_username(username: str) -> str:
    m = re.search(r"_state-([^_]+)", username)
    return m.group(1) if m else "US"


def _is_legacy_username(username: str) -> bool:
    """Reject old/wrong SmartProxy username shapes."""
    u = username or ""
    if re.search(r"-session[a-f0-9]+-country-", u, re.I):
        return True
    if "_area-US" not in u:
        return True
    if "_city-" in u:
        return True
    return False


class SmartProxyManager:
    """
    Per-profile sticky SmartProxy usernames (residential format).
    Each profile keeps the same session until life expires, then rotates.
    """

    def __init__(self) -> None:
        self._profile_sessions: dict[str, dict] = {}

    def reload_from_env(self) -> None:
        """Call after Settings save so new PROXY_* values apply."""
        self._profile_sessions.clear()

    def get_proxy_config(self, profile_id: str) -> dict:
        creds = _load_creds()
        if not creds["prefix"] or not creds["password"]:
            log.warning("[Proxy] PROXY_PREFIX or PROXY_PASSWORD missing — check Settings / .env")

        life_secs = _life_to_seconds(creds["life"])
        existing  = self._profile_sessions.get(profile_id)
        if existing:
            if _is_legacy_username(existing.get("username", "")):
                log.warning("[Proxy] Dropping legacy session for %s — rebuilding", profile_id[:8])
                del self._profile_sessions[profile_id]
                existing = None
            else:
                age = time.time() - existing["assigned_at"]
                if age < life_secs:
                    return self._config_dict(creds, existing)

        session = self._build_session(profile_id, creds)
        self._profile_sessions[profile_id] = session
        log.info(
            "[Proxy] New session for %s...: %s...",
            profile_id[:8], session["username"][:60],
        )
        return self._config_dict(creds, session)

    def _build_session(self, profile_id: str, creds: dict) -> dict:
        state      = _pick_state(profile_id)
        life       = creds["life"]
        if life not in PROXY_LIVES and not str(life).isdigit():
            life = "120"
        session_id = _random_session_id()
        username   = (
            f"{creds['prefix']}_area-US_state-{state}"
            f"_life-{life}_session-{session_id}"
        )
        return {
            "username":    username,
            "assigned_at": time.time(),
            "state":       state,
            "city":        "",
            "life":        life,
            "session_id":  session_id,
            "country":     "us",
        }

    def _config_dict(self, creds: dict, session: dict) -> dict:
        username = session["username"]
        server   = creds["server"]
        port     = creds["port"]
        password = creds["password"]
        return {
            "server":     server,
            "port":       port,
            "username":   username,
            "password":   password,
            "state":      session.get("state", _parse_state_from_username(username)),
            "city":       session.get("city", ""),
            "life":       session.get("life", creds["life"]),
            "session_id": session.get("session_id", ""),
            "country":    "us",
            "url":        f"http://{username}:{password}@{server}:{port}",
        }

    def migrate_session(self, old_id: str, new_id: str) -> None:
        """After profile create: keep same proxy session on real profile id."""
        if old_id == new_id:
            return
        sess = self._profile_sessions.pop(old_id, None)
        if sess:
            self._profile_sessions[new_id] = sess
            log.info("[Proxy] Session migrated %s → %s", old_id[:8], new_id[:8])

    def rotate_session(self, profile_id: str) -> dict:
        if profile_id in self._profile_sessions:
            del self._profile_sessions[profile_id]
        log.info("[Proxy] Force rotating session for %s...", profile_id[:8])
        return self.get_proxy_config(profile_id)

    def get_all_sessions(self) -> list[dict]:
        creds     = _load_creds()
        life_secs = _life_to_seconds(creds["life"])
        now       = time.time()
        result    = []
        for pid, sess in self._profile_sessions.items():
            age = now - sess["assigned_at"]
            result.append({
                "profile_id": pid,
                "username":   sess["username"],
                "state":      sess.get("state"),
                "city":       sess.get("city"),
                "age_seconds": round(age),
                "expires_in":  max(0, round(life_secs - age)),
                "expired":     age >= life_secs,
            })
        return result

    async def check_proxy_health(self, profile_id: str) -> dict:
        """
        Check if proxy server is reachable.
        FIX #1: asyncio.get_event_loop() → asyncio.get_running_loop()
                (get_event_loop() is deprecated in Python 3.10+)
        """
        import socket
        creds  = _load_creds()
        config = self.get_proxy_config(profile_id)
        try:
            # FIX #1: get_running_loop() is the correct modern API
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                lambda: socket.create_connection(
                    (creds["server"], creds["port"]), timeout=5
                ),
            )
            return {
                "ok":       True,
                "proxy":    f"{creds['server']}:{creds['port']}",
                "username": config["username"],
            }
        except Exception as e:
            return {
                "ok":    False,
                "error": str(e),
                "proxy": f"{creds['server']}:{creds['port']}",
            }

    def format_for_playwright(self, profile_id: str) -> dict:
        creds  = _load_creds()
        config = self.get_proxy_config(profile_id)
        return {
            "server":   f"http://{creds['server']}:{creds['port']}",
            "username": config["username"],
            "password": creds["password"],
        }


_proxy_manager: Optional[SmartProxyManager] = None


def get_proxy_manager() -> SmartProxyManager:
    global _proxy_manager
    if _proxy_manager is None:
        _proxy_manager = SmartProxyManager()
    return _proxy_manager


def reset_proxy_manager() -> None:
    """Clear in-memory proxy sessions (after settings change)."""
    global _proxy_manager
    _proxy_manager = None
    log.info("[Proxy] Session cache cleared")


# Public alias for settings / profile create
normalize_proxy_server = _normalize_proxy_server
