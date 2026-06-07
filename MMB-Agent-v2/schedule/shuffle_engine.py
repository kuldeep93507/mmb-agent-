"""
T2-03 — Shuffle Engine + Watch History
========================================

Per-profile video assignment with:
  • Strict 24-hour dedup window (not calendar-day)
  • Priority sort  — priority=1 (high) ALWAYS before priority=5 (normal)
  • Profile-seeded Fisher-Yates shuffle  — deterministic per profile
  • Cross-profile overlap avoidance  — profile_2 gets different video than profile_1
  • Full engagement tracking in watch_history.json

Data sources:
  • data/videos.json     — T2-01 video DB (enabled videos + priority)
  • data/watch_history.json — per-profile engagement audit trail
  • data/shuffle_dedup.json — existing cross-profile overlap store (reused)

Key API::
    from schedule.shuffle_engine import ProfileShuffleEngine

    engine = ProfileShuffleEngine()

    # Get next video for a profile
    video = engine.get_next_video("profile-id-123")
    # → {"video_id": "...", "title": "...", "priority": 1, "fresh": True, ...}
    # → None if no videos available

    # Mark as watched
    engine.mark_watched("profile-id-123", "KjNyAVwtAUg", {
        "watch_time_sec": 240,
        "liked": True,
        "commented": False,
        "subscribed": False,
        "title": "Best Credit Card 2026",
    })

    # Get history
    history = engine.get_watch_history("profile-id-123", last_n=20)

    # Purge old entries
    engine.clear_old_history(hours=24)

    # Available pool for a profile
    pool = engine.get_fresh_pool("profile-id-123")

Rules (hard-coded, non-negotiable):
  1. priority=1 videos ALWAYS before priority=5  — no exceptions
  2. 24h window is time-based (not date-based)
  3. Profile seed: hash(profile_id) & 0x7FFFFFFF → deterministic shuffle
  4. Overlap: once assigned to profile_A → pushed to back for profile_B
  5. All writes are atomic (tmp → replace)
  6. Every decision is logged with reason
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

VIDEOS_PATH       = PROJECT_ROOT / "data" / "videos.json"
WATCH_HISTORY_PATH = PROJECT_ROOT / "data" / "watch_history.json"
DEDUP_PATH        = PROJECT_ROOT / "data" / "shuffle_dedup.json"
LOG_PATH          = PROJECT_ROOT / "logs" / "shuffle_engine.log"

PRIORITY_LABELS = {1: "critical", 2: "high", 3: "medium", 4: "normal", 5: "low"}


# ── Atomic JSON helpers ────────────────────────────────────────────────────────

def _load_json(path: Path, default: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default


def _save_json(path: Path, data: Any) -> None:
    """
    Atomic JSON save — concurrent-safe on Linux and Windows.

    Uses tempfile.mkstemp (unique tmp path per call, same directory) so
    os.replace() is an atomic rename. Multiple concurrent callers each get
    their own temp file — no shared filename collision.

    Windows note: os.replace() can raise WinError 5 (Access Denied) when
    another thread holds a transient write lock on the target. We retry up
    to 5x with exponential back-off (10–50ms) before giving up. In production
    (6 profiles) this window is <1ms; retry is a safety net only.

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
        # Retry loop for Windows WinError 5 (Access Denied on rename)
        for attempt in range(5):
            try:
                os.replace(tmp_path, path)
                return           # success
            except OSError:
                if attempt == 4:
                    raise        # give up after 5 tries
                _time.sleep(0.01 * (attempt + 1))   # 10, 20, 30, 40 ms
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


def _parse_iso(s: str) -> Optional[datetime]:
    """Parse ISO-8601 UTC string. Returns None on failure."""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


# ── Profile seed helper ────────────────────────────────────────────────────────

def _profile_seed(profile_id: str) -> int:
    """
    Deterministic integer seed from profile_id.
    Same profile → same seed → same shuffle order (before dedup filter).
    Uses SHA-256 first 8 bytes → int.
    """
    digest = hashlib.sha256(profile_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFFFFFF


# ── Fisher-Yates in-place shuffle ─────────────────────────────────────────────

def _fisher_yates(lst: list, rng: random.Random) -> list:
    """
    Standard Fisher-Yates in-place shuffle.
    Returns same list (mutated) for chaining.
    """
    n = len(lst)
    for i in range(n - 1, 0, -1):
        j = rng.randint(0, i)
        lst[i], lst[j] = lst[j], lst[i]
    return lst


# ── Watch History Store ────────────────────────────────────────────────────────

class WatchHistoryStore:
    """
    CRUD for data/watch_history.json.

    Schema::
        {
          "profiles": {
            "profile_id_1": [
              {
                "video_id":       "KjNyAVwtAUg",
                "title":          "Best Credit Card 2026",
                "watched_at":     "2026-05-31T10:00:00Z",
                "watch_time_sec": 240,
                "liked":          true,
                "commented":      false,
                "subscribed":     false
              }
            ]
          }
        }

    All writes are atomic (tmp → os.replace).
    """

    def __init__(self, path: Path = WATCH_HISTORY_PATH) -> None:
        self._path = path

    def _load(self) -> dict:
        return _load_json(self._path, {"profiles": {}})

    def _save(self, data: dict) -> None:
        _save_json(self._path, data)

    # ── Write ──────────────────────────────────────────────────────────────

    def add_entry(self, profile_id: str, video_id: str, details: dict) -> dict:
        """
        Add a watch entry for a profile.

        Parameters
        ----------
        profile_id : Multilogin profile UUID.
        video_id   : YouTube video ID.
        details    : Dict with: title, watch_time_sec, liked, commented, subscribed.
                     Missing keys default to safe values.

        Returns the stored entry dict.
        """
        data = self._load()
        profiles = data.setdefault("profiles", {})
        profile_history = profiles.setdefault(profile_id, [])

        entry = {
            "video_id":       video_id,
            "title":          str(details.get("title", "")),
            "watched_at":     details.get("watched_at") or _now_iso(),
            "watch_time_sec": int(details.get("watch_time_sec", 0)),
            "liked":          bool(details.get("liked", False)),
            "commented":      bool(details.get("commented", False)),
            "subscribed":     bool(details.get("subscribed", False)),
        }
        profile_history.append(entry)
        self._save(data)
        return entry

    # ── Read ───────────────────────────────────────────────────────────────

    def get_history(self, profile_id: str, last_n: int = 50) -> list[dict]:
        """
        Return last N watch entries for a profile (most recent first).
        """
        data = self._load()
        history = data.get("profiles", {}).get(profile_id, [])
        return list(reversed(history[-last_n:]))

    def get_watched_in_window(self, profile_id: str, hours: float = 24.0) -> set[str]:
        """
        Return set of video_ids watched within the last `hours` hours.
        Uses actual watched_at timestamp (strict, not calendar-day).
        """
        data = self._load()
        history = data.get("profiles", {}).get(profile_id, [])
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        seen = set()
        for entry in history:
            ts = _parse_iso(entry.get("watched_at", ""))
            if ts and ts >= cutoff:
                seen.add(entry["video_id"])
        return seen

    def get_all_watched_in_window(self, hours: float = 24.0) -> dict[str, set[str]]:
        """
        Returns {profile_id: set(video_ids)} for all profiles within window.
        Used for cross-profile overlap avoidance.
        """
        data = self._load()
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        result: dict[str, set[str]] = {}
        for pid, history in data.get("profiles", {}).items():
            seen = set()
            for entry in history:
                ts = _parse_iso(entry.get("watched_at", ""))
                if ts and ts >= cutoff:
                    seen.add(entry["video_id"])
            result[pid] = seen
        return result

    # ── Cleanup ────────────────────────────────────────────────────────────

    def clear_old_entries(self, hours: float = 24.0) -> int:
        """
        Delete all entries older than `hours` from ALL profiles.
        Returns count of deleted entries.
        """
        data = self._load()
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        deleted = 0

        for pid in list(data.get("profiles", {}).keys()):
            before = data["profiles"][pid]
            after = [
                e for e in before
                if (_parse_iso(e.get("watched_at", "")) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff
            ]
            deleted += len(before) - len(after)
            data["profiles"][pid] = after
            # Remove empty profile keys
            if not data["profiles"][pid]:
                del data["profiles"][pid]

        if deleted:
            self._save(data)
        return deleted


# ── Cross-profile Overlap Store ────────────────────────────────────────────────

class OverlapStore:
    """
    Tracks which video was last assigned to each profile (short-term, TTL-based).
    Stored in data/shuffle_dedup.json — reuses existing file with new key.

    Layout added::
        {
          "overlap_v2": {
            "profile_id_1": {"video_id": "KjNyAVwtAUg", "assigned_at": "2026-05-31T10:00:00Z"},
            "profile_id_2": {"video_id": "C64hwS63yIc", "assigned_at": "2026-05-31T10:01:00Z"}
          }
        }

    TTL: overlap_ttl_hours (default 2h). Assignments older than TTL are ignored.
    When assigning to profile_N:
      - Collect videos assigned to any OTHER profile within TTL window
      - Push those to back of pool (soft deprioritize, not hard remove)
    """

    _KEY = "overlap_v2"

    def __init__(self, path: Path = DEDUP_PATH, ttl_hours: float = 2.0) -> None:
        self._path = path
        self._ttl_hours = ttl_hours

    def _load(self) -> dict:
        return _load_json(self._path, {})

    def get_recently_assigned(self, exclude_profile: str) -> set[str]:
        """
        Return video_ids recently assigned (within TTL) to any profile
        EXCEPT exclude_profile.
        """
        data = self._load()
        overlap = data.get(self._KEY, {})
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self._ttl_hours)
        result = set()
        for pid, entry in overlap.items():
            if pid == exclude_profile:
                continue
            if not isinstance(entry, dict):
                continue  # old format — skip
            ts = _parse_iso(entry.get("assigned_at", ""))
            if ts and ts >= cutoff:
                result.add(entry.get("video_id", ""))
        return result - {""}  # remove empty strings

    def mark_assigned(self, profile_id: str, video_id: str) -> None:
        """Record assignment with timestamp: profile → {video_id, assigned_at}."""
        data = self._load()
        data.setdefault(self._KEY, {})[profile_id] = {
            "video_id":    video_id,
            "assigned_at": _now_iso(),
        }
        _save_json(self._path, data)

    def clear(self) -> None:
        data = self._load()
        data.pop(self._KEY, None)
        _save_json(self._path, data)


# ── Logger ────────────────────────────────────────────────────────────────────

# Sprint-4: module-level lock + configured set to prevent duplicate handlers
# when multiple ProfileShuffleEngine instances are created concurrently.
# Bug: `if not logger.handlers:` is NOT thread-safe — two threads could both
# read handlers=[] and both add FileHandlers → doubled log output.
_LOGGER_LOCK = threading.Lock()
_CONFIGURED_LOGGERS: set = set()

_LOGGER_NAME = "mmb.shuffle_engine_v2"


def _make_logger(path: Path = LOG_PATH) -> logging.Logger:
    """
    Return (or create) the shared shuffle-engine logger.

    Thread-safe: uses a module-level lock so concurrent ProfileShuffleEngine
    __init__ calls never add duplicate handlers.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(_LOGGER_NAME)

    with _LOGGER_LOCK:
        if _LOGGER_NAME not in _CONFIGURED_LOGGERS:
            logger.setLevel(logging.DEBUG)
            logger.propagate = False
            fh = logging.FileHandler(path, encoding="utf-8")
            fh.setFormatter(logging.Formatter(
                "%(asctime)s | %(levelname)s | %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            ))
            logger.addHandler(fh)
            # Stdout handler only when explicitly requested (not in production)
            if os.getenv("SHUFFLE_ENGINE_VERBOSE", "").lower() in ("1", "true", "yes"):
                ch = logging.StreamHandler(sys.stdout)
                ch.setFormatter(logging.Formatter(
                    "%(asctime)s | SHUFFLE | %(message)s", datefmt="%H:%M:%S"
                ))
                ch.setLevel(logging.INFO)
                logger.addHandler(ch)
            _CONFIGURED_LOGGERS.add(_LOGGER_NAME)

    return logger


# ── ProfileShuffleEngine (main) ───────────────────────────────────────────────

class ProfileShuffleEngine:
    """
    T2-03 Shuffle Engine — complete per-profile video assignment system.

    Responsibilities:
      1. Load enabled videos from data/videos.json (T2-01 DB)
      2. Apply 24h dedup: remove already-watched videos
      3. Sort by priority (1=first, higher number=later)
      4. Fisher-Yates shuffle WITHIN each priority tier (seeded by profile_id)
      5. Soft-deprioritize videos assigned to other profiles (overlap avoidance)
      6. Return best available video with full metadata
      7. Track all assignments in watch_history.json

    Usage::
        engine = ProfileShuffleEngine()
        video = engine.get_next_video("profile-uuid")
        if video:
            # ... run the view session ...
            engine.mark_watched("profile-uuid", video["video_id"], {
                "title": video["title"],
                "watch_time_sec": 240,
                "liked": True,
                "commented": False,
                "subscribed": True,
            })
    """

    def __init__(
        self,
        *,
        videos_path: Path = VIDEOS_PATH,
        history_path: Path = WATCH_HISTORY_PATH,
        dedup_path: Path = DEDUP_PATH,
        log_path: Path = LOG_PATH,
        dedup_hours: float = 24.0,
    ) -> None:
        self._videos_path  = videos_path
        self._dedup_hours  = dedup_hours
        self._history      = WatchHistoryStore(history_path)
        self._overlap      = OverlapStore(dedup_path)
        self._logger       = _make_logger(log_path)

    # ── Public API ─────────────────────────────────────────────────────────

    def get_next_video(self, profile_id: str) -> Optional[dict]:
        """
        Return the next best video for a profile.

        Algorithm:
          1. Load all enabled videos from videos.json
          2. Remove videos watched by this profile in last 24h
          3. Sort by priority ascending (1 = highest priority)
          4. Fisher-Yates shuffle WITHIN each priority group (profile-seeded)
          5. Soft-demote videos recently assigned to OTHER profiles
          6. Return first video from final ordered pool

        Returns dict with full video record + extra fields:
            {video_id, title, channel_id, url, priority, fresh, priority_label}
        Returns None if no videos available.
        """
        # Step 1: load enabled videos
        all_videos = self._load_enabled_videos()
        if not all_videos:
            self._logger.warning("[Profile %s] No enabled videos in DB", profile_id[:8])
            return None

        # Step 2: remove 24h-watched videos
        watched_ids = self._history.get_watched_in_window(profile_id, self._dedup_hours)
        fresh_pool = [v for v in all_videos if v["video_id"] not in watched_ids]

        if not fresh_pool:
            # Spec says 24h dedup is non-negotiable.
            # Return None — caller must wait or move to next profile.
            # Do NOT re-serve recently watched videos.
            self._logger.warning(
                "[Profile %s] All %d videos watched in 24h window — pool exhausted, returning None",
                profile_id[:8], len(all_videos),
            )
            return None
        is_fresh = True

        # Step 3 + 4: priority-tiered + profile-seeded Fisher-Yates shuffle
        ordered = self._priority_shuffle(fresh_pool, profile_id)

        # Step 5: soft-demote recently-assigned-to-other-profiles videos
        overlap_ids = self._overlap.get_recently_assigned(exclude_profile=profile_id)
        if overlap_ids:
            primary   = [v for v in ordered if v["video_id"] not in overlap_ids]
            secondary = [v for v in ordered if v["video_id"] in overlap_ids]
            ordered   = primary + secondary

        # Step 6: pick first
        chosen = ordered[0]
        try:
            pri_int = int(chosen.get("priority", 5))
        except (TypeError, ValueError):
            pri_int = 5  # guard against non-numeric priority in videos.json
        pri_label = PRIORITY_LABELS.get(pri_int, "normal")
        # is_fresh=True — fresh_pool was non-empty (all watched_ids already filtered out)
        fresh_label = "yes"

        self._logger.info(
            "Profile %s -> Assigned Video %s | title=%r | priority: %s | fresh: %s | pool=%d/%d",
            profile_id[:8],
            chosen["video_id"],
            chosen.get("title", "")[:40],
            pri_label,
            fresh_label,
            len(fresh_pool),
            len(all_videos),
        )

        # Record in overlap store
        self._overlap.mark_assigned(profile_id, chosen["video_id"])

        return {
            **chosen,
            "fresh":          True,   # always True here — pool was non-empty
            "priority_label": pri_label,
        }

    def mark_watched(
        self,
        profile_id: str,
        video_id: str,
        details: dict,
    ) -> dict:
        """
        Record a completed watch session in watch_history.json.

        Parameters
        ----------
        profile_id : Multilogin profile UUID.
        video_id   : YouTube video ID.
        details    : {title, watch_time_sec, liked, commented, subscribed}

        Returns the stored entry.
        """
        entry = self._history.add_entry(profile_id, video_id, details)
        self._logger.info(
            "Marked watched | profile=%s video=%s watch=%ds liked=%s commented=%s subscribed=%s",
            profile_id[:8],
            video_id,
            entry["watch_time_sec"],
            entry["liked"],
            entry["commented"],
            entry["subscribed"],
        )
        return entry

    def get_watch_history(self, profile_id: str, last_n: int = 50) -> list[dict]:
        """
        Return last N watch entries for a profile (most recent first).
        """
        return self._history.get_history(profile_id, last_n)

    def clear_old_history(self, hours: float = 24.0) -> int:
        """
        Delete entries older than `hours` from ALL profiles.
        Returns total count of deleted entries.
        """
        deleted = self._history.clear_old_entries(hours)
        self._logger.info(
            "History cleanup | removed=%d entries older than %gh", deleted, hours
        )
        return deleted

    def get_fresh_pool(self, profile_id: str) -> list[dict]:
        """
        Return all videos NOT watched by this profile in the last 24h,
        sorted by priority then shuffled within tier.

        Useful for dashboard display / analytics.
        """
        all_videos = self._load_enabled_videos()
        watched_ids = self._history.get_watched_in_window(profile_id, self._dedup_hours)
        fresh = [v for v in all_videos if v["video_id"] not in watched_ids]
        return self._priority_shuffle(fresh, profile_id)

    def get_pool_stats(self, profile_id: str) -> dict:
        """
        Return pool statistics for a profile.
        Useful for monitoring / dashboard.
        """
        all_videos  = self._load_enabled_videos()
        watched_ids = self._history.get_watched_in_window(profile_id, self._dedup_hours)
        fresh       = [v for v in all_videos if v["video_id"] not in watched_ids]
        return {
            "profile_id":      profile_id,
            "total_videos":    len(all_videos),
            "watched_24h":     len(watched_ids),
            "fresh_available": len(fresh),
            "dedup_hours":     self._dedup_hours,
        }

    # ── Internal helpers ───────────────────────────────────────────────────

    def _load_enabled_videos(self) -> list[dict]:
        """
        Load enabled videos from data/videos.json.
        Returns raw (unsorted) list — sorting happens in _priority_shuffle().
        """
        data = _load_json(self._videos_path, {"videos": []})
        return [
            v for v in data.get("videos", [])
            if v.get("enabled", True)
        ]

    def _priority_shuffle(self, videos: list[dict], profile_id: str) -> list[dict]:
        """
        Sort by priority asc, then Fisher-Yates shuffle WITHIN each priority tier.
        Same profile_id → same seed → deterministic order per tier.

        Priority 1 (critical) always before priority 5 (low).
        Within same priority → profile-seeded random order.
        """
        if not videos:
            return []

        # Group by priority — guard against non-numeric priority values in DB
        groups: dict[int, list[dict]] = {}
        for v in videos:
            try:
                pri = int(v.get("priority", 5))
            except (TypeError, ValueError):
                pri = 5  # treat corrupt/string priority as lowest
            groups.setdefault(pri, []).append(v)

        seed = _profile_seed(profile_id)
        result = []

        for pri in sorted(groups.keys()):  # 1 first, higher later
            tier = groups[pri]
            # Multiply-add mixing: better seed separation than XOR with small int.
            # seed ^ 1, seed ^ 2 differ by only 1–3 bits (weak).
            # seed * 31 + pri * 1_000_003 spreads the entropy properly.
            tier_seed = (seed * 31 + pri * 1_000_003) & 0x7FFFFFFF
            rng = random.Random(tier_seed)
            _fisher_yates(tier, rng)
            result.extend(tier)

        return result


# ── Convenience: Orchestrator integration helper ───────────────────────────────

def get_engine() -> ProfileShuffleEngine:
    """
    Factory — returns a new ProfileShuffleEngine with default paths.

    NOTE: This is NOT a singleton. Each call creates a new instance.
    For production use, create ONE engine per Orchestrator and reuse it
    (e.g. self._profile_shuffle = ProfileShuffleEngine() in __init__).
    Creating multiple engines is safe but wastes memory.
    """
    return ProfileShuffleEngine()


# ── CLI quick test ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("T2-03 Shuffle Engine — Quick Test")
    print("=" * 60)

    engine = ProfileShuffleEngine()

    # Test profiles (from jobs.json)
    test_profiles = [
        "c58a40dc-d6ff-4234-8d26-a592804d32ea",
        "eae1a9ea-b399-4e68-919b-b2edc4fae5de",
        "7f3c8a12-1234-5678-abcd-ef0987654321",
    ]

    print("\n[1] Pool stats before assignment:")
    for pid in test_profiles[:2]:
        stats = engine.get_pool_stats(pid)
        print(f"  Profile {pid[:8]}: total={stats['total_videos']} "
              f"fresh={stats['fresh_available']} watched_24h={stats['watched_24h']}")

    print("\n[2] get_next_video() for each profile:")
    for pid in test_profiles[:2]:
        video = engine.get_next_video(pid)
        if video:
            print(f"  Profile {pid[:8]} -> {video['video_id']} "
                  f"| priority={video.get('priority_label')} "
                  f"| fresh={video.get('fresh')}")
        else:
            print(f"  Profile {pid[:8]} -> No video available (DB empty?)")

    print("\n[3] Overlap check — same profiles again:")
    for pid in test_profiles[:2]:
        video = engine.get_next_video(pid)
        if video:
            print(f"  Profile {pid[:8]} -> {video['video_id']} (should differ from above)")

    print("\n[4] History cleanup:")
    deleted = engine.clear_old_history(hours=24)
    print(f"  Deleted {deleted} old entries")

    print("\nDone. Check logs/shuffle_engine.log for full output.")
