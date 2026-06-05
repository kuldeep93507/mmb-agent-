"""
YouTube Video Fetcher — No API key needed, scrape karo.
Adapted from MMB-Agent-v2/services/video_fetcher.py

Fetches video info from:
  - Direct video URL  (youtube.com/watch?v=ID)
  - Playlist          (youtube.com/playlist?list=ID)
  - Channel           (youtube.com/@channel/videos)
  - Search results    (youtube.com/results?search_query=...)
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional
from urllib.parse import urlencode, urlparse, parse_qs

import aiohttp

log = logging.getLogger("mmb.video_fetcher")

YT_BASE = "https://www.youtube.com"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def _extract_video_ids_from_html(html: str) -> list[str]:
    """Extract all unique 11-char video IDs from HTML."""
    patterns = [
        r'"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"',
        r'watch\?v=([a-zA-Z0-9_-]{11})',
        r'/shorts/([a-zA-Z0-9_-]{11})',
    ]
    seen: set[str] = set()
    result: list[str] = []
    for pat in patterns:
        for vid in re.findall(pat, html):
            if vid not in seen:
                seen.add(vid)
                result.append(vid)
    return result


def _extract_video_info_from_html(html: str) -> list[dict]:
    """Extract video info dicts from YouTube page HTML."""
    videos: list[dict] = []
    seen: set[str] = set()

    # Match videoId + title pairs
    pattern = r'"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})".*?"title"\s*:\s*\{"runs"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"'
    for m in re.finditer(pattern, html[:500_000]):
        vid_id = m.group(1)
        title = m.group(2)
        if vid_id not in seen:
            seen.add(vid_id)
            videos.append({
                "videoId": vid_id,
                "title": title,
                "url": f"{YT_BASE}/watch?v={vid_id}",
            })

    # Fallback: just video IDs if no title matched
    if not videos:
        for vid_id in _extract_video_ids_from_html(html):
            if vid_id not in seen:
                seen.add(vid_id)
                videos.append({
                    "videoId": vid_id,
                    "title": "",
                    "url": f"{YT_BASE}/watch?v={vid_id}",
                })

    return videos


async def _fetch_html(url: str, timeout: int = 15) -> Optional[str]:
    """Fetch a YouTube page HTML."""
    try:
        async with aiohttp.ClientSession(headers=_HEADERS) as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                if resp.status == 200:
                    return await resp.text(encoding="utf-8", errors="ignore")
                log.warning(f"[VideoFetcher] HTTP {resp.status} for {url}")
                return None
    except Exception as e:
        log.error(f"[VideoFetcher] Fetch error for {url}: {e}")
        return None


async def get_video_info(video_id: str) -> Optional[dict]:
    """Get basic info about a single video by ID."""
    url = f"{YT_BASE}/watch?v={video_id}"
    html = await _fetch_html(url)
    if not html:
        return None

    # Extract title
    title_match = re.search(r'"title"\s*:\s*"([^"]+)"', html[:100_000])
    title = title_match.group(1) if title_match else ""

    # Extract channel
    channel_match = re.search(r'"ownerChannelName"\s*:\s*"([^"]+)"', html[:200_000])
    channel = channel_match.group(1) if channel_match else ""

    # Extract duration in seconds
    duration = 0
    dur_match = re.search(r'"lengthSeconds"\s*:\s*"(\d+)"', html[:200_000])
    if dur_match:
        duration = int(dur_match.group(1))

    return {
        "videoId":  video_id,
        "title":    title,
        "channel":  channel,
        "duration": duration,
        "url":      url,
    }


async def fetch_playlist_videos(playlist_id: str, max_videos: int = 50) -> list[dict]:
    """Fetch videos from a YouTube playlist."""
    url = f"{YT_BASE}/playlist?list={playlist_id}"
    log.info(f"[VideoFetcher] Fetching playlist: {playlist_id}")
    html = await _fetch_html(url)
    if not html:
        return []

    videos = _extract_video_info_from_html(html)
    log.info(f"[VideoFetcher] Playlist {playlist_id}: found {len(videos)} videos")
    return videos[:max_videos]


async def fetch_channel_videos(
    channel_handle: str,
    max_videos: int = 30,
) -> list[dict]:
    """
    Fetch videos from a YouTube channel.
    channel_handle: '@ChannelName' or 'UCxxxxxx' or 'channel-slug'
    """
    if channel_handle.startswith("UC"):
        url = f"{YT_BASE}/channel/{channel_handle}/videos"
    elif channel_handle.startswith("@"):
        url = f"{YT_BASE}/{channel_handle}/videos"
    else:
        url = f"{YT_BASE}/@{channel_handle}/videos"

    log.info(f"[VideoFetcher] Fetching channel: {url}")
    html = await _fetch_html(url)
    if not html:
        return []

    videos = _extract_video_info_from_html(html)
    log.info(f"[VideoFetcher] Channel: found {len(videos)} videos")
    return videos[:max_videos]


async def search_videos(
    query: str,
    max_results: int = 20,
) -> list[dict]:
    """Search YouTube (no API key) — scrape search results page."""
    params = urlencode({"search_query": query})
    url = f"{YT_BASE}/results?{params}"
    log.info(f"[VideoFetcher] Searching: {query!r}")
    html = await _fetch_html(url)
    if not html:
        return []

    videos = _extract_video_info_from_html(html)
    log.info(f"[VideoFetcher] Search '{query}': found {len(videos)} results")
    return videos[:max_results]


async def resolve_video_url(url_or_id: str) -> list[dict]:
    """
    Auto-detect what the input is and fetch accordingly.
    Accepts: video URL, playlist URL, channel URL, channel handle, video ID
    """
    url_or_id = url_or_id.strip()

    # Direct video ID (11 chars)
    if re.fullmatch(r'[a-zA-Z0-9_-]{11}', url_or_id):
        info = await get_video_info(url_or_id)
        return [info] if info else []

    parsed = urlparse(url_or_id)

    # Playlist
    if "playlist" in parsed.path or "list=" in parsed.query:
        qs = parse_qs(parsed.query)
        playlist_id = qs.get("list", [""])[0]
        if playlist_id:
            return await fetch_playlist_videos(playlist_id)

    # Watch URL — single video
    if "/watch" in parsed.path or "v=" in parsed.query:
        qs = parse_qs(parsed.query)
        vid_id = qs.get("v", [""])[0]
        if vid_id:
            info = await get_video_info(vid_id)
            return [info] if info else []

    # Channel handle (@name)
    if "/@" in url_or_id or url_or_id.startswith("@"):
        handle = re.search(r'@([^/\s]+)', url_or_id)
        if handle:
            return await fetch_channel_videos(f"@{handle.group(1)}")

    # Channel URL (UCxxxxxx)
    if "/channel/UC" in url_or_id:
        ch_match = re.search(r'/channel/(UC[a-zA-Z0-9_-]+)', url_or_id)
        if ch_match:
            return await fetch_channel_videos(ch_match.group(1))

    # YouTube Shorts
    if "/shorts/" in url_or_id:
        vid_match = re.search(r'/shorts/([a-zA-Z0-9_-]{11})', url_or_id)
        if vid_match:
            info = await get_video_info(vid_match.group(1))
            return [info] if info else []

    # Fallback — treat as search query
    log.info(f"[VideoFetcher] Treating as search query: {url_or_id!r}")
    return await search_videos(url_or_id)
