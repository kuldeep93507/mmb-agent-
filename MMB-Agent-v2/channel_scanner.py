"""
Channel Scanner — YouTube RSS Feed se automatic video discovery.

Usage:
    python channel_scanner.py https://www.youtube.com/@ULTRAPLAY8
    python channel_scanner.py --update-jobs   (sab channels refresh karo)

Features:
  - @handle se channel_id auto-resolve
  - RSS feed parse (no API key needed)
  - data/channels.json mein save
  - jobs.json auto-update (naye videos add, purane preserve)
"""

from __future__ import annotations

import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

import requests

ROOT = Path(__file__).resolve().parent
CHANNELS_FILE = ROOT / "data" / "channels.json"
JOBS_FILE = ROOT / "data" / "jobs.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

NS = {"atom": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: @handle → channel_id
# ─────────────────────────────────────────────────────────────────────────────

def resolve_channel_id(channel_url: str) -> Optional[str]:
    """
    YouTube channel URL (@handle ya /channel/UC...) se channel_id nikalo.
    Returns UCxxxxxxxx format ID.
    """
    # Already a channel ID?
    if "UC" in channel_url and len(channel_url) > 20:
        match = re.search(r'UC[\w-]{22}', channel_url)
        if match:
            return match.group()

    # Fetch channel page and extract channel_id
    url = channel_url.rstrip("/")
    if not url.startswith("http"):
        url = "https://www.youtube.com/" + url.lstrip("/")

    print(f"  [Scanner] Resolving channel ID from: {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        html = resp.text

        # Try multiple patterns
        patterns = [
            r'"channelId"\s*:\s*"(UC[\w-]{22})"',
            r'"externalId"\s*:\s*"(UC[\w-]{22})"',
            r'channel_id=(UC[\w-]{22})',
            r'"browseId"\s*:\s*"(UC[\w-]{22})"',
        ]
        for pat in patterns:
            m = re.search(pat, html)
            if m:
                print(f"  [Scanner] Channel ID resolved: {m.group(1)}")
                return m.group(1)

        # Try meta tag
        m = re.search(r'<meta itemprop="channelId" content="(UC[\w-]{22})"', html)
        if m:
            return m.group(1)

    except Exception as e:
        print(f"  [Scanner] Error resolving channel: {e}")

    return None


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: channel_id → RSS videos
# ─────────────────────────────────────────────────────────────────────────────

def fetch_rss_videos(channel_id: str) -> list[dict]:
    """
    YouTube RSS feed se latest 15 videos fetch karo.
    Returns list of: {video_id, title, published, url, thumbnail}
    """
    rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    print(f"  [Scanner] Fetching RSS: {rss_url}")

    try:
        resp = requests.get(rss_url, headers=HEADERS, timeout=15)
        resp.raise_for_status()

        root = ET.fromstring(resp.content)
        videos = []

        for entry in root.findall("atom:entry", NS):
            vid_el = entry.find("yt:videoId", NS)
            title_el = entry.find("atom:title", NS)
            pub_el = entry.find("atom:published", NS)
            link_el = entry.find("atom:link", NS)

            if vid_el is None:
                continue

            video_id = vid_el.text or ""
            title = title_el.text if title_el is not None else ""
            published = pub_el.text if pub_el is not None else ""
            url = link_el.get("href", "") if link_el is not None else f"https://www.youtube.com/watch?v={video_id}"
            thumbnail = f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg"

            videos.append({
                "video_id": video_id,
                "title": title,
                "published": published,
                "url": url,
                "thumbnail": thumbnail,
                "enabled": True,   # default: include in jobs
            })

        print(f"  [Scanner] Found {len(videos)} videos from RSS")
        return videos

    except Exception as e:
        print(f"  [Scanner] RSS fetch error: {e}")
        return []


# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Save to channels.json
# ─────────────────────────────────────────────────────────────────────────────

def load_channels() -> dict:
    if CHANNELS_FILE.exists():
        try:
            return json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"channels": []}


def save_channels(data: dict) -> None:
    CHANNELS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CHANNELS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def scan_channel(channel_url: str, channel_name: str = "") -> dict | None:
    """
    Full pipeline: URL → channel_id → RSS videos → save to channels.json
    Returns the channel dict or None on failure.
    """
    print(f"\n{'='*60}")
    print(f"  Scanning channel: {channel_url}")
    print(f"{'='*60}")

    channel_id = resolve_channel_id(channel_url)
    if not channel_id:
        print("  ❌ Could not resolve channel ID")
        return None

    videos = fetch_rss_videos(channel_id)
    if not videos:
        print("  ❌ No videos found in RSS feed")
        return None

    # Auto-detect channel name from URL if not provided
    if not channel_name:
        m = re.search(r'@([\w]+)', channel_url)
        channel_name = m.group(1) if m else channel_id

    channel_data = {
        "channel_id": channel_id,
        "channel_name": channel_name,
        "channel_url": channel_url,
        "last_scanned": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "videos": videos,
    }

    # Save to channels.json
    db = load_channels()
    # Update existing or add new
    existing = next((c for c in db["channels"] if c["channel_id"] == channel_id), None)
    if existing:
        # Preserve enabled flags from old data
        old_flags = {v["video_id"]: v.get("enabled", True) for v in existing.get("videos", [])}
        for v in videos:
            v["enabled"] = old_flags.get(v["video_id"], True)
        existing.update(channel_data)
        print(f"  ✅ Channel updated: {channel_name} ({len(videos)} videos)")
    else:
        db["channels"].append(channel_data)
        print(f"  ✅ Channel added: {channel_name} ({len(videos)} videos)")

    save_channels(db)

    for v in videos:
        status = "✅" if v["enabled"] else "⏭️"
        print(f"    {status} [{v['video_id']}] {v['title'][:55]}")

    return channel_data


# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: channels.json → jobs.json auto-update
# ─────────────────────────────────────────────────────────────────────────────

def update_jobs_from_channels() -> int:
    """
    channels.json ke enabled videos ko jobs.json mein sync karo.
    Naye videos add, purane preserve. Returns count of jobs added.
    """
    db = load_channels()
    if not db["channels"]:
        print("  [Jobs] No channels in database")
        return 0

    # Load jobs.json
    try:
        jobs_data = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except Exception:
        jobs_data = {"jobs": []}

    existing_ids = {j["video_id"] for j in jobs_data.get("jobs", [])}

    # Load template job config (from first existing job or defaults)
    template_engagement = None
    template_watch = None
    if jobs_data.get("jobs"):
        t = jobs_data["jobs"][0]
        template_engagement = t.get("engagement")
        template_watch = t.get("watch_time")

    added = 0
    for channel in db["channels"]:
        ch_name = channel["channel_name"]
        ch_url = channel["channel_url"]

        for video in channel.get("videos", []):
            if not video.get("enabled", True):
                continue
            vid_id = video["video_id"]
            if vid_id in existing_ids:
                continue  # already in jobs

            # Build keyword variants from title
            title = video["title"]
            words = title.lower().replace(",", "").replace("!", "").split()
            keywords_base = " ".join(words[:5])

            new_job = {
                "id": f"auto-{ch_name}-{vid_id}",
                "video_id": vid_id,
                "channel_name": ch_name,
                "channel_url": ch_url,
                "title_hint": title[:60],
                "search_keywords": keywords_base,
                "search_keyword_variants": [
                    keywords_base,
                    title[:40],
                    f"{ch_name} {keywords_base}",
                ],
                "target_views": 6,
                "referrer_search": False,
                "behavior_profile": "serious_learner",
                "watch_time": template_watch or {
                    "mode": "smart",
                    "smart_min_pct": 0.40,
                    "smart_max_pct": 0.60,
                    "min_seconds": 90,
                    "max_seconds": 300,
                },
                "engagement": template_engagement or {
                    "like": {"enabled": True, "probability": 0.85},
                    "dislike": {"enabled": False},
                    "subscribe": {"enabled": True, "probability": 0.30},
                    "bell": {"enabled": True, "probability": 0.50},
                    "comment": {
                        "enabled": True,
                        "probability": 0.40,
                        "comment_templates": [
                            "Great video, very helpful!",
                            "This is exactly what I needed, thanks!",
                            "Very informative content, keep it up!",
                        ],
                    },
                    "autoplay_off": {"enabled": True, "must_do": True},
                    "ads_skip": {"enabled": True, "must_do": True, "skip_after_seconds": 5},
                    "quality": {"enabled": True, "target": "360p"},
                    "description": {"enabled": False},
                },
            }
            jobs_data.setdefault("jobs", []).append(new_job)
            existing_ids.add(vid_id)
            added += 1
            print(f"  [Jobs] Added: [{vid_id}] {title[:50]}")

    if added > 0:
        JOBS_FILE.write_text(json.dumps(jobs_data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\n  ✅ {added} new jobs added to jobs.json")
    else:
        print("  ✅ jobs.json already up to date")

    return added


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python channel_scanner.py https://www.youtube.com/@ULTRAPLAY8")
        print("  python channel_scanner.py --update-jobs")
        print("  python channel_scanner.py --list")
        return

    arg = sys.argv[1]

    if arg == "--update-jobs":
        print("\n[Channel Scanner] Refreshing all channels + updating jobs.json")
        db = load_channels()
        for ch in db["channels"]:
            scan_channel(ch["channel_url"], ch["channel_name"])
        update_jobs_from_channels()

    elif arg == "--list":
        db = load_channels()
        if not db["channels"]:
            print("No channels saved yet. Add one first.")
            return
        for ch in db["channels"]:
            vcount = len(ch.get("videos", []))
            enabled = sum(1 for v in ch.get("videos", []) if v.get("enabled", True))
            print(f"\n📺 {ch['channel_name']} ({ch['channel_id']})")
            print(f"   {ch['channel_url']}")
            print(f"   Videos: {vcount} total, {enabled} enabled")
            for v in ch.get("videos", []):
                s = "✅" if v.get("enabled") else "⏭️"
                print(f"   {s} [{v['video_id']}] {v['title'][:55]}")

    else:
        # Treat as channel URL
        channel = scan_channel(arg)
        if channel:
            update_jobs_from_channels()


if __name__ == "__main__":
    main()
