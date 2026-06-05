"""
MultiloginProvider — Python
===========================
Node.js MultiloginProvider.cjs ka replacement.

CDP Approach (Proven Working):
  1. Start profile via MLX HTTP API (port 45000, no SSL)
  2. Get running chrome.exe cmdline via WMI/PowerShell
  3. Kill that chrome process
  4. Re-launch with same cmdline + --remote-debugging-port=PORT
  5. nodriver attaches to PORT

Why: MLX launcher's automation_type=cdp does NOT add --remote-debugging-port to chrome.
     But chrome happily accepts it alongside MLX's --client-port flag.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import ssl
import subprocess

import aiohttp

log = logging.getLogger("mmb.multilogin")

CLOUD_API      = "https://api.multilogin.com"
LAUNCHER_HTTP  = "http://127.0.0.1:45000"
LAUNCHER_HTTPS = "https://launcher.mlx.yt:45001"

# CDP port range for MLX profiles (per-profile deterministic port)
CDP_PORT_BASE = 35550
CDP_PORT_RANGE = 100  # 35550–35649

# SSL context (for HTTPS fallback)
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE


def _profile_cdp_port(profile_id: str) -> int:
    """Deterministic CDP port for a profile — always same port for same ID."""
    h = int(hashlib.md5(profile_id.encode()).hexdigest(), 16)
    return CDP_PORT_BASE + (h % CDP_PORT_RANGE)


class MultiloginProvider:
    def __init__(self, token: str = ""):
        self.token     = token or os.getenv("MULTILOGIN_TOKEN", "")
        self.folder_id = os.getenv("MULTILOGIN_FOLDER_ID", "")
        self.email     = os.getenv("MULTILOGIN_EMAIL", "")
        self.password  = os.getenv("MULTILOGIN_PASSWORD", "")
        self._session_token: str = ""

    # ── Auth ─────────────────────────────────────────────────────────────────

    async def _get_token(self) -> str:
        if self.token:
            return self.token
        if self._session_token:
            return self._session_token
        return await self._signin()

    async def _signin(self) -> str:
        import hashlib as _h
        pw_md5 = _h.md5(self.password.encode()).hexdigest()
        payload = {"email": self.email, "password": pw_md5}
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{CLOUD_API}/user/signin", json=payload,
                               timeout=aiohttp.ClientTimeout(total=15)) as r:
                data = await r.json()
                t = data.get("data", {}).get("token", "")
                if not t:
                    raise RuntimeError(f"Signin failed: {data.get('message', data)}")
                self._session_token = t
                return t

    def _auth_header(self) -> dict:
        return {"Authorization": f"Bearer {self.token or self._session_token}"}

    def _headers(self, strict: bool = False) -> dict:
        h = {**self._auth_header(), "Content-Type": "application/json", "Accept": "application/json"}
        if strict:
            h["X-Strict-Mode"] = "true"
        return h

    async def update_profile_parameters(self, profile_id: str, parameters: dict) -> dict:
        """POST /profile/update — force antidetect flags after create."""
        await self._get_token()
        payload = {"profile_id": profile_id, "parameters": parameters}
        async with aiohttp.ClientSession() as s:
            async with s.post(
                f"{CLOUD_API}/profile/update",
                json=payload,
                headers=self._headers(strict=True),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as r:
                data = await r.json(content_type=None)
                status = data.get("status") or {}
                if status.get("http_code", r.status) not in (200, 201):
                    return {"code": -1, "message": status.get("message") or str(data)}
                return {"code": 0, "message": "updated"}

    # ── List profiles ─────────────────────────────────────────────────────────

    async def list_profiles(self, page: int = 1, page_size: int = 50) -> list:
        await self._get_token()
        body = {
            "folder_id": self.folder_id,
            "search_text": "",
            "offset": (page - 1) * page_size,
            "limit": page_size,
            "is_removed": False,
        }
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{CLOUD_API}/profile/search", json=body,
                               headers=self._headers(),
                               timeout=aiohttp.ClientTimeout(total=15)) as r:
                ct = r.content_type or ""
                if "html" in ct:
                    raise RuntimeError(
                        f"Multilogin token expired or invalid — API returned HTML "
                        f"(HTTP {r.status}). Go to Settings → refresh your Multilogin token."
                    )
                data = await r.json(content_type=None)
                if data.get("status", {}).get("http_code") == 200 or r.status == 200:
                    profiles = data.get("data", {}).get("profiles", [])
                    return [self._normalize(p) for p in profiles]
                raise RuntimeError(f"list_profiles failed: {data.get('status', data)}")

    def _normalize(self, p: dict) -> dict:
        raw_status = str(p.get("status", "")).lower()
        if "running" in raw_status or "active" in raw_status:
            status = "running"
        elif "error" in raw_status or "crash" in raw_status:
            status = "error"
        else:
            status = "stopped"
        return {
            "id":            p.get("profile_id") or p.get("id", ""),
            "name":          p.get("name", ""),
            "status":        status,
            "debugPort":     None,
            "browserType":   "multilogin",
            "os":            p.get("os_type", "windows"),
            "proxyHost":     None,
            "proxyPort":     None,
            "proxyUsername": None,
            "userAgentHint": None,
        }

    # ── Start profile (MAIN METHOD) ───────────────────────────────────────────

    async def start_profile(self, profile_id: str) -> dict:
        """
        Start MLX profile with CDP debug port accessible to nodriver.

        Flow:
        1. Kill any existing browser for this profile
        2. Start via MLX API (chrome starts WITHOUT --remote-debugging-port)
        3. Find the running chrome process via --client-session-id in cmdline
        4. Kill chrome
        5. Re-launch with same cmdline + --remote-debugging-port=PORT
        6. Verify and return PORT
        """
        await self._get_token()
        folder = self.folder_id or "no-folder"
        cdp_port = _profile_cdp_port(profile_id)

        log.info(f"[MLX] starting profile {profile_id[:8]} → CDP port {cdp_port}")

        # Step 1: Kill any existing process for this profile
        await self._kill_profile_browser(profile_id)
        await asyncio.sleep(1.5)

        # Step 2: Start via MLX API
        path = f"/api/v2/profile/f/{folder}/p/{profile_id}/start?automation_type=cdp"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(f"{LAUNCHER_HTTP}{path}",
                                  headers=self._auth_header(),
                                  timeout=aiohttp.ClientTimeout(total=60)) as r:
                    txt = await r.text()
                    log.info(f"[MLX] start response ({r.status}): {txt[:150]}")
                    if r.status not in (200, 400):  # 400 = ALREADY_RUNNING (ok)
                        raise RuntimeError(f"start_profile failed ({r.status}): {txt[:200]}")
        except aiohttp.ClientConnectorError:
            connector = aiohttp.TCPConnector(ssl=_SSL_CTX)
            async with aiohttp.ClientSession(connector=connector) as s:
                async with s.get(f"{LAUNCHER_HTTPS}{path}",
                                  headers=self._auth_header(),
                                  ssl=_SSL_CTX,
                                  timeout=aiohttp.ClientTimeout(total=60)) as r:
                    txt = await r.text()
                    log.info(f"[MLX] start HTTPS ({r.status}): {txt[:150]}")

        # Step 3: Wait for chrome to initialize
        log.info("[MLX] waiting for chrome to initialize...")
        await asyncio.sleep(4)

        # Step 4: Get chrome PID + cmdline via --client-session-id
        chrome_pid, chrome_cmd = await self._get_chrome_info(profile_id)
        if not chrome_cmd:
            raise RuntimeError(f"MLX started but chrome not found for profile {profile_id[:8]}")

        log.info(f"[MLX] found chrome PID={chrome_pid}")

        # Step 5: Kill chrome (no debug port)
        await self._kill_pid(chrome_pid)
        await asyncio.sleep(2)

        # Step 6: Re-launch with --remote-debugging-port added
        new_cmd = re.sub(r'--remote-debugging-port=\d+\s?', '', chrome_cmd).strip()
        new_cmd += f" --remote-debugging-port={cdp_port}"
        log.info(f"[MLX] re-launching with CDP port {cdp_port}")
        subprocess.Popen(new_cmd, shell=True,
                         creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)

        log.info(f"[MLX] profile {profile_id[:8]} → CDP port {cdp_port}")

        # Step 5: Verify CDP is accessible
        ok = await self._verify_cdp(cdp_port)
        if not ok:
            await asyncio.sleep(3)
            ok = await self._verify_cdp(cdp_port)
        if not ok:
            raise RuntimeError(f"CDP port {cdp_port} not accessible (profile {profile_id[:8]})")

        return {
            "code": 0,
            "data": {
                "cdpPort":     cdp_port,
                "cdpEndpoint": f"http://127.0.0.1:{cdp_port}",
            },
        }

    async def _detect_cdp_port(self, profile_id: str) -> int:
        """Read --remote-debugging-port from running chrome cmdline for this profile."""
        pid_short = profile_id.replace("-", "").upper()[:6]

        # Try wmi module first
        try:
            import wmi as _wmi  # type: ignore
            c = _wmi.WMI()
            for p in c.Win32_Process(Name="chrome.exe"):
                cmd = p.CommandLine or ""
                if (pid_short in cmd.upper() or profile_id.lower() in cmd.lower()) \
                   and "--type=" not in cmd:
                    m = re.search(r'--remote-debugging-port=(\d+)', cmd)
                    if m:
                        return int(m.group(1))
        except ImportError:
            pass

        # Fallback: PowerShell
        ps_cmd = (
            f"Get-WmiObject Win32_Process -Filter \"Name='chrome.exe'\" | "
            f"Where-Object {{ $_.CommandLine -match '{pid_short}' -and $_.CommandLine -notmatch '--type=' }} | "
            f"Select-Object -First 1 CommandLine | ConvertTo-Json"
        )
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_cmd],
                capture_output=True, text=True, timeout=15
            )
            if result.stdout.strip():
                obj = json.loads(result.stdout.strip())
                cmd = obj.get("CommandLine", "") if isinstance(obj, dict) else ""
                m = re.search(r'--remote-debugging-port=(\d+)', cmd)
                if m:
                    return int(m.group(1))
        except Exception as e:
            log.debug(f"[MLX] _detect_cdp_port PS error: {e}")

        return 0

    async def _scan_cdp_ports(self) -> int:
        """Find open CDP port via netstat — fast, checks only listening ports."""
        try:
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True, text=True, timeout=10
            )
            ports_to_check = set()
            for line in result.stdout.splitlines():
                # Look for 127.0.0.1:PORT or 0.0.0.0:PORT in LISTENING state
                if "LISTENING" not in line:
                    continue
                m = re.search(r'(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)', line)
                if m:
                    port = int(m.group(1))
                    # MLX CDP ports are typically in 30000–40000 range
                    if 30000 <= port <= 40000:
                        ports_to_check.add(port)

            log.info(f"[MLX] netstat found {len(ports_to_check)} candidate ports: {sorted(ports_to_check)}")
            for port in sorted(ports_to_check):
                if await self._verify_cdp(port):
                    log.info(f"[MLX] found CDP via netstat scan: port {port}")
                    return port
        except Exception as e:
            log.debug(f"[MLX] _scan_cdp_ports error: {e}")
        return 0

    async def _get_chrome_info(self, profile_id: str):
        """Get PID and cmdline of MLX main chrome process for this profile.
        MLX puts the profile ID in --client-session-id=PROFILE_ID flag."""
        # Use PowerShell to find chrome with matching --client-session-id
        # (MLX always sets this flag; no --type= means it's the main process)
        ps_cmd = (
            f"Get-WmiObject Win32_Process -Filter \"Name='chrome.exe'\" | "
            f"Where-Object {{ $_.CommandLine -match 'client-session-id={profile_id}' "
            f"-and $_.CommandLine -notmatch '--type=' }} | "
            f"Select-Object -First 1 ProcessId,CommandLine | ConvertTo-Json"
        )
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_cmd],
                capture_output=True, text=True, timeout=15
            )
            if result.stdout.strip():
                obj = json.loads(result.stdout.strip())
                if obj and "ProcessId" in obj:
                    return int(obj["ProcessId"]), obj["CommandLine"]
        except Exception as e:
            log.debug(f"[MLX] _get_chrome_info error: {e}")

        return None, None

    async def _kill_pid(self, pid) -> None:
        """Kill a specific PID."""
        if pid is None:
            return
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                           capture_output=True, timeout=5)
            log.info(f"[MLX] killed PID {pid}")
        except Exception as e:
            log.debug(f"[MLX] kill PID {pid} failed: {e}")

    async def _kill_profile_browser(self, profile_id: str) -> None:
        """Kill all MLX browser processes for this profile (matched by --client-session-id)."""
        try:
            ps_cmd = (
                f"Get-WmiObject Win32_Process -Filter \"Name='chrome.exe'\" | "
                f"Where-Object {{ $_.CommandLine -match 'client-session-id={profile_id}' }} | "
                f"ForEach-Object {{ $_.Terminate() }}"
            )
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_cmd],
                capture_output=True, timeout=10
            )
            log.info(f"[MLX] killed browser processes for {profile_id[:8]}")
        except Exception as e:
            log.debug(f"[MLX] kill profile browser error: {e}")

    async def _verify_cdp(self, port: int) -> bool:
        """Check if CDP is accessible on given port."""
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(f"http://127.0.0.1:{port}/json/version",
                                  timeout=aiohttp.ClientTimeout(total=3)) as r:
                    return r.status == 200
        except Exception:
            return False

    # ── Stop profile ──────────────────────────────────────────────────────────

    async def stop_profile(self, profile_id: str) -> dict:
        """Stop profile by killing its chrome processes."""
        await self._kill_profile_browser(profile_id)
        return {"code": 0, "message": "stopped"}

    # ── Create profile ────────────────────────────────────────────────────────

    async def create_profile(self, options: dict) -> dict:
        """POST /profile/create — noise antidetect (never natural/real)."""
        await self._get_token()
        if not self.folder_id:
            return {"code": -1, "message": "MULTILOGIN_FOLDER_ID not set in .env / Settings", "data": None}

        os_type = str(options.get("platform", "windows")).lower()
        parameters = options.get("parameters")
        if not parameters:
            return {
                "code": -1,
                "message": "Missing fingerprint parameters — profile creator must supply antidetect config",
                "data": None,
            }

        payload = {
            "name":         options.get("name", "MMB-Profile"),
            "browser_type": "mimic",
            "os_type":      os_type,
            "folder_id":    self.folder_id,
            "parameters":   parameters,
        }
        core = options.get("coreVersion")
        if core:
            payload["core_version"] = int(core)

        async with aiohttp.ClientSession() as s:
            async with s.post(
                f"{CLOUD_API}/profile/create",
                json=payload,
                headers=self._headers(strict=True),
                timeout=aiohttp.ClientTimeout(total=45),
            ) as r:
                ct = r.content_type or ""
                if "html" in ct:
                    return {
                        "code": -1,
                        "message": (
                            f"Multilogin token expired or invalid (HTTP {r.status}). "
                            "Settings → Multilogin → refresh automation token."
                        ),
                        "data": None,
                    }
                data = await r.json(content_type=None)
                status = data.get("status") or {}
                http_code = status.get("http_code", r.status)
                if http_code not in (200, 201):
                    msg = status.get("message") or str(data)
                    return {"code": -1, "message": msg, "data": None}

                ids = data.get("data", {}).get("ids") or []
                profile_id = ids[0] if ids else ""
                if not profile_id:
                    return {"code": -1, "message": "No profile id in Multilogin response", "data": None}

                upd = await self.update_profile_parameters(profile_id, parameters)
                if upd.get("code") != 0:
                    log.warning("[MLX] profile/update antidetect failed: %s", upd.get("message"))

                return {
                    "code": 0,
                    "message": status.get("message") or "Profile created",
                    "data": {"id": profile_id, "profileId": profile_id, "name": payload["name"]},
                }

    # ── Delete profile ────────────────────────────────────────────────────────

    async def delete_profile(self, profile_id: str) -> dict:
        """POST /profile/remove — move to trash or permanently delete."""
        await self._get_token()

        # Stop local browser + launcher session first (best effort)
        try:
            await self.stop_profile(profile_id)
            folder = self.folder_id or "no-folder"
            stop_path = f"/api/v2/profile/f/{folder}/p/{profile_id}/stop"
            async with aiohttp.ClientSession() as s:
                try:
                    async with s.get(
                        f"{LAUNCHER_HTTP}{stop_path}",
                        headers=self._auth_header(),
                        timeout=aiohttp.ClientTimeout(total=15),
                    ) as r:
                        await r.text()
                except aiohttp.ClientConnectorError:
                    connector = aiohttp.TCPConnector(ssl=_SSL_CTX)
                    async with aiohttp.ClientSession(connector=connector) as hs:
                        async with hs.get(
                            f"{LAUNCHER_HTTPS}{stop_path}",
                            headers=self._auth_header(),
                            ssl=_SSL_CTX,
                            timeout=aiohttp.ClientTimeout(total=15),
                        ) as r:
                            await r.text()
        except Exception as e:
            log.debug("[MLX] pre-delete stop skipped: %s", e)

        purge = os.getenv("MULTILOGIN_PURGE_ON_DELETE", "true").lower() in ("true", "1", "yes")
        # Multilogin X API expects "ids" (not "profile_ids") — wrong key returns HTTP 501
        payload = {"ids": [profile_id], "permanently": purge}

        async with aiohttp.ClientSession() as s:
            async with s.post(
                f"{CLOUD_API}/profile/remove",
                json=payload,
                headers={**self._headers(), "Accept": "application/json"},
                timeout=aiohttp.ClientTimeout(total=20),
            ) as r:
                text = (await r.text()).strip()
                data: dict = {}
                if text:
                    try:
                        data = json.loads(text)
                    except json.JSONDecodeError:
                        return {
                            "code": -1,
                            "message": f"Multilogin delete returned non-JSON (HTTP {r.status}): {text[:200]}",
                            "data": None,
                        }

                status = data.get("status") or {}
                http_code = status.get("http_code", r.status)
                if http_code in (200, 201) or r.status in (200, 201):
                    msg = status.get("message") or data.get("message") or "Profile removed"
                    return {"code": 0, "message": msg, "data": {"profileId": profile_id}}

                msg = status.get("message") or data.get("message") or text[:200] or f"HTTP {r.status}"
                return {"code": -1, "message": msg, "data": None}

    # ── Fetch token ───────────────────────────────────────────────────────────

    async def fetch_token(self, email: str = "", password: str = "") -> str:
        self.email    = email or self.email
        self.password = password or self.password
        await self._signin()
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{CLOUD_API}/workspace/automation_token?expiration_period=720h",
                headers=self._auth_header(),
                timeout=aiohttp.ClientTimeout(total=15)) as r:
                data = await r.json()
                token = data.get("data", {}).get("token", "")
                if not token:
                    raise RuntimeError(f"Token fetch failed: {data}")
                self.token = token
                return token
