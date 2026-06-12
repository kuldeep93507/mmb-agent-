"""
Global traffic-source enable/disable — temporary operator toggles in user-settings.json.

disabledTrafficSources: ["google", "bing", ...]

Enforced everywhere: engagement, shuffle, fleet, future agent, worker mix %.
"""
from __future__ import annotations

import logging
import random
from typing import Any

log = logging.getLogger("mmb.traffic_sources")

# Canonical backend source ids
ALL_SOURCE_IDS: tuple[str, ...] = (
    "search",
    "google",
    "bing",
    "notification",
    "homepage",
    "channel_discovery",
    "direct",
    "suggested",
    "backlinks",
)

SOURCE_LABELS: dict[str, str] = {
    "search": "YouTube Search",
    "google": "Google Search",
    "bing": "Bing Search",
    "notification": "Notification",
    "homepage": "Homepage Browse",
    "channel_discovery": "Channel Discovery",
    "direct": "Direct URL",
    "suggested": "Suggested / Sidebar",
    "backlinks": "Backlinks",
}

# UI / fleet label → canonical id
_LABEL_TO_ID: dict[str, str] = {
    "youtube search": "search",
    "yt search": "search",
    "search": "search",
    "direct": "direct",
    "direct url": "direct",
    "google": "google",
    "google search": "google",
    "bing": "bing",
    "bing search": "bing",
    "channel page": "channel_discovery",
    "channel discovery": "channel_discovery",
    "channel_discovery": "channel_discovery",
    "notification": "notification",
    "homepage": "homepage",
    "homepage browse": "homepage",
    "suggested": "suggested",
    "backlinks": "backlinks",
    "custom": "search",
    "random": "random",
}

_RANDOM_POOL = ("search", "google", "bing", "channel_discovery")


def normalize_source_id(raw: str) -> str:
    t = (raw or "").strip().lower()
    if t.startswith("🎲") or t == "random":
        return "random"
    if t in _LABEL_TO_ID:
        return _LABEL_TO_ID[t]
    if t.replace("-", "_") in ALL_SOURCE_IDS:
        return t.replace("-", "_")
    if t.replace("_", "-") in ALL_SOURCE_IDS:
        return t.replace("_", "-")
    return t or "search"


def disabled_from_settings(settings: dict[str, Any] | None) -> set[str]:
    raw = (settings or {}).get("disabledTrafficSources") or []
    if not isinstance(raw, list):
        return set()
    out: set[str] = set()
    for item in raw:
        sid = normalize_source_id(str(item))
        if sid != "random" and sid in ALL_SOURCE_IDS:
            out.add(sid)
    return out


def is_source_enabled(source_id: str, disabled: set[str]) -> bool:
    sid = normalize_source_id(source_id)
    if sid == "random":
        return True
    return sid not in disabled


def list_sources_status(disabled: set[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sid in ALL_SOURCE_IDS:
        rows.append({
            "id": sid,
            "label": SOURCE_LABELS.get(sid, sid),
            "enabled": sid not in disabled,
        })
    return rows


def _fallback_enabled(disabled: set[str], rng: random.Random) -> str:
    for pool in (_RANDOM_POOL, ("search", "homepage", "notification", "direct")):
        enabled = [s for s in pool if s not in disabled]
        if enabled:
            return rng.choice(enabled)
    return "direct"


def resolve_source(
    requested: str,
    disabled: set[str],
    rng: random.Random | None = None,
) -> tuple[str, str | None]:
    """
    Return (canonical_source, warning_or_none).
    Disabled explicit sources fall back to a random enabled source.
    """
    r = rng or random.Random()
    sid = normalize_source_id(requested)

    if sid == "random":
        resolved = _fallback_enabled(disabled, r)
        return resolved, None

    if is_source_enabled(sid, disabled):
        return sid, None

    fallback = _fallback_enabled(disabled, r)
    note = f"Traffic source '{sid}' is temporarily disabled — using '{fallback}'"
    log.info("[Traffic] %s", note)
    return fallback, note


def pick_from_mix_percentages(
    config: dict[str, Any],
    disabled: set[str],
    rng: random.Random,
) -> str:
    """Worker engagement random mix — skips globally disabled sources."""
    buckets: list[tuple[str, int]] = [
        ("notification", int(config.get("srcNotificationPct", 20))),
        ("search", int(config.get("srcSearchPct", 30))),
        ("homepage", int(config.get("srcHomepagePct", 20))),
        ("google", int(config.get("srcGooglePct", 12))),
        ("bing", int(config.get("srcBingPct", 8))),
        ("channel_discovery", int(config.get("srcChannelDiscPct", 10))),
    ]
    active: list[tuple[str, int]] = []
    for name, pct in buckets:
        pct = max(0, min(100, pct))
        if pct <= 0 or name in disabled:
            continue
        active.append((name, pct))

    if not active:
        return _fallback_enabled(disabled, rng)

    total = sum(p for _, p in active)
    roll = rng.randint(1, max(1, total))
    cursor = 0
    for name, pct in active:
        cursor += pct
        if roll <= cursor:
            return name
    return active[-1][0]
