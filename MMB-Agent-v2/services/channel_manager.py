"""
T2-01 — Channel & Video Database Manager
=========================================

channels.json aur videos.json ka CRUD interface.

Schema — channels.json:
    {
      "channels": [
        {
          "channel_id":     "UCxxxxxx",
          "channel_name":   "ULTRAPLAY8",
          "channel_handle": "@ultraplay8",
          "channel_url":    "https://www.youtube.com/@ultraplay8",
          "enabled":        true,
          "added_at":       "2026-05-31T00:00:00Z"
        }
      ]
    }

Schema — videos.json:
    {
      "videos": [
        {
          "video_id":   "KjNyAVwtAUg",
          "title":      "Best Credit Cards 2026",
          "channel_id": "UCxxxxxx",
          "url":        "https://www.youtube.com/watch?v=KjNyAVwtAUg",
          "enabled":    true,
          "priority":   1,
          "added_at":   "2026-05-31T00:00:00Z"
        }
      ]
    }

Priority: lower number = higher priority (1 = highest).
get_all_videos() returns enabled videos sorted by priority asc, then added_at asc.

Atomic saves: write to .tmp → os.replace() (crash-safe on all platforms).

Usage::
    from services.channel_manager import ChannelManager

    cm = ChannelManager()

    # Add a channel
    cm.add_channel("UCxxxxxx", name="ULTRAPLAY8", handle="@ultraplay8")

    # Fetch + store its videos (uses video_fetcher internally)
    from services.video_fetcher import VideoFetcher
    videos = await VideoFetcher().fetch(channel_id="UCxxxxxx")
    cm.bulk_add_videos(videos)

    # Get playable videos (enabled, priority-sorted)
    targets = cm.get_all_videos()
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

CHANNELS_PATH = PROJECT_ROOT / "data" / "channels.json"
VIDEOS_PATH   = PROJECT_ROOT / "data" / "videos.json"


# ── Atomic JSON helpers ────────────────────────────────────────────────────────

def _load_json(path: Path, default: dict) -> dict:
    """Load JSON file. Returns default if missing or corrupt."""
    try:
        if path.exists():
            text = path.read_text(encoding="utf-8")
            return json.loads(text)
    except Exception:
        pass
    return default


def _save_json(path: Path, data: dict) -> None:
    """
    Atomic save — concurrent-safe on Linux and Windows.

    Uses tempfile.mkstemp (unique tmp path per write, same directory) so
    os.replace() is an atomic rename. Retries up to 5x with back-off for
    Windows WinError 5 (transient lock on rename). fd_closed flag prevents
    double-close when os.replace fails after fd already closed.

    Sprint-3: mkstemp + fd_closed guard + Windows retry.
    """
    import time as _time
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp", prefix="_mmb_")
    fd_closed = False
    try:
        os.write(fd, payload)
        os.close(fd)
        fd_closed = True
        for attempt in range(5):
            try:
                os.replace(tmp_path, path)
                return
            except OSError:
                if attempt == 4:
                    raise
                _time.sleep(0.01 * (attempt + 1))
    except Exception:
        if not fd_closed:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── ChannelManager ─────────────────────────────────────────────────────────────

class ChannelManager:
    """
    CRUD for channels.json and videos.json.

    All methods are synchronous (file I/O). Call from async code with
    asyncio.to_thread() if needed (files are small, usually <1ms).
    """

    # ── Internal loaders ──────────────────────────────────────────────────────

    def _load_channels(self) -> list[dict]:
        data = _load_json(CHANNELS_PATH, {"channels": []})
        return data.get("channels") or []

    def _save_channels(self, channels: list[dict]) -> None:
        _save_json(CHANNELS_PATH, {"channels": channels})

    def _load_videos(self) -> list[dict]:
        data = _load_json(VIDEOS_PATH, {"videos": []})
        return data.get("videos") or []

    def _save_videos(self, videos: list[dict]) -> None:
        _save_json(VIDEOS_PATH, {"videos": videos})

    # ── Channel CRUD ──────────────────────────────────────────────────────────

    def add_channel(
        self,
        channel_id: str,
        *,
        name: str = "",
        handle: str = "",
        url: str = "",
        enabled: bool = True,
    ) -> dict:
        """
        Add a channel. If channel_id already exists, update name/handle/url.
        Returns the channel record.
        """
        channel_id = channel_id.strip()
        if not channel_id:
            raise ValueError("channel_id cannot be empty")

        channels = self._load_channels()

        # Update if exists
        for ch in channels:
            if ch.get("channel_id") == channel_id:
                if name:
                    ch["channel_name"] = name
                if handle:
                    ch["channel_handle"] = handle
                if url:
                    ch["channel_url"] = url
                ch["enabled"] = enabled
                self._save_channels(channels)
                return ch

        # Build URL if not provided
        if not url:
            if handle:
                clean_handle = handle.lstrip("@")
                url = f"https://www.youtube.com/@{clean_handle}" if clean_handle else f"https://www.youtube.com/channel/{channel_id}"
            else:
                url = f"https://www.youtube.com/channel/{channel_id}"

        record = {
            "channel_id":     channel_id,
            "channel_name":   name,
            "channel_handle": handle,
            "channel_url":    url,
            "enabled":        enabled,
            "added_at":       _now_iso(),
        }
        channels.append(record)
        self._save_channels(channels)
        return record

    def remove_channel(self, channel_id: str, *, remove_videos: bool = True) -> bool:
        """
        Remove a channel (and optionally all its videos).
        Returns True if found and removed.
        """
        channels = self._load_channels()
        before = len(channels)
        channels = [c for c in channels if c.get("channel_id") != channel_id]
        if len(channels) == before:
            return False
        self._save_channels(channels)

        if remove_videos:
            videos = self._load_videos()
            videos = [v for v in videos if v.get("channel_id") != channel_id]
            self._save_videos(videos)

        return True

    def enable_disable_channel(self, channel_id: str, *, enabled: bool) -> bool:
        """Toggle channel enabled/disabled. Returns True if found."""
        channels = self._load_channels()
        for ch in channels:
            if ch.get("channel_id") == channel_id:
                ch["enabled"] = enabled
                self._save_channels(channels)
                return True
        return False

    def get_channel(self, channel_id: str) -> Optional[dict]:
        """Get a single channel record. Returns None if not found."""
        for ch in self._load_channels():
            if ch.get("channel_id") == channel_id:
                return ch
        return None

    def get_all_channels(self, *, enabled_only: bool = False) -> list[dict]:
        """Return all channels, optionally filtered to enabled ones."""
        channels = self._load_channels()
        if enabled_only:
            channels = [c for c in channels if c.get("enabled", True)]
        return channels

    # ── Video CRUD ────────────────────────────────────────────────────────────

    def add_video(
        self,
        video_id: str,
        *,
        title: str = "",
        channel_id: str = "",
        url: str = "",
        enabled: bool = True,
        priority: int = 5,
    ) -> dict:
        """
        Add a video. If video_id already exists, update title/channel/url.
        Returns the video record.
        """
        video_id = video_id.strip()
        if not video_id:
            raise ValueError("video_id cannot be empty")

        videos = self._load_videos()

        # Update if exists
        for v in videos:
            if v.get("video_id") == video_id:
                if title:
                    v["title"] = title
                if channel_id:
                    v["channel_id"] = channel_id
                if url:
                    v["url"] = url
                v["enabled"]  = enabled
                v["priority"] = max(1, int(priority))
                self._save_videos(videos)
                return v

        # Build URL if not provided
        if not url:
            url = f"https://www.youtube.com/watch?v={video_id}"

        record = {
            "video_id":   video_id,
            "title":      title,
            "channel_id": channel_id,
            "url":        url,
            "enabled":    enabled,
            "priority":   max(1, int(priority)),
            "added_at":   _now_iso(),
        }
        videos.append(record)
        self._save_videos(videos)
        return record

    def bulk_add_videos(self, video_list: list[dict]) -> int:
        """
        Add multiple videos in one atomic save.
        Each dict should have: video_id, title, channel_id, url, [enabled], [priority]
        Returns count of newly added videos.
        """
        videos = self._load_videos()
        existing_ids = {v["video_id"] for v in videos}
        added = 0

        for item in video_list:
            vid = str(item.get("video_id", "")).strip()
            if not vid:
                continue
            if vid in existing_ids:
                # Update title if we now have it
                for v in videos:
                    if v["video_id"] == vid:
                        if item.get("title") and not v.get("title"):
                            v["title"] = item["title"]
                        break
                continue

            url = item.get("url") or f"https://www.youtube.com/watch?v={vid}"
            record = {
                "video_id":   vid,
                "title":      str(item.get("title", "")),
                "channel_id": str(item.get("channel_id", "")),
                "url":        url,
                "enabled":    bool(item.get("enabled", True)),
                "priority":   max(1, int(item.get("priority", 5))),
                "added_at":   _now_iso(),
            }
            videos.append(record)
            existing_ids.add(vid)
            added += 1

        self._save_videos(videos)
        return added

    def remove_video(self, video_id: str) -> bool:
        """Remove a video by video_id. Returns True if found."""
        videos = self._load_videos()
        before = len(videos)
        videos = [v for v in videos if v.get("video_id") != video_id]
        if len(videos) == before:
            return False
        self._save_videos(videos)
        return True

    def enable_disable_video(self, video_id: str, *, enabled: bool) -> bool:
        """Toggle video enabled/disabled. Returns True if found."""
        videos = self._load_videos()
        for v in videos:
            if v.get("video_id") == video_id:
                v["enabled"] = enabled
                self._save_videos(videos)
                return True
        return False

    def set_priority(self, video_id: str, priority: int) -> bool:
        """
        Set priority for a video (1 = highest, larger = lower priority).
        Returns True if found.
        """
        videos = self._load_videos()
        for v in videos:
            if v.get("video_id") == video_id:
                v["priority"] = max(1, int(priority))
                self._save_videos(videos)
                return True
        return False

    def get_video(self, video_id: str) -> Optional[dict]:
        """Get a single video record."""
        for v in self._load_videos():
            if v.get("video_id") == video_id:
                return v
        return None

    def get_all_videos(
        self,
        *,
        enabled_only: bool = True,
        channel_id: Optional[str] = None,
    ) -> list[dict]:
        """
        Return videos sorted by priority (asc) then added_at (asc).

        Parameters
        ----------
        enabled_only : Skip disabled videos (default True).
        channel_id   : Filter by specific channel (default: all channels).
        """
        videos = self._load_videos()

        if enabled_only:
            videos = [v for v in videos if v.get("enabled", True)]

        if channel_id:
            videos = [v for v in videos if v.get("channel_id") == channel_id]

        # Sort: priority asc (1=first), then added_at asc (older first)
        videos.sort(key=lambda v: (
            int(v.get("priority", 5)),
            v.get("added_at", ""),
        ))
        return videos

    # ── Sync videos.json → jobs.json ──────────────────────────────────────────

    def sync_to_jobs(
        self,
        jobs_path: "Path",
        *,
        default_target_views: int = 6,
        overwrite_existing: bool = False,
    ) -> dict:
        """
        Sync enabled videos from videos.json → jobs.json.

        For each enabled video NOT already in jobs.json, creates a full job
        entry with default engagement settings. Existing jobs are NOT
        overwritten unless overwrite_existing=True.

        Parameters
        ----------
        jobs_path           : Path to jobs.json.
        default_target_views: Target views per job (default 6).
        overwrite_existing  : Replace existing job if video_id matches.

        Returns
        -------
        {"added": N, "skipped": N, "total_videos": N}
        """
        from pathlib import Path as _Path  # avoid circular at module level
        _p = _Path(jobs_path)

        # Load current jobs.json
        try:
            jobs_data = json.loads(_p.read_text(encoding="utf-8")) if _p.exists() else {}
        except Exception:
            jobs_data = {}

        jobs_list: list[dict] = jobs_data.get("jobs", [])
        existing_ids: set = {j.get("video_id", "") for j in jobs_list}

        # Channel lookup for name/url enrichment
        ch_map = {c["channel_id"]: c for c in self._load_channels()}

        enabled_videos = self.get_all_videos(enabled_only=True)
        added = 0
        skipped = 0

        for video in enabled_videos:
            vid_id = video.get("video_id", "").strip()
            if not vid_id:
                continue

            if vid_id in existing_ids and not overwrite_existing:
                skipped += 1
                continue

            # Enrich with channel info from channels.json
            ch_info     = ch_map.get(video.get("channel_id", ""), {})
            channel_name = ch_info.get("channel_name", "")
            channel_id   = video.get("channel_id", "")
            channel_url  = ch_info.get("channel_url", "")
            title        = video.get("title", "")
            keywords     = title.lower() if title else vid_id

            new_job = {
                "id":                    f"job-{vid_id}",
                "video_id":              vid_id,
                "channel_name":          channel_name,
                "channel_id":            channel_id,
                "channel_url":           channel_url,
                "title_hint":            title,
                "search_keywords":       keywords,
                "target_views":          default_target_views,
                "enabled":               True,
                "watch_time": {
                    "mode":          "smart",
                    "smart_min_pct": 0.40,
                    "smart_max_pct": 0.60,
                    "min_seconds":   90,
                    "max_seconds":   300,
                },
                "engagement": {
                    "like":         {"enabled": True,  "probability": 0.85},
                    "dislike":      {"enabled": False},
                    "subscribe":    {"enabled": True,  "probability": 0.30},
                    "bell":         {"enabled": True,  "probability": 0.50},
                    "comment":      {
                        "enabled":            True,
                        "probability":        0.40,
                        "comment_templates":  [
                            "Great video! Very helpful content.",
                            "Thanks for sharing this amazing insight!",
                            "Subscribed! This channel is amazing.",
                        ],
                    },
                    "autoplay_off": {"enabled": True,  "must_do": True},
                    "ads_skip":     {"enabled": True,  "must_do": True, "skip_after_seconds": 5},
                    "quality":      {"enabled": True,  "target": "360p"},
                    "description":  {"enabled": False},
                },
            }

            if vid_id in existing_ids:
                # overwrite mode: drop old entry, replace with new
                jobs_list = [j for j in jobs_list if j.get("video_id") != vid_id]

            jobs_list.append(new_job)
            existing_ids.add(vid_id)
            added += 1

        jobs_data["jobs"] = jobs_list
        _save_json(_p, jobs_data)

        return {"added": added, "skipped": skipped, "total_videos": len(enabled_videos)}

    # ── Fetch + store from live channel ──────────────────────────────────────

    async def fetch_videos(
        self,
        channel_id: str,
        *,
        priority: int = 5,
        enabled: bool = True,
        log=None,
    ) -> int:
        """
        Fetch latest videos for a channel via RSS, store them.
        Uses VideoFetcher internally (no API key required).

        Returns count of newly added videos.
        """
        _log = log or (lambda msg: None)
        from services.video_fetcher import VideoFetcher
        fetcher = VideoFetcher()
        raw = await fetcher.fetch(channel_id=channel_id, log=_log)
        if not raw:
            _log(f"[ChannelManager] No videos fetched for channel_id={channel_id}")
            return 0

        # Inject priority + enabled from caller
        for item in raw:
            item.setdefault("priority", priority)
            item.setdefault("enabled", enabled)
            item["channel_id"] = channel_id

        added = self.bulk_add_videos(raw)
        _log(f"[ChannelManager] channel_id={channel_id} | fetched={len(raw)} | new={added}")
        return added
