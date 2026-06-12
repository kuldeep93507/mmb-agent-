"""
MLX / MoreLogin antidetect — profile create
============================================
NEVER use Multilogin "natural" or canvas "disabled" (that = REAL → IP leak risk).

Noise (always):
  canvas, webgl graphics, audio, port scan → mask + noise seeds in fingerprint

Custom (proxy-aligned, unique per profile):
  webrtc (proxy IP), timezone, geolocation, language, screen, navigator,
  media devices, webgl/webgpu metadata, fonts
"""

from __future__ import annotations

import hashlib
import logging
import random
import string
from typing import Any, Optional

from server_python.identity_manager import ProfileIdentity

log = logging.getLogger("mmb.fingerprint_builder")

_UA_CHROME = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.178 Safari/537.36",
]

_UA_MAC = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
]

_UA_ANDROID = [
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
]

_GRAPHICS = [
    ("Google Inc. (NVIDIA)", "ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)"),
    ("Google Inc. (NVIDIA)", "ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)"),
    ("Google Inc. (NVIDIA)", "ANGLE (NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)"),
    ("Google Inc. (Intel)", "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)"),
    ("Google Inc. (AMD)", "ANGLE (AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0)"),
]

_FONT_POOL = [
    "Arial", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New",
    "Georgia", "Helvetica", "Impact", "Lucida Console", "Segoe UI", "Tahoma",
    "Times New Roman", "Trebuchet MS", "Verdana", "Arial Black", "Candara",
    "Constantia", "Corbel", "Franklin Gothic Medium", "Gabriola", "Garamond",
    "Lucida Sans Unicode", "Microsoft Sans Serif", "Palatino Linotype", "Symbol",
    "Wingdings", "Book Antiqua", "Century Gothic", "Gill Sans MT",
]

# MLX only accepts 2, 4, 6, 8, 12, 16 (10 causes "wrong HardwareConcurrency data")
_CPU_CORES = [2, 4, 6, 8, 12, 16]


def _device_memory_for_cores(hw: int) -> int:
    """Browsers report device_memory as power-of-two GB: 2, 4, or 8."""
    if hw >= 12:
        return 8
    if hw >= 6:
        return 8
    if hw >= 4:
        return 4
    return 2


def _seed_rng(profile_id: str, salt: str = "") -> random.Random:
    digest = hashlib.sha256(f"{profile_id}:{salt}".encode()).hexdigest()
    return random.Random(int(digest[:12], 16))


def _noise_seed_8(profile_id: str, salt: str) -> str:
    chars = string.ascii_lowercase + string.digits
    rng = _seed_rng(profile_id, salt)
    return "".join(rng.choice(chars) for _ in range(8))


def _pick(pool: list, profile_id: str, salt: str = "") -> Any:
    return _seed_rng(profile_id, salt).choice(pool)


def _navigator_platform(os_type: str) -> tuple[str, str]:
    o = os_type.lower()
    if o == "macos":
        return "MacIntel", "Intel Mac OS X 10_15_7"
    if o == "android":
        return "Linux armv8l", "Linux armv8l"
    return "Win32", "Windows NT 10.0; Win64; x64"


def _user_agent(os_type: str, profile_id: str) -> str:
    o = os_type.lower()
    if o == "macos":
        return _pick(_UA_MAC, profile_id, "ua")
    if o == "android":
        return _pick(_UA_ANDROID, profile_id, "ua")
    return _pick(_UA_CHROME, profile_id, "ua")


def _pick_fonts(profile_id: str, count: int = 48) -> list[str]:
    rng = _seed_rng(profile_id, "fonts")
    n = min(count, len(_FONT_POOL))
    return rng.sample(_FONT_POOL, n)


def _media_devices(profile_id: str) -> dict:
    rng = _seed_rng(profile_id, "media")
    return {
        "audio_inputs": rng.randint(1, 2),
        "audio_outputs": rng.randint(1, 3),
        "video_inputs": rng.randint(0, 1),
    }


def _build_mlx_flags(has_proxy: bool) -> dict[str, Any]:
    """
    MLX flags — NO 'natural' / NO canvas 'disabled' (those expose real fingerprint).
    """
    return {
        "canvas_noise": "mask",
        "graphics_noise": "mask",
        "audio_masking": "mask",
        "ports_masking": "mask",
        "webrtc_masking": "custom",
        "timezone_masking": "custom",
        "geolocation_masking": "custom",
        "geolocation_popup": "prompt",
        "localization_masking": "custom",
        "screen_masking": "custom",
        "navigator_masking": "custom",
        "media_devices_masking": "custom",
        "graphics_masking": "custom",
        "fonts_masking": "mask",
        "proxy_masking": "custom" if has_proxy else "disabled",
        "startup_behavior": "recover",
    }


def build_mlx_fingerprint_payload(
    identity: ProfileIdentity,
    os_type: str,
    public_ip: str,
) -> dict[str, Any]:
    """Full MLX fingerprint block — noise seeds + custom proxy-aligned values."""
    pid = identity.profile_id
    platform, os_cpu = _navigator_platform(os_type)
    ua = _user_agent(os_type, pid)
    vendor, renderer = _pick(_GRAPHICS, pid, "gpu")
    hw = _pick(_CPU_CORES, pid, "cpu")
    media = _media_devices(pid)
    pixel_ratio = 2 if os_type.lower() == "android" else _pick([1, 1.25, 1.5], pid, "dpr")
    lang = identity.language
    base = lang.split("-")[0]

    canvas_seed = _noise_seed_8(pid, "canvas")
    webgl_seed = _noise_seed_8(pid, "webgl")
    audio_seed = _noise_seed_8(pid, "audio")
    port_val = 1024 + (int(hashlib.sha256(f"{pid}:port".encode()).hexdigest()[:4], 16) % 60000)

    webrtc_ip = public_ip or "0.0.0.0"

    fp: dict[str, Any] = {
        "navigator": {
            "user_agent": ua,
            "hardware_concurrency": hw,
            "device_memory": _device_memory_for_cores(hw),
            "platform": platform,
            "os_cpu": os_cpu,
        },
        "timezone": {"zone": identity.timezone},
        "screen": {
            "width": identity.screen_width,
            "height": identity.screen_height,
            "pixel_ratio": pixel_ratio,
        },
        "webrtc": {"public_ip": webrtc_ip},
        "localization": {
            "accept_languages": identity.accept_language,
            "languages": lang,
            "locale": lang,
        },
        "language": {"list": [lang]},
        "graphic": {"vendor": vendor, "renderer": renderer},
        "webgpu": {"vendor": vendor, "adapter": renderer},
        "media_devices": media,
        "geolocation": {
            "latitude": identity.lat,
            "longitude": identity.lon,
            "accuracy": _pick([50, 75, 100, 150], pid, "geoacc"),
            "altitude": round(_seed_rng(pid, "alt").uniform(0, 120), 1),
        },
        "canvas": {"mode": "noise", "seed": canvas_seed},
        "webgl": {"mode": "noise", "seed": webgl_seed},
        "audio": {"mode": "noise", "seed": audio_seed},
        "ports": [port_val],
    }
    return fp


def build_mlx_real_parameters(
    identity: ProfileIdentity,
    os_type: str,
    public_ip: str,
    proxy_payload: Optional[dict] = None,
    fingerprint_config: Optional[dict] = None,
    screen_override: Optional[tuple[int, int]] = None,
) -> dict:
    """Multilogin POST /profile/create parameters."""
    _ = fingerprint_config
    has_proxy = bool(proxy_payload)
    fingerprint = build_mlx_fingerprint_payload(identity, os_type, public_ip)

    if screen_override:
        w, h = screen_override
        fingerprint["screen"] = {
            "width": w,
            "height": h,
            "pixel_ratio": fingerprint.get("screen", {}).get("pixel_ratio", 1),
        }

    parameters: dict[str, Any] = {
        "flags": _build_mlx_flags(has_proxy),
        "fingerprint": fingerprint,
        "storage": {
            "bookmarks": True,
            "cookies": True,
            "extensions": True,
            "history": True,
            "local_storage": True,
            "passwords": True,
        },
    }
    if proxy_payload:
        parameters["proxy"] = proxy_payload

    log.info(
        "[Antidetect] MLX profile %s | canvas=noise(%s) webgl=noise(%s) audio=noise(%s) "
        "webrtc=custom(%s) tz=%s screen=%dx%d",
        identity.profile_id[:8],
        fingerprint["canvas"]["seed"],
        fingerprint["webgl"]["seed"],
        fingerprint["audio"]["seed"],
        public_ip or "pending",
        identity.timezone,
        fingerprint["screen"]["width"],
        fingerprint["screen"]["height"],
    )
    return parameters


def build_morelogin_create_fields(
    identity: ProfileIdentity,
    os_type: str,
) -> dict[str, Any]:
    """
    MoreLogin /api/env/create/quick + update fields.
    webrtcType: 0=off, 1=REAL (never), 2=masked/noise
    canvasType/webglType/audioType: 1 = noise with seed
    """
    pid = identity.profile_id
    return {
        "timezone": identity.timezone,
        "language": identity.language,
        "resolution": f"{identity.screen_width}x{identity.screen_height}",
        "webrtcType": 2,
        "canvasType": 1,
        "canvasSeed": _noise_seed_8(pid, "canvas"),
        "webglType": 1,
        "webglSeed": _noise_seed_8(pid, "webgl"),
        "audioType": 1,
        "audioSeed": _noise_seed_8(pid, "audio"),
        "latitude": identity.lat,
        "longitude": identity.lon,
        "ua": _user_agent(os_type, pid),
        "fontList": _pick_fonts(pid, 40),
    }


def antidetect_real_summary(identity: ProfileIdentity, public_ip: str, proxy: dict) -> dict:
    return {
        "provider": "multilogin",
        "engine": "Noise canvas/webgl/audio + custom proxy-aligned (never natural/real)",
        "canvas": "noise + mask",
        "webgl": "noise + custom metadata",
        "webgpu": "custom",
        "audio": "noise + mask",
        "webrtc": f"custom (proxy IP, not real) → {public_ip or 'pending'}",
        "timezone": f"custom → {identity.timezone}",
        "geolocation": f"custom → {identity.lat:.4f},{identity.lon:.4f} | popup=prompt",
        "navigator": "custom unique UA",
        "screen": f"custom → {identity.screen_width}x{identity.screen_height}",
        "language": identity.language,
        "mediaDevices": "custom",
        "portScan": "mask",
        "publicIp": public_ip or "pending",
        "proxyAligned": True,
        "proxyType": proxy.get("type", "unknown"),
        "proxyState": proxy.get("state"),
    }


async def resolve_identity_for_create(profile_id: str, custom_resolution: Optional[tuple[int, int]] = None) -> tuple[ProfileIdentity, str]:
    from server_python.identity_manager import get_identity_manager
    from server_python.smart_proxy import get_proxy_manager

    proxy_mgr = get_proxy_manager()
    proxy_cfg = proxy_mgr.get_proxy_config(profile_id)

    mgr = get_identity_manager(proxy_manager=proxy_mgr)
    identity = await mgr.get_identity(profile_id, custom_resolution=custom_resolution)
    identity = mgr.align_with_proxy_hint(identity, proxy_cfg)

    public_ip = ""
    try:
        public_ip = await mgr._get_outbound_ip(proxy_cfg.get("url", "")) or ""
    except Exception as e:
        log.debug("public IP lookup skipped: %s", e)
    return identity, public_ip
