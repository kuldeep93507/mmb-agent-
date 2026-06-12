"""
Per-profile YouTube search keywords — SHA-256 seeded, never video_id / URL.

Seed chain (aligned with session_behavior.py):
  SHA256(profile_id | video_id | YYYY-MM-DD [| session_nonce])

Same profile + same video + same day → same keyword order (consistent).
Different profile OR different day → different keywords (natural diversity).
"""
from __future__ import annotations

import hashlib
import json
import logging
import random
import re
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

log = logging.getLogger("mmb.search_keywords")

_YT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")
_URLISH_RE = re.compile(r"https?://|youtube\.com|youtu\.be|/watch\?v=", re.I)
_VIDEO_ID_IN_URL = re.compile(
    r"(?:[?&]v=|youtu\.be/|/shorts/)([a-zA-Z0-9_-]{11})"
)

_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "this", "that", "my", "your",
    "how", "what", "why", "when", "where", "who", "vs", "ft", "feat",
    "official", "video", "full", "hd", "4k", "new", "latest",
})

# Persona patterns — 3+ title words; no bare 2-word generic CPC-style queries
_QUERY_PATTERNS: tuple[str, ...] = (
    "{w1} {w2} {w3}",
    "how to {w1} {w2} {w3}",
    "{w1} {w2} tutorial",
    "{w1} {w2} explained",
    "{w1} {w2} tips",
    "best {w1} {w2} {w3}",
    "{w1} {w2} guide",
    "{w1} {w2} hindi",
    "learn {w1} {w2}",
    "{w1} {w2} for beginners",
    "why {w1} {w2} {w3}",
    "{w1} {w2} review",
    "{w1} {w2} {w3} tricks",
)

# Modifiers alone (without title words) = rejected as generic/high-CPC noise
_GENERIC_MODIFIERS = frozenset({
    "best", "quick", "easy", "simple", "learn", "how", "tips", "guide",
    "tutorial", "review", "tricks", "explained", "beginners", "why",
    "hindi", "2024", "2025", "2026",
})

_VIEWER_MODIFIERS: tuple[str, ...] = (
    "", "", "",  # often no modifier — natural
    "easy",
    "quick",
    "simple",
    "best",
    "2024",
    "2025",
    "2026",
)


def extract_video_id(url_or_id: str) -> str:
    s = (url_or_id or "").strip()
    if _YT_ID_RE.match(s):
        return s
    m = _VIDEO_ID_IN_URL.search(s)
    return m.group(1) if m else ""


def is_invalid_search_text(text: str) -> bool:
    t = (text or "").strip()
    if not t or len(t) < 3:
        return True
    if _YT_ID_RE.match(t):
        return True
    if _URLISH_RE.search(t):
        return True
    low = t.lower()
    if low in ("video", "youtube", "youtu.be", "watch"):
        return True
    return False


def clean_search_text(text: str, max_len: int = 48) -> str:
    cleaned = re.sub(r'[|"\'`~!@#$%^&*(){}\[\]<>/\\;:+=]', " ", text or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rsplit(" ", 1)[0]
    return cleaned


def title_words(title: str) -> list[str]:
    raw = clean_search_text(title, max_len=120).lower()
    words = [w for w in raw.split() if len(w) > 2 and w not in _STOPWORDS]
    return words[:12]


def keyword_seed_hex(
    profile_id: str,
    video_id: str,
    session_nonce: str = "",
) -> str:
    today = date.today().isoformat()
    raw = f"{profile_id}|{video_id}|{today}"
    if session_nonce:
        raw += f"|{session_nonce}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_profile_search_pool(
    profile_id: str,
    video_id: str,
    title: str,
    channel: str = "",
    *,
    session_nonce: str = "",
    max_keywords: int = 6,
) -> list[str]:
    """
    Deterministic per-profile keyword list — diverse, no video_id, no URL.
    """
    seed_hex = keyword_seed_hex(profile_id, video_id, session_nonce)
    rng = random.Random(int(seed_hex[:8], 16))

    title_clean = clean_search_text(title) if not is_invalid_search_text(title) else ""
    channel_clean = clean_search_text(channel) if not is_invalid_search_text(channel) else ""

    words = title_words(title_clean) if title_clean else []
    if not words and channel_clean:
        words = title_words(channel_clean)

    if len(words) < 2:
        # Last resort: channel name words only — never video_id
        if channel_clean:
            return [channel_clean[:40]]
        return []

    pool: list[str] = []
    seen: set[str] = set()

    def _add(kw: str) -> None:
        k = clean_search_text(kw)
        if not k or is_invalid_search_text(k):
            return
        if not validate_search_keyword(k, title_clean, channel_clean):
            return
        kl = k.lower()
        if kl in seen:
            return
        seen.add(kl)
        pool.append(k)

    # 1) SHA-256 picks unique 3-word windows from title (per profile)
    for i in range(min(5, len(words))):
        off = int(seed_hex[2 + i * 2 : 4 + i * 2], 16)
        start = off % max(1, len(words) - 2)
        chunk = words[start : start + 3]
        if len(chunk) >= 3:
            _add(" ".join(chunk))
        elif len(chunk) >= 2 and len(words) < 3:
            _add(" ".join(chunk))

    # 2) Persona-style patterns with title words (not generic channel templates)
    patterns = list(_QUERY_PATTERNS)
    rng.shuffle(patterns)
    for pat in patterns[:5]:
        if len(words) < 2:
            break
        w1 = words[int(seed_hex[12:14], 16) % len(words)]
        w2 = words[int(seed_hex[14:16], 16) % len(words)]
        w3 = words[int(seed_hex[16:18], 16) % len(words)] if len(words) > 2 else w2
        mod = _VIEWER_MODIFIERS[int(seed_hex[18:20], 16) % len(_VIEWER_MODIFIERS)]
        try:
            kw = pat.format(w1=w1, w2=w2, w3=w3).strip()
            if mod and rng.random() < 0.35:
                kw = f"{mod} {kw}".strip()
            _add(kw)
        except Exception:
            pass

    # 3) Optional: title + channel (once) — not "channel latest video"
    if channel_clean and title_clean and rng.random() < 0.4:
        _add(f"{words[0]} {channel_clean.split()[0]}")

    rng.shuffle(pool[1:]) if len(pool) > 2 else None
    return pool[:max_keywords]


def normalize_exact_query(text: str, max_len: int = 100) -> str:
    """Full title/channel for exact-match fallback searches (less truncation)."""
    cleaned = re.sub(r'[|"\'`~!@#$%^&*(){}\[\]<>/\\;:+=]', " ", text or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rsplit(" ", 1)[0]
    return cleaned


def exact_match_fallback_keywords(title: str, channel: str = "") -> list[str]:
    """
    Last-resort keywords after persona pool fails:
      1) exact video title
      2) title + channel name
    """
    out: list[str] = []
    seen: set[str] = set()

    def _add(kw: str) -> None:
        k = normalize_exact_query(kw)
        if not k or len(k) < 3 or is_invalid_search_text(k):
            return
        kl = k.lower()
        if kl in seen:
            return
        seen.add(kl)
        out.append(k)

    title_n = normalize_exact_query(title)
    channel_n = normalize_exact_query(channel, max_len=60)
    if title_n and not is_invalid_search_text(title_n):
        _add(title_n)
    if title_n and channel_n and not is_invalid_search_text(channel_n):
        _add(f"{title_n} {channel_n}")
    elif channel_n and not title_n and not is_invalid_search_text(channel_n):
        _add(channel_n)
    return out


def build_search_attempt_plan(
    profile_id: str,
    video_id: str,
    title: str,
    channel: str = "",
    *,
    session_nonce: str = "",
) -> tuple[list[str], list[str]]:
    """
    (persona_keywords, exact_fallback_keywords)
    Persona first — exact title / title+channel only when caller uses fallbacks.
    All keywords verified title-related before return (project-wide rule).
    """
    primary_raw = build_profile_search_pool(
        profile_id, video_id, title, channel, session_nonce=session_nonce,
    )
    fallbacks_raw = exact_match_fallback_keywords(title, channel)
    primary = filter_keyword_pool(primary_raw, title, channel)
    fallbacks = filter_keyword_pool(
        fallbacks_raw, title, channel, allow_exact_title=True,
    )
    primary_lower = {k.lower() for k in primary}
    fallbacks = [f for f in fallbacks if f.lower() not in primary_lower]
    return primary, fallbacks


def title_word_hits(keyword: str, video_title: str) -> int:
    """How many meaningful title words appear in the keyword."""
    words = title_words(video_title)
    if not words:
        return 0
    k_low = keyword.lower()
    return sum(1 for w in words if len(w) > 2 and w in k_low)


def validate_search_keyword(
    keyword: str,
    video_title: str,
    channel_name: str = "",
    *,
    allow_exact_title: bool = False,
) -> bool:
    """
    Project-wide rule: every search keyword must relate to the video title.
    Rejects 2-word generic CPC-style queries, URLs, video IDs, and unrelated AI junk.
    """
    max_len = 100 if allow_exact_title else 48
    k = clean_search_text(keyword, max_len=max_len)
    if not k or is_invalid_search_text(k):
        return False

    title_clean = clean_search_text(video_title, max_len=120)
    channel_clean = clean_search_text(channel_name, max_len=60) if channel_name else ""

    if allow_exact_title and not is_invalid_search_text(title_clean):
        norm_t = normalize_exact_query(title_clean).lower()
        if k.lower() == norm_t:
            return True
        if channel_clean and not is_invalid_search_text(channel_clean):
            combo = f"{norm_t} {channel_clean.lower()}".strip()
            if k.lower() == combo:
                return True

    if is_invalid_search_text(title_clean):
        if channel_clean and channel_clean.lower() in k.lower():
            return len(k.split()) >= 2
        return False

    parts = [p for p in k.lower().split() if p]
    title_w = title_words(title_clean)
    min_words = 3 if len(title_w) >= 3 else 2
    if len(parts) < min_words:
        return False

    hits = title_word_hits(k, title_clean)
    if hits < 1:
        return False

    content_words = [p for p in parts if p not in _GENERIC_MODIFIERS and p not in _STOPWORDS]
    if len(content_words) < 2:
        return False

    # Need 2+ title words OR a 4+ word query with at least 1 title anchor
    if hits < 2 and len(parts) < 4:
        return False

    # Reject repeated tokens (e.g. "bank bank usa")
    if len(parts) != len(set(parts)):
        return False

    return True


def validate_ai_search_keyword(keyword: str, video_title: str, channel_name: str = "") -> bool:
    """Alias — AI keywords must pass the same title-related rules as persona keywords."""
    return validate_search_keyword(keyword, video_title, channel_name)


def filter_keyword_pool(
    keywords: list[str],
    video_title: str,
    channel_name: str = "",
    *,
    allow_exact_title: bool = False,
) -> list[str]:
    """Dedupe + verify — used by engagement, shuffle, fleet, future agent (via entropy)."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in keywords or []:
        k = clean_search_text(
            raw,
            max_len=100 if allow_exact_title else 48,
        )
        if not k:
            continue
        kl = k.lower()
        if kl in seen:
            continue
        if not validate_search_keyword(
            k, video_title, channel_name, allow_exact_title=allow_exact_title,
        ):
            log.debug("keyword rejected (not title-related): %r", k)
            continue
        seen.add(kl)
        out.append(k)
    return out


def verify_keyword_pool(
    keywords: list[str],
    video_title: str,
    channel_name: str = "",
    *,
    allow_exact_title: bool = False,
) -> dict[str, Any]:
    """Post-build audit — returns ok/rejected lists for logging."""
    ok: list[str] = []
    rejected: list[str] = []
    for raw in keywords or []:
        k = clean_search_text(raw, max_len=100 if allow_exact_title else 48)
        if not k:
            rejected.append(str(raw))
            continue
        if validate_search_keyword(
            k, video_title, channel_name, allow_exact_title=allow_exact_title,
        ):
            ok.append(k)
        else:
            rejected.append(k)
    return {
        "total": len(keywords or []),
        "ok": len(ok),
        "valid": ok,
        "rejected": rejected,
        "passed": len(rejected) == 0,
    }


def primary_search_keyword(
    profile_id: str,
    video_id: str,
    title: str,
    channel: str = "",
    *,
    session_nonce: str = "",
) -> str:
    primary, fallbacks = build_search_attempt_plan(
        profile_id, video_id, title, channel, session_nonce=session_nonce,
    )
    if primary:
        return primary[0]
    if fallbacks:
        return fallbacks[0]
    tc = clean_search_text(title)
    if tc and not is_invalid_search_text(tc):
        words = title_words(tc)
        candidate = " ".join(words[:4]) if len(words) >= 3 else " ".join(words)
        if validate_search_keyword(candidate, title, channel, allow_exact_title=True):
            return candidate
    return ""


def fetch_oembed_metadata(url: str) -> dict[str, str]:
    """YouTube oEmbed — no API key. Returns {title, channelName}."""
    try:
        q = urllib.parse.quote(url.strip(), safe="")
        req_url = f"https://www.youtube.com/oembed?url={q}&format=json"
        req = urllib.request.Request(req_url, headers={"User-Agent": "MMB-Agent/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {
            "title": str(data.get("title") or "").strip(),
            "channelName": str(data.get("author_name") or "").strip(),
        }
    except Exception as e:
        log.debug("oEmbed failed for %s: %s", url[:60], e)
        return {}


def lookup_channels_db(
    url: str,
    channels_path: Path,
) -> dict[str, str]:
    vid = extract_video_id(url)
    if not vid or not channels_path.exists():
        return {}
    try:
        data = json.loads(channels_path.read_text(encoding="utf-8"))
        clist = data.get("channels") or []
        vlist = data.get("videos") or []
        cname: dict[str, str] = {}
        for c in clist:
            cid = str(c.get("id") or c.get("channelId") or c.get("channel_id") or "")
            if cid:
                cname[cid] = str(
                    c.get("channel_name") or c.get("name") or c.get("title") or ""
                )
        for v in vlist:
            v_id = str(v.get("video_id") or extract_video_id(str(v.get("url") or "")))
            if v_id != vid:
                continue
            cid = str(v.get("channel_id") or v.get("channelId") or "")
            return {
                "title": str(v.get("title") or "").strip(),
                "channelName": cname.get(cid, str(v.get("channel_name") or "")),
            }
    except Exception:
        pass
    return {}


def enrich_video_entry(
    entry: dict[str, Any],
    channels_path: Path,
    *,
    use_oembed: bool = True,
) -> dict[str, str]:
    """Fill missing title/channelName — never put URL or video_id in search fields."""
    url = str(entry.get("url") or "").strip()
    title = str(entry.get("title") or "").strip()
    channel = str(entry.get("channelName") or entry.get("channel") or "").strip()

    if is_invalid_search_text(title):
        title = ""
    if is_invalid_search_text(channel):
        channel = ""

    if (not title or not channel) and url:
        db = lookup_channels_db(url, channels_path)
        title = title or db.get("title", "")
        channel = channel or db.get("channelName", "")

    if not title and url and use_oembed:
        oem = fetch_oembed_metadata(url)
        title = title or oem.get("title", "")
        channel = channel or oem.get("channelName", "")

    return {
        "url": url,
        "title": clean_search_text(title) if title else "",
        "channelName": clean_search_text(channel) if channel else "",
    }


def enrich_video_pool(
    pool: list[dict[str, Any]],
    channels_path: Path,
) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in pool or []:
        if isinstance(item, str):
            item = {"url": item, "title": "", "channelName": ""}
        enriched = enrich_video_entry(item, channels_path)
        if enriched.get("url"):
            out.append(enriched)
    return out
