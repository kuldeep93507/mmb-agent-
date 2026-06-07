"""
IdentityManager — Browser Fingerprint Sync for MMB AGENT 24/7
Adapted from MMB-Agent-v2/services/IdentityManager.py

Per-profile consistent identity:
  1. Proxy IP → GeoIP API → real country/city/timezone
  2. Country → timezone / language / Accept-Language header
  3. Country → realistic screen resolution pool
  4. Profile SHA-256 → deterministic noise seeds (canvas, webgl, audio)
  5. apply_to_browser() → inject JS overrides into nodriver Tab

GeoIP API: ip-api.com (free, no key needed)
  GET http://ip-api.com/json/{ip}?fields=country,countryCode,city,timezone,lat,lon

Cache: data/identity_cache/{profile_id[:12]}.json
  - Avoids hitting GeoIP API every session
  - Cache TTL: 6 hours (proxy session kan change IP)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

import aiohttp

log = logging.getLogger("mmb.identity_manager")

# Cache directory
_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "identity_cache"

# Cache TTL in seconds (6 hours)
_CACHE_TTL = 6 * 3600

# GeoIP API — free, no key
_GEOIP_URL = "http://ip-api.com/json/{ip}?fields=country,countryCode,city,timezone,lat,lon,regionName"
_GEOIP_TIMEOUT = 8  # seconds


# ── Resolution pools by country code ─────────────────────────────────────────
# Most common resolutions per region (weighted toward realistic values)
_RESOLUTION_POOLS: dict[str, list[tuple[int, int]]] = {
    # English-speaking / Western Europe — mostly 1080p+
    "US": [(1920, 1080), (1366, 768), (1440, 900), (1280, 800), (2560, 1440), (1536, 864)],
    "GB": [(1920, 1080), (1366, 768), (1440, 900), (2560, 1440), (1280, 1024)],
    "CA": [(1920, 1080), (1366, 768), (1440, 900), (2560, 1440), (1280, 800)],
    "AU": [(1920, 1080), (1366, 768), (1440, 900), (1280, 800), (2560, 1440)],
    "DE": [(1920, 1080), (1366, 768), (2560, 1440), (1440, 900), (1280, 1024)],
    "FR": [(1920, 1080), (1366, 768), (1440, 900), (2560, 1440), (1280, 1024)],
    "NL": [(1920, 1080), (1366, 768), (2560, 1440), (1440, 900)],
    "SE": [(1920, 1080), (2560, 1440), (1366, 768), (1440, 900)],
    "NO": [(1920, 1080), (2560, 1440), (1366, 768)],
    # South Asia — more 768p
    "IN": [(1366, 768), (1920, 1080), (1280, 720), (1024, 768), (1600, 900)],
    "PK": [(1366, 768), (1280, 720), (1024, 768), (1920, 1080)],
    "BD": [(1366, 768), (1024, 768), (1280, 720)],
    # East Asia
    "JP": [(1920, 1080), (1366, 768), (2560, 1440), (1440, 900)],
    "KR": [(1920, 1080), (2560, 1440), (1366, 768)],
    "CN": [(1920, 1080), (1366, 768), (1600, 900), (1280, 720)],
    # Default fallback
    "_DEFAULT": [(1920, 1080), (1366, 768), (1440, 900), (1280, 800)],
}

# ── Language / Accept-Language by country ─────────────────────────────────────
_LANGUAGE_MAP: dict[str, tuple[str, str]] = {
    # (navigator.language, Accept-Language header)
    "US": ("en-US", "en-US,en;q=0.9"),
    "GB": ("en-GB", "en-GB,en;q=0.9"),
    "CA": ("en-CA", "en-CA,en;q=0.9,fr-CA;q=0.8"),
    "AU": ("en-AU", "en-AU,en;q=0.9"),
    "IN": ("en-IN", "en-IN,en;q=0.9,hi;q=0.8"),
    "DE": ("de-DE", "de-DE,de;q=0.9,en;q=0.8"),
    "FR": ("fr-FR", "fr-FR,fr;q=0.9,en;q=0.8"),
    "NL": ("nl-NL", "nl-NL,nl;q=0.9,en;q=0.8"),
    "SE": ("sv-SE", "sv-SE,sv;q=0.9,en;q=0.8"),
    "NO": ("nb-NO", "nb-NO,nb;q=0.9,en;q=0.8"),
    "JP": ("ja-JP", "ja-JP,ja;q=0.9,en;q=0.8"),
    "KR": ("ko-KR", "ko-KR,ko;q=0.9,en;q=0.8"),
    "PK": ("en-PK", "en-PK,en;q=0.9,ur;q=0.8"),
    "BD": ("en-BD", "en-BD,en;q=0.9,bn;q=0.8"),
    "_DEFAULT": ("en-US", "en-US,en;q=0.9"),
}

# ── Timezone by country (primary/most common) ─────────────────────────────────
_TIMEZONE_MAP: dict[str, str] = {
    "US": "America/New_York",
    "GB": "Europe/London",
    "CA": "America/Toronto",
    "AU": "Australia/Sydney",
    "IN": "Asia/Kolkata",
    "DE": "Europe/Berlin",
    "FR": "Europe/Paris",
    "NL": "Europe/Amsterdam",
    "SE": "Europe/Stockholm",
    "NO": "Europe/Oslo",
    "JP": "Asia/Tokyo",
    "KR": "Asia/Seoul",
    "CN": "Asia/Shanghai",
    "PK": "Asia/Karachi",
    "BD": "Asia/Dhaka",
    "_DEFAULT": "America/New_York",
}

# US proxy state code → timezone (SmartProxy state-XX in username)
_US_STATE_TIMEZONE: dict[str, str] = {
    "ALASKA": "America/Anchorage",
    "ARIZONA": "America/Phoenix",
    "CALIFORNIA": "America/Los_Angeles",
    "COLORADO": "America/Denver",
    "FLORIDA": "America/New_York",
    "GEORGIA": "America/New_York",
    "ILLINOIS": "America/Chicago",
    "NEWYORK": "America/New_York",
    "OHIO": "America/New_York",
    "TEXAS": "America/Chicago",
    "WASHINGTON": "America/Los_Angeles",
    "NEVADA": "America/Los_Angeles",
    "OREGON": "America/Los_Angeles",
    "MICHIGAN": "America/Detroit",
    "PENNSYLVANIA": "America/New_York",
    "VIRGINIA": "America/New_York",
    "NORTH_CAROLINA": "America/New_York",
    "TX": "America/Chicago",
    "CA": "America/Los_Angeles",
    "NY": "America/New_York",
}

# Approximate geo per US state (proxy-aligned custom geolocation)
_US_STATE_GEO: dict[str, tuple[float, float]] = {
    "TX": (30.27, -97.74),
    "CA": (34.05, -118.24),
    "NY": (40.71, -74.01),
    "FL": (25.76, -80.19),
    "WA": (47.61, -122.33),
    "IL": (41.88, -87.63),
    "AZ": (33.45, -112.07),
    "GA": (33.75, -84.39),
    "NC": (35.23, -80.84),
    "OH": (39.96, -82.99),
    "ALASKA": (61.22, -149.90),
}


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class GeoInfo:
    """Raw geo data from GeoIP API."""
    ip: str = ""
    country: str = "United States"
    country_code: str = "US"
    city: str = "New York"
    region: str = ""
    timezone: str = "America/New_York"
    lat: float = 40.7128
    lon: float = -74.0060
    fetched_at: float = field(default_factory=time.time)


@dataclass
class ProfileIdentity:
    """Complete browser identity for one profile."""
    profile_id: str
    # Geo
    country_code: str
    country: str
    city: str
    timezone: str
    lat: float
    lon: float
    # Browser
    language: str           # e.g. "en-US"
    accept_language: str    # e.g. "en-US,en;q=0.9"
    screen_width: int
    screen_height: int
    # Anti-fingerprint noise (tiny, deterministic per profile)
    noise_seed: int
    canvas_noise: float     # 0.001 – 0.008  (sub-pixel canvas noise)
    webgl_noise: float      # 0.001 – 0.005
    audio_noise: float      # 0.00001 – 0.0001
    # Cache metadata
    cached_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ProfileIdentity":
        return cls(**d)


# ── IdentityManager ───────────────────────────────────────────────────────────

class IdentityManager:
    """
    Per-profile browser identity sync.

    Usage:
        mgr = IdentityManager(proxy_manager=get_proxy_manager())
        identity = await mgr.get_identity(profile_id)
        await mgr.apply_to_browser(tab, identity)
    """

    def __init__(self, proxy_manager=None) -> None:
        self._proxy_manager = proxy_manager
        self._memory_cache: dict[str, ProfileIdentity] = {}

    # ── Main API ──────────────────────────────────────────────────────────────

    async def get_identity(self, profile_id: str, custom_resolution: Optional[tuple[int, int]] = None) -> ProfileIdentity:
        """
        Get complete browser identity for a profile.
        Uses cache if fresh, otherwise fetches GeoIP from proxy IP.
        Always returns a valid identity (falls back to US defaults on error).

        custom_resolution: optional (width, height) tuple. If provided, overrides
        the country-pool auto-pick. Used when user manually sets resolution at
        profile creation time.
        """
        # 1. In-memory cache (same process)
        if profile_id in self._memory_cache:
            cached = self._memory_cache[profile_id]
            age = time.time() - cached.cached_at
            if age < _CACHE_TTL:
                # If custom resolution requested and cached doesn't match, override in place
                if custom_resolution and (cached.screen_width, cached.screen_height) != custom_resolution:
                    cached.screen_width, cached.screen_height = custom_resolution
                    self._save_cache(profile_id, cached)
                    log.info(f"[Identity] Memory-cache resolution overridden for {profile_id[:8]} → {custom_resolution[0]}x{custom_resolution[1]}")
                else:
                    log.debug(f"[Identity] Memory cache hit for {profile_id[:8]}")
                return cached

        # 2. Disk cache
        cached_disk = self._load_cache(profile_id)
        if cached_disk:
            if custom_resolution and (cached_disk.screen_width, cached_disk.screen_height) != custom_resolution:
                cached_disk.screen_width, cached_disk.screen_height = custom_resolution
                self._save_cache(profile_id, cached_disk)
                log.info(f"[Identity] Disk-cache resolution overridden for {profile_id[:8]} → {custom_resolution[0]}x{custom_resolution[1]}")
            self._memory_cache[profile_id] = cached_disk
            log.info(f"[Identity] Disk cache hit for {profile_id[:8]} | "
                     f"country={cached_disk.country_code} tz={cached_disk.timezone}")
            return cached_disk

        # 3. Fetch from GeoIP
        geo = await self._fetch_geo(profile_id)
        identity = self._build_identity(profile_id, geo, custom_resolution=custom_resolution)
        self._save_cache(profile_id, identity)
        self._memory_cache[profile_id] = identity

        log.info(f"[Identity] Built for {profile_id[:8]} | "
                 f"country={identity.country_code} city={identity.city} "
                 f"tz={identity.timezone} res={identity.screen_width}x{identity.screen_height} "
                 f"lang={identity.language}"
                 + (" [custom-res]" if custom_resolution else ""))
        return identity

    async def apply_to_browser(self, tab: Any, identity: ProfileIdentity) -> None:
        """
        Inject identity overrides into a running browser tab via JS.
        Overrides: timezone, language, screen resolution, canvas/webgl/audio noise.
        Non-fatal — logs warning on any error.
        """
        try:
            js = self._build_injection_js(identity)
            await tab.evaluate(js, return_by_value=True)
            log.info(f"[Identity] Injected into browser | "
                     f"tz={identity.timezone} lang={identity.language} "
                     f"res={identity.screen_width}x{identity.screen_height}")
        except Exception as e:
            log.warning(f"[Identity] apply_to_browser error (non-fatal): {e}")

    def invalidate(self, profile_id: str) -> None:
        """Force re-fetch on next get_identity() call (use after proxy rotation)."""
        self._memory_cache.pop(profile_id, None)
        p = self._cache_path(profile_id)
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
        log.info(f"[Identity] Cache invalidated for {profile_id[:8]}")

    def align_with_proxy_hint(self, identity: ProfileIdentity, proxy_cfg: dict) -> ProfileIdentity:
        """Align timezone/geo with SmartProxy state when GeoIP is unavailable or generic."""
        state = str(proxy_cfg.get("state") or "").upper()
        if not state or state == "US":
            return identity
        tz = _US_STATE_TIMEZONE.get(state)
        if tz:
            identity.timezone = tz
        geo = _US_STATE_GEO.get(state)
        if geo:
            identity.lat, identity.lon = geo
            identity.country_code = "US"
            identity.country = "United States"
        city = proxy_cfg.get("city")
        if city:
            identity.city = str(city)
        return identity

    # ── GeoIP fetch ───────────────────────────────────────────────────────────

    async def _fetch_geo(self, profile_id: str) -> GeoInfo:
        """Fetch geo from proxy IP via ip-api.com. Falls back to US on error."""
        proxy_url: Optional[str] = None
        proxy_ip: Optional[str] = None

        # Get proxy IP from SmartProxy config
        if self._proxy_manager:
            try:
                proxy_cfg = self._proxy_manager.get_proxy_config(profile_id)
                proxy_url = proxy_cfg.get("url", "")
            except Exception as e:
                log.debug(f"[Identity] Proxy config error: {e}")

        # First: get actual outbound IP via proxy
        if proxy_url:
            proxy_ip = await self._get_outbound_ip(proxy_url)

        if not proxy_ip:
            log.warning(f"[Identity] Could not get proxy IP for {profile_id[:8]} — using US defaults")
            return self._us_default_geo()

        # Now fetch GeoIP for that IP
        geo = await self._geoip_lookup(proxy_ip)
        return geo

    async def _get_outbound_ip(self, proxy_url: str) -> Optional[str]:
        """Get outbound IP as seen from proxy using api.ipify.org."""
        import asyncio

        def _fetch() -> Optional[str]:
            try:
                import requests
                r = requests.get(
                    "http://ip-api.com/json/?fields=query",
                    proxies={"http": proxy_url, "https": proxy_url},
                    timeout=_GEOIP_TIMEOUT,
                    headers={"User-Agent": "MMB-Agent/1.5"},
                )
                if r.status_code == 200:
                    data = r.json()
                    return data.get("query") or data.get("ip", "")
            except Exception as e:
                log.debug(f"[Identity] _get_outbound_ip error: {e}")
            return None

        try:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, _fetch)
        except Exception as e:
            log.debug(f"[Identity] _get_outbound_ip executor error: {e}")
            return None

    async def _geoip_lookup(self, ip: str) -> GeoInfo:
        """Query ip-api.com for geo data of given IP."""
        url = _GEOIP_URL.format(ip=ip)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=_GEOIP_TIMEOUT)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        geo = GeoInfo(
                            ip=ip,
                            country=data.get("country", "United States"),
                            country_code=data.get("countryCode", "US"),
                            city=data.get("city", "New York"),
                            region=data.get("regionName", ""),
                            timezone=data.get("timezone", "America/New_York"),
                            lat=float(data.get("lat", 40.7128)),
                            lon=float(data.get("lon", -74.0060)),
                            fetched_at=time.time(),
                        )
                        log.info(f"[Identity] GeoIP: {ip} → {geo.country_code}/{geo.city}/{geo.timezone}")
                        return geo
        except Exception as e:
            log.warning(f"[Identity] GeoIP lookup failed for {ip}: {e}")
        return self._us_default_geo(ip)

    def _us_default_geo(self, ip: str = "") -> GeoInfo:
        """Return US defaults when geo lookup fails."""
        return GeoInfo(
            ip=ip,
            country="United States",
            country_code="US",
            city="New York",
            region="New York",
            timezone="America/New_York",
            lat=40.7128,
            lon=-74.0060,
        )

    # ── Identity builder ──────────────────────────────────────────────────────

    def _build_identity(self, profile_id: str, geo: GeoInfo, custom_resolution: Optional[tuple[int, int]] = None) -> ProfileIdentity:
        """Build complete ProfileIdentity from GeoInfo + profile_id hash.

        custom_resolution: optional (width, height). If set, used instead of
        country-pool auto-pick. Caller is responsible for validating the tuple.
        """
        cc = geo.country_code or "US"

        # Timezone — use API value if set, else country map
        timezone = geo.timezone or _TIMEZONE_MAP.get(cc, _TIMEZONE_MAP["_DEFAULT"])

        # Language
        lang, accept_lang = _LANGUAGE_MAP.get(cc, _LANGUAGE_MAP["_DEFAULT"])

        # Screen resolution — user override > deterministic per-profile pool
        if custom_resolution:
            screen_w, screen_h = custom_resolution
        else:
            screen_w, screen_h = self._get_resolution(cc, profile_id)

        # Noise seeds — all deterministic from profile_id SHA-256
        noise_seed = self._noise_seed_int(profile_id)
        rng = random.Random(noise_seed)

        canvas_noise = round(rng.uniform(0.001, 0.008), 6)
        webgl_noise  = round(rng.uniform(0.001, 0.005), 6)
        audio_noise  = round(rng.uniform(0.00001, 0.0001), 8)

        return ProfileIdentity(
            profile_id=profile_id,
            country_code=cc,
            country=geo.country,
            city=geo.city,
            timezone=timezone,
            lat=geo.lat,
            lon=geo.lon,
            language=lang,
            accept_language=accept_lang,
            screen_width=screen_w,
            screen_height=screen_h,
            noise_seed=noise_seed,
            canvas_noise=canvas_noise,
            webgl_noise=webgl_noise,
            audio_noise=audio_noise,
            cached_at=time.time(),
        )

    def _get_resolution(self, country_code: str, profile_id: str) -> tuple[int, int]:
        """Deterministic resolution from profile_id hash + country pool."""
        pool = _RESOLUTION_POOLS.get(country_code, _RESOLUTION_POOLS["_DEFAULT"])
        # Use bytes 12-14 of SHA-256 for resolution index
        digest = hashlib.sha256(profile_id.encode()).hexdigest()
        idx = int(digest[12:14], 16) % len(pool)
        return pool[idx]

    def _noise_seed_int(self, profile_id: str) -> int:
        """Deterministic int seed from profile_id SHA-256."""
        digest = hashlib.sha256(profile_id.encode()).hexdigest()
        return int(digest[:8], 16)

    # ── JS injection ──────────────────────────────────────────────────────────

    def _build_injection_js(self, identity: ProfileIdentity) -> str:
        """
        Build JS that overrides browser fingerprint properties.
        Injected once after tab opens — overrides are consistent for the session.
        """
        # Escape strings for JS
        tz       = identity.timezone.replace("'", "\\'")
        lang     = identity.language.replace("'", "\\'")
        acc_lang = identity.accept_language.replace("'", "\\'")
        w        = identity.screen_width
        h        = identity.screen_height
        c_noise  = identity.canvas_noise
        wg_noise = identity.webgl_noise
        a_noise  = identity.audio_noise

        js = f"""
(function() {{
    'use strict';

    // ── 1. Timezone override ────────────────────────────────────────────────
    try {{
        const OrigDateTimeFormat = Intl.DateTimeFormat;
        function PatchedDateTimeFormat(locales, options) {{
            if (!options) options = {{}};
            if (!options.timeZone) options.timeZone = '{tz}';
            return new OrigDateTimeFormat(locales, options);
        }}
        PatchedDateTimeFormat.prototype = OrigDateTimeFormat.prototype;
        PatchedDateTimeFormat.supportedLocalesOf = OrigDateTimeFormat.supportedLocalesOf;
        Object.defineProperty(Intl, 'DateTimeFormat', {{ value: PatchedDateTimeFormat, writable: false }});
    }} catch(e) {{}}

    // ── 2. Language override ────────────────────────────────────────────────
    try {{
        Object.defineProperty(navigator, 'language', {{
            get: function() {{ return '{lang}'; }},
            configurable: true
        }});
        Object.defineProperty(navigator, 'languages', {{
            get: function() {{ return ['{lang}', 'en']; }},
            configurable: true
        }});
    }} catch(e) {{}}

    // ── 3. Screen resolution override ───────────────────────────────────────
    try {{
        Object.defineProperty(screen, 'width',       {{ get: function() {{ return {w}; }}, configurable: true }});
        Object.defineProperty(screen, 'height',      {{ get: function() {{ return {h}; }}, configurable: true }});
        Object.defineProperty(screen, 'availWidth',  {{ get: function() {{ return {w}; }}, configurable: true }});
        Object.defineProperty(screen, 'availHeight', {{ get: function() {{ return {h} - 40; }}, configurable: true }});
        Object.defineProperty(window, 'innerWidth',  {{ get: function() {{ return {w}; }}, configurable: true }});
        Object.defineProperty(window, 'innerHeight', {{ get: function() {{ return {h} - 80; }}, configurable: true }});
    }} catch(e) {{}}

    // ── 4. Canvas noise (sub-pixel, invisible to human) ────────────────────
    try {{
        const origGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, attrs) {{
            var ctx = origGetContext.call(this, type, attrs);
            if (!ctx || type !== '2d') return ctx;
            var origGetImageData = ctx.getImageData.bind(ctx);
            ctx.getImageData = function(x, y, w, h) {{
                var imageData = origGetImageData(x, y, w, h);
                var noise = {c_noise};
                for (var i = 0; i < imageData.data.length; i += 4) {{
                    imageData.data[i]   = Math.min(255, imageData.data[i]   + Math.floor(noise * 255 * Math.random()));
                    imageData.data[i+1] = Math.min(255, imageData.data[i+1] + Math.floor(noise * 255 * Math.random()));
                    imageData.data[i+2] = Math.min(255, imageData.data[i+2] + Math.floor(noise * 255 * Math.random()));
                }}
                return imageData;
            }};
            return ctx;
        }};
    }} catch(e) {{}}

    // ── 5. WebGL noise ──────────────────────────────────────────────────────
    try {{
        var origGetParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {{
            var result = origGetParam.call(this, param);
            if (typeof result === 'number') {{
                result = result + (Math.random() - 0.5) * {wg_noise};
            }}
            return result;
        }};
    }} catch(e) {{}}

    // ── 6. Audio noise ──────────────────────────────────────────────────────
    try {{
        var origCreateAnalyser = AudioContext.prototype.createAnalyser;
        AudioContext.prototype.createAnalyser = function() {{
            var analyser = origCreateAnalyser.call(this);
            var origGetFloatFreq = analyser.getFloatFrequencyData.bind(analyser);
            analyser.getFloatFrequencyData = function(arr) {{
                origGetFloatFreq(arr);
                for (var i = 0; i < arr.length; i++) {{
                    arr[i] += (Math.random() - 0.5) * {a_noise};
                }}
            }};
            return analyser;
        }};
    }} catch(e) {{}}

}})();
""".strip()
        return js

    # ── Cache helpers ─────────────────────────────────────────────────────────

    def _cache_path(self, profile_id: str) -> Path:
        safe_id = "".join(c for c in profile_id[:12] if c.isalnum() or c in "-_")
        return _CACHE_DIR / f"{safe_id}.json"

    def _load_cache(self, profile_id: str) -> Optional[ProfileIdentity]:
        """Load identity from disk cache if fresh enough."""
        p = self._cache_path(profile_id)
        try:
            if p.exists():
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                identity = ProfileIdentity.from_dict(data)
                age = time.time() - identity.cached_at
                if age < _CACHE_TTL:
                    return identity
                log.debug(f"[Identity] Cache expired for {profile_id[:8]} (age={age:.0f}s)")
        except Exception as e:
            log.debug(f"[Identity] Cache load error: {e}")
        return None

    def _save_cache(self, profile_id: str, identity: ProfileIdentity) -> None:
        """Atomic save to disk cache."""
        p = self._cache_path(profile_id)
        tmp = p.with_suffix(".tmp")
        try:
            _CACHE_DIR.mkdir(parents=True, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(identity.to_dict(), f, indent=2)
            tmp.replace(p)
        except Exception as e:
            log.warning(f"[Identity] Cache save error: {e}")
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass


# ── Singleton ─────────────────────────────────────────────────────────────────

_identity_manager: Optional[IdentityManager] = None


def get_identity_manager(proxy_manager=None) -> IdentityManager:
    global _identity_manager
    if _identity_manager is None:
        _identity_manager = IdentityManager(proxy_manager=proxy_manager)
    return _identity_manager
