"""
Fleet engagement helpers — map Fleet UI config → per-agent engagement payloads.
"""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent.parent
_CHANNELS_FILE = _ROOT / "channels_data.json"
if not _CHANNELS_FILE.exists():
    _CHANNELS_FILE = _ROOT / "data" / "channels.json"

def _load_disabled() -> set[str]:
    try:
        from server_python.traffic_source_control import disabled_from_settings
        return disabled_from_settings(json.loads(_SETTINGS_FILE.read_text(encoding="utf-8")))
    except Exception:
        return set()


_SETTINGS_FILE = _ROOT / "user-settings.json"


def traffic_to_source(traffic_raw: str, rng: random.Random | None = None) -> str:
    from server_python.traffic_source_control import resolve_source
    r = rng or random
    disabled = _load_disabled()
    resolved, _note = resolve_source(traffic_raw, disabled, r)
    return resolved


def per_profile_traffic_to_source(
    traffic_raw: str,
    rng: random.Random | None = None,
) -> str:
    return traffic_to_source(traffic_raw, rng)


def fleet_keys_to_actions(
    keys: set[str],
    *,
    quality: str = "auto",
    vol_min: int = 60,
    vol_max: int = 80,
    comment_text: str = "",
    smart_comment: bool = True,
) -> dict[str, Any]:
    lo = max(0, min(int(vol_min), int(vol_max)))
    hi = max(lo, max(int(vol_min), int(vol_max)))
    vol_pct = random.randint(lo, hi) if hi > lo else lo
    q = (quality or "auto").strip()
    quality_on = "quality" in keys or (q.lower() not in ("", "auto"))
    adskip = "adskip" in keys if keys else True
    return {
        "like": "like" in keys,
        "dislike": "dislike" in keys,
        "subscribe": "sub" in keys,
        "bell": "bell" in keys,
        "comment": "comment" in keys,
        "commentText": "" if smart_comment else (comment_text or ""),
        "useAiComment": bool(smart_comment),
        "descriptionExpand": "desc" in keys,
        "descriptionLinks": "links" in keys,
        "captionsEnabled": "captions" in keys,
        "captionsToggle": "captions" in keys,
        "seekEnabled": "seek" in keys,
        "adSkipEnabled": adskip,
        "qualityChange": quality_on,
        "qualityChangeEnabled": quality_on,
        "videoQuality": q,
        "volumePct": vol_pct,
        "volumeMin": lo,
        "volumeMax": hi,
        "naturalScrollCurves": True,
        "scrollActivity": True,
        "scroll": True,
        "gmailLoggedIn": True,
    }


def load_comment_templates(comments_file: Path) -> list[str]:
    try:
        if not comments_file.exists():
            return []
        raw = json.loads(comments_file.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            items = raw
        elif isinstance(raw, dict):
            items = raw.get("comments") or raw.get("templates") or []
        else:
            items = []
        out: list[str] = []
        for item in items:
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
            elif isinstance(item, dict):
                t = str(item.get("text") or "").strip()
                if t:
                    out.append(t)
        return out
    except Exception:
        return []


def resolve_video_pool(
    manual_links: list[str],
    channel_ids: list[str] | None,
    channels_path: Path,
) -> list[dict[str, str]]:
    videos: list[dict[str, str]] = []
    seen: set[str] = set()

    def _add(url: str, title: str = "", channel: str = "") -> None:
        u = (url or "").strip()
        if not u or u in seen:
            return
        seen.add(u)
        videos.append({"url": u, "title": title or "", "channelName": channel or ""})

    for link in manual_links or []:
        _add(str(link).strip())

    if not channel_ids:
        return videos

    try:
        if channels_path.exists():
            data = json.loads(channels_path.read_text(encoding="utf-8"))
        else:
            data = {}
        vlist = data.get("videos") or []
        clist = data.get("channels") or []
        cname: dict[str, str] = {}
        for c in clist:
            cid = str(c.get("id") or c.get("channelId") or c.get("channel_id") or "")
            if cid:
                cname[cid] = str(c.get("channel_name") or c.get("name") or c.get("title") or cid)
        want = {str(x) for x in channel_ids}
        for v in vlist:
            cid = str(v.get("channel_id") or v.get("channelId") or "")
            if cid not in want:
                continue
            url = str(v.get("url") or "").strip()
            if not url and v.get("video_id"):
                url = f"https://www.youtube.com/watch?v={v['video_id']}"
            _add(url, str(v.get("title") or ""), cname.get(cid, ""))
    except Exception:
        pass
    return videos


def assign_profile_videos(
    profile_ids: list[str],
    pool: list[dict[str, str]],
    assign_mode: str,
    rng: random.Random | None = None,
) -> dict[str, list[dict[str, str]]]:
    r = rng or random
    if not pool or not profile_ids:
        return {pid: [] for pid in profile_ids}
    mode = (assign_mode or "shuffle").strip().lower()
    out: dict[str, list[dict[str, str]]] = {}
    if mode == "same":
        pick = pool[0]
        for pid in profile_ids:
            out[pid] = [dict(pick)]
    elif mode in ("roundrobin", "round-robin"):
        for i, pid in enumerate(profile_ids):
            out[pid] = [dict(pool[i % len(pool)])]
    else:
        for pid in profile_ids:
            out[pid] = [dict(r.choice(pool))]
    return out
