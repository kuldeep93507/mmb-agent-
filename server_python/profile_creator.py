"""
ProfileCreator — Full REAL antidetect profile creation
======================================================
Unique antidetect per profile: canvas/webgl/audio noise, WebRTC/timezone/geo custom (proxy-aligned).
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Optional

log = logging.getLogger("mmb.profile_creator")


def _os_to_multilogin(os_name: str) -> str:
    m = (os_name or "Windows").strip().lower()
    if m in ("macos", "mac", "osx"):
        return "macos"
    if m == "android":
        return "android"
    if m == "linux":
        return "linux"
    return "windows"


def _os_to_morelogin(os_name: str) -> int:
    m = (os_name or "Windows").strip().lower()
    if m in ("macos", "mac", "osx"):
        return 2
    if m == "android":
        return 3
    if m in ("ios", "iphone"):
        return 4
    return 1


def _build_smartproxy(profile_id: str) -> dict:
    from server_python.smart_proxy import get_proxy_manager, normalize_proxy_server

    cfg = get_proxy_manager().get_proxy_config(profile_id)
    server = normalize_proxy_server(cfg["server"])
    return {
        "type": "smartproxy",
        "protocol": "http",
        "host": server,
        "port": cfg["port"],
        "username": cfg["username"],
        "password": cfg["password"],
        "server": server,
        "state": cfg.get("state") or "US",
        "city": cfg.get("city") or "",
        "country": cfg.get("country") or "us",
    }


def _build_multilogin_builtin_proxy(country: str = "us") -> dict:
    cc = (country or "us").lower()
    return {
        "type": "multilogin_residential",
        "host": "gate.multilogin.com",
        "port": 1080,
        "server": "gate.multilogin.com",
        "country": cc,
        "username": "",
        "password": "",
    }


def _mlx_proxy_payload(proxy: dict, api_format: str = "cloud") -> dict:
    """MLX cloud /profile/create requires type HTTP (uppercase), not http."""
    ptype = str(proxy.get("type", "http")).lower()
    if ptype == "multilogin_residential":
        return {
            "type": "socks5" if api_format == "quick" else "SOCKS5",
            "host": "gate.multilogin.com",
            "port": 1080,
            "username": f"country-{proxy.get('country', 'us')}",
            "password": "",
        }
    raw = str(proxy.get("protocol") or ptype or "http").lower()
    if raw in ("smartproxy", "residential"):
        raw = "http"
    type_map = {"http": "HTTP", "https": "HTTPS", "socks5": "SOCKS5", "socks4": "SOCKS4"}
    mlx_type = "socks5" if api_format == "quick" and raw == "socks5" else type_map.get(raw, "HTTP")
    host = proxy.get("host") or proxy.get("server") or ""
    return {
        "type": mlx_type,
        "host": host,
        "port": int(proxy["port"]),
        "username": proxy.get("username", ""),
        "password": proxy.get("password", ""),
        "save_traffic": False,
    }


def _parse_custom_resolution(body: dict) -> Optional[tuple[int, int]]:
    """Parse user-selected resolution from create-full request body."""
    raw_res = body.get("resolution")
    if raw_res and isinstance(raw_res, str) and raw_res.lower() != "auto":
        try:
            parts = raw_res.lower().replace("×", "x").split("x")
            if len(parts) == 2:
                w, h = int(parts[0].strip()), int(parts[1].strip())
                if 320 <= w <= 7680 and 240 <= h <= 4320:
                    return w, h
        except Exception:
            pass

    fp = body.get("fingerprintConfig") or {}
    fp_res = fp.get("resolution")
    if fp_res and isinstance(fp_res, str) and "x" in fp_res.lower():
        try:
            parts = fp_res.lower().replace("×", "x").split("x")
            w, h = int(parts[0].strip()), int(parts[1].strip())
            if 320 <= w <= 7680 and 240 <= h <= 4320:
                return w, h
        except Exception:
            pass

    try:
        w = int(body.get("screenWidth") or body.get("screen_width") or 0)
        h = int(body.get("screenHeight") or body.get("screen_height") or 0)
        if 320 <= w <= 7680 and 240 <= h <= 4320:
            return w, h
    except Exception:
        pass
    return None


async def create_full_profile(body: dict) -> dict:
    """
    Create profile with REAL antidetect + proxy alignment.
    Returns { code, message, data } matching frontend expectations.
    """
    browser_type = (body.get("browserType") or os.getenv("BROWSER_PROVIDER", "multilogin")).lower()
    if browser_type not in ("multilogin", "morelogin"):
        browser_type = "multilogin"

    os_name = body.get("os") or "Windows"
    name = (body.get("name") or f"MMB-{uuid.uuid4().hex[:6]}").strip()
    proxy_type = (body.get("proxyType") or "smartproxy").lower()
    profile_mode = (body.get("profileMode") or "cloud").lower()
    fp_config = body.get("fingerprintConfig") or {}

    # Parse user-selected resolution override (e.g. "1920x1080"). Falls back to
    # country-pool deterministic pick when unset / "auto" / malformed.
    custom_resolution = _parse_custom_resolution(body)
    if custom_resolution:
        log.info("[ProfileCreate] User resolution: %dx%d", *custom_resolution)

    temp_id = str(uuid.uuid4())
    if proxy_type == "multilogin" and browser_type == "multilogin":
        proxy = _build_multilogin_builtin_proxy()
    elif proxy_type != "none":
        proxy = _build_smartproxy(temp_id)
    else:
        proxy = {"type": "none"}

    identity = None
    public_ip = ""
    antidetect = {}

    if browser_type == "multilogin":
        from server_python.fingerprint_builder import (
            antidetect_real_summary,
            build_mlx_real_parameters,
            resolve_identity_for_create,
        )

        identity, public_ip = await resolve_identity_for_create(temp_id, custom_resolution=custom_resolution)
        mlx_os = _os_to_multilogin(os_name)
        proxy_payload = _mlx_proxy_payload(proxy, "cloud") if proxy.get("type") != "none" else None
        parameters = build_mlx_real_parameters(
            identity,
            mlx_os,
            public_ip,
            proxy_payload,
            fp_config,
            screen_override=custom_resolution,
        )
        antidetect = antidetect_real_summary(identity, public_ip, proxy)

        from server_python.providers.multilogin import MultiloginProvider

        provider = MultiloginProvider()
        result = await provider.create_profile({
            "name": name,
            "platform": mlx_os,
            "profileMode": profile_mode,
            "parameters": parameters,
        })
    else:
        from server_python.fingerprint_builder import (
            build_morelogin_create_fields,
            resolve_identity_for_create,
        )
        from server_python.providers.morelogin import MoreLoginProvider

        identity, public_ip = await resolve_identity_for_create(temp_id, custom_resolution=custom_resolution)
        ml_fp = build_morelogin_create_fields(identity, os_name)
        provider = MoreLoginProvider()
        result = await provider.create_profile({
            "name": name,
            "platform": os_name,
            "operatorSystemId": _os_to_morelogin(os_name),
            "browserTypeId": 1,
            "proxyConfig": _mlx_proxy_payload(proxy) if proxy.get("type") not in ("none", "multilogin_residential") else {},
            "moreloginFingerprint": ml_fp,
        })
        antidetect = {
            "provider": "morelogin",
            "engine": "MoreLogin noise canvas/webrtc + proxy-aligned identity",
            "canvas": "noise (masked)",
            "webrtc": "masked/custom",
            "timezone": identity.timezone if identity else "proxy-aligned",
            "navigator": "unique UA",
            "screen": f"{identity.screen_width}x{identity.screen_height}" if identity else "custom",
            "proxyType": proxy.get("type", "none"),
        }

    if result.get("code") != 0:
        return result

    data = result.get("data") or {}
    profile_id = data.get("id") or data.get("profileId") or ""
    if not profile_id:
        return {"code": -1, "message": "Provider returned success but no profile id", "data": None}

    if proxy.get("type") == "smartproxy" and temp_id != profile_id:
        from server_python.smart_proxy import get_proxy_manager
        get_proxy_manager().migrate_session(temp_id, profile_id)

    if identity and temp_id != profile_id:
        try:
            from server_python.identity_manager import IdentityManager
            from server_python.smart_proxy import get_proxy_manager
            IdentityManager(get_proxy_manager()).migrate_cache(temp_id, profile_id)
        except Exception as e:
            log.warning("[ProfileCreate] Identity cache migrate failed: %s", e)

    fp_out = {
        "timezone": identity.timezone if identity else "custom",
        "webrtc": "custom (proxy IP)",
        "canvas": "noise",
        "webgl": "noise + custom metadata",
        "audio": "noise",
        "navigator": "custom unique UA",
        "screen": f"{identity.screen_width}x{identity.screen_height}" if identity else "custom",
        "publicIp": public_ip or None,
    }

    return {
        "code": 0,
        "message": result.get("message") or "Profile created",
        "data": {
            "id": profile_id,
            "name": name,
            "os": os_name,
            "browserType": browser_type,
            "profileMode": profile_mode if browser_type == "multilogin" else "quick",
            "proxy": proxy,
            "fingerprint": fp_out,
            "antidetect": antidetect,
        },
    }
