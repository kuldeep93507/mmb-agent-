"""
Behavioral Entropy System — Anti-Detection Navigation Engine
Adapted from MMB-Agent-v2/behavior/youtube/entropy.py

Path A: Keyword Search → random keyword pool → search → scroll → click target
Path B: Channel Search → search channel name → channel page → find video
Path C: Homepage Browse → homepage → organic scroll → title match → click
Path D: Notification bell → panel → click target video

Extra features:
- 20% chance 'Human Mistake' — wrong video first, 15-30s watch, back
- Strict metadata verification before click (video_id + channel name)
- Interaction jitter: typing speed, scroll amount, pause timing
- Per-profile deterministic personality (from profile_id hash)

FIXED:
  ✅ Bug #1: 'from nodriver.core.tab import Tab' → Any type hint
             (nodriver internal — version-sensitive, breaks on updates)
  ✅ Bug #2: tab.url → JS evaluate('location.href') throughout
             (nodriver tab has no .url property reliably)
  ✅ Bug #3: tab.evaluate() calls wrapped with asyncio.wait_for timeout
  ✅ Bug #4: _clean_search_text regex fixed — was double-escaped raw string
  ✅ Bug #5: _wait_for_channel_url — was using tab.url (broken), now JS eval
  ✅ Bug #6: 'from nodriver import cdp' inside _clear_input → moved to top
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

# FIX #1: Use Any instead of nodriver internal Tab import (version-sensitive)
# from nodriver.core.tab import Tab  ← REMOVED
Tab = Any  # type alias — safe across nodriver versions

# FIX #6: top-level cdp import
try:
    from nodriver import cdp as _cdp
    _NODRIVER_OK = True
except ImportError:
    _cdp = None          # type: ignore
    _NODRIVER_OK = False

from server_python.human_engine import (
    _extract_str,
    _js_find_selector,
    _js_find_text,
    exact_match,
    send_keys_human,
    press_enter,
)
from server_python.yt_types import VideoTarget, YouTubeManagerError
from server_python.behavior.youtube.selectors import DESKTOP

# ---------------------------------------------------------------------------
# KEYWORD POOL
# ---------------------------------------------------------------------------
GENERIC_KEYWORD_POOL: tuple[str, ...] = (
    "{title}",
    "{title} {channel}",
    "{channel} {title}",
    "{channel} latest video",
    "{channel} new video",
    "{title} full video",
    "{channel} YouTube",
    "{title} watch online",
    "{channel} official",
    "{channel} channel",
    "{channel} videos",
    "watch {title}",
    "{title} {channel} video",
    "{channel}",
    "{title} strategy",
)

CHANNEL_SEARCH_VARIATIONS: tuple[str, ...] = (
    "{channel}",
    "{channel} channel",
    "{channel} YouTube channel",
    "{channel} official",
    "{channel} videos",
)

# Desktop search — V2 single source of truth
DESKTOP_SEARCH_SELECTORS = DESKTOP.get("search_input", (
    'input[role="combobox"]',
    'input[aria-label="Search"]',
    '[role="search"] input',
    'input#search',
    'input[name="search_query"]',
    'ytd-searchbox input#search',
    'input[aria-label*="Search"]',
))

DESKTOP_RESULT_SELECTORS = DESKTOP.get("search_results_video", (
    'ytd-video-renderer',
    'ytd-item-section-renderer ytd-video-renderer',
    '#contents ytd-video-renderer',
))


class EntryPathKind(str, Enum):
    KEYWORD_SEARCH  = "path_a_keyword"
    CHANNEL_SEARCH  = "path_b_channel"
    HOMEPAGE_BROWSE = "path_c_homepage"
    NOTIFICATION    = "path_d_notification"
    GOOGLE_SEARCH   = "path_e_google"   # NEW — Plan PART 1 STEP 6C
    BING_SEARCH     = "path_f_bing"     # NEW — Plan PART 1 STEP 6C


class PersonalityType(str, Enum):
    IMPATIENT = "impatient"
    CAUTIOUS  = "cautious"
    CURIOUS   = "curious"
    DIRECT    = "direct"


# Weights: (A_keyword, B_channel, C_homepage, D_notification, E_google, F_bing)
# Plan PART 1: traffic mix per source — Google + Bing now included
_PERSONALITY_PATH_WEIGHTS: dict[PersonalityType, tuple[float, float, float, float, float, float]] = {
    PersonalityType.IMPATIENT: (0.50, 0.18, 0.02, 0.05, 0.15, 0.10),
    PersonalityType.CAUTIOUS:  (0.40, 0.25, 0.03, 0.08, 0.15, 0.09),
    PersonalityType.CURIOUS:   (0.38, 0.22, 0.04, 0.10, 0.16, 0.10),
    PersonalityType.DIRECT:    (0.48, 0.20, 0.02, 0.05, 0.15, 0.10),
}

VIEWER_PERSONAS: tuple[str, ...] = (
    "curious student",
    "working professional",
    "casual browser",
    "topic enthusiast",
    "regular subscriber",
    "first time viewer",
    "experienced researcher",
    "quick info seeker",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _tab_url(tab: Any) -> str:
    """
    FIX #2: Get current tab URL safely via JS evaluate.
    nodriver Tab does not reliably expose a .url property.
    """
    try:
        result = await asyncio.wait_for(
            tab.evaluate("(() => window.location.href)()", return_by_value=True),
            timeout=5.0,
        )
        url = result if isinstance(result, str) else getattr(result, "value", "")
        return str(url or "")
    except Exception:
        return ""


async def _safe_eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """FIX #3: All tab.evaluate calls go through this with timeout."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout,
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        return None
    except Exception:
        return None


@dataclass
class BehavioralPersonality:
    """Per-profile personality — deterministically derived from profile_id hash."""
    profile_id:         str
    personality_type:   PersonalityType
    path_weights:       tuple[float, float, float, float]
    typing_speed:       str
    scroll_speed:       str
    mistake_probability: float
    pre_click_pause:    tuple[float, float]
    search_linger:      tuple[float, float]

    @classmethod
    def from_profile_id(cls, profile_id: str) -> "BehavioralPersonality":
        digest = hashlib.sha256(profile_id.encode()).hexdigest()
        p_byte = int(digest[0:2], 16)
        t_byte = int(digest[2:4], 16)
        s_byte = int(digest[4:6], 16)
        m_byte = int(digest[6:8], 16)
        l_byte = int(digest[8:10], 16)

        personality_types = list(PersonalityType)
        personality   = personality_types[p_byte % len(personality_types)]
        typing_speeds = ["fast", "fast", "normal", "normal", "normal", "slow"]
        scroll_speeds = ["fast", "normal", "normal", "normal", "slow", "slow"]
        typing_speed  = typing_speeds[t_byte % len(typing_speeds)]
        scroll_speed  = scroll_speeds[s_byte % len(scroll_speeds)]
        mistake_prob  = 0.10 + (m_byte / 255.0) * 0.20
        pause_min     = 0.5 + (l_byte / 255.0) * 2.0
        pause_max     = pause_min + 1.0 + (p_byte / 255.0) * 1.5
        linger_min    = 2.0 + (t_byte / 255.0) * 6.0
        linger_max    = linger_min + 2.0 + (s_byte / 255.0) * 10.0
        path_weights  = _PERSONALITY_PATH_WEIGHTS[personality]

        return cls(
            profile_id=profile_id,
            personality_type=personality,
            path_weights=path_weights,
            typing_speed=typing_speed,
            scroll_speed=scroll_speed,
            mistake_probability=mistake_prob,
            pre_click_pause=(round(pause_min, 2), round(pause_max, 2)),
            search_linger=(round(linger_min, 2), round(linger_max, 2)),
        )


def _clean_search_text(text: str) -> str:
    """
    Strip special characters that break YouTube search.
    FIX #4: Was double-escaped raw string — regex was wrong.
    """
    cleaned = re.sub(r'[|"\'`~!@#$%^&*(){}\[\]<>/\\;:+=]', ' ', text)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if len(cleaned) > 50:
        cleaned = cleaned[:50].rsplit(' ', 1)[0]
    return cleaned


def _build_keyword_variants(target: VideoTarget) -> list[str]:
    title   = _clean_search_text(target.title_hint or target.video_id or "video")
    channel = _clean_search_text(target.channel_name or "")
    base    = _clean_search_text(target.search_keywords or title)
    variants: list[str] = []
    for template in GENERIC_KEYWORD_POOL:
        if not channel and "{channel}" in template and "{title}" not in template:
            continue
        kw = template.format(title=title, channel=channel).strip()
        if kw and len(kw) >= 5 and kw not in variants:
            variants.append(kw)
    if base and base not in variants:
        variants.insert(0, base)
    return variants


def _build_channel_keyword_variants(target: VideoTarget) -> list[str]:
    channel = _clean_search_text(target.channel_name or "")
    if not channel:
        return [_clean_search_text(target.search_keywords or target.title_hint or "")]
    variants = []
    for template in CHANNEL_SEARCH_VARIATIONS:
        kw = template.format(channel=channel)
        if kw and kw not in variants:
            variants.append(kw)
    return variants


def _verify_card(card: dict, target: VideoTarget) -> bool:
    href    = card.get("href", "")
    title   = card.get("title", "")
    channel = card.get("channel", "")

    if target.video_id:
        return target.video_id in href

    channel_ok = True
    if target.channel_name:
        target_ch  = target.channel_name.strip().lower()
        card_ch    = channel.strip().lower()
        channel_ok = target_ch in card_ch or card_ch in target_ch

    title_ok = True
    if target.title_hint:
        title_ok = exact_match(title, channel, target)

    return channel_ok and title_ok


async def _js_get_cards(tab: Tab) -> list[dict]:
    """Single IIFE — collect all visible result cards. Updated for 2024/2025 YT DOM."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate("""
            (() => {
                var sels = [
                    'ytd-video-renderer',
                    'ytd-rich-item-renderer',
                    'ytd-compact-video-renderer'
                ];
                var seen = new Set();
                var out = [];
                for (var s = 0; s < sels.length; s++) {
                    var els = document.querySelectorAll(sels[s]);
                    for (var i = 0; i < els.length && out.length < 40; i++) {
                        var el = els[i];
                        var titleEl = (
                            el.querySelector('#video-title') ||
                            el.querySelector('a#video-title') ||
                            el.querySelector('a#video-title-link') ||
                            el.querySelector('h3 a')
                        );
                        var channelEl = (
                            el.querySelector('ytd-channel-name yt-formatted-string') ||
                            el.querySelector('ytd-channel-name span.yt-core-attributed-string') ||
                            el.querySelector('ytd-channel-name a') ||
                            el.querySelector('#channel-name yt-formatted-string') ||
                            el.querySelector('#channel-name a') ||
                            el.querySelector('a.yt-formatted-string[href*="/@"]') ||
                            el.querySelector('a.yt-formatted-string[href*="/channel/"]') ||
                            el.querySelector('yt-formatted-string.ytd-channel-name')
                        );
                        var link = (titleEl && titleEl.tagName === 'A' ? titleEl : null)
                                || el.querySelector('a[href*="/watch"]');
                        var href = link ? (link.href || link.getAttribute('href') || '') : '';
                        if (!href || seen.has(href)) continue;
                        seen.add(href);
                        out.push({
                            title:   (titleEl ? (titleEl.getAttribute('title') || titleEl.innerText || '').trim() : ''),
                            channel: (channelEl ? (channelEl.getAttribute('title') || channelEl.innerText || channelEl.textContent || '').trim() : ''),
                            href:    href
                        });
                    }
                }
                return JSON.stringify(out);
            })()
            """, return_by_value=True),
            timeout=8.0,
        )
        json_str = _extract_str(result)
        if json_str:
            data = json.loads(json_str)
            if isinstance(data, list):
                return data
    except Exception:
        pass
    return []


async def _js_get_channel_videos(tab: Tab) -> list[dict]:
    """Scrape video cards from a channel page. Updated for 2024/2025 DOM."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate("""
            (() => {
                var out = [];
                var els = document.querySelectorAll(
                    'ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-video-renderer'
                );
                for (var i = 0; i < els.length && out.length < 30; i++) {
                    var el = els[i];
                    var titleEl = (
                        el.querySelector('#video-title') ||
                        el.querySelector('a#video-title') ||
                        el.querySelector('a#video-title-link') ||
                        el.querySelector('h3 a')
                    );
                    var href = titleEl ? (titleEl.href || titleEl.getAttribute('href') || '') : '';
                    if (!href) continue;
                    if (href.startsWith('/')) href = 'https://www.youtube.com' + href;
                    out.push({
                        title:   (titleEl ? (titleEl.getAttribute('title') || titleEl.innerText || '').trim() : ''),
                        channel: '',
                        href:    href
                    });
                }
                return JSON.stringify(out);
            })()
            """, return_by_value=True),
            timeout=8.0,
        )
        json_str = _extract_str(result)
        if json_str:
            data = json.loads(json_str)
            if isinstance(data, list):
                return data
    except Exception:
        pass
    return []


async def _js_click_by_href(tab: Tab, video_id: str, href: str) -> bool:
    """Click video link via JS — by video_id first, fallback direct nav."""
    clicked = False
    if video_id:
        try:
            result = await asyncio.wait_for(
                tab.evaluate(f"""
                (() => {{
                    var a = document.querySelector('a[href*="{video_id}"]');
                    if (a) {{ a.click(); return true; }}
                    return false;
                }})()
                """, return_by_value=True),
                timeout=5.0,
            )
            raw = getattr(result, "value", result)
            clicked = bool(raw)
        except Exception:
            pass

    if not clicked and href:
        try:
            full = href if href.startswith("http") else f"https://www.youtube.com{href}"
            await asyncio.wait_for(tab.get(full), timeout=20.0)
            clicked = True
        except Exception:
            pass

    return clicked


async def _wait_for_watch_url(tab: Tab, timeout: float = 20.0) -> bool:
    """Poll until /watch appears in URL. FIX #2: uses JS eval, not tab.url."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        url = await _tab_url(tab)
        if url and "/watch" in url:
            return True
        await asyncio.sleep(0.5)
    return False


async def _wait_for_channel_url(tab: Tab, timeout: float = 15.0) -> bool:
    """FIX #5: was using tab.url (broken) — now uses JS evaluate."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        url = await _tab_url(tab)
        if url and ("/@" in url or "/channel/" in url or "/c/" in url):
            return True
        await asyncio.sleep(0.5)
    return False


def _jitter_scroll_amount(rng: Any, personality: BehavioralPersonality) -> int:
    if personality.scroll_speed == "fast":
        return rng.randint(400, 1200)
    elif personality.scroll_speed == "slow":
        return rng.randint(200, 500)
    else:
        return rng.randint(250, 800)


async def _jitter_scroll(tab: Tab, rng: Any, personality: BehavioralPersonality, passes: int = 1) -> None:
    for _ in range(passes):
        px = _jitter_scroll_amount(rng, personality)
        try:
            await asyncio.wait_for(
                tab.evaluate(f"(() => window.scrollBy({{top: {px}, behavior: 'smooth'}}))()", return_by_value=True),
                timeout=5.0,
            )
        except Exception:
            try:
                await asyncio.wait_for(
                    tab.evaluate(f"(() => window.scrollBy(0, {px}))()", return_by_value=True),
                    timeout=5.0,
                )
            except Exception:
                pass
        delay = rng.uniform(0.6, 2.5) if personality.scroll_speed == "slow" else rng.uniform(0.3, 1.2)
        await asyncio.sleep(delay)


async def _jitter_pause_before_click(rng: Any, personality: BehavioralPersonality) -> None:
    mn, mx = personality.pre_click_pause
    await asyncio.sleep(rng.uniform(mn, mx))


async def _jitter_linger_on_results(rng: Any, personality: BehavioralPersonality) -> None:
    mn, mx = personality.search_linger
    await asyncio.sleep(rng.uniform(mn, mx))


async def _do_wrong_video_detour(tab: Tab, rng: Any, log: Any) -> None:
    """Click a random wrong video, watch 15-30s, then go back — Human Mistake pattern."""
    log("HumanMistake | picking wrong video to click first")
    cards = await _js_get_cards(tab)
    if not cards:
        log("HumanMistake | no cards found, skipping detour")
        return

    pool  = cards[:min(5, len(cards))]
    wrong = rng.choice(pool)
    w_href  = wrong.get("href", "")
    w_title = wrong.get("title", "unknown")

    if not w_href:
        log("HumanMistake | no href on wrong card, skipping")
        return

    log(f"HumanMistake | clicking wrong video: {w_title!r}")
    w_vid_id = ""
    if "/watch?v=" in w_href:
        w_vid_id = w_href.split("/watch?v=")[-1].split("&")[0][:11]

    clicked = await _js_click_by_href(tab, w_vid_id, w_href)
    if not clicked:
        log("HumanMistake | click failed, aborting detour")
        return

    await _wait_for_watch_url(tab, timeout=12.0)
    await asyncio.sleep(rng.uniform(1.5, 3.0))
    watch_time = rng.uniform(15.0, 30.0)
    log(f"HumanMistake | watching wrong video for {watch_time:.0f}s")
    await asyncio.sleep(watch_time)

    log("HumanMistake | going back to search results")
    try:
        await asyncio.wait_for(
            tab.evaluate("(() => window.history.back())()", return_by_value=True),
            timeout=5.0,
        )
    except Exception:
        pass
    await asyncio.sleep(rng.uniform(2.0, 4.0))


# ---------------------------------------------------------------------------
# MAIN ENGINE
# ---------------------------------------------------------------------------

class BehavioralEntropyEngine:
    """
    Orchestrates unpredictable navigation paths.
    Har profile ka apna unique behavioral pattern hota hai.
    """

    def __init__(self, profile_id: str, rng: Any, log: Any, wake_fn: Any = None) -> None:
        self._profile_id  = profile_id
        self._rng         = rng
        self._log         = log
        self._wake_fn     = wake_fn
        self._personality = BehavioralPersonality.from_profile_id(profile_id)
        self._log(
            f"[Entropy] Personality={self._personality.personality_type.value} "
            f"typing={self._personality.typing_speed} "
            f"scroll={self._personality.scroll_speed} "
            f"mistake_prob={self._personality.mistake_probability:.0%}"
        )

    def select_path(self) -> EntryPathKind:
        paths = [
            EntryPathKind.KEYWORD_SEARCH,
            EntryPathKind.CHANNEL_SEARCH,
            EntryPathKind.HOMEPAGE_BROWSE,
            EntryPathKind.NOTIFICATION,
            EntryPathKind.GOOGLE_SEARCH,
            EntryPathKind.BING_SEARCH,
        ]
        weights = list(self._personality.path_weights)
        chosen  = self._rng.choices(paths, weights=weights, k=1)[0]
        self._log(f"[Entropy] Entry path selected: {chosen.value}")
        return chosen

    def _get_viewer_persona(self) -> str:
        digest      = hashlib.sha256(self._profile_id.encode()).hexdigest()
        persona_idx = int(digest[10:12], 16) % len(VIEWER_PERSONAS)
        persona     = VIEWER_PERSONAS[persona_idx]
        self._log(f"[Entropy] Viewer persona: {persona!r}")
        return persona

    def _get_profile_seed(self) -> int:
        digest = hashlib.sha256(self._profile_id.encode()).hexdigest()
        return int(digest[:8], 16)

    async def execute(self, tab: Tab, target: VideoTarget) -> bool:
        """
        Main entry — pick path and execute.
        Fallback chain: B → A, C → A, D → A
        Returns True if target video found & clicked.
        """
        await self._wake("entropy-execute")
        path = self.select_path()

        if path == EntryPathKind.KEYWORD_SEARCH:
            self._log("[Entropy] Executing Path A (YouTube Keyword Search)")
            return await self._path_a_keyword_search(tab, target)

        elif path == EntryPathKind.CHANNEL_SEARCH:
            self._log("[Entropy] Executing Path B (Channel Page Search)")
            result = await self._path_b_channel_search(tab, target)
            if not result:
                self._log("[Entropy] Path B failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        elif path == EntryPathKind.HOMEPAGE_BROWSE:
            self._log("[Entropy] Executing Path C (Homepage Browse)")
            result = await self._path_c_homepage_browse(tab, target)
            if not result:
                self._log("[Entropy] Path C failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        elif path == EntryPathKind.NOTIFICATION:
            self._log("[Entropy] Executing Path D (Notification)")
            result = await self._path_d_notification(tab, target)
            if not result:
                self._log("[Entropy] Path D failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        elif path == EntryPathKind.GOOGLE_SEARCH:
            self._log("[Entropy] Executing Path E (Google Search)")
            result = await self._path_e_google_search(tab, target)
            if not result:
                self._log("[Entropy] Path E failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        else:  # BING_SEARCH
            self._log("[Entropy] Executing Path F (Bing Search)")
            result = await self._path_f_bing_search(tab, target)
            if not result:
                self._log("[Entropy] Path F failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

    async def _wake(self, reason: str) -> None:
        if not self._wake_fn:
            return
        try:
            await self._wake_fn(reason)
        except Exception as exc:
            self._log(f"[AntiSleep] wake warn ({reason}): {exc}")

    async def execute_for_source(
        self, tab: Tab, target: VideoTarget, source: str = "", wake_fn: Any = None
    ) -> bool:
        """Honour Engagement source override; wake profile before navigation."""
        if wake_fn is not None:
            self._wake_fn = wake_fn
        await self._wake("nav-start")
        s = (source or "").strip().lower()

        if s == "direct":
            self._log("[Entropy] Source=direct — skipping organic navigation")
            return False

        if s in ("search", "youtube_search", "youtube-search"):
            self._log("[Entropy] Source=search — forced Path A (YouTube keyword)")
            await self._ensure_home(tab)
            return await self._path_a_keyword_search(tab, target)

        if s == "homepage":
            self._log("[Entropy] Source=homepage — forced Path C")
            result = await self._path_c_homepage_browse(tab, target)
            if not result:
                self._log("[Entropy] Path C failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        if s == "notification":
            self._log("[Entropy] Source=notification — forced Path D")
            result = await self._path_d_notification(tab, target)
            if not result:
                self._log("[Entropy] Path D failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        if s in ("google", "google_search", "google-search"):
            self._log("[Entropy] Source=google — forced Path E (Google Search)")
            result = await self._path_e_google_search(tab, target)
            if not result:
                self._log("[Entropy] Path E failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        if s in ("bing", "bing_search", "bing-search"):
            self._log("[Entropy] Source=bing — forced Path F (Bing Search)")
            result = await self._path_f_bing_search(tab, target)
            if not result:
                self._log("[Entropy] Path F failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        return await self.execute(tab, target)

    async def _ensure_home(self, tab: Tab) -> None:
        """FIX #2: tab.url replaced with _tab_url() JS eval."""
        await self._wake("ensure-home")
        try:
            url = await _tab_url(tab)
            if "youtube.com" in url and "/watch" not in url and "/results" not in url:
                return
            await asyncio.wait_for(tab.get("https://www.youtube.com"), timeout=15.0)
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
        except Exception as e:
            self._log(f"[Entropy] _ensure_home error: {e}")

    # ── Search input helpers ───────────────────────────────────────────────────

    async def _find_search_bar(self, tab: Tab, label: str) -> Optional[Any]:
        from server_python.human_engine import wait_for_any_element
        from server_python.yt_types import ElementNotFoundError
        try:
            el, _ = await wait_for_any_element(
                tab, DESKTOP_SEARCH_SELECTORS, timeout=15.0, label=label
            )
            return el
        except ElementNotFoundError:
            return None

    async def _clear_input(self, tab: Tab) -> None:
        """Ctrl+A → Backspace to clear search input. FIX #6: uses top-level _cdp."""
        if not _NODRIVER_OK or _cdp is None:
            return
        try:
            await tab.send(_cdp.input_.dispatch_key_event(
                "keyDown", key="a", code="KeyA", modifiers=2, windows_virtual_key_code=65
            ))
            await tab.send(_cdp.input_.dispatch_key_event(
                "keyUp", key="a", code="KeyA", modifiers=2, windows_virtual_key_code=65
            ))
            await asyncio.sleep(0.1)
            await tab.send(_cdp.input_.dispatch_key_event(
                "keyDown", key="Backspace", code="Backspace", windows_virtual_key_code=8
            ))
            await tab.send(_cdp.input_.dispatch_key_event(
                "keyUp", key="Backspace", code="Backspace", windows_virtual_key_code=8
            ))
        except Exception:
            pass

    async def _submit_search(self, tab: Tab) -> bool:
        try:
            await press_enter(tab)
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
            return True
        except Exception:
            return False

    async def _wait_for_results(self, tab: Tab) -> bool:
        """FIX #2: uses _tab_url() not tab.url."""
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            url = await _tab_url(tab)
            if url and "/results" in url:
                return True
            await asyncio.sleep(0.5)
        return False

    async def _jitter_type(self, tab: Tab, text: str, element: Any = None) -> None:
        if self._personality.typing_speed == "slow":
            await asyncio.sleep(self._rng.uniform(0.5, 1.2))
        elif self._personality.typing_speed == "fast":
            await asyncio.sleep(self._rng.uniform(0.05, 0.2))
        await send_keys_human(tab, text, self._rng, element=element)
        if self._personality.typing_speed == "slow":
            await asyncio.sleep(self._rng.uniform(0.4, 1.0))
        elif self._rng.random() < 0.15:
            await asyncio.sleep(self._rng.uniform(0.3, 0.8))

    # ── PATH A: Smart Keyword Search ──────────────────────────────────────────

    async def _path_a_keyword_search(self, tab: Tab, target: VideoTarget) -> bool:
        await self._wake("search-path-a")
        title        = target.title_hint or target.video_id or "video"
        channel      = target.channel_name or ""
        profile_seed = self._get_profile_seed()
        viewer_persona = self._get_viewer_persona()

        base_variants = _build_keyword_variants(target)
        profile_rng   = random.Random(profile_seed)
        profile_rng.shuffle(base_variants)

        # AI persona keyword
        ai_persona_kw: Optional[str] = None
        try:
            from server_python.ai_brain import pick_keyword_for_persona, is_available
            if is_available():
                ai_persona_kw = pick_keyword_for_persona(
                    video_title=title, channel_name=channel,
                    viewer_persona=viewer_persona, profile_seed=profile_seed,
                    fallback_keywords=base_variants[:3], rng=self._rng,
                )
                self._log(f"[PathA] Persona keyword [{viewer_persona!r}]: {ai_persona_kw!r}")
        except Exception as e:
            self._log(f"[PathA] Persona keyword error: {e}")

        exact_kw  = f"{title} {channel}".strip() if channel else title
        mid_pos   = profile_rng.randint(2, 4)
        keyword_pool: list[str] = []
        if ai_persona_kw:
            keyword_pool.append(ai_persona_kw)

        seen_kws: set[str] = {(ai_persona_kw or "").lower()}
        for kw in base_variants:
            if kw.lower() not in seen_kws and len(keyword_pool) < 5:
                keyword_pool.append(kw)
                seen_kws.add(kw.lower())

        if exact_kw.lower() not in seen_kws:
            insert_at = min(mid_pos, len(keyword_pool))
            keyword_pool.insert(insert_at, exact_kw)

        if exact_kw not in keyword_pool:
            keyword_pool.append(exact_kw)

        self._log(f"[PathA] Keyword pool ({len(keyword_pool)}): {keyword_pool}")

        for attempt, kw in enumerate(keyword_pool, start=1):
            self._log(f"[PathA] Search attempt {attempt}/{len(keyword_pool)}: {kw!r}")
            success = await self._search_with_keyword(tab, kw, target)
            if success:
                self._log(f"[PathA] ✓ Found at keyword #{attempt}: {kw!r}")
                return True
            self._log(f"[PathA] Attempt {attempt} failed — next keyword")
            try:
                await asyncio.wait_for(
                    tab.evaluate("(() => window.history.back())()", return_by_value=True),
                    timeout=5.0,
                )
                await asyncio.sleep(self._rng.uniform(1.5, 3.0))
            except Exception:
                pass

        # Last resort: direct URL
        if target.video_id:
            self._log("[PathA] All keywords exhausted — direct URL navigate as last resort")
            try:
                direct_url = f"https://www.youtube.com/watch?v={target.video_id}"
                await asyncio.wait_for(self._navigate_direct(tab, direct_url), timeout=20.0)
                nav_ok = await _wait_for_watch_url(tab, timeout=15.0)
                if nav_ok:
                    self._log("[PathA] Direct URL last resort: success")
                    return True
            except Exception as e:
                self._log(f"[PathA] Direct URL last resort failed: {e}")

        self._log(f"[PathA] All {len(keyword_pool)} keywords exhausted")
        return False

    async def _search_with_keyword(self, tab: Tab, keyword: str, target: VideoTarget) -> bool:
        await self._wake(f"search:{keyword[:40]}")
        search_el = await self._find_search_bar(tab, "entropy_search_bar")
        if not search_el:
            self._log("[PathA] Search bar not found")
            return False

        try:
            await search_el.click()
        except Exception:
            pass
        await asyncio.sleep(self._rng.uniform(0.3, 0.7))
        await self._clear_input(tab)
        await asyncio.sleep(self._rng.uniform(0.1, 0.3))
        await self._jitter_type(tab, keyword, element=search_el)
        await asyncio.sleep(self._rng.uniform(0.4, 1.2))

        submitted = await self._submit_search(tab)
        if not submitted:
            return False

        await self._wait_for_results(tab)

        results_found = None
        for _wait in range(12):
            results_found = await _js_find_selector(tab, DESKTOP_RESULT_SELECTORS)
            if results_found:
                break
            await asyncio.sleep(1.5)
        if not results_found:
            self._log("[PathA] Results DOM not found")
            return False

        await _jitter_linger_on_results(self._rng, self._personality)

        pre_scroll_passes = self._rng.randint(1, 2)
        self._log(f"[PathA] Pre-scroll {pre_scroll_passes} pass(es) after results load")
        await _jitter_scroll(tab, self._rng, self._personality, passes=pre_scroll_passes)
        await asyncio.sleep(self._rng.uniform(0.5, 1.5))

        if self._rng.random() < self._personality.mistake_probability:
            await _do_wrong_video_detour(tab, self._rng, self._log)
            await asyncio.sleep(self._rng.uniform(1.0, 2.5))

        return await self._find_target_in_results(tab, target)

    async def _find_target_in_results(self, tab: Tab, target: VideoTarget) -> bool:
        max_passes  = self._rng.randint(3, 6)
        seen_hrefs: set[str] = set()
        all_cards:  list[dict] = []

        for pass_num in range(1, max_passes + 1):
            self._log(f"[PathA] Scanning results pass {pass_num}/{max_passes}")
            cards = await _js_get_cards(tab)

            for card in cards:
                href = card.get("href", "")
                if not href or href in seen_hrefs:
                    continue
                seen_hrefs.add(href)
                all_cards.append(card)

                if not _verify_card(card, target):
                    continue

                self._log(f"[PathA] Target verified | title={card.get('title')!r} href={href[:60]}")
                await _jitter_pause_before_click(self._rng, self._personality)
                await self._hover_card(tab, target.video_id or "", href)
                clicked = await _js_click_by_href(tab, target.video_id or "", href)
                if clicked:
                    nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
                    self._log(f"[PathA] Clicked & navigated | watch_url={nav_ok}")
                    await asyncio.sleep(self._rng.uniform(1.0, 2.5))
                    return True

            await _jitter_scroll(tab, self._rng, self._personality, passes=1)

        # AI fallback
        if all_cards:
            self._log("[PathA] Strict match failed — asking AI to identify target")
            try:
                from server_python.ai_brain import identify_target_video, is_available
                if is_available():
                    ai_idx = identify_target_video(
                        results=all_cards,
                        target_video_id=target.video_id or "",
                        target_title=target.title_hint or "",
                        target_channel=target.channel_name or "",
                    )
                    if ai_idx is not None:
                        card  = all_cards[ai_idx]
                        href  = card.get("href", "")
                        self._log(f"[AIBrain] Video identified | idx={ai_idx} href={href[:60]}")
                        await _jitter_pause_before_click(self._rng, self._personality)
                        clicked = await _js_click_by_href(tab, target.video_id or "", href)
                        if clicked:
                            nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
                            self._log(f"[AIBrain] Clicked & navigated | watch_url={nav_ok}")
                            return True
            except Exception as e:
                self._log(f"[AIBrain] Error: {e}")

        self._log(f"[PathA] Target not found after {max_passes} passes")
        return False

    # ── PATH B: Channel Search ─────────────────────────────────────────────────

    async def _path_b_channel_search(self, tab: Tab, target: VideoTarget) -> bool:
        await self._wake("search-path-b")
        self._log(f"[PathB] Channel search | channel={target.channel_name!r}")
        if not target.channel_name:
            self._log("[PathB] No channel_name — skipping")
            return False

        channel_variants = _build_channel_keyword_variants(target)
        channel_kw = self._rng.choice(channel_variants)
        self._log(f"[PathB] Searching channel: {channel_kw!r}")

        search_el = await self._find_search_bar(tab, "pathb_search_bar")
        if not search_el:
            return False

        try:
            await search_el.click()
        except Exception:
            pass
        await asyncio.sleep(self._rng.uniform(0.3, 0.6))
        await self._clear_input(tab)
        await self._jitter_type(tab, channel_kw, element=search_el)
        await asyncio.sleep(self._rng.uniform(0.5, 1.0))

        submitted = await self._submit_search(tab)
        if not submitted:
            return False

        await asyncio.sleep(self._rng.uniform(1.5, 3.0))

        channel_clicked = await self._click_channel_from_results(tab, target)
        if not channel_clicked:
            self._log("[PathB] Channel not found in results")
            return False

        await asyncio.sleep(self._rng.uniform(2.0, 4.0))
        await _wait_for_channel_url(tab, timeout=15.0)
        await self._navigate_to_videos_tab(tab)
        await asyncio.sleep(self._rng.uniform(1.5, 3.0))

        return await self._find_target_on_channel_page(tab, target)

    async def _click_channel_from_results(self, tab: Tab, target: VideoTarget) -> bool:
        target_ch = (target.channel_name or "").strip().lower()
        deadline  = time.monotonic() + 12.0
        while time.monotonic() < deadline:
            try:
                result = await asyncio.wait_for(
                    tab.evaluate(f"""
                    (() => {{
                        var channelEls = document.querySelectorAll(
                            'ytd-channel-renderer, ytd-vertical-list-item-renderer'
                        );
                        var target = {json.dumps(target_ch)};
                        for (var i = 0; i < channelEls.length; i++) {{
                            var el = channelEls[i];
                            var name = (el.querySelector('#channel-title, #text, .channel-name')
                                     || el).innerText || '';
                            if (name.toLowerCase().includes(target) || target.includes(name.toLowerCase().trim())) {{
                                var link = el.querySelector('a#main-link, a[href*="/@"], a[href*="/channel/"]');
                                if (link) {{ link.click(); return true; }}
                            }}
                        }}
                        return false;
                    }})()
                    """, return_by_value=True),
                    timeout=6.0,
                )
                raw = getattr(result, "value", result)
                if raw:
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.8)
        return False

    async def _navigate_to_videos_tab(self, tab: Tab) -> None:
        try:
            result = await asyncio.wait_for(
                tab.evaluate("""
                (() => {
                    var tabs = document.querySelectorAll(
                        'yt-tab-shape, ytd-tab-renderer, [tab-title], #tabsContent tp-yt-paper-tab'
                    );
                    for (var i = 0; i < tabs.length; i++) {
                        var t = tabs[i].innerText || tabs[i].getAttribute('tab-title') || '';
                        if (t.toLowerCase().trim() === 'videos') {
                            tabs[i].click();
                            return true;
                        }
                    }
                    return false;
                })()
                """, return_by_value=True),
                timeout=6.0,
            )
            raw = getattr(result, "value", result)
            self._log(f"[PathB] Videos tab click: {raw}")
        except Exception as e:
            self._log(f"[PathB] Videos tab error: {e}")
        await asyncio.sleep(self._rng.uniform(1.0, 2.5))

    async def _find_target_on_channel_page(self, tab: Tab, target: VideoTarget) -> bool:
        max_passes = self._rng.randint(4, 8)
        seen_hrefs: set[str] = set()

        for pass_num in range(1, max_passes + 1):
            self._log(f"[PathB] Channel video scan pass {pass_num}")
            cards = await _js_get_channel_videos(tab)

            for card in cards:
                href = card.get("href", "")
                if not href or href in seen_hrefs:
                    continue
                seen_hrefs.add(href)

                id_match    = target.video_id and target.video_id in href
                title_match = (not target.video_id) and exact_match(card.get("title", ""), "", target)

                if not (id_match or title_match):
                    continue

                self._log(f"[PathB] Target found on channel | href={href[:60]}")
                await _jitter_pause_before_click(self._rng, self._personality)
                clicked = await _js_click_by_href(tab, target.video_id or "", href)
                if clicked:
                    nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
                    self._log(f"[PathB] Clicked | watch_url={nav_ok}")
                    return True

            await _jitter_scroll(tab, self._rng, self._personality, passes=1)
            await asyncio.sleep(self._rng.uniform(0.8, 2.0))

        self._log("[PathB] Target not found on channel page")
        return False

    # ── PATH C: Homepage Browse ────────────────────────────────────────────────

    async def _path_c_homepage_browse(self, tab: Tab, target: VideoTarget) -> bool:
        """FIX #2: tab.url replaced with _tab_url()."""
        await self._wake("search-path-c")
        self._log("[PathC] Homepage browse path")

        current = await _tab_url(tab)
        if "youtube.com" not in current or "/watch" in current or "/results" in current:
            try:
                await asyncio.wait_for(tab.get("https://www.youtube.com"), timeout=20.0)
                await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            except Exception as e:
                self._log(f"[PathC] Homepage nav error: {e}")
                return False

        self._log(f"[PathC] On homepage | url={current[:60]}")

        initial_scroll = self._rng.randint(1, 2)
        await _jitter_scroll(tab, self._rng, self._personality, passes=initial_scroll)
        await asyncio.sleep(self._rng.uniform(1.5, 3.0))

        max_passes = self._rng.randint(3, 5)
        seen_hrefs: set[str] = set()

        for pass_num in range(1, max_passes + 1):
            self._log(f"[PathC] Homepage scan pass {pass_num}/{max_passes}")
            cards = await _js_get_cards(tab)

            for card in cards:
                href = card.get("href", "")
                if not href or href in seen_hrefs:
                    continue
                seen_hrefs.add(href)

                if not _verify_card(card, target):
                    continue

                self._log(f"[PathC] Target found on homepage | title={card.get('title')!r}")
                await asyncio.sleep(self._rng.uniform(1.5, 4.0))
                await _jitter_pause_before_click(self._rng, self._personality)
                clicked = await _js_click_by_href(tab, target.video_id or "", href)
                if clicked:
                    nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
                    self._log(f"[PathC] Clicked | watch_url={nav_ok}")
                    return True

            await _jitter_scroll(tab, self._rng, self._personality, passes=1)
            await asyncio.sleep(self._rng.uniform(1.0, 3.0))

        self._log("[PathC] Target not found on homepage")
        return False

    # ── PATH D: Notification Entry ────────────────────────────────────────────

    async def _path_d_notification(self, tab: Tab, target: VideoTarget) -> bool:
        await self._wake("search-path-d")
        self._log(f"[PathD] Notification path | video={target.video_id!r}")
        try:
            from server_python.notification_path import NotificationPath
            notif_path = NotificationPath(
                tab=tab, target=target, rng=self._rng,
                log_fn=self._log, resolver=None,
            )
            result = await notif_path.execute()
            if result:
                self._log("[PathD] ✓ Notification path succeeded")
                return True
        except Exception as e:
            self._log(f"[PathD] Notification path failed: {e}")
        return False

    # ── PATH E: Google Search ─────────────────────────────────────────────────

    async def _path_e_google_search(self, tab: Tab, target: VideoTarget) -> bool:
        """
        Plan PART 1 — STEP 6C: Google Search traffic source.
        Flow: google.com → search → YouTube link → verify → click
        """
        await self._wake("search-path-e")
        self._log(f"[PathE] Google Search | video={target.video_id!r}")

        title   = _clean_search_text(target.title_hint or target.video_id or "video")
        channel = _clean_search_text(target.channel_name or "")

        keyword_pool = []
        if channel:
            keyword_pool.append(f"{channel} {title} youtube")
        keyword_pool.append(f"{title} youtube")
        base = _build_keyword_variants(target)[:2]
        for kw in base:
            q = f"{kw} youtube"
            if q not in keyword_pool:
                keyword_pool.append(q)

        self._log(f"[PathE] Google keyword pool: {keyword_pool}")

        try:
            await asyncio.wait_for(tab.get("https://www.google.com"), timeout=15.0)
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            for attempt, kw in enumerate(keyword_pool, 1):
                self._log(f"[PathE] Google attempt {attempt}: {kw!r}")
                if await self._google_search_and_find(tab, kw, target):
                    self._log(f"[PathE] ✓ Found via Google at attempt {attempt}")
                    return True
                self._log(f"[PathE] Attempt {attempt} failed — next keyword")
                try:
                    await asyncio.wait_for(tab.get("https://www.google.com"), timeout=10.0)
                    await asyncio.sleep(self._rng.uniform(1.0, 2.0))
                except Exception:
                    pass

            self._log("[PathE] All Google keywords exhausted")
            return False
        except Exception as e:
            self._log(f"[PathE] Google error: {e}")
            return False

    async def _google_search_and_find(self, tab: Tab, keyword: str, target: VideoTarget) -> bool:
        """Type keyword in Google, find + click YouTube video link."""
        # Find Google search bar
        search_el = None
        for sel in ('input[name="q"]', 'textarea[name="q"]', '#APjFqb', 'input[type="text"]'):
            try:
                el = await asyncio.wait_for(tab.select(sel), timeout=3.0)
                if el:
                    search_el = el
                    break
            except Exception:
                continue

        if not search_el:
            self._log("[PathE] Google search bar not found")
            return False

        try:
            await search_el.click()
        except Exception:
            pass
        await asyncio.sleep(self._rng.uniform(0.3, 0.7))
        await self._clear_input(tab)
        await asyncio.sleep(self._rng.uniform(0.1, 0.3))
        await self._jitter_type(tab, keyword, element=search_el)
        await asyncio.sleep(self._rng.uniform(0.4, 1.0))

        if not await self._submit_search(tab):
            return False

        # Wait for Google results page
        deadline = time.monotonic() + 12.0
        while time.monotonic() < deadline:
            url = await _tab_url(tab)
            if url and "google.com/search" in url:
                break
            await asyncio.sleep(0.5)

        await asyncio.sleep(self._rng.uniform(1.5, 3.0))
        await _jitter_scroll(tab, self._rng, self._personality, passes=1)
        await asyncio.sleep(self._rng.uniform(1.0, 2.5))

        # Find best YouTube link in results
        video_id   = target.video_id or ""
        title_kw   = _clean_search_text(target.title_hint or "").lower()
        channel_kw = _clean_search_text(target.channel_name or "").lower()

        raw = await _safe_eval(tab, f"""
        (() => {{
            var links = document.querySelectorAll('a[href*="youtube.com/watch"]');
            var video_id  = {json.dumps(video_id)};
            var title_kw  = {json.dumps(title_kw)};
            var ch_kw     = {json.dumps(channel_kw)};
            for (var i = 0; i < links.length; i++) {{
                var href = links[i].href || '';
                if (!href.includes('youtube.com/watch')) continue;
                if (video_id && href.includes(video_id))
                    return JSON.stringify({{href: href, match: 'video_id'}});
                if (title_kw) {{
                    var par  = links[i].closest('.g, .tF2Cxc, .MjjYud, [data-sokoban-feature]');
                    var text = (par ? par.innerText : links[i].innerText || '').toLowerCase();
                    var words = title_kw.split(' ').filter(function(w){{return w.length>3;}});
                    if (words.length && words.filter(function(w){{return text.includes(w);}}).length / words.length >= 0.5)
                        return JSON.stringify({{href: href, match: 'title'}});
                }}
                if (ch_kw && ch_kw.length > 3) {{
                    var par2 = links[i].closest('.g, .tF2Cxc, .MjjYud');
                    if (par2 && par2.innerText.toLowerCase().includes(ch_kw))
                        return JSON.stringify({{href: href, match: 'channel'}});
                }}
            }}
            if (links.length > 0) return JSON.stringify({{href: links[0].href, match: 'first'}});
            return null;
        }})()
        """, timeout=8.0)

        if not raw:
            self._log("[PathE] No YouTube links in Google results")
            return False

        try:
            found = json.loads(str(raw))
        except Exception:
            return False

        href = found.get("href", "")
        if not href:
            return False

        self._log(f"[PathE] Link found ({found.get('match')}): {href[:60]}")
        await _jitter_pause_before_click(self._rng, self._personality)

        # Click link
        clicked = await _safe_eval(tab, f"""
        (() => {{
            var links = document.querySelectorAll('a[href*="youtube.com/watch"]');
            for (var i=0; i<links.length; i++) {{
                if (links[i].href.includes({json.dumps(href[:50])})) {{
                    links[i].click(); return true;
                }}
            }}
            return false;
        }})()
        """, timeout=5.0)

        if not clicked:
            try:
                await asyncio.wait_for(tab.get(href), timeout=15.0)
                clicked = True
            except Exception as e:
                self._log(f"[PathE] Direct nav failed: {e}")
                return False

        nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
        self._log(f"[PathE] YouTube navigation: {nav_ok}")
        if nav_ok:
            await asyncio.sleep(self._rng.uniform(1.0, 2.5))
        return nav_ok

    # ── PATH F: Bing Search ───────────────────────────────────────────────────

    async def _path_f_bing_search(self, tab: Tab, target: VideoTarget) -> bool:
        """
        Plan PART 1 — STEP 6C: Bing Search traffic source.
        Flow: bing.com → search → YouTube link → verify → click
        """
        await self._wake("search-path-f")
        self._log(f"[PathF] Bing Search | video={target.video_id!r}")

        title   = _clean_search_text(target.title_hint or target.video_id or "video")
        channel = _clean_search_text(target.channel_name or "")

        keyword_pool = []
        if channel:
            keyword_pool.append(f"{channel} {title} site:youtube.com")
            keyword_pool.append(f"{channel} {title} youtube")
        keyword_pool.append(f"{title} site:youtube.com")
        keyword_pool.append(f"{title} youtube")

        self._log(f"[PathF] Bing keyword pool: {keyword_pool}")

        try:
            await asyncio.wait_for(tab.get("https://www.bing.com"), timeout=15.0)
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            for attempt, kw in enumerate(keyword_pool, 1):
                self._log(f"[PathF] Bing attempt {attempt}: {kw!r}")
                if await self._bing_search_and_find(tab, kw, target):
                    self._log(f"[PathF] ✓ Found via Bing at attempt {attempt}")
                    return True
                self._log(f"[PathF] Attempt {attempt} failed — next keyword")
                try:
                    await asyncio.wait_for(tab.get("https://www.bing.com"), timeout=10.0)
                    await asyncio.sleep(self._rng.uniform(1.0, 2.0))
                except Exception:
                    pass

            self._log("[PathF] All Bing keywords exhausted")
            return False
        except Exception as e:
            self._log(f"[PathF] Bing error: {e}")
            return False

    async def _bing_search_and_find(self, tab: Tab, keyword: str, target: VideoTarget) -> bool:
        """Type keyword in Bing, find + click YouTube video link."""
        search_el = None
        for sel in ('input[name="q"]', '#sb_form_q', 'input[type="search"]', 'input[type="text"]'):
            try:
                el = await asyncio.wait_for(tab.select(sel), timeout=3.0)
                if el:
                    search_el = el
                    break
            except Exception:
                continue

        if not search_el:
            self._log("[PathF] Bing search bar not found")
            return False

        try:
            await search_el.click()
        except Exception:
            pass
        await asyncio.sleep(self._rng.uniform(0.3, 0.7))
        await self._clear_input(tab)
        await asyncio.sleep(self._rng.uniform(0.1, 0.3))
        await self._jitter_type(tab, keyword, element=search_el)
        await asyncio.sleep(self._rng.uniform(0.4, 1.0))

        if not await self._submit_search(tab):
            return False

        # Wait for Bing results
        deadline = time.monotonic() + 12.0
        while time.monotonic() < deadline:
            url = await _tab_url(tab)
            if url and "bing.com/search" in url:
                break
            await asyncio.sleep(0.5)

        await asyncio.sleep(self._rng.uniform(1.5, 3.0))
        await _jitter_scroll(tab, self._rng, self._personality, passes=1)
        await asyncio.sleep(self._rng.uniform(1.0, 2.0))

        video_id   = target.video_id or ""
        title_kw   = _clean_search_text(target.title_hint or "").lower()
        channel_kw = _clean_search_text(target.channel_name or "").lower()

        raw = await _safe_eval(tab, f"""
        (() => {{
            var links = document.querySelectorAll('a[href*="youtube.com/watch"]');
            var video_id  = {json.dumps(video_id)};
            var title_kw  = {json.dumps(title_kw)};
            var ch_kw     = {json.dumps(channel_kw)};
            for (var i=0; i<links.length; i++) {{
                var href = links[i].href || '';
                if (!href.includes('youtube.com/watch')) continue;
                if (video_id && href.includes(video_id))
                    return JSON.stringify({{href: href, match: 'video_id'}});
                if (title_kw) {{
                    var par  = links[i].closest('li.b_algo, .b_ans, .b_result');
                    var text = (par ? par.innerText : links[i].innerText || '').toLowerCase();
                    var words = title_kw.split(' ').filter(function(w){{return w.length>3;}});
                    if (words.length && words.filter(function(w){{return text.includes(w);}}).length/words.length >= 0.5)
                        return JSON.stringify({{href: href, match: 'title'}});
                }}
                if (ch_kw && ch_kw.length > 3) {{
                    var par2 = links[i].closest('li.b_algo, .b_ans');
                    if (par2 && par2.innerText.toLowerCase().includes(ch_kw))
                        return JSON.stringify({{href: href, match: 'channel'}});
                }}
            }}
            if (links.length > 0) return JSON.stringify({{href: links[0].href, match: 'first'}});
            return null;
        }})()
        """, timeout=8.0)

        if not raw:
            self._log("[PathF] No YouTube links in Bing results")
            return False

        try:
            found = json.loads(str(raw))
        except Exception:
            return False

        href = found.get("href", "")
        if not href:
            return False

        self._log(f"[PathF] Link found ({found.get('match')}): {href[:60]}")
        await _jitter_pause_before_click(self._rng, self._personality)

        clicked = await _safe_eval(tab, f"""
        (() => {{
            var links = document.querySelectorAll('a[href*="youtube.com/watch"]');
            for (var i=0; i<links.length; i++) {{
                if (links[i].href.includes({json.dumps(href[:50])})) {{
                    links[i].click(); return true;
                }}
            }}
            return false;
        }})()
        """, timeout=5.0)

        if not clicked:
            try:
                await asyncio.wait_for(tab.get(href), timeout=15.0)
                clicked = True
            except Exception as e:
                self._log(f"[PathF] Direct nav failed: {e}")
                return False

        nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
        self._log(f"[PathF] YouTube navigation: {nav_ok}")
        if nav_ok:
            await asyncio.sleep(self._rng.uniform(1.0, 2.5))
        return nav_ok

    # ── Helpers ────────────────────────────────────────────────────────────────

    async def _navigate_direct(self, tab: Tab, url: str) -> None:
        await tab.get(url)
        await asyncio.sleep(self._rng.uniform(1.5, 3.0))

    async def _hover_card(self, tab: Tab, video_id: str, href: str) -> None:
        """Dispatch hover events on target card before clicking — human-like."""
        try:
            sel = f'a[href*="{video_id}"]' if video_id else f'a[href="{href}"]'
            await asyncio.wait_for(
                tab.evaluate(f"""
                (() => {{
                    var el = document.querySelector({json.dumps(sel)});
                    if (!el && {json.dumps(href)}) {{
                        var all = document.querySelectorAll('a[href]');
                        for (var i = 0; i < all.length; i++) {{
                            if (all[i].href === {json.dumps(href)} || all[i].getAttribute('href') === {json.dumps(href)}) {{
                                el = all[i]; break;
                            }}
                        }}
                    }}
                    if (!el) return false;
                    el.scrollIntoView({{behavior:'smooth', block:'center'}});
                    el.dispatchEvent(new MouseEvent('mouseover', {{bubbles:true}}));
                    el.dispatchEvent(new MouseEvent('mouseenter', {{bubbles:true}}));
                    return true;
                }})()
                """, return_by_value=True),
                timeout=5.0,
            )
            await asyncio.sleep(self._rng.uniform(0.5, 2.0))
        except Exception:
            pass
