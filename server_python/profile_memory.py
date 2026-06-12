"""
Per-profile action memory — remember channels visited, comments posted, keywords used.

Prevents robotic repetition: same profile won't leave identical comments on the
same channel or revisit patterns that look bot-like.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("mmb.profile_memory")

_MEMORY_DIR = Path(__file__).resolve().parent.parent / "data" / "profile_memory"
_MAX_COMMENTS = 200
_MAX_CHANNELS = 100
_MAX_KEYWORDS = 80


def _path(profile_id: str) -> Path:
    _MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in profile_id[:16] if c.isalnum() or c in "-_") or "unknown"
    return _MEMORY_DIR / f"{safe}.json"


def _load(profile_id: str) -> dict:
    p = _path(profile_id)
    if not p.exists():
        return _empty(profile_id)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception as e:
        log.warning("profile_memory load %s: %s", profile_id[:8], e)
    return _empty(profile_id)


def _empty(profile_id: str) -> dict:
    return {
        "profileId": profile_id,
        "channelsVisited": [],
        "commentsPosted": [],
        "keywordsUsed": [],
        "updatedAt": 0,
    }


def _save(profile_id: str, data: dict) -> None:
    data["updatedAt"] = int(time.time())
    p = _path(profile_id)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def is_enabled() -> bool:
    try:
        settings_path = Path(__file__).resolve().parent.parent / "user-settings.json"
        if settings_path.exists():
            s = json.loads(settings_path.read_text(encoding="utf-8"))
            v = s.get("aiProfileMemoryEnabled", True)
            return v is True or str(v).lower() == "true"
    except Exception:
        pass
    return True


def record_channel_visit(profile_id: str, channel_name: str, video_id: str = "") -> None:
    if not is_enabled() or not profile_id or not channel_name:
        return
    data = _load(profile_id)
    entry = {
        "channel": channel_name.strip()[:120],
        "videoId": video_id[:20],
        "ts": int(time.time()),
    }
    visits = data.get("channelsVisited") or []
    visits = [v for v in visits if not (
        v.get("channel") == entry["channel"] and v.get("videoId") == entry["videoId"]
    )]
    visits.insert(0, entry)
    data["channelsVisited"] = visits[:_MAX_CHANNELS]
    _save(profile_id, data)


def record_comment(
    profile_id: str,
    channel_name: str,
    video_title: str,
    comment_text: str,
    video_id: str = "",
) -> None:
    if not is_enabled() or not profile_id or not comment_text:
        return
    data = _load(profile_id)
    entry = {
        "channel": (channel_name or "")[:120],
        "videoTitle": (video_title or "")[:200],
        "videoId": video_id[:20],
        "text": comment_text[:300],
        "ts": int(time.time()),
    }
    comments = data.get("commentsPosted") or []
    comments.insert(0, entry)
    data["commentsPosted"] = comments[:_MAX_COMMENTS]
    _save(profile_id, data)


def record_keyword(profile_id: str, keyword: str) -> None:
    if not is_enabled() or not profile_id or not keyword:
        return
    data = _load(profile_id)
    kws = data.get("keywordsUsed") or []
    kw = keyword.strip()[:80]
    kws = [k for k in kws if k.get("keyword") != kw]
    kws.insert(0, {"keyword": kw, "ts": int(time.time())})
    data["keywordsUsed"] = kws[:_MAX_KEYWORDS]
    _save(profile_id, data)


def get_memory(profile_id: str) -> dict:
    return _load(profile_id)


def get_comment_avoidance_context(profile_id: str, channel_name: str = "") -> str:
    """Text block for AI prompt — what this profile already said."""
    if not is_enabled():
        return ""
    data = _load(profile_id)
    comments = data.get("commentsPosted") or []
    if not comments:
        return ""
    lines = []
    ch_lower = (channel_name or "").lower()
    for c in comments[:12]:
        if ch_lower and c.get("channel", "").lower() != ch_lower:
            continue
        t = c.get("text", "")
        if t:
            lines.append(f'- "{t[:80]}"')
    if not lines and comments:
        for c in comments[:5]:
            t = c.get("text", "")
            if t:
                lines.append(f'- "{t[:80]}"')
    if not lines:
        return ""
    return (
        "This profile already posted these comments (DO NOT repeat similar wording):\n"
        + "\n".join(lines)
    )


def has_recent_comment_on_channel(profile_id: str, channel_name: str, within_hours: int = 48) -> bool:
    if not is_enabled() or not channel_name:
        return False
    cutoff = int(time.time()) - within_hours * 3600
    data = _load(profile_id)
    ch = channel_name.lower()
    for c in data.get("commentsPosted") or []:
        if c.get("channel", "").lower() == ch and c.get("ts", 0) >= cutoff:
            return True
    return False


def clear_memory(profile_id: str) -> None:
    p = _path(profile_id)
    if p.exists():
        p.unlink()


def list_all_profiles() -> list[str]:
    if not _MEMORY_DIR.exists():
        return []
    return [f.stem for f in _MEMORY_DIR.glob("*.json")]
