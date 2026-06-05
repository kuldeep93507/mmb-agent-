"""
SessionBehaviorPlan — SHA-256 unique human activity per profile + session + video.

Seed chain (like clientSeed):
  SHA256(profile_id | session_nonce | video_id)

Har profile ka alag timing/pattern — 20 profiles same video pe bhi same pattern nahi.
Har session (naya job) pe bhi naya pattern.
"""

from __future__ import annotations

import hashlib
import random
import time
from dataclasses import dataclass, field


def _pct(seed: str, offset: int, lo: float, hi: float) -> float:
    b = int(seed[offset : offset + 2], 16)
    return lo + (b / 255.0) * (hi - lo)


def _int(seed: str, offset: int, lo: int, hi: int) -> int:
    b = int(seed[offset : offset + 2], 16)
    return lo + (b * (hi - lo)) // 255


_DEFAULT_ACTION_ORDER: tuple[str, ...] = (
    "pause", "seek", "like", "dislike", "desc", "desc_link",
    "subscribe", "bell", "comment", "comment_like",
)


@dataclass
class SessionBehaviorPlan:
    """All engagement + human-activity knobs derived from SHA-256 seed."""

    profile_id: str
    video_id: str
    session_nonce: str
    seed_hex: str
    fingerprint: str
    rng: random.Random = field(repr=False)

    # Timing as fraction of total watch_secs (each uses different seed bytes)
    pause_at_pct: float = 0.25
    like_at_pct: float = 0.30
    dislike_at_pct: float = 0.28
    sub_at_pct: float = 0.58
    bell_after_sub_sec: float = 3.5
    desc_at_pct: float = 0.42
    desc_link_after_sec: float = 5.0
    seek_at_pct: float = 0.48
    comment_at_pct: float = 0.78
    comment_like_at_pct: float = 0.90

    pause_hold_sec: float = 18.0
    seek_seconds: int = 15
    seek_dir: str = "backward"  # forward | backward | mixed

    scroll_prob: float = 0.22
    mouse_prob: float = 0.18
    chunk_lo: float = 8.0
    chunk_hi: float = 22.0

    desc_dwell_lo: float = 1.5
    desc_dwell_hi: float = 3.2
    comment_dwell_lo: float = 1.5
    comment_dwell_hi: float = 3.5
    comment_like_scroll_px: int = 380

    mouse_start_x: float = 500.0
    mouse_start_y: float = 340.0

    # Order when multiple actions fire same tick (profile-unique shuffle)
    action_order: tuple[str, ...] = _DEFAULT_ACTION_ORDER

    @classmethod
    def create(
        cls,
        profile_id: str,
        video_id: str,
        session_nonce: str | None = None,
    ) -> "SessionBehaviorPlan":
        nonce = session_nonce or str(int(time.time() * 1000))
        raw = f"{profile_id}|{nonce}|{video_id or 'none'}"
        seed = hashlib.sha256(raw.encode()).hexdigest()
        rng = random.Random(int(seed[:16], 16))

        # Spread action times across video — different byte offsets per action
        like_pct = _pct(seed, 0, 0.14, 0.42)
        dislike_pct = _pct(seed, 2, 0.16, 0.44)
        if abs(like_pct - dislike_pct) < 0.04:
            dislike_pct = min(0.48, dislike_pct + 0.06)

        order = list(_DEFAULT_ACTION_ORDER)
        rng.shuffle(order)

        plan = cls(
            profile_id=profile_id,
            video_id=video_id or "",
            session_nonce=nonce,
            seed_hex=seed,
            fingerprint=seed[:8],
            rng=rng,
            pause_at_pct=_pct(seed, 4, 0.18, 0.38),
            like_at_pct=like_pct,
            dislike_at_pct=dislike_pct,
            sub_at_pct=_pct(seed, 6, 0.46, 0.74),
            bell_after_sub_sec=_pct(seed, 8, 2.0, 7.5),
            desc_at_pct=_pct(seed, 10, 0.28, 0.58),
            desc_link_after_sec=_pct(seed, 12, 2.5, 9.0),
            seek_at_pct=_pct(seed, 14, 0.30, 0.65),
            comment_at_pct=_pct(seed, 16, 0.68, 0.92),
            comment_like_at_pct=_pct(seed, 18, 0.82, 0.97),
            pause_hold_sec=_pct(seed, 20, 12.0, 28.0),
            seek_seconds=_int(seed, 22, 10, 20),
            seek_dir=("forward", "backward", "mixed")[_int(seed, 24, 0, 2)],
            scroll_prob=_pct(seed, 26, 0.10, 0.38),
            mouse_prob=_pct(seed, 28, 0.12, 0.35),
            chunk_lo=_pct(seed, 30, 6.0, 12.0),
            chunk_hi=_pct(seed, 32, 16.0, 26.0),
            desc_dwell_lo=_pct(seed, 34, 1.0, 2.0),
            desc_dwell_hi=_pct(seed, 36, 2.5, 4.5),
            comment_dwell_lo=_pct(seed, 38, 1.2, 2.2),
            comment_dwell_hi=_pct(seed, 40, 2.8, 4.8),
            comment_like_scroll_px=_int(seed, 42, 250, 520),
            mouse_start_x=float(_int(seed, 44, 320, 780)),
            mouse_start_y=float(_int(seed, 46, 200, 480)),
            action_order=tuple(order),
        )
        if plan.chunk_hi <= plan.chunk_lo:
            plan.chunk_hi = plan.chunk_lo + 6.0
        return plan

    def abs_timings(self, watch_secs: float) -> dict[str, float]:
        """Convert pct timings to absolute seconds for this watch duration."""
        w = max(60.0, watch_secs)
        return {
            "pause_at": w * self.pause_at_pct,
            "like_at": w * self.like_at_pct,
            "dislike_at": w * self.dislike_at_pct,
            "sub_at": w * self.sub_at_pct,
            "bell_at": w * self.sub_at_pct + self.bell_after_sub_sec,
            "desc_at": w * self.desc_at_pct,
            "desc_link_at": w * self.desc_at_pct + self.desc_link_after_sec,
            "seek_at": max(40.0, w * self.seek_at_pct),
            "comment_at": w * self.comment_at_pct,
            "comment_like_at": w * self.comment_like_at_pct,
        }

    def summary_line(self) -> str:
        return (
            f"[Behavior] fp={self.fingerprint} "
            f"like@{self.like_at_pct:.0%} sub@{self.sub_at_pct:.0%} "
            f"pause@{self.pause_at_pct:.0%} seek@{self.seek_at_pct:.0%} "
            f"scroll={self.scroll_prob:.0%} mouse={self.mouse_prob:.0%}"
        )
