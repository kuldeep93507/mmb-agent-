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
    GOOGLE_SEARCH   = "path_e_google"   # Plan PART 1 STEP 6C
    BING_SEARCH     = "path_f_bing"     # Plan PART 1 STEP 6C
    CHANNEL_DISCOVERY = "path_g_channel_discovery"  # Plan: search → channel icon → channel page → video


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


def _build_keyword_variants(
    target: VideoTarget,
    profile_id: str = "",
    session_nonce: str = "",
) -> list[str]:
    from server_python.search_keyword_planner import (
        build_profile_search_pool,
        clean_search_text,
        is_invalid_search_text,
    )

    title = clean_search_text(target.title_hint or "")
    if is_invalid_search_text(title):
        title = ""
    channel = clean_search_text(target.channel_name or "")
    if is_invalid_search_text(channel):
        channel = ""

    vid = (target.video_id or "").strip()
    if profile_id and vid and (title or channel):
        pool = build_profile_search_pool(
            profile_id, vid, title, channel, session_nonce=session_nonce,
        )
        if pool:
            return pool

    # Fallback without profile seed — still no video_id
    base = clean_search_text(target.search_keywords or title)
    if is_invalid_search_text(base):
        base = title
    variants: list[str] = []
    if base and not is_invalid_search_text(base):
        variants.append(base)
    if title and title not in variants:
        variants.append(title)
    return variants[:6] or ([title] if title else [])


def _build_channel_keyword_variants(target: VideoTarget) -> list[str]:
    from server_python.search_keyword_planner import is_invalid_search_text

    channel = _clean_search_text(target.channel_name or "")
    if not channel:
        for raw in (target.search_keywords, target.title_hint):
            cand = _clean_search_text(raw or "")
            if cand and not is_invalid_search_text(cand):
                return [cand]
        return []
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


_YT_VIDEO_ID_RE = re.compile(r"(?:v=|/shorts/|youtu\.be/)([a-zA-Z0-9_-]{11})")


def _video_id_from_href(href: str) -> Optional[str]:
    if not href:
        return None
    m = _YT_VIDEO_ID_RE.search(href)
    return m.group(1) if m else None


def _channel_video_matches(card: dict, target: VideoTarget) -> bool:
    """
    Match assigned task video on a channel page — STRICT id match.

    Jab video_id pata hai to SIRF id se match karo. Title fallback hata diya:
    similar-title wali galat video click ho jaati thi (wrong-video jump bug),
    fir _ensure_on_watch_page direct URL pe le jaata tha.
    """
    href = (card.get("href") or "").strip()
    card_vid = (card.get("video_id") or "").strip() or (_video_id_from_href(href) or "")
    title = card.get("title") or ""

    if target.video_id:
        return card_vid == target.video_id or target.video_id in href

    if target.title_hint:
        return exact_match(title, "", target)
    return bool(card_vid)


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
                        var channelLinkEl = (
                            el.querySelector('ytd-channel-name a') ||
                            el.querySelector('#channel-name a') ||
                            el.querySelector('a.yt-formatted-string[href*="/@"]') ||
                            el.querySelector('a.yt-formatted-string[href*="/channel/"]') ||
                            el.querySelector('a[href*="/@"]') ||
                            el.querySelector('a[href*="/channel/"]')
                        );
                        var channelEl = (
                            channelLinkEl ||
                            el.querySelector('ytd-channel-name yt-formatted-string') ||
                            el.querySelector('ytd-channel-name span.yt-core-attributed-string') ||
                            el.querySelector('#channel-name yt-formatted-string') ||
                            el.querySelector('yt-formatted-string.ytd-channel-name')
                        );
                        var link = (titleEl && titleEl.tagName === 'A' ? titleEl : null)
                                || el.querySelector('a[href*="/watch"]');
                        var href = link ? (link.href || link.getAttribute('href') || '') : '';
                        if (!href || seen.has(href)) continue;
                        seen.add(href);
                        var channelHref = channelLinkEl
                            ? (channelLinkEl.href || channelLinkEl.getAttribute('href') || '')
                            : '';
                        out.push({
                            title:   (titleEl ? (titleEl.getAttribute('title') || titleEl.innerText || '').trim() : ''),
                            channel: (channelEl ? (channelEl.getAttribute('title') || channelEl.innerText || channelEl.textContent || '').trim() : ''),
                            href:    href,
                            channel_href: channelHref
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
    """Scrape video cards from a channel page (Videos tab + grid layouts)."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate("""
            (() => {
                var out = [];
                var seen = new Set();
                var sels = [
                    'ytd-rich-grid-media',
                    'ytd-grid-video-renderer',
                    'ytd-rich-item-renderer',
                    'ytd-video-renderer',
                    'ytd-playlist-video-list-renderer'
                ];
                for (var s = 0; s < sels.length; s++) {
                    var els = document.querySelectorAll(sels[s]);
                    for (var i = 0; i < els.length && out.length < 60; i++) {
                        var el = els[i];
                        var titleEl = (
                            el.querySelector('a#video-title-link') ||
                            el.querySelector('a#video-title') ||
                            el.querySelector('#video-title') ||
                            el.querySelector('h3 a') ||
                            el.querySelector('yt-formatted-string#video-title')
                        );
                        var thumbEl = el.querySelector('a#thumbnail, a.ytd-thumbnail');
                        var watchEl = (
                            (titleEl && (titleEl.href || titleEl.getAttribute('href')) ? titleEl : null) ||
                            (thumbEl && (thumbEl.href || thumbEl.getAttribute('href')) ? thumbEl : null) ||
                            el.querySelector('a[href*="/watch"], a[href*="/shorts/"]')
                        );
                        var href = watchEl ? (watchEl.href || watchEl.getAttribute('href') || '') : '';
                        if (!href) continue;
                        if (href.startsWith('/')) href = 'https://www.youtube.com' + href;
                        var vid = '';
                        var m = href.match(/(?:v=|\\/shorts\\/|youtu\\.be\\/)([a-zA-Z0-9_-]{11})/);
                        if (m) vid = m[1];
                        var dedupe = vid || href;
                        if (seen.has(dedupe)) continue;
                        seen.add(dedupe);
                        var title = '';
                        if (titleEl) {
                            title = (titleEl.getAttribute('title') || titleEl.innerText || titleEl.textContent || '').trim();
                        }
                        if (!title && watchEl) {
                            title = (watchEl.getAttribute('title') || watchEl.getAttribute('aria-label') || '').trim();
                        }
                        out.push({
                            title:   title,
                            channel: '',
                            href:    href,
                            video_id: vid
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


_MMB_FIND_LINK_JS = """
function __mmbUnwrapHref(h) {
    if (!h) return '';
    if (h.indexOf('google.') >= 0 && h.indexOf('/url') >= 0) {
        try {
            var u = new URL(h);
            var q = u.searchParams.get('url') || u.searchParams.get('q');
            if (q) h = q;
        } catch (e) {}
    }
    if (h.indexOf('bing.com') >= 0 && h.indexOf('/ck/a') >= 0) {
        try {
            var m = h.match(/[?&]u=([^&]+)/);
            if (m) h = decodeURIComponent(m[1]);
        } catch (e) {}
    }
    return h;
}
function __mmbFindResultLink(vid, targetHref) {
    var all = document.querySelectorAll('a[href]');
    var th = __mmbUnwrapHref(targetHref || '');
    for (var i = 0; i < all.length; i++) {
        var raw = all[i].href || all[i].getAttribute('href') || '';
        var h = __mmbUnwrapHref(raw);
        if (vid && (raw.indexOf(vid) >= 0 || h.indexOf(vid) >= 0)) return all[i];
        if (th && (h === th || raw === targetHref || h.indexOf(th) >= 0 || th.indexOf(h) >= 0))
            return all[i];
    }
    return null;
}
"""


async def _js_click_by_href(tab: Tab, video_id: str, href: str, rng: Any | None = None) -> bool:
    """
    Human-like click on search/homepage result card:
    scroll to center → hover dwell → CDP bezier click.
    No direct tab.get() URL jump (unnatural).
    """
    import json as _json
    import random as _random

    r = rng or _random.Random()
    vid_j = _json.dumps(video_id or "")
    href_j = _json.dumps(href or "")

    coords_raw = None
    try:
        result = await asyncio.wait_for(
            tab.evaluate(f"""
            (() => {{
                {_MMB_FIND_LINK_JS}
                var el = __mmbFindResultLink({vid_j}, {href_j});
                if (!el) return null;
                el.scrollIntoView({{behavior: 'smooth', block: 'center'}});
                return 'pending';
            }})()
            """, return_by_value=True),
            timeout=8.0,
        )
        raw = getattr(result, "value", result)
        if raw:
            await asyncio.sleep(r.uniform(0.65, 1.25))
        result = await asyncio.wait_for(
            tab.evaluate(f"""
            (() => {{
                {_MMB_FIND_LINK_JS}
                var el = __mmbFindResultLink({vid_j}, {href_j});
                if (!el) return null;
                el.dispatchEvent(new MouseEvent('mouseover', {{bubbles: true}}));
                el.dispatchEvent(new MouseEvent('mouseenter', {{bubbles: true}}));
                var rect = el.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2) return null;
                return JSON.stringify({{
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2)
                }});
            }})()
            """, return_by_value=True),
            timeout=8.0,
        )
        raw = getattr(result, "value", result)
        if raw:
            coords_raw = raw
    except Exception:
        pass

    if coords_raw:
        try:
            await asyncio.sleep(r.uniform(0.55, 1.35))
            info = _json.loads(str(coords_raw))
            cx = float(info["x"]) + r.uniform(-8, 8)
            cy = float(info["y"]) + r.uniform(-6, 6)
            from server_python.cdp_mouse import cdp_hover_then_click
            if await cdp_hover_then_click(
                tab, cx, cy, r, dwell_min=0.45, dwell_max=1.9,
            ):
                return True
        except Exception:
            pass

    try:
        result = await asyncio.wait_for(
            tab.evaluate(f"""
            (() => {{
                {_MMB_FIND_LINK_JS}
                var el = __mmbFindResultLink({vid_j}, {href_j});
                if (!el) return false;
                el.scrollIntoView({{behavior: 'smooth', block: 'center'}});
                el.click();
                return true;
            }})()
            """, return_by_value=True),
            timeout=6.0,
        )
        raw = getattr(result, "value", result)
        if bool(raw):
            return True
    except Exception:
        pass

    return False


async def _wait_for_watch_url(tab: Tab, timeout: float = 20.0) -> bool:
    """Poll until /watch appears in URL. FIX #2: uses JS eval, not tab.url."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        url = await _tab_url(tab)
        if url and ("/watch" in url or "youtu.be/" in url):
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


async def _jitter_scroll(
    tab: Tab,
    rng: Any,
    personality: BehavioralPersonality,
    passes: int = 1,
    *,
    curve_id: str = "",
) -> None:
    """Curved wheel scroll — small steps, different easing per session."""
    from server_python.behavior.external_search import human_results_scroll
    await human_results_scroll(
        tab, rng,
        personality_speed=personality.scroll_speed,
        passes=passes,
        curve_id=curve_id,
    )


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

    clicked = await _js_click_by_href(tab, w_vid_id, w_href, rng)
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
        self._session_nonce = ""
        self._scroll_curve_id = hashlib.sha256(
            f"{profile_id}:scroll".encode()
        ).hexdigest()[8:20]
        self._log(
            f"[Entropy] Personality={self._personality.personality_type.value} "
            f"typing={self._personality.typing_speed} "
            f"scroll={self._personality.scroll_speed} "
            f"mistake_prob={self._personality.mistake_probability:.0%}"
        )

    def _profile_keyword_variants(self, target: VideoTarget) -> list[str]:
        return _build_keyword_variants(
            target,
            profile_id=self._profile_id,
            session_nonce=getattr(self, "_session_nonce", "") or "",
        )

    def _search_attempt_plan(self, target: VideoTarget) -> tuple[list[str], list[str]]:
        from server_python.search_keyword_planner import build_search_attempt_plan
        return build_search_attempt_plan(
            self._profile_id,
            target.video_id or "",
            target.title_hint or "",
            target.channel_name or "",
            session_nonce=getattr(self, "_session_nonce", "") or "",
        )

    def _build_persona_keyword_pool(
        self,
        target: VideoTarget,
        primary: list[str],
        profile_seed: int,
    ) -> list[str]:
        """Persona keywords from title words only — verified, no AI prepend."""
        from server_python.search_keyword_planner import (
            filter_keyword_pool,
            verify_keyword_pool,
        )

        title = target.title_hint or ""
        channel = target.channel_name or ""
        profile_rng = random.Random(profile_seed)
        shuffled = list(primary)
        profile_rng.shuffle(shuffled)

        keyword_pool = filter_keyword_pool(shuffled, title, channel)[:6]
        audit = verify_keyword_pool(keyword_pool, title, channel)
        self._log(
            f"[Keywords] Persona pool verified {audit['ok']}/{audit['total']} "
            f"title-related: {keyword_pool[:3]}"
        )
        if audit.get("rejected"):
            self._log(f"[Keywords] Rejected (not title-related): {audit['rejected'][:3]}")
        return keyword_pool

    async def _run_keyword_attempts(
        self,
        tab: Tab,
        target: VideoTarget,
        keyword_pool: list[str],
        *,
        log_prefix: str = "PathA",
        channel_discovery: bool = False,
    ) -> bool:
        for attempt, kw in enumerate(keyword_pool, start=1):
            self._log(f"[{log_prefix}] Search attempt {attempt}/{len(keyword_pool)}: {kw!r}")
            success = await self._search_with_keyword(
                tab, kw, target, channel_discovery=channel_discovery,
            )
            if success:
                self._log(f"[{log_prefix}] ✓ Found at keyword #{attempt}: {kw!r}")
                return True
            self._log(f"[{log_prefix}] Attempt {attempt} failed — reset for next keyword")
            await self._reset_for_next_search_attempt(tab)
        return False

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

    def _get_profile_seed(self, video_id: str = "") -> int:
        if video_id:
            from server_python.search_keyword_planner import keyword_seed_hex
            nonce = getattr(self, "_session_nonce", "") or ""
            return int(keyword_seed_hex(self._profile_id, video_id, nonce)[:8], 16)
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
                self._log("[Entropy] Path D failed — no fallback (notification source locked)")
            return result

        if s in ("google", "google_search", "google-search"):
            self._log("[Entropy] Source=google — forced Path E (Google Search)")
            result = await self._path_e_google_search(tab, target)
            if not result:
                self._log("[Entropy] Path E failed — falling back to YouTube Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        if s in ("bing", "bing_search", "bing-search"):
            self._log("[Entropy] Source=bing — forced Path F (Bing Search)")
            result = await self._path_f_bing_search(tab, target)
            if not result:
                self._log("[Entropy] Path F failed — falling back to YouTube Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        if s in ("channel_discovery", "channel_disc", "channel-discovery", "channel"):
            self._log("[Entropy] Source=channel_discovery — forced Path G")
            await self._ensure_home(tab)
            result = await self._path_g_channel_discovery(tab, target)
            if not result:
                self._log("[Entropy] Path G failed — falling back to Path A")
                await self._ensure_home(tab)
                return await self._path_a_keyword_search(tab, target)
            return result

        return await self.execute(tab, target)

    async def _ensure_home(self, tab: Tab) -> None:
        """Navigate to YouTube home and wait until masthead search is usable."""
        await self._wake("ensure-home")
        try:
            url = await _tab_url(tab)
            on_home = (
                "youtube.com" in url
                and "/watch" not in url
                and "/results" not in url
            )
            if not on_home:
                await asyncio.wait_for(tab.get("https://www.youtube.com"), timeout=25.0)
            await self._wait_youtube_ready(tab)
        except Exception as e:
            self._log(f"[Entropy] _ensure_home error: {e}")

    async def _wait_youtube_ready(self, tab: Tab, timeout: float = 45.0) -> bool:
        """
        Slow networks: wait for consent + search input before typing.
        Never history.back — stay on YouTube until ready or timeout.
        """
        from server_python.behavior.youtube.entry_flow import accept_consent_if_present

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                await accept_consent_if_present(tab)
            except Exception:
                pass
            matched = await _js_find_selector(tab, DESKTOP_SEARCH_SELECTORS)
            if matched:
                await asyncio.sleep(self._rng.uniform(0.6, 1.4))
                return True
            await asyncio.sleep(1.0)
        self._log("[Entropy] YouTube home slow — search bar not ready before timeout")
        return False

    async def _reset_for_next_search_attempt(self, tab: Tab) -> None:
        """Between keyword tries: return to YT home — never history.back (leaves YouTube)."""
        try:
            url = await _tab_url(tab)
            if "/results" in url or "/watch" in url or "youtube.com" not in url:
                self._log("[Entropy] Reset → YouTube home for next keyword")
                await self._ensure_home(tab)
            else:
                await self._wait_youtube_ready(tab, timeout=20.0)
            await asyncio.sleep(self._rng.uniform(0.8, 1.6))
        except Exception as exc:
            self._log(f"[Entropy] search reset warn: {exc}")

    # ── Search input helpers ───────────────────────────────────────────────────

    async def _find_search_bar(self, tab: Tab, label: str) -> Optional[Any]:
        from server_python.human_engine import wait_for_any_element
        from server_python.yt_types import ElementNotFoundError

        for attempt in range(2):
            try:
                el, _ = await wait_for_any_element(
                    tab, DESKTOP_SEARCH_SELECTORS, timeout=35.0, label=label,
                )
                return el
            except ElementNotFoundError:
                if attempt == 0:
                    self._log("[Entropy] Search bar not ready — waiting for YouTube load…")
                    ready = await self._wait_youtube_ready(tab, timeout=30.0)
                    if not ready:
                        try:
                            await asyncio.wait_for(
                                tab.get("https://www.youtube.com"), timeout=20.0,
                            )
                            await self._wait_youtube_ready(tab, timeout=25.0)
                        except Exception:
                            pass
                else:
                    return None
        return None

    async def _prepare_search_input(self, tab: Tab, search_el: Any) -> None:
        """Click → focus → Ctrl+A → Backspace (human_engine.clear_search_input)."""
        from server_python.human_engine import clear_search_input
        await clear_search_input(tab, search_el, self._rng)

    async def _submit_search(self, tab: Tab) -> bool:
        """Submit search via Enter; fallback to magnifying-glass click if URL unchanged."""
        try:
            before = await _tab_url(tab)
            await press_enter(tab)
            await asyncio.sleep(self._rng.uniform(1.2, 2.2))
            if await self._wait_for_results(tab, timeout=8.0):
                return True
            after = await _tab_url(tab)
            if after and "/results" in after:
                return True
            submit_sels = DESKTOP.get("search_submit_button", ())
            if submit_sels:
                hit = await _js_find_selector(tab, submit_sels)
                if hit:
                    try:
                        await tab.evaluate(
                            f"(() => {{ const el = document.querySelector({json.dumps(hit)});"
                            " if (el) { el.click(); return true; } return false; })()",
                            return_by_value=True,
                        )
                        await asyncio.sleep(self._rng.uniform(1.5, 2.5))
                        if await self._wait_for_results(tab, timeout=10.0):
                            return True
                    except Exception:
                        pass
            self._log(f"[Entropy] Search submit uncertain (url {before[:50]!r} → {after[:50]!r})")
            return "/results" in (after or "")
        except Exception:
            return False

    async def _wait_for_results(self, tab: Tab, timeout: float = 15.0) -> bool:
        """FIX #2: uses _tab_url() not tab.url."""
        deadline = time.monotonic() + timeout
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
        video_id     = target.video_id or ""
        profile_seed = self._get_profile_seed(video_id)

        primary, fallbacks = self._search_attempt_plan(target)
        keyword_pool = self._build_persona_keyword_pool(target, primary, profile_seed)
        self._log(f"[PathA] Persona keyword pool ({len(keyword_pool)}): {keyword_pool}")

        if await self._run_keyword_attempts(tab, target, keyword_pool, log_prefix="PathA"):
            return True

        if fallbacks:
            self._log(f"[PathA] Persona keywords failed — exact fallbacks: {fallbacks}")
            if await self._run_keyword_attempts(tab, target, fallbacks, log_prefix="PathA"):
                return True

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

        self._log("[PathA] All persona + exact fallback keywords exhausted")
        return False

    async def _search_with_keyword(
        self,
        tab: Tab,
        keyword: str,
        target: VideoTarget,
        *,
        channel_discovery: bool = False,
    ) -> bool:
        await self._wake(f"search:{keyword[:40]}")
        await self._ensure_home(tab)
        search_el = await self._find_search_bar(tab, "entropy_search_bar")
        if not search_el:
            self._log("[PathA] Search bar not found after home ready-wait")
            return False

        await self._prepare_search_input(tab, search_el)
        await asyncio.sleep(self._rng.uniform(0.25, 0.55))
        search_el = await self._find_search_bar(tab, "entropy_search_bar_focus")
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
        await _jitter_scroll(
            tab, self._rng, self._personality, passes=pre_scroll_passes,
            curve_id=self._scroll_curve_id,
        )
        await asyncio.sleep(self._rng.uniform(0.5, 1.5))

        if self._rng.random() < self._personality.mistake_probability:
            await _do_wrong_video_detour(tab, self._rng, self._log)
            await asyncio.sleep(self._rng.uniform(1.0, 2.5))

        if channel_discovery:
            return await self._find_target_via_channel_discovery(tab, target)
        return await self._find_target_in_results(tab, target)

    async def _path_g_channel_discovery(self, tab: Tab, target: VideoTarget) -> bool:
        """
        Plan PART 1 twist: YouTube search → see target video → click CHANNEL (not video)
        → channel page → find video → click.
        """
        await self._wake("search-path-g")
        self._log("[PathG] Channel discovery — search results → channel page → video")
        video_id     = target.video_id or ""
        profile_seed = self._get_profile_seed(video_id)

        primary, fallbacks = self._search_attempt_plan(target)
        keyword_pool = self._build_persona_keyword_pool(target, primary, profile_seed)
        self._log(f"[PathG] Persona keyword pool ({len(keyword_pool)}): {keyword_pool}")

        if await self._run_keyword_attempts(
            tab, target, keyword_pool, log_prefix="PathG", channel_discovery=True,
        ):
            return True

        if fallbacks:
            self._log(f"[PathG] Persona keywords failed — exact fallbacks: {fallbacks}")
            if await self._run_keyword_attempts(
                tab, target, fallbacks, log_prefix="PathG", channel_discovery=True,
            ):
                return True

        self._log("[PathG] All persona + exact fallback keywords exhausted")
        return False

    async def _find_target_via_channel_discovery(self, tab: Tab, target: VideoTarget) -> bool:
        """Find verified result card → click channel link → open video from channel page."""
        max_passes = self._rng.randint(3, 6)
        seen_hrefs: set[str] = set()

        for pass_num in range(1, max_passes + 1):
            self._log(f"[PathG] Scanning results pass {pass_num}/{max_passes}")
            cards = await _js_get_cards(tab)

            for card in cards:
                href = card.get("href", "")
                if not href or href in seen_hrefs:
                    continue
                seen_hrefs.add(href)

                if not _verify_card(card, target):
                    continue

                self._log(
                    f"[PathG] Target verified in results | channel={card.get('channel')!r} "
                    f"— clicking channel (NOT video)"
                )
                await _jitter_pause_before_click(self._rng, self._personality)
                if not await self._click_channel_from_video_card(tab, card, target):
                    continue

                await asyncio.sleep(self._rng.uniform(2.0, 4.0))
                await _wait_for_channel_url(tab, timeout=15.0)
                await self._navigate_to_videos_tab(tab)
                await asyncio.sleep(self._rng.uniform(1.5, 3.0))
                if await self._find_target_on_channel_page(tab, target):
                    return True

            await _jitter_scroll(
                tab, self._rng, self._personality, passes=1, curve_id=self._scroll_curve_id,
            )

        self._log(f"[PathG] Channel discovery failed after {max_passes} passes")
        return False

    async def _click_channel_from_video_card(
        self, tab: Tab, card: dict, target: VideoTarget
    ) -> bool:
        channel_href = (card.get("channel_href") or "").strip()
        channel_name = (card.get("channel") or target.channel_name or "").strip()
        video_href   = (card.get("href") or "").strip()

        try:
            result = await asyncio.wait_for(
                tab.evaluate(f"""
                (() => {{
                    var channelHref = {json.dumps(channel_href)};
                    var channelName = {json.dumps(channel_name).lower()};
                    var videoHref = {json.dumps(video_href)};

                    function clickEl(el) {{
                        if (!el) return false;
                        el.scrollIntoView({{behavior:'smooth', block:'center'}});
                        el.dispatchEvent(new MouseEvent('mouseover', {{bubbles:true}}));
                        el.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true}}));
                        el.dispatchEvent(new MouseEvent('mouseup', {{bubbles:true}}));
                        el.click();
                        return true;
                    }}

                    if (channelHref) {{
                        var links = document.querySelectorAll('a[href]');
                        for (var i = 0; i < links.length; i++) {{
                            var h = links[i].href || links[i].getAttribute('href') || '';
                            if (h === channelHref || h.indexOf(channelHref) >= 0) {{
                                return clickEl(links[i]);
                            }}
                        }}
                    }}

                    var renderers = document.querySelectorAll(
                        'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer'
                    );
                    for (var r = 0; r < renderers.length; r++) {{
                        var el = renderers[r];
                        var watch = el.querySelector('a[href*="/watch"]');
                        if (!watch) continue;
                        var wh = watch.href || watch.getAttribute('href') || '';
                        if (videoHref && wh !== videoHref && wh.indexOf(videoHref) < 0) continue;

                        var ch = el.querySelector(
                            'ytd-channel-name a, #channel-name a, a[href*="/@"], a[href*="/channel/"]'
                        );
                        if (!ch) continue;
                        var chText = (ch.innerText || ch.textContent || '').toLowerCase().trim();
                        if (channelName && chText && !chText.includes(channelName) && !channelName.includes(chText)) {{
                            continue;
                        }}
                        return clickEl(ch);
                    }}
                    return false;
                }})()
                """, return_by_value=True),
                timeout=8.0,
            )
            raw = getattr(result, "value", result)
            if raw:
                self._log("[PathG] Channel link clicked from search result card")
                return True
        except Exception as e:
            self._log(f"[PathG] Channel click error: {e}")
        return False

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
                clicked = await _js_click_by_href(tab, target.video_id or "", href, self._rng)
                if clicked:
                    nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
                    self._log(f"[PathA] Clicked & navigated | watch_url={nav_ok}")
                    await asyncio.sleep(self._rng.uniform(1.0, 2.5))
                    return True

            await _jitter_scroll(
                tab, self._rng, self._personality, passes=1, curve_id=self._scroll_curve_id,
            )

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
                        clicked = await _js_click_by_href(tab, target.video_id or "", href, self._rng)
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

        await self._prepare_search_input(tab, search_el)
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
        clicked = False
        try:
            result = await asyncio.wait_for(
                tab.evaluate("""
                (() => {
                    var tabs = document.querySelectorAll(
                        'yt-tab-shape, ytd-tab-renderer, tp-yt-paper-tab, #tabsContent tp-yt-paper-tab, button[role="tab"]'
                    );
                    for (var i = 0; i < tabs.length; i++) {
                        var el = tabs[i];
                        var t = (
                            el.innerText || el.textContent ||
                            el.getAttribute('tab-title') || el.getAttribute('aria-label') || ''
                        ).toLowerCase().trim();
                        if (t === 'videos' || t.startsWith('videos')) {
                            el.click();
                            return true;
                        }
                        var label = el.querySelector('.yt-tab-shape__text, .tab-content, span');
                        if (label) {
                            var lt = (label.innerText || label.textContent || '').toLowerCase().trim();
                            if (lt === 'videos' || lt.startsWith('videos')) {
                                el.click();
                                return true;
                            }
                        }
                    }
                    return false;
                })()
                """, return_by_value=True),
                timeout=6.0,
            )
            raw = getattr(result, "value", result)
            clicked = bool(raw)
            self._log(f"[PathB] Videos tab click: {clicked}")
        except Exception as e:
            self._log(f"[PathB] Videos tab error: {e}")

        await asyncio.sleep(self._rng.uniform(1.0, 2.0))
        url = await _tab_url(tab)
        if clicked and url and "/videos" in url:
            await asyncio.sleep(self._rng.uniform(0.5, 1.5))
            return

        # Fallback — open /@handle/videos or /channel/ID/videos directly (plan STEP 6B)
        if url and ("/@" in url or "/channel/" in url or "/c/" in url):
            base = url.split("?")[0].split("#")[0].rstrip("/")
            for suffix in ("/featured", "/videos", "/streams", "/shorts", "/playlists", "/community", "/about"):
                if base.endswith(suffix):
                    base = base[: -len(suffix)]
                    break
            if not base.endswith("/videos"):
                videos_url = f"{base}/videos"
                try:
                    await asyncio.wait_for(tab.get(videos_url), timeout=20.0)
                    self._log(f"[PathB] Videos tab via URL: {videos_url[:90]}")
                    await asyncio.sleep(self._rng.uniform(2.0, 3.5))
                except Exception as e:
                    self._log(f"[PathB] Videos URL nav error: {e}")

    async def _find_target_on_channel_page(self, tab: Tab, target: VideoTarget) -> bool:
        max_passes = self._rng.randint(6, 10)
        seen_keys: set[str] = set()

        for pass_num in range(1, max_passes + 1):
            cards = await _js_get_channel_videos(tab)
            self._log(
                f"[PathB] Channel video scan pass {pass_num}/{max_passes} "
                f"— {len(cards)} cards | want={target.video_id or target.title_hint!r}"
            )

            for card in cards:
                href = card.get("href", "")
                card_vid = card.get("video_id") or _video_id_from_href(href) or ""
                dedupe = card_vid or href
                if not dedupe or dedupe in seen_keys:
                    continue
                seen_keys.add(dedupe)

                if not _channel_video_matches(card, target):
                    continue

                self._log(
                    f"[PathB] Target found on channel | id={card_vid!r} "
                    f"title={card.get('title', '')[:50]!r} href={href[:60]}"
                )
                await _jitter_pause_before_click(self._rng, self._personality)
                clicked = await _js_click_by_href(tab, target.video_id or card_vid or "", href, self._rng)
                if clicked:
                    nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
                    self._log(f"[PathB] Clicked | watch_url={nav_ok}")
                    return nav_ok

            await _jitter_scroll(
                tab, self._rng, self._personality, passes=1, curve_id=self._scroll_curve_id,
            )
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
        await _jitter_scroll(
            tab, self._rng, self._personality, passes=initial_scroll, curve_id=self._scroll_curve_id,
        )
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
                clicked = await _js_click_by_href(tab, target.video_id or "", href, self._rng)
                if clicked:
                    nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
                    self._log(f"[PathC] Clicked | watch_url={nav_ok}")
                    return True

            await _jitter_scroll(
                tab, self._rng, self._personality, passes=1, curve_id=self._scroll_curve_id,
            )
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

    async def _google_focus_search_bar(self, tab: Tab) -> Any:
        """Find Google search input on homepage OR results page."""
        for sel in (
            'textarea[name="q"]', 'input[name="q"]', '#APjFqb',
            'input[type="search"]', 'input[title="Search"]',
        ):
            try:
                el = await asyncio.wait_for(tab.select(sel), timeout=3.0)
                if el:
                    return el
            except Exception:
                continue
        return None

    async def _google_find_verified_link(self, tab: Tab, target: VideoTarget) -> Optional[dict]:
        """Scan visible Google results — verified YouTube link only (no first-link fallback)."""
        video_id   = target.video_id or ""
        title_kw   = _clean_search_text(target.title_hint or "").lower()
        channel_kw = _clean_search_text(target.channel_name or "").lower()

        raw = await _safe_eval(tab, f"""
        (() => {{
            var links = document.querySelectorAll(
                'a[href*="youtube.com/watch"], a[href*="youtu.be/"], ' +
                'a[href*="/url?"][href*="youtube"], a[href*="bing.com/ck/a"][href*="youtube"]'
            );
            var video_id  = {json.dumps(video_id)};
            var title_kw  = {json.dumps(title_kw)};
            var ch_kw     = {json.dumps(channel_kw)};
            for (var i = 0; i < links.length; i++) {{
                var href = links[i].href || '';
                if (!href.includes('youtube.com/watch') && !href.includes('youtu.be/')) continue;
                if (href.indexOf('google.') >= 0 && href.indexOf('/url') >= 0) {{
                    try {{
                        var u = new URL(href);
                        var q = u.searchParams.get('url') || u.searchParams.get('q');
                        if (q) href = q;
                    }} catch (e) {{}}
                }}
                if (video_id && href.includes(video_id))
                    return JSON.stringify({{href: href, match: 'video_id'}});
                var par  = links[i].closest('.g, .tF2Cxc, .MjjYud, [data-sokoban-feature], li');
                var text = (par ? par.innerText : links[i].innerText || '').toLowerCase();
                var title_ok = true;
                var ch_ok = true;
                if (title_kw) {{
                    var words = title_kw.split(' ').filter(function(w){{return w.length>3;}});
                    title_ok = words.length === 0 ||
                        words.filter(function(w){{return text.includes(w);}}).length / words.length >= 0.5;
                }}
                if (ch_kw && ch_kw.length > 3) {{
                    ch_ok = text.includes(ch_kw);
                }}
                if (title_kw && ch_kw) {{
                    if (title_ok && ch_ok) return JSON.stringify({{href: href, match: 'title+channel'}});
                }} else if (title_kw && title_ok) {{
                    return JSON.stringify({{href: href, match: 'title'}});
                }} else if (ch_kw && ch_ok) {{
                    return JSON.stringify({{href: href, match: 'channel'}});
                }}
            }}
            return null;
        }})()
        """, timeout=8.0)

        if not raw:
            return None
        try:
            found = json.loads(str(raw))
            return found if found.get("href") else None
        except Exception:
            return None

    def _external_search_keyword_pools(self, target: VideoTarget) -> tuple[list[str], list[str]]:
        """Google/Bing: verified persona first, then exact title variants with site suffix."""
        from server_python.search_keyword_planner import filter_keyword_pool

        title = target.title_hint or ""
        channel = target.channel_name or ""
        primary, fallbacks = self._search_attempt_plan(target)
        persona_pool = filter_keyword_pool(primary, title, channel)[:8]
        fallback_pool: list[str] = []
        seen = {k.lower() for k in persona_pool}
        for fb in fallbacks:
            for variant in (f"{fb} site:youtube.com", f"{fb} youtube"):
                v = variant.strip()
                if not v or v.lower() in seen:
                    continue
                if filter_keyword_pool([v], title, channel, allow_exact_title=True):
                    fallback_pool.append(v)
                    seen.add(v.lower())
        return persona_pool, fallback_pool[:6]

    async def _run_external_engine_attempts(
        self,
        tab: Tab,
        target: VideoTarget,
        persona_pool: list[str],
        fallback_pool: list[str],
        search_fn: Any,
        log_prefix: str,
    ) -> bool:
        for label, pool in (("Persona", persona_pool), ("Exact fallback", fallback_pool)):
            if not pool:
                continue
            self._log(f"[{log_prefix}] {label} keywords ({len(pool)}): {pool[:3]}…")
            for attempt, kw in enumerate(pool, 1):
                self._log(f"[{log_prefix}] {label} attempt {attempt}/{len(pool)}: {kw!r}")
                if await search_fn(tab, kw, target):
                    self._log(f"[{log_prefix}] ✓ Found via {label} at attempt {attempt}")
                    return True
                self._log(f"[{log_prefix}] Attempt {attempt} failed — next keyword")
                await asyncio.sleep(self._rng.uniform(1.0, 2.0))
        return False

    async def _path_e_google_search(self, tab: Tab, target: VideoTarget) -> bool:
        """
        Plan PART 1 — STEP 6C: Google Search traffic source.
        google.com → search → scroll results → verify → click.
        Next keyword: same results page search bar (NOT back to homepage, NOT YouTube).
        """
        await self._wake("search-path-e")
        self._log(f"[PathE] Google Search | video={target.video_id!r}")

        persona_pool, fallback_pool = self._external_search_keyword_pools(target)

        try:
            from server_python.behavior.external_search import dismiss_engine_consent
            await asyncio.wait_for(tab.get("https://www.google.com"), timeout=20.0)
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
            await dismiss_engine_consent(tab)

            if await self._run_external_engine_attempts(
                tab, target, persona_pool, fallback_pool,
                self._google_search_and_find, "PathE",
            ):
                return True

            self._log("[PathE] All Google persona + exact fallback keywords exhausted")
            return False
        except Exception as e:
            self._log(f"[PathE] Google error: {e}")
            return False

    async def _google_search_and_find(self, tab: Tab, keyword: str, target: VideoTarget) -> bool:
        """Type keyword in Google search bar (homepage or results page), scroll, verify, click."""
        from server_python.behavior.external_search import dismiss_engine_consent
        await dismiss_engine_consent(tab)
        search_el = await self._google_focus_search_bar(tab)
        if not search_el:
            self._log("[PathE] Google search bar not found")
            return False

        await self._prepare_search_input(tab, search_el)
        await asyncio.sleep(self._rng.uniform(0.1, 0.25))
        await self._jitter_type(tab, keyword, element=search_el)
        await asyncio.sleep(self._rng.uniform(0.4, 1.0))

        if not await self._submit_search(tab):
            return False

        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            url = await _tab_url(tab)
            if url and "google.com/search" in url:
                break
            await asyncio.sleep(0.5)

        await asyncio.sleep(self._rng.uniform(2.0, 3.5))
        await _jitter_linger_on_results(self._rng, self._personality)

        curve_id = getattr(self, "_scroll_curve_id", "") or self._profile_id[:12]
        found: Optional[dict] = None
        scroll_passes = self._rng.randint(4, 7)
        for sp in range(1, scroll_passes + 1):
            self._log(f"[PathE] Google results scan pass {sp}/{scroll_passes}")
            found = await self._google_find_verified_link(tab, target)
            if found:
                break
            if sp < scroll_passes:
                await _jitter_scroll(
                    tab, self._rng, self._personality, passes=1, curve_id=curve_id,
                )
                await asyncio.sleep(self._rng.uniform(1.0, 2.5))

        if not found:
            self._log("[PathE] No verified YouTube link in Google results after scroll")
            return False

        href = found.get("href", "")
        if not href:
            return False

        self._log(f"[PathE] Verified link ({found.get('match')}): {href[:70]}")
        await _jitter_pause_before_click(self._rng, self._personality)

        from server_python.behavior.external_search import finish_watch_navigation
        vid = target.video_id or _video_id_from_href(href) or ""
        nav_ok = await finish_watch_navigation(
            tab, href, vid, self._rng,
            click_fn=_js_click_by_href,
            log_fn=self._log,
        )
        self._log(f"[PathE] YouTube navigation: {nav_ok}")
        return nav_ok

    # ── PATH F: Bing Search ───────────────────────────────────────────────────

    async def _bing_focus_search_bar(self, tab: Tab) -> Any:
        """Find Bing search input on homepage OR results page."""
        for sel in (
            'input[name="q"]', '#sb_form_q', 'textarea[name="q"]',
            'input[type="search"]', 'input.b_searchbox',
        ):
            try:
                el = await asyncio.wait_for(tab.select(sel), timeout=3.0)
                if el:
                    return el
            except Exception:
                continue
        return None

    async def _bing_find_verified_link(self, tab: Tab, target: VideoTarget) -> Optional[dict]:
        """Scan visible Bing results — verified YouTube link only (plan STEP 6C/7)."""
        video_id   = target.video_id or ""
        title_kw   = _clean_search_text(target.title_hint or "").lower()
        channel_kw = _clean_search_text(target.channel_name or "").lower()

        raw = await _safe_eval(tab, f"""
        (() => {{
            var links = document.querySelectorAll(
                'a[href*="youtube.com/watch"], a[href*="youtu.be/"], ' +
                'a[href*="/url?"][href*="youtube"], a[href*="bing.com/ck/a"][href*="youtube"]'
            );
            var video_id  = {json.dumps(video_id)};
            var title_kw  = {json.dumps(title_kw)};
            var ch_kw     = {json.dumps(channel_kw)};
            for (var i = 0; i < links.length; i++) {{
                var href = links[i].href || '';
                if (!href.includes('youtube.com/watch') && !href.includes('youtu.be/')) continue;
                if (video_id && href.includes(video_id))
                    return JSON.stringify({{href: href, match: 'video_id'}});
                var par  = links[i].closest('li.b_algo, .b_ans, .b_result, .b_algoSlug');
                var text = (par ? par.innerText : links[i].innerText || '').toLowerCase();
                var title_ok = true;
                var ch_ok = true;
                if (title_kw) {{
                    var words = title_kw.split(' ').filter(function(w){{return w.length>3;}});
                    title_ok = words.length === 0 ||
                        words.filter(function(w){{return text.includes(w);}}).length / words.length >= 0.5;
                }}
                if (ch_kw && ch_kw.length > 3) {{
                    ch_ok = text.includes(ch_kw);
                }}
                if (title_kw && ch_kw) {{
                    if (title_ok && ch_ok) return JSON.stringify({{href: href, match: 'title+channel'}});
                }} else if (title_kw && title_ok) {{
                    return JSON.stringify({{href: href, match: 'title'}});
                }} else if (ch_kw && ch_ok) {{
                    return JSON.stringify({{href: href, match: 'channel'}});
                }}
            }}
            return null;
        }})()
        """, timeout=8.0)

        if not raw:
            return None
        try:
            found = json.loads(str(raw))
            return found if found.get("href") else None
        except Exception:
            return None

    async def _path_f_bing_search(self, tab: Tab, target: VideoTarget) -> bool:
        """
        Plan PART 1 — STEP 6C: Bing Search traffic source.
        bing.com → search → scroll results → verify → click.
        Next keyword: same results page search bar (NOT back to homepage, NOT YouTube).
        """
        await self._wake("search-path-f")
        self._log(f"[PathF] Bing Search | video={target.video_id!r}")

        persona_pool, fallback_pool = self._external_search_keyword_pools(target)

        try:
            from server_python.behavior.external_search import dismiss_engine_consent
            await asyncio.wait_for(tab.get("https://www.bing.com"), timeout=20.0)
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
            await dismiss_engine_consent(tab)

            if await self._run_external_engine_attempts(
                tab, target, persona_pool, fallback_pool,
                self._bing_search_and_find, "PathF",
            ):
                return True

            self._log("[PathF] All Bing persona + exact fallback keywords exhausted")
            return False
        except Exception as e:
            self._log(f"[PathF] Bing error: {e}")
            return False

    async def _bing_search_and_find(self, tab: Tab, keyword: str, target: VideoTarget) -> bool:
        """Type keyword in Bing search bar (homepage or results page), scroll, verify, click."""
        from server_python.behavior.external_search import dismiss_engine_consent
        await dismiss_engine_consent(tab)
        search_el = await self._bing_focus_search_bar(tab)
        if not search_el:
            self._log("[PathF] Bing search bar not found")
            return False

        await self._prepare_search_input(tab, search_el)
        await asyncio.sleep(self._rng.uniform(0.1, 0.25))
        await self._jitter_type(tab, keyword, element=search_el)
        await asyncio.sleep(self._rng.uniform(0.4, 1.0))

        if not await self._submit_search(tab):
            return False

        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            url = await _tab_url(tab)
            if url and ("bing.com/search" in url or "bing.com/images/search" in url):
                break
            await asyncio.sleep(0.5)

        await asyncio.sleep(self._rng.uniform(2.0, 3.5))
        await _jitter_linger_on_results(self._rng, self._personality)

        curve_id = getattr(self, "_scroll_curve_id", "") or self._profile_id[:12]
        found: Optional[dict] = None
        scroll_passes = self._rng.randint(4, 7)
        for sp in range(1, scroll_passes + 1):
            self._log(f"[PathF] Bing results scan pass {sp}/{scroll_passes}")
            found = await self._bing_find_verified_link(tab, target)
            if found:
                break
            if sp < scroll_passes:
                await _jitter_scroll(
                    tab, self._rng, self._personality, passes=1, curve_id=curve_id,
                )
                await asyncio.sleep(self._rng.uniform(1.0, 2.5))

        if not found:
            self._log("[PathF] No verified YouTube link in Bing results after scroll")
            return False

        href = found.get("href", "")
        if not href:
            return False

        self._log(f"[PathF] Verified link ({found.get('match')}): {href[:70]}")
        await _jitter_pause_before_click(self._rng, self._personality)

        from server_python.behavior.external_search import finish_watch_navigation
        vid = target.video_id or _video_id_from_href(href) or ""
        nav_ok = await finish_watch_navigation(
            tab, href, vid, self._rng,
            click_fn=_js_click_by_href,
            log_fn=self._log,
        )
        self._log(f"[PathF] YouTube navigation: {nav_ok}")
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
            pause_lo, pause_hi = self._personality.pre_click_pause
            await asyncio.sleep(self._rng.uniform(pause_lo, pause_hi))
        except Exception:
            pass
