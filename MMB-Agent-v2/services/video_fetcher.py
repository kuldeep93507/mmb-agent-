"""
T2-01 — Video Fetcher (No API Key)
====================================

YouTube channel ke latest videos scrape karo — NO API key required.

Strategy (in order, first success wins):
  1. YouTube RSS Feed  — youtube.com/feeds/videos.xml?channel_id={id}
                          Returns last 15 videos. Fast, stable, no auth needed.
  2. HTML Fallback     — youtube.com/channel/{id}/videos page HTML parse
                          yt_initial_data JSON se video list extract karo.
                          Last ~30 videos milte hain.

Both return list of dicts:
    {video_id, title, channel_id, url, published_at}

Usage::
    from services.video_fetcher import VideoFetcher

    fetcher = VideoFetcher()
    videos = await fetcher.fetch(channel_id="UCxxxxxx")
    # or by handle:
    videos = await fetcher.fetch_by_handle("@ultraplay8")

Design rules:
  - No external API keys.
  - aiohttp preferred; falls back to urllib if aiohttp not installed.
  - Timeouts: 15s connect, 20s read.
  - On error: log + return [] (non-fatal).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Callable, Optional
from xml.etree import ElementTree as ET

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

RSS_URL      = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
CHANNEL_URL  = "https://www.youtube.com/channel/{channel_id}/videos"
HANDLE_URL   = "https://www.youtube.com/{handle}/videos"


# ── HTTP helper (aiohttp preferred, urllib fallback) ──────────────────────────

async def _fetch_url(url: str, timeout: int = 20) -> Optional[str]:
    """
    Fetch URL text. Returns None on any error.

    Strategy:
      1. aiohttp (async, preferred) — if installed AND succeeds
      2. urllib (stdlib fallback) — if aiohttp not installed OR raises any error

    NOTE: ssl=True (default) — certificate verification is ENABLED.
    """
    _aiohttp_ok = False
    try:
        import aiohttp
        _aiohttp_ok = True
        async with aiohttp.ClientSession(
            headers=_HEADERS,
            timeout=aiohttp.ClientTimeout(connect=15, total=timeout),
        ) as session:
            async with session.get(url) as resp:
                if resp.status == 200:
                    return await resp.text(encoding="utf-8", errors="replace")
                # Non-200 → fall through to urllib
    except ImportError:
        pass  # aiohttp not installed — use urllib
    except Exception:
        pass  # aiohttp runtime error (DNS, timeout, etc.) — try urllib fallback

    # urllib fallback (stdlib) — runs when aiohttp absent OR failed
    try:
        import urllib.request
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


# ── RSS parser ─────────────────────────────────────────────────────────────────

def _parse_rss(xml_text: str, channel_id: str) -> list[dict]:
    """
    Parse YouTube RSS feed XML.
    Returns list of {video_id, title, channel_id, url, published_at}.
    """
    videos = []
    try:
        # YouTube RSS uses Atom namespace
        # Namespaces we need
        ns = {
            "atom":  "http://www.w3.org/2005/Atom",
            "yt":    "http://www.youtube.com/xml/schemas/2015",
            "media": "http://search.yahoo.com/mrss/",
        }
        root = ET.fromstring(xml_text)

        for entry in root.findall("atom:entry", ns):
            vid_el     = entry.find("yt:videoId", ns)
            title_el   = entry.find("atom:title", ns)
            link_el    = entry.find("atom:link", ns)
            pub_el     = entry.find("atom:published", ns)

            video_id = vid_el.text.strip() if vid_el is not None else ""
            title    = title_el.text.strip() if title_el is not None else ""
            url      = link_el.get("href", "") if link_el is not None else ""
            pub_at   = pub_el.text.strip() if pub_el is not None else ""

            if not video_id:
                continue
            if not url:
                url = f"https://www.youtube.com/watch?v={video_id}"

            videos.append({
                "video_id":     video_id,
                "title":        title,
                "channel_id":   channel_id,
                "url":          url,
                "published_at": pub_at,
            })
    except Exception:
        pass
    return videos


# ── HTML fallback parser ───────────────────────────────────────────────────────

def _extract_yt_initial_data(html: str) -> Optional[dict]:
    """
    Robustly extract ytInitialData JSON from YouTube HTML page.

    IMPORTANT: regex {.+?} (lazy) is WRONG for nested JSON — it stops at the
    first closing brace, producing invalid JSON. We use brace-counting instead.

    Strategy:
      1. Find 'ytInitialData' keyword in HTML
      2. Find the opening '{' after it
      3. Walk characters counting depth until matching '}'
      4. Parse only that substring with json.loads
    """
    try:
        # Find the start marker
        marker = "ytInitialData"
        idx = html.find(marker)
        if idx == -1:
            return None

        # Find '=' then '{' after marker
        eq_idx = html.find("=", idx + len(marker))
        if eq_idx == -1:
            return None
        brace_idx = html.find("{", eq_idx)
        if brace_idx == -1:
            return None

        # Walk brace depth to find matching closing brace
        depth = 0
        in_string = False
        escape_next = False
        end_idx = brace_idx

        for i, ch in enumerate(html[brace_idx:], start=brace_idx):
            if escape_next:
                escape_next = False
                continue
            if ch == "\\" and in_string:
                escape_next = True
                continue
            if ch == '"' and not escape_next:
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end_idx = i
                    break
        else:
            return None  # Never found matching brace

        raw = html[brace_idx : end_idx + 1]
        return json.loads(raw)
    except Exception:
        return None


def _parse_html_videos(html: str, channel_id: str) -> list[dict]:
    """
    Extract videos from YouTube channel/videos HTML page.
    Finds ytInitialData JSON via brace-counting (NOT lazy regex) → parses video renderers.
    Returns list of {video_id, title, channel_id, url, published_at}.
    """
    videos = []
    try:
        data = _extract_yt_initial_data(html)
        if data is None:
            return []

        # Dig into the tab contents — path varies but always contains "videoRenderer"
        # We'll do a recursive search for all videoRenderer dicts
        found = []
        _find_video_renderers(data, found)

        seen = set()
        for vr in found:
            vid_id_obj = vr.get("videoId", "")
            video_id   = str(vid_id_obj).strip() if vid_id_obj else ""
            if not video_id or video_id in seen:
                continue
            # Guard: skip ad/promoted content renderers.
            # Real videoRenderers have "lengthText" or "publishedTimeText".
            # Ads typically have neither or have "adBadgeText" instead.
            if "adBadgeText" in vr or "promotedVideoOverlayRenderer" in vr:
                continue
            seen.add(video_id)

            # Title
            title = ""
            title_obj = vr.get("title", {})
            if isinstance(title_obj, dict):
                runs = title_obj.get("runs", [])
                title = "".join(r.get("text", "") for r in runs) if runs else \
                        title_obj.get("simpleText", "")
            elif isinstance(title_obj, str):
                title = title_obj

            url = f"https://www.youtube.com/watch?v={video_id}"
            videos.append({
                "video_id":     video_id,
                "title":        title.strip(),
                "channel_id":   channel_id,
                "url":          url,
                "published_at": "",
            })
    except Exception:
        pass
    return videos


def _find_video_renderers(obj: Any, result: list, depth: int = 0) -> None:
    """
    Recursive dict/list walk to collect real videoRenderer dicts.

    Sprint-4 fix: tightened match criteria to avoid false positives.

    OLD bug: `"videoId" in obj and "title" in obj` matched too broadly —
    shelf metadata, player config, and channel-level dicts all have
    videoId + title but are NOT individual video cards.

    NEW rule: a dict is a real video renderer only if it has BOTH
      • "videoId"          — the YouTube video ID
      • "title"            — display title
    AND at least ONE of these real-video-only fields:
      • "lengthText"       — video duration (e.g. "12:34")
      • "publishedTimeText"— upload age  (e.g. "3 days ago")
      • "viewCountText"    — view count  (e.g. "1.2M views")
      • "thumbnail"        — thumbnail object (all real renderers have this)

    After appending we do NOT recurse into the renderer — its inner
    structure (thumbnails, runs) would re-trigger matches.
    """
    if depth > 50:
        return
    if isinstance(obj, dict):
        if "videoId" in obj and "title" in obj:
            # Require at least one real-video-specific field to filter out
            # metadata dicts (shelf titles, player config, etc.)
            _REAL_VIDEO_FIELDS = ("lengthText", "publishedTimeText",
                                  "viewCountText", "thumbnail")
            if any(f in obj for f in _REAL_VIDEO_FIELDS):
                result.append(obj)
                return  # don't recurse into this renderer's own values
            # Has videoId+title but no video-specific fields → could be a
            # container. Continue recursing to find real renderers inside.
        for v in obj.values():
            _find_video_renderers(v, result, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            _find_video_renderers(item, result, depth + 1)


# ── VideoFetcher ───────────────────────────────────────────────────────────────

class VideoFetcher:
    """
    Fetches video list for a YouTube channel without any API key.

    Strategy order:
      1. RSS feed (fast, last 15 videos)
      2. HTML /videos page (slower, last ~30 videos)

    Returns [] on complete failure (non-fatal).
    """

    async def fetch(
        self,
        *,
        channel_id: str,
        log: Optional[Callable[[str], None]] = None,
    ) -> list[dict]:
        """
        Fetch latest videos for channel_id.

        Parameters
        ----------
        channel_id : UCxxxxxx format channel ID.
        log        : Optional logging callable.

        Returns
        -------
        List of dicts: {video_id, title, channel_id, url, published_at}
        Empty list if all strategies fail.
        """
        _log = log or (lambda msg: None)

        # ── Strategy 1: RSS ────────────────────────────────────────────────
        rss_url = RSS_URL.format(channel_id=channel_id)
        _log(f"[VideoFetcher] RSS fetch | url={rss_url}")
        rss_text = await _fetch_url(rss_url, timeout=15)

        if rss_text:
            videos = _parse_rss(rss_text, channel_id)
            if videos:
                _log(f"[VideoFetcher] RSS OK | {len(videos)} videos")
                return videos
            _log("[VideoFetcher] RSS returned 0 videos — trying HTML fallback")
        else:
            _log("[VideoFetcher] RSS fetch failed — trying HTML fallback")

        # ── Strategy 2: HTML /videos page ─────────────────────────────────
        html_url = CHANNEL_URL.format(channel_id=channel_id)
        _log(f"[VideoFetcher] HTML fetch | url={html_url}")
        html = await _fetch_url(html_url, timeout=20)

        if html:
            videos = _parse_html_videos(html, channel_id)
            if videos:
                _log(f"[VideoFetcher] HTML OK | {len(videos)} videos")
                return videos
            _log("[VideoFetcher] HTML parse returned 0 videos")
        else:
            _log("[VideoFetcher] HTML fetch failed")

        _log(f"[VideoFetcher] All strategies failed for channel_id={channel_id}")
        return []

    async def fetch_by_handle(
        self,
        handle: str,
        *,
        log: Optional[Callable[[str], None]] = None,
    ) -> list[dict]:
        """
        Fetch videos by YouTube handle (e.g. '@ultraplay8').
        channel_id will be empty in returned records — caller should fill it.

        Uses HTML /videos page only (handle → RSS not directly available).
        """
        _log = log or (lambda msg: None)

        handle = handle.strip()
        if not handle.startswith("@"):
            handle = "@" + handle

        url = HANDLE_URL.format(handle=handle)
        _log(f"[VideoFetcher] Handle fetch | url={url}")
        html = await _fetch_url(url, timeout=20)

        if not html:
            _log(f"[VideoFetcher] Handle fetch failed for {handle}")
            return []

        # Try to extract channel_id from page.
        #
        # Sprint-4 fix: "channelId" appears many times in YouTube HTML —
        # recommended videos, sidebar channels, ads. The first match is often
        # NOT the channel being viewed. Use "externalId" instead which
        # YouTube sets to the VIEWED channel's UC-ID in ytInitialData.
        # Fallback to "channelId" if externalId not found.
        channel_id = ""
        # externalId: always the channel page owner (most reliable)
        m = re.search(r'"externalId"\s*:\s*"(UC[^"]{10,})"', html)
        if not m:
            # browserId / canonicalBaseUrl sometimes present
            m = re.search(r'"browseId"\s*:\s*"(UC[^"]{10,})"', html)
        if not m:
            # Last resort: channelId (least specific — may match recommendations)
            m = re.search(r'"channelId"\s*:\s*"(UC[^"]{10,})"', html)
        if m:
            channel_id = m.group(1)
            _log(f"[VideoFetcher] Extracted channel_id={channel_id} from handle page")

        videos = _parse_html_videos(html, channel_id)
        if videos:
            _log(f"[VideoFetcher] Handle OK | {len(videos)} videos | channel_id={channel_id}")
        else:
            _log(f"[VideoFetcher] Handle fetch returned 0 videos | channel_id={channel_id}")
        return videos
