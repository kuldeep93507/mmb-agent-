"""
MultiloginProvider — Python
===========================
Node.js MultiloginProvider.cjs ka replacement.

CDP Approach (Proven Working):
  1. Start profile via MLX launcher API with automation_type=puppeteer
  2. Read dynamic CDP port from response data.port
  3. nodriver attaches to that port

Why: MLX assigns a fresh CDP port per launch. Kill/relaunch hacks fail because the
     MLX agent respawns chrome without --remote-debugging-port.
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
import time

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


def _parse_wmic_process_pairs(stdout: str) -> list[tuple[int, str]]:
    """Parse WMIC /format:list output into (pid, cmdline) pairs.

    WMIC often puts ProcessId and CommandLine in separate blank-line blocks when
    the command line is long (typical for MLX mimic browsers). Line-by-line
    pairing handles both combined and split records.
    """
    if not stdout:
        return []

    normalized = stdout.replace("\r\r\n", "\n").replace("\r\n", "\n")
    pairs: list[tuple[int, str]] = []
    current_pid: int | None = None

    for line in normalized.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("ProcessId="):
            try:
                current_pid = int(line.split("=", 1)[1].strip())
            except ValueError:
                current_pid = None
        elif line.startswith("CommandLine="):
            cmd = line.split("=", 1)[1].strip()
            if current_pid is not None and cmd:
                pairs.append((current_pid, cmd))
            current_pid = None

    return pairs


def _run_wmic_chrome_processes(timeout: int = 30) -> str:
    """Run WMIC query for chrome.exe processes; return stdout (may be empty)."""
    try:
        result = subprocess.run(
            [
                "wmic",
                "process",
                "where",
                "name='chrome.exe'",
                "get",
                "ProcessId,CommandLine",
                "/format:list",
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        return result.stdout or ""
    except subprocess.TimeoutExpired:
        log.warning("[MLX] wmic chrome query timeout after %ss", timeout)
    except Exception as e:
        log.debug("[MLX] wmic chrome query error: %s", e)
    return ""


def _settings_file_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "user-settings.json"))


def _load_settings_file() -> dict:
    """Read user-settings.json from repo root (two levels up from this file)."""
    try:
        settings_path = _settings_file_path()
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


class MultiloginProvider:
    def __init__(self, token: str = "", email: str = "", password: str = "", folder_id: str = ""):
        # Try env vars first (set by main.py's _load_settings_to_env at startup)
        self.token     = token or os.getenv("MULTILOGIN_TOKEN", "")
        self.folder_id = folder_id or os.getenv("MULTILOGIN_FOLDER_ID", "")
        self.email     = email or os.getenv("MULTILOGIN_EMAIL", "")
        self.password  = password or os.getenv("MULTILOGIN_PASSWORD", "")

        # Fallback: read user-settings.json directly (works even without main.py import)
        if not self.token or not self.folder_id:
            try:
                s = _load_settings_file()
                if not self.token:
                    self.token = s.get("multiloginToken", "") or ""
                if not self.folder_id:
                    self.folder_id = s.get("multiloginFolderId", "") or ""
                if not self.email:
                    self.email = s.get("multiloginEmail", "") or ""
                if not self.password:
                    self.password = s.get("multiloginPassword", "") or ""
            except Exception as e:
                log.debug("[MLX] Could not read user-settings.json fallback: %s", e)

        self._session_token: str = ""

    # ── Auth ─────────────────────────────────────────────────────────────────

    def _reload_credentials(self) -> None:
        """Re-read user-settings.json + env (UI save may update disk mid-run)."""
        self.token = self.token or os.getenv("MULTILOGIN_TOKEN", "")
        self.email = self.email or os.getenv("MULTILOGIN_EMAIL", "")
        self.password = self.password or os.getenv("MULTILOGIN_PASSWORD", "")
        self.folder_id = self.folder_id or os.getenv("MULTILOGIN_FOLDER_ID", "")
        s = _load_settings_file()
        if s.get("multiloginToken"):
            self.token = str(s["multiloginToken"]).strip()
        if s.get("multiloginEmail"):
            self.email = str(s["multiloginEmail"]).strip()
        if s.get("multiloginPassword"):
            self.password = str(s["multiloginPassword"]).strip()
        if s.get("multiloginFolderId"):
            self.folder_id = str(s["multiloginFolderId"]).strip()

    def _persist_token(self, token: str) -> None:
        """Save automation token to memory, env, and user-settings.json."""
        token = (token or "").strip()
        if not token:
            return
        self.token = token
        self._session_token = token
        os.environ["MULTILOGIN_TOKEN"] = token
        try:
            path = _settings_file_path()
            data = _load_settings_file()
            data["multiloginToken"] = token
            if self.email:
                data.setdefault("multiloginEmail", self.email)
            if self.folder_id:
                data.setdefault("multiloginFolderId", self.folder_id)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            log.info("[MLX] automation token saved to user-settings.json")
        except Exception as exc:
            log.warning("[MLX] could not persist token to settings file: %s", exc)

    async def _get_token(self) -> str:
        """Return 30-day automation token (preferred) or bootstrap from email/password."""
        if self._session_token:
            return self._session_token
        self._reload_credentials()
        if self.token:
            self._session_token = self.token
            return self.token
        if self.email and self.password:
            return await self._fetch_automation_token()
        raise RuntimeError(
            "Multilogin token missing. Fix: Settings → Multilogin → email + password save karo, "
            "phir 'Fetch Token' dabao. Multilogin X desktop app bhi login + running honi chahiye."
        )

    async def _signin(self) -> str:
        import hashlib as _h
        if not self.email or not self.password:
            raise RuntimeError("Multilogin email/password missing in Settings")
        pw_md5 = _h.md5(self.password.encode()).hexdigest()
        payload = {"email": self.email, "password": pw_md5}
        delays = (0, 3, 6)
        last_err = "signin failed"
        async with aiohttp.ClientSession() as s:
            for attempt, delay in enumerate(delays, start=1):
                if delay:
                    await asyncio.sleep(delay)
                try:
                    async with s.post(
                        f"{CLOUD_API}/user/signin",
                        json=payload,
                        timeout=aiohttp.ClientTimeout(total=20),
                    ) as r:
                        data = await r.json(content_type=None)
                        if r.status == 501 and attempt < len(delays):
                            log.warning("[MLX] signin HTTP 501 — retry %s/%s", attempt, len(delays))
                            continue
                        t = (data.get("data") or {}).get("token", "")
                        if not t:
                            last_err = str(data.get("message") or data)
                            continue
                        self._session_token = t
                        log.info("[MLX] signin OK — session token obtained")
                        return t
                except Exception as exc:
                    last_err = str(exc)
        raise RuntimeError(f"Multilogin signin failed: {last_err}")

    async def _fetch_automation_token(self, *, force_signin: bool = False) -> str:
        """Sign in + fetch 720h automation token (what launcher + cloud API expect)."""
        self._reload_credentials()
        if not force_signin and self.token:
            self._session_token = self.token
            return self.token
        if not self.email or not self.password:
            raise RuntimeError(
                "Multilogin email/password missing — Settings page se save karo, phir Fetch Token."
            )
        await self._signin()
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{CLOUD_API}/workspace/automation_token?expiration_period=720h",
                headers=self._auth_header(),
                timeout=aiohttp.ClientTimeout(total=20),
            ) as r:
                data = await r.json(content_type=None)
                token = (data.get("data") or {}).get("token", "")
                if not token:
                    raise RuntimeError(
                        f"Automation token fetch failed: "
                        f"{(data.get('status') or {}).get('message') or data}"
                    )
        self._persist_token(token)
        log.info("[MLX] automation token fetched (720h)")
        return token

    async def _call_launcher(self, path: str, *, method: str = "GET", retry_on_401: bool = True) -> tuple[int, str]:
        """Call local MLX launcher. Auto-refreshes token on 401."""
        token = await self._get_token()
        headers = {"Authorization": f"Bearer {token}"}

        async def _do(base_url: str, ssl_ctx=None) -> tuple[int, str]:
            kw = {"timeout": aiohttp.ClientTimeout(total=60)}
            if ssl_ctx:
                conn = aiohttp.TCPConnector(ssl=ssl_ctx)
                session = aiohttp.ClientSession(connector=conn)
            else:
                session = aiohttp.ClientSession()
            async with session as s:
                fn = s.get if method == "GET" else s.post
                async with fn(f"{base_url}{path}", headers=headers, **kw) as r:
                    return r.status, await r.text()

        # Try HTTP first, then HTTPS
        try:
            status, txt = await _do(LAUNCHER_HTTP)
        except aiohttp.ClientConnectorError:
            status, txt = await _do(LAUNCHER_HTTPS, ssl_ctx=_SSL_CTX)

        if status == 401 and retry_on_401:
            log.warning("[MLX] 401 from launcher — refreshing automation token")
            self._session_token = ""
            self.token = ""
            try:
                new_token = await self._fetch_automation_token(force_signin=True)
                headers = {"Authorization": f"Bearer {new_token}"}
                try:
                    status, txt = await _do(LAUNCHER_HTTP)
                except aiohttp.ClientConnectorError:
                    status, txt = await _do(LAUNCHER_HTTPS, ssl_ctx=_SSL_CTX)
                log.info("[MLX] retry after automation token refresh: status=%s", status)
            except Exception as se:
                log.error("[MLX] automation token refresh failed: %s", se)

        log.info(f"[MLX] launcher {path[:60]} → {status}: {txt[:120]}")
        return status, txt

    def _auth_header(self) -> dict:
        return {"Authorization": f"Bearer {self._session_token or self.token}"}

    def _headers(self, strict: bool = False) -> dict:
        h = {**self._auth_header(), "Content-Type": "application/json", "Accept": "application/json"}
        if strict:
            h["X-Strict-Mode"] = "true"
        return h

    async def update_profile_parameters(
        self, profile_id: str, parameters: dict, *, is_local: bool = False,
    ) -> dict:
        """POST /profile/update — force antidetect flags after create."""
        await self._get_token()
        payload = {
            "profile_id": profile_id,
            "is_local": bool(is_local),
            "parameters": parameters,
        }
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
        body = {
            "folder_id": self.folder_id,
            "search_text": "",
            "offset": (page - 1) * page_size,
            "limit": page_size,
            "is_removed": False,
        }

        async def _search_with_token() -> list:
            await self._get_token()
            async with aiohttp.ClientSession() as s:
                async with s.post(
                    f"{CLOUD_API}/profile/search",
                    json=body,
                    headers=self._headers(),
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as r:
                    ct = r.content_type or ""
                    if "html" in ct or r.status in (401, 403):
                        raise RuntimeError("token_invalid")
                    data = await r.json(content_type=None)
                    http_code = (data.get("status") or {}).get("http_code", r.status)
                    if http_code in (200, 201) or r.status == 200:
                        profiles = data.get("data", {}).get("profiles", [])
                        return [self._normalize(p) for p in profiles]
                    if http_code in (401, 403):
                        raise RuntimeError("token_invalid")
                    raise RuntimeError(f"list_profiles failed: {data.get('status', data)}")

        try:
            return await _search_with_token()
        except RuntimeError as exc:
            if "token_invalid" not in str(exc):
                raise
            log.warning("[MLX] profile search auth failed — refreshing automation token")
            self._session_token = ""
            self.token = ""
            await self._fetch_automation_token(force_signin=True)
            return await _search_with_token()

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

    def _parse_launcher_start_response(self, status: int, txt: str) -> dict:
        """Parse MLX /start response — returns port, already_running flag, or error."""
        try:
            body = json.loads(txt)
        except json.JSONDecodeError:
            return {"error": f"invalid JSON ({status}): {txt[:200]}"}

        data = body.get("data") or {}
        raw_port = data.get("port")
        if raw_port is not None:
            try:
                return {"port": int(raw_port)}
            except (TypeError, ValueError):
                return {"error": f"invalid port in response: {raw_port!r}"}

        status_block = body.get("status") or {}
        err_code = str(status_block.get("error_code") or "")
        message = str(status_block.get("message") or txt[:200])
        if status in (400, 500) and (
            "ALREADY_RUNNING" in err_code
            or "ALREADY_RUNNING" in txt
            or "browser process is running" in message.lower()
        ):
            return {"already_running": True}

        if err_code:
            return {"error": f"{err_code}: {message}"}
        if status not in (200, 201):
            return {"error": f"HTTP {status}: {message}"}
        return {"error": f"no port in MLX response: {txt[:200]}"}

    async def _launcher_stop_profile(self, profile_id: str) -> None:
        """Stop profile via MLX launcher (releases lock) and kill stray chrome."""
        path = f"/api/v1/profile/stop/p/{profile_id}"
        try:
            status, txt = await self._call_launcher(path)
            log.info("[MLX] launcher stop %s → %s: %s", profile_id[:8], status, txt[:120])
        except Exception as e:
            log.warning("[MLX] launcher stop failed for %s: %s", profile_id[:8], e)
        await self._kill_profile_browser(profile_id)

    async def start_profile(self, profile_id: str) -> dict:
        """
        Start MLX profile with CDP debug port accessible to nodriver.

        Uses MLX launcher automation_type=puppeteer — the API returns data.port
        (dynamic CDP port). Do NOT kill/relaunch chrome manually; MLX respawns
        without a debug port if we do that.
        """
        await self._get_token()
        folder = self.folder_id or "no-folder"
        path = (
            f"/api/v2/profile/f/{folder}/p/{profile_id}/start"
            f"?automation_type=puppeteer&headless_mode=false"
        )

        log.info("[MLX] starting profile %s via puppeteer automation", profile_id[:8])

        last_error = "unknown error"
        for attempt in range(2):
            status, txt = await self._call_launcher(path)
            parsed = self._parse_launcher_start_response(status, txt)

            if parsed.get("already_running") and attempt == 0:
                log.warning(
                    "[MLX] profile %s already running — stopping via launcher then retrying",
                    profile_id[:8],
                )
                await self._launcher_stop_profile(profile_id)
                await asyncio.sleep(4)
                continue

            if "port" in parsed:
                cdp_port = parsed["port"]
                log.info("[MLX] launcher returned CDP port %s for %s", cdp_port, profile_id[:8])
                if await self._verify_cdp_with_retry(cdp_port, timeout=45):
                    return {
                        "code": 0,
                        "data": {
                            "cdpPort": cdp_port,
                            "cdpEndpoint": f"http://127.0.0.1:{cdp_port}",
                        },
                    }
                last_error = f"CDP port {cdp_port} not accessible (profile {profile_id[:8]})"
                break

            last_error = parsed.get("error") or f"start failed ({status}): {txt[:200]}"
            break

        raise RuntimeError(last_error)

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

    def _find_main_chrome_process(
        self, profile_id: str, pairs: list[tuple[int, str]]
    ) -> tuple[int | None, str | None]:
        """Return the main (non-renderer) chrome process for a profile."""
        needle = f"client-session-id={profile_id}"
        for pid, cmd in pairs:
            if needle in cmd and "--type=" not in cmd:
                return pid, cmd
        return None, None

    async def _get_chrome_info_ps(self, profile_id: str) -> tuple[int | None, str | None]:
        """PowerShell fallback when WMIC parsing fails or returns nothing."""
        ps_cmd = (
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
            f"Where-Object {{ $_.CommandLine -like '*client-session-id={profile_id}*' "
            "-and $_.CommandLine -notlike '*--type=*' }} | "
            "Select-Object -First 1 ProcessId, CommandLine | ConvertTo-Json -Compress"
        )
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_cmd],
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            )
            if not result.stdout.strip():
                return None, None
            obj = json.loads(result.stdout.strip())
            if isinstance(obj, dict):
                pid = obj.get("ProcessId")
                cmd = obj.get("CommandLine") or ""
                if pid and cmd:
                    return int(pid), cmd
        except Exception as e:
            log.debug("[MLX] _get_chrome_info_ps error: %s", e)
        return None, None

    async def _get_chrome_info(self, profile_id: str):
        """Get PID and cmdline of MLX main chrome process for this profile.
        MLX puts the profile ID in --client-session-id=PROFILE_ID flag.
        """
        stdout = _run_wmic_chrome_processes(timeout=30)
        pid, cmd = self._find_main_chrome_process(profile_id, _parse_wmic_process_pairs(stdout))
        if cmd:
            return pid, cmd

        log.debug("[MLX] wmic missed chrome for %s — trying PowerShell fallback", profile_id[:8])
        return await self._get_chrome_info_ps(profile_id)

    def _relaunch_chrome_detached(self, cmdline: str) -> None:
        """
        Relaunch Chrome completely detached from Python — Windows-safe.
        Uses DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP so Chrome stays alive
        after Python exits. cmd.exe /c start /B runs it as background job.
        """
        try:
            # Method 1: Proper Windows detached process
            CREATE_NEW_PROCESS_GROUP = 0x00000200
            DETACHED_PROCESS         = 0x00000008
            subprocess.Popen(
                cmdline,
                shell=True,
                creationflags=CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            log.info("[MLX] Chrome relaunched (detached)")
        except Exception as e:
            log.error(f"[MLX] Chrome relaunch error: {e}")
            # Method 2: Start via cmd /c start (fully detached job)
            try:
                safe_cmd = cmdline.replace('"', '\\"')
                subprocess.Popen(
                    f'cmd /c start "" {safe_cmd}',
                    shell=True,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                log.info("[MLX] Chrome relaunched (cmd start fallback)")
            except Exception as e2:
                log.error(f"[MLX] Chrome relaunch fallback also failed: {e2}")

    async def _chrome_alive_after_relaunch(self, profile_id: str) -> bool:
        """Returns True if chrome is running for this profile."""
        stdout = _run_wmic_chrome_processes(timeout=15)
        pid, cmd = self._find_main_chrome_process(profile_id, _parse_wmic_process_pairs(stdout))
        if cmd:
            log.info(f"[MLX] post-relaunch chrome alive (PID={pid})")
            return True
        # PS fallback
        pid, cmd = await self._get_chrome_info_ps(profile_id)
        alive = bool(cmd)
        log.info(f"[MLX] post-relaunch chrome alive (PS): {alive}")
        return alive

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
        needle = f"client-session-id={profile_id}"
        stdout = _run_wmic_chrome_processes(timeout=30)
        pids = [
            str(pid)
            for pid, cmd in _parse_wmic_process_pairs(stdout)
            if cmd and needle in cmd
        ]

        if not pids:
            ps_cmd = (
                "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
                f"Where-Object {{ $_.CommandLine -like '*client-session-id={profile_id}*' }} | "
                "Select-Object -ExpandProperty ProcessId"
            )
            try:
                result = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", ps_cmd],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
                )
                pids = [p.strip() for p in result.stdout.splitlines() if p.strip().isdigit()]
            except Exception as e:
                log.debug("[MLX] kill profile browser PS fallback error: %s", e)

        if not pids:
            log.info("[MLX] no chrome processes to kill for %s", profile_id[:8])
            return

        for pid in pids:
            try:
                subprocess.run(
                    ["taskkill", "/PID", pid, "/F", "/T"],
                    capture_output=True,
                    timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
                )
            except Exception:
                pass
        log.info("[MLX] killed %d browser process(es) for %s", len(pids), profile_id[:8])

    async def _verify_cdp(self, port: int) -> bool:
        """Check if Chrome CDP is accessible on given port (ignore non-Chrome endpoints)."""
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(
                    f"http://127.0.0.1:{port}/json/version",
                    timeout=aiohttp.ClientTimeout(total=3),
                ) as r:
                    if r.status != 200:
                        return False
                    data = await r.json(content_type=None)
                    browser = str(data.get("Browser", ""))
                    if "Chrome" in browser or "Chromium" in browser:
                        return True
                    log.debug("[MLX] port %s is not Chrome CDP (Browser=%s)", port, browser)
                    return False
        except Exception:
            return False

    async def _verify_cdp_with_retry(self, port: int, timeout: int = 20) -> bool:
        """Poll CDP endpoint until reachable or timeout (seconds)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if await self._verify_cdp(port):
                return True
            await asyncio.sleep(2)
        return False

    # ── Stop profile ──────────────────────────────────────────────────────────

    async def stop_profile(self, profile_id: str) -> dict:
        """Stop profile via MLX launcher API and kill stray chrome processes."""
        await self._launcher_stop_profile(profile_id)
        return {"code": 0, "message": "stopped"}

    # ── Create profile ────────────────────────────────────────────────────────

    async def create_profile(self, options: dict) -> dict:
        """POST /profile/create — noise antidetect (never natural/real)."""
        await self._get_token()
        if not self.folder_id:
            return {"code": -1, "message": "MULTILOGIN_FOLDER_ID not set in .env / Settings", "data": None}

        os_type = str(options.get("platform", "windows")).lower()
        profile_mode = str(options.get("profileMode") or "cloud").lower()
        is_local = profile_mode in ("quick", "local")
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

                upd = await self.update_profile_parameters(
                    profile_id, parameters, is_local=is_local,
                )
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
        if email:
            self.email = email.strip()
        if password:
            self.password = password
        self._session_token = ""
        return await self._fetch_automation_token(force_signin=True)
