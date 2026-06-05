"""
MoreLoginProvider — Python
==========================
Node.js MoreLoginProvider.cjs ka replacement.
MoreLogin local desktop app API se baat karta hai (port 40000).
"""

from __future__ import annotations

import logging
import os
import aiohttp

log = logging.getLogger("mmb.morelogin")

class MoreLoginProvider:
    def __init__(self, api_key: str = "", port: int = 0):
        self.api_key = api_key or os.getenv("MORELOGIN_API_KEY", "")
        self.port    = port or int(os.getenv("MORELOGIN_PORT", 40000))
        self.base    = f"http://127.0.0.1:{self.port}"

    def _headers(self) -> dict:
        # MoreLogin local API expects Authorization (not api-key) — matches Vite proxy + official SDK
        return {
            "Content-Type": "application/json",
            "Authorization": self.api_key,
        }

    def _parse_error(self, data: dict) -> str:
        msg = data.get("msg") or data.get("message") or str(data)
        code = data.get("code")
        if code == 401 or "invalid api key" in str(msg).lower():
            return (
                "Invalid API Key — MoreLogin app me jao → Settings → API → naya key copy karo, "
                "phir Settings page ya .env me MORELOGIN_API_KEY update karo. "
                "MoreLogin desktop app running + logged in hona chahiye."
            )
        if code == 19063 or "reached the limit" in str(msg).lower():
            return (
                "MoreLogin profile limit full — purane profiles delete karo ya plan upgrade karo, "
                "phir dubara create karo."
            )
        return str(msg)

    async def list_profiles(self, page: int = 1, page_size: int = 100) -> list:
        """POST /api/env/page — profile list."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base}/api/env/page",
                json={"pageNo": page, "pageSize": page_size},
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                data = await resp.json(content_type=None)
                if data.get("code") == 0:
                    rows = data.get("data", {}).get("dataList", [])
                    return [
                        {
                            "id": r.get("id") or r.get("envId", ""),
                            "name": r.get("envName") or r.get("name", ""),
                            "status": "idle",
                            "browserType": "morelogin",
                        }
                        for r in rows
                    ]
                raise RuntimeError(self._parse_error(data))

    async def start_profile(self, profile_id: str) -> dict:
        """POST /api/env/start — profile shuru karo, CDP port lo."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base}/api/env/start",
                json={"id": profile_id},
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                data = await resp.json()
                if data.get("code") == 0:
                    cdp_port = data.get("data", {}).get("cdpPort") or data.get("data", {}).get("debugPort")
                    return {
                        "code": 0,
                        "data": {
                            "cdpPort": cdp_port,
                            "cdpEndpoint": f"http://127.0.0.1:{cdp_port}",
                        }
                    }
                raise RuntimeError(f"MoreLogin start_profile error: {data.get('msg', data)}")

    async def stop_profile(self, profile_id: str) -> dict:
        """POST /api/env/close — profile band karo."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base}/api/env/close",
                json={"id": profile_id},
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                data = await resp.json()
                return {"code": data.get("code", 0), "message": data.get("msg", "")}

    async def create_profile(self, options: dict) -> dict:
        """POST /api/env/create/quick — MoreLogin antidetect profile."""
        if not self.api_key:
            return {
                "code": -1,
                "message": "MORELOGIN_API_KEY missing — Settings page ya .env me set karo",
                "data": None,
            }

        os_id = int(options.get("operatorSystemId") or 1)
        payload: dict = {
            "browserTypeId": int(options.get("browserTypeId") or 1),
            "operatorSystemId": os_id,
            "quantity": 1,
        }
        proxy_cfg = options.get("proxyConfig") or {}
        if proxy_cfg.get("host"):
            payload["proxyConfig"] = {
                "proxyIp": proxy_cfg.get("host"),
                "proxyPort": int(proxy_cfg.get("port", 3120)),
                "proxyUser": proxy_cfg.get("username", ""),
                "proxyPassword": proxy_cfg.get("password", ""),
                "proxyType": proxy_cfg.get("type", "http"),
            }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.base}/api/env/create/quick",
                    json=payload,
                    headers=self._headers(),
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    data = await resp.json(content_type=None)
        except aiohttp.ClientConnectorError:
            return {
                "code": -1,
                "message": "MoreLogin app nahi chal rahi — desktop app open karo aur login karo (port 40000)",
                "data": None,
            }

        if data.get("code") != 0:
            return {"code": -1, "message": self._parse_error(data), "data": None}

        raw = data.get("data")
        env_id = ""
        if isinstance(raw, list) and raw:
            env_id = str(raw[0])
        elif isinstance(raw, dict):
            env_id = str(raw.get("envId") or raw.get("id") or "")
        elif isinstance(raw, str):
            env_id = raw

        if not env_id:
            return {"code": -1, "message": "MoreLogin create OK but no env id returned", "data": None}

        profile_name = options.get("name") or f"MMB-{env_id[-6:]}"
        await self._rename_profile(env_id, profile_name)
        ml_fp = options.get("moreloginFingerprint") or {}
        if ml_fp:
            await self._apply_antidetect_fingerprint(env_id, ml_fp)
        else:
            await self._apply_antidetect_fingerprint(env_id, {})

        return {
            "code": 0,
            "message": "Profile created",
            "data": {"id": env_id, "profileId": env_id, "name": profile_name},
        }

    async def _apply_antidetect_fingerprint(self, env_id: str, fp: dict) -> None:
        """Noise canvas/webgl/audio + custom tz/geo — never 'real' webrtc (type 1)."""
        body: dict = {"envId": env_id}
        body["advancedSetting"] = {
            "canvas": "masked",
            "webRTC": "masked",
            "randomizeScreenResolution": False,
            "randomizeUserAgent": False,
        }
        for key in (
            "timezone", "language", "resolution", "webrtcType", "canvasType", "canvasSeed",
            "webglType", "webglSeed", "audioType", "audioSeed", "latitude", "longitude",
            "ua", "fontList",
        ):
            if key in fp and fp[key] is not None:
                body[key] = fp[key]
        if "webrtcType" not in body:
            body["webrtcType"] = 2
        if "canvasType" not in body:
            body["canvasType"] = 1
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.base}/api/env/update",
                    json=body,
                    headers=self._headers(),
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    data = await resp.json(content_type=None)
                    if data.get("code") != 0:
                        log.warning("MoreLogin antidetect update: %s", data.get("msg"))
                    else:
                        log.info(
                            "[MoreLogin] antidetect %s | canvas=noise webrtc=masked tz=%s",
                            env_id[:8], fp.get("timezone", "?"),
                        )
        except Exception as e:
            log.debug("MoreLogin fingerprint config skipped: %s", e)

    async def _rename_profile(self, env_id: str, name: str) -> None:
        if not name:
            return
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.base}/api/env/update",
                    json={"envId": env_id, "envName": name},
                    headers=self._headers(),
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    await resp.json(content_type=None)
        except Exception as e:
            log.debug("MoreLogin rename skipped: %s", e)

    async def delete_profile(self, profile_id: str) -> dict:
        """DELETE profile — recycle bin mein daalo."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base}/api/env/removeToRecycleBin/batch",
                json={"ids": [profile_id]},
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                data = await resp.json()
                return {"code": data.get("code", 0)}

    async def get_profile_status(self, profile_id: str) -> str:
        """Profile ka status check karo."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base}/api/env/status",
                json={"ids": [profile_id]},
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                data = await resp.json()
                items = data.get("data", [])
                if items:
                    return items[0].get("status", "unknown")
                return "unknown"
