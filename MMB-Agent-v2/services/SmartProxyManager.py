"""
SmartProxyManager — Per-session sticky proxy credentials for SmartProxy residential.

SmartProxy sticky session format:
  Username: {prefix}-session-{unique_id}
  Password: {password}
  Host:     us.smartproxy.net
  Port:     3120

Each profile gets a unique session ID → different residential IP → looks like
a different user. Session life = 4hrs (240 min) as configured in SmartProxy dashboard.

Usage:
    mgr = SmartProxyManager.from_env()
    proxy = mgr.build_proxy_config(profile_id="abc123")
    # proxy = {"host": "us.smartproxy.net", "port": 3120, "user": "...", "password": "...", "type": "http"}
    ok = await mgr.set_multilogin_profile_proxy(profile_id, proxy, token, folder_id)
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import string
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"

logger = logging.getLogger("mmb.smartproxy")


class SmartProxyManager:
    """Generates unique per-profile sticky SmartProxy credentials and wires them into Multilogin."""

    MULTILOGIN_PROFILE_UPDATE_URL = "https://api.multilogin.com/profile"
    MULTILOGIN_LAUNCHER_BASE = "https://launcher.mlx.yt:45001"

    def __init__(
        self,
        host: str,
        port: int,
        prefix: str,
        password: str,
        session_life_minutes: int = 240,  # 4hr
    ) -> None:
        self._host = host
        self._port = port
        self._prefix = prefix
        self._password = password
        self._session_life_minutes = session_life_minutes

    @classmethod
    def from_env(cls, env_path: Optional[str] = None) -> "SmartProxyManager":
        """Load SmartProxy config from .env file."""
        load_dotenv(env_path or DEFAULT_ENV_PATH, override=True)
        host     = os.getenv("PROXY_SERVER", "us.smartproxy.net").strip()
        port     = int(os.getenv("PROXY_PORT", "3120"))
        prefix   = os.getenv("PROXY_PREFIX", "").strip()
        password = os.getenv("PROXY_PASSWORD", "").strip()
        life_min = int(os.getenv("DEFAULT_PROXY_LIFE", "240"))

        if not prefix or not password:
            raise ValueError(
                "PROXY_PREFIX and PROXY_PASSWORD must be set in .env for SmartProxy"
            )

        return cls(host=host, port=port, prefix=prefix, password=password,
                   session_life_minutes=life_min)

    def _generate_session_id(self, profile_id: str) -> str:
        """
        Generate a deterministic-but-unique 8-char session ID from profile_id.
        Same profile always gets same session ID in same day (sticky IP per day).
        """
        today = __import__("datetime").date.today().isoformat()
        seed = f"{profile_id}:{today}"
        h = hashlib.sha256(seed.encode()).hexdigest()
        # Take 8 alphanumeric chars from hash
        return h[:8]

    def build_proxy_config(self, profile_id: str) -> dict:
        """
        Build a SmartProxy sticky session config for a specific profile.

        Returns dict compatible with Multilogin ProxyConfig TypedDict.
        """
        session_id = self._generate_session_id(profile_id)
        username = f"{self._prefix}-session-{session_id}"

        return {
            "host": self._host,
            "port": self._port,
            "user": username,
            "password": self._password,
            "type": "http",
        }

    async def set_multilogin_profile_proxy(
        self,
        profile_id: str,
        proxy: dict,
        mlx_token: str,
        folder_id: str,
        timeout: int = 30,
    ) -> bool:
        """
        Update an existing Multilogin profile's proxy via API.

        Tries 2 endpoints (API + launcher) — whichever works.
        Returns True on success, False on failure (non-fatal — continues without proxy).
        """
        import asyncio
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            self._set_proxy_sync,
            profile_id, proxy, mlx_token, folder_id, timeout,
        )

    def _set_proxy_sync(
        self,
        profile_id: str,
        proxy: dict,
        mlx_token: str,
        folder_id: str,
        timeout: int,
    ) -> bool:
        """Synchronous proxy-set — runs in thread pool."""
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {mlx_token}",
        }

        # ── Method 1: Multilogin profile update API ───────────────────────────
        payload = {
            "profile_id": profile_id,
            "parameters": {
                "proxy_config": {
                    "connection_type": "HTTP",
                    "external_proxy": {
                        "host": proxy["host"],
                        "port": int(proxy["port"]),
                        "username": proxy["user"],
                        "password": proxy["password"],
                    }
                }
            }
        }

        try:
            resp = requests.put(
                self.MULTILOGIN_PROFILE_UPDATE_URL,
                json=payload,
                headers=headers,
                timeout=timeout,
                verify=False,
            )
            if resp.status_code in (200, 201, 204):
                logger.info(
                    "SmartProxy set via API | profile=%s user=%s host=%s",
                    profile_id[:8], proxy["user"], proxy["host"]
                )
                return True
            logger.debug("Proxy API method 1 status=%s body=%s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.debug("Proxy API method 1 failed: %s", e)

        # ── Method 2: Multilogin launcher proxy endpoint ──────────────────────
        launcher_url = f"{self.MULTILOGIN_LAUNCHER_BASE}/api/v1/profile/proxy"
        launcher_payload = {
            "profile_id": profile_id,
            "proxy": {
                "type": "HTTP",
                "host": proxy["host"],
                "port": int(proxy["port"]),
                "username": proxy["user"],
                "password": proxy["password"],
            }
        }

        try:
            resp2 = requests.post(
                launcher_url,
                json=launcher_payload,
                headers=headers,
                timeout=timeout,
                verify=False,
            )
            if resp2.status_code in (200, 201, 204):
                logger.info(
                    "SmartProxy set via launcher | profile=%s user=%s",
                    profile_id[:8], proxy["user"]
                )
                return True
            logger.debug("Proxy launcher method status=%s body=%s", resp2.status_code, resp2.text[:200])
        except Exception as e:
            logger.debug("Proxy launcher method failed: %s", e)

        # ── Both methods failed — log and continue (non-fatal) ────────────────
        logger.warning(
            "SmartProxy set failed for profile=%s — continuing without proxy. "
            "Profile may use its existing proxy or no proxy.",
            profile_id[:8]
        )
        return False

    def proxy_display(self, profile_id: str) -> str:
        """Return a human-readable proxy string for logging."""
        cfg = self.build_proxy_config(profile_id)
        return f"{cfg['host']}:{cfg['port']} user={cfg['user']}"
