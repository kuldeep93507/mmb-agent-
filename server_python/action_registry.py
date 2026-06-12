"""
MMB Agent — action status registry (single source of truth).

Used by worker_manager / main to sanitize engagement flags before watch runs.
See ACTIONS_HANDOFF.md in project root for full context for future AI/devs.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("mmb.action_registry")

# Live-verified on Multilogin — DO NOT refactor without explicit user approval.
LOCKED_WORKING: frozenset[str] = frozenset({
    "play_pause",
    "volume",
    "captions",
    "like",
    "subscribe",
    "bell",
    "comment_post",
    "seek",
})

# Verified in June 2026 session (profile c58a40dc).
# ad_skip: live PASS 2026-06-09 — SKIP VERIFIED via CDP (user eye-witnessed).
SESSION_VERIFIED: frozenset[str] = frozenset({
    "comment_like",
    "description_expand",
    "description_collapse",
    "autoplay_off",
    "dislike",
    "quality_change",
    "scroll_activity",
    "ad_skip",
})

# Disabled server-side until stable (UI shows Coming Soon).
COMING_SOON: frozenset[str] = frozenset({
    "description_links",
})

# Wired in code; live PASS not confirmed yet.
PENDING_TEST: frozenset[str] = frozenset({
    "related_video_sidebar",
    "recycle_loop",
    "speed_change",
})

_COMING_SOON_ENGAGEMENT_KEYS: dict[str, str] = {
    "description_links": "descriptionLinks",
}


def is_action_enabled(action_key: str) -> bool:
    if action_key in COMING_SOON:
        return False
    return True


def sanitize_engagement(engagement: dict[str, Any]) -> dict[str, Any]:
    """Force coming-soon flags off; never let unstable actions run in production."""
    out = dict(engagement)
    for action_key, eng_key in _COMING_SOON_ENGAGEMENT_KEYS.items():
        if out.get(eng_key):
            log.warning(
                "[ActionRegistry] %s is COMING_SOON — forced OFF (was requested ON)",
                action_key,
            )
        out[eng_key] = False
    return out


def sanitize_config(config: dict[str, Any]) -> dict[str, Any]:
    """Schedule/profile config pass-through sanitizer."""
    out = dict(config)
    if out.get("descriptionLinks"):
        log.warning("[ActionRegistry] descriptionLinks forced OFF (coming soon)")
    out["descriptionLinks"] = False
    return out
