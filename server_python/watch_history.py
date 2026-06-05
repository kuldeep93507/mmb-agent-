"""
WatchHistory — Per-profile persistent video watch tracking for MMB AGENT 24/7

Purpose:
  Har profile ke liye track karta h kaunsi videos dekhi ja chuki hain.
  Sidebar related video feature ke liye — same video dobara nahi chalani.

Storage:
  data/watch_history/{profile_id_first8}.json
  Format: {"profile_id": "...", "watched": ["vid1", "vid2", ...], "updated_at": "..."}

Atomic saves — write to .tmp → rename (crash-safe)
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("mmb.watch_history")

# Storage directory — relative to project root
_HISTORY_DIR = Path(__file__).resolve().parent.parent / "data" / "watch_history"


def _history_path(profile_id: str) -> Path:
    """Return JSON path for a profile's watch history."""
    # Use first 12 chars of profile_id as filename (safe for filesystem)
    safe_id = "".join(c for c in profile_id[:12] if c.isalnum() or c in "-_")
    return _HISTORY_DIR / f"{safe_id}.json"


def _load_raw(profile_id: str) -> dict:
    """Load raw history dict from disk, or return empty structure."""
    p = _history_path(profile_id)
    try:
        if p.exists():
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and "watched" in data:
                return data
    except Exception as e:
        log.debug(f"[WatchHistory] Load error for {profile_id[:8]}: {e}")
    return {"profile_id": profile_id, "watched": [], "updated_at": ""}


def _save_atomic(profile_id: str, data: dict) -> None:
    """Atomic save — write to .tmp then rename (crash-safe)."""
    p = _history_path(profile_id)
    tmp = p.with_suffix(".tmp")
    try:
        _HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        # Atomic replace
        tmp.replace(p)
    except Exception as e:
        log.warning(f"[WatchHistory] Save error for {profile_id[:8]}: {e}")
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


# ── Public API ────────────────────────────────────────────────────────────────

def mark_watched(profile_id: str, video_id: str, video_title: str = "") -> None:
    """
    Mark video_id as watched by this profile.
    Stores {videoId, watchedAt, videoTitle} objects so frontend can do
    title-based dedup and recency filtering.
    Idempotent — updates timestamp if already present.
    """
    if not profile_id or not video_id:
        return
    data = _load_raw(profile_id)
    # Migrate legacy format: list of strings → list of dicts
    raw_watched = data.get("watched", [])
    watched_dict: list[dict] = []
    for entry in raw_watched:
        if isinstance(entry, str):
            watched_dict.append({"videoId": entry, "watchedAt": 0, "videoTitle": ""})
        elif isinstance(entry, dict):
            watched_dict.append(entry)
    # Upsert — update watchedAt if already present
    now_ms = int(time.time() * 1000)
    existing = next((e for e in watched_dict if e.get("videoId") == video_id), None)
    if existing:
        existing["watchedAt"] = now_ms
        if video_title:
            existing["videoTitle"] = video_title
    else:
        watched_dict.append({
            "videoId": video_id,
            "watchedAt": now_ms,
            "videoTitle": video_title or "",
        })
    data["watched"] = watched_dict
    _save_atomic(profile_id, data)
    log.debug(f"[WatchHistory] Marked {video_id!r} watched for {profile_id[:8]}")


def _get_watched_ids(data: dict) -> set[str]:
    """Extract video IDs from either legacy (list of strings) or new (list of dicts) format."""
    result: set[str] = set()
    for entry in data.get("watched", []):
        if isinstance(entry, str):
            result.add(entry)
        elif isinstance(entry, dict) and entry.get("videoId"):
            result.add(entry["videoId"])
    return result


def _get_watched_list(data: dict) -> list[dict]:
    """Return watched list as list of dicts (normalises legacy string entries)."""
    result: list[dict] = []
    for entry in data.get("watched", []):
        if isinstance(entry, str):
            result.append({"videoId": entry, "watchedAt": 0, "videoTitle": ""})
        elif isinstance(entry, dict):
            result.append(entry)
    return result


def has_watched(profile_id: str, video_id: str) -> bool:
    """
    Check if this profile has already watched video_id.
    Returns True if yes (should skip), False if not watched yet.
    """
    if not profile_id or not video_id:
        return False
    data = _load_raw(profile_id)
    return video_id in _get_watched_ids(data)


def get_watched(profile_id: str) -> set[str]:
    """Return full set of video_ids watched by this profile."""
    if not profile_id:
        return set()
    data = _load_raw(profile_id)
    return _get_watched_ids(data)


def get_watched_entries(profile_id: str) -> list[dict]:
    """Return full list of {videoId, watchedAt, videoTitle} entries."""
    if not profile_id:
        return []
    data = _load_raw(profile_id)
    return _get_watched_list(data)


def clear_history(profile_id: str) -> None:
    """Clear all watch history for a profile (use carefully)."""
    p = _history_path(profile_id)
    try:
        if p.exists():
            p.unlink()
            log.info(f"[WatchHistory] Cleared history for {profile_id[:8]}")
    except Exception as e:
        log.warning(f"[WatchHistory] Clear error: {e}")


def get_stats(profile_id: str) -> dict:
    """Return stats for a profile's watch history."""
    data = _load_raw(profile_id)
    watched = data.get("watched", [])
    return {
        "profile_id": profile_id,
        "total_watched": len(watched),
        "updated_at": data.get("updated_at", "never"),
    }
