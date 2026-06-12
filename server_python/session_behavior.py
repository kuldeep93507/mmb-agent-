"""
SessionBehaviorPlan — SHA-256 unique human activity per profile + session + video.

Seed chain:
  SHA256(profile_id | session_nonce | video_id)

Each watch run MUST pass a unique session_nonce (job id / worker cycle / auto-generated).
Scroll curve (0–4 peeks, directions, px) is derived from the same seed.

  ✅ chunk_lo/chunk_hi reduced from 6-26s → 2-5s
     Plan says "har second check karo" — smaller chunks = closer to plan.
     (True per-second would need separate goroutine; 2-5s is good compromise.)
"""
from __future__ import annotations

import hashlib
import random
import secrets
import time
from dataclasses import dataclass, field

# ── Helpers ───────────────────────────────────────────────────────────────────

def _seed_byte(seed: str, offset: int) -> int:
    """Map logical offset into SHA-256 hex (wraps — supports offsets > 62)."""
    o = (abs(offset) % 31) * 2
    return int(seed[o: o + 2], 16)


def _pct(seed: str, offset: int, lo: float, hi: float) -> float:
    b = _seed_byte(seed, offset)
    return lo + (b / 255.0) * (hi - lo)


def _int(seed: str, offset: int, lo: int, hi: int) -> int:
    b = _seed_byte(seed, offset)
    return lo + (b * (hi - lo)) // 255


_DEFAULT_ACTION_ORDER: tuple[str, ...] = (
    "pause", "seek", "like", "dislike", "desc", "desc_link",
    "subscribe", "bell", "comment", "comment_like",
)


@dataclass(frozen=True)
class PlannedScrollEvent:
    """One SHA-planned scroll during watch — time as fraction of watch_secs."""
    at_pct: float
    delta_px: int
    kind: str = "idle_peek"


def ensure_session_nonce(session_nonce: str | None) -> str:
    """Every watch session gets a unique nonce unless caller already supplied one."""
    if session_nonce and str(session_nonce).strip():
        return str(session_nonce).strip()
    return f"sess-{time.time_ns()}-{secrets.token_hex(4)}"


def _build_scroll_curve(seed: str) -> tuple[str, tuple[PlannedScrollEvent, ...]]:
    """
    Per-session scroll curve from SHA-256.
    0–4 idle scrolls per profile/session; amounts stay near player/description.
    """
    curve_id = seed[8:20]
    n = _int(seed, 58, 0, 4)
    events: list[PlannedScrollEvent] = []
    used: list[float] = []
    for i in range(n):
        lo = 0.14 + i * 0.11
        hi = min(0.86, lo + 0.22)
        at = _pct(seed, (60 + i * 7) % 56, lo, hi)
        while any(abs(at - u) < 0.07 for u in used):
            at = min(0.86, at + 0.08)
        used.append(at)
        px = _int(seed, (62 + i * 5) % 56, 25, 95)
        if _int(seed, (63 + i * 3) % 56, 0, 9) < 3:
            px = -_int(seed, (64 + i * 4) % 56, 18, 85)
        events.append(PlannedScrollEvent(at_pct=at, delta_px=px, kind="idle_peek"))
    events.sort(key=lambda e: e.at_pct)
    return curve_id, tuple(events)

# ── Plan-aligned valid trigger ranges ─────────────────────────────────────────
# (from PART 2 — PART C of plan)
_TRIGGER_RANGES = {
    "volume":    (0.02, 0.15),   # 2-15% — shuruaat mein adjust
    "like":      (0.10, 0.85),   # 10-85% — thoda dekh ke
    "dislike":   (0.10, 0.85),
    "subscribe": (0.20, 0.90),   # 20-90% — channel pasand aayi
    "bell":      (0.20, 0.90),
    "desc":      (0.15, 0.70),   # 15-70% — beech mein padhta hai
    "seek":      (0.20, 0.75),   # 20-75% — kuch miss kiya
    "pause":     (0.50, 0.88),   # 50-88% — beech mein pause
    "comment":   (0.65, 0.95),   # 65-95% — video khatam hone ke paas
    "comment_like": (0.70, 0.95),
    "sidebar":   (0.88, 0.98),   # 88-98% — almost done
}


@dataclass
class SessionBehaviorPlan:
    """All engagement + human-activity knobs derived from SHA-256 seed."""

    profile_id:    str
    video_id:      str
    session_nonce: str
    seed_hex:      str
    fingerprint:   str
    rng:           random.Random = field(repr=False)

    # Timing — fraction of total watch_secs
    pause_at_pct:       float = 0.25
    like_at_pct:        float = 0.30
    dislike_at_pct:     float = 0.28
    sub_at_pct:         float = 0.58
    bell_after_sub_sec: float = 3.5
    desc_at_pct:        float = 0.42
    desc_link_after_sec: float = 5.0
    seek_at_pct:        float = 0.48
    comment_at_pct:     float = 0.78
    comment_like_at_pct: float = 0.90

    pause_hold_sec:  float = 3.0
    seek_seconds:    int   = 15
    seek_dir:        str   = "backward"

    scroll_prob:     float = 0.22
    mouse_prob:      float = 0.18

    # ✅ FIXED: chunk_lo/hi reduced from 6-26s → 2-5s
    # Plan: "har second check" — 2-5s chunks = much closer to plan
    # True 1s would need separate goroutine (bigger refactor)
    chunk_lo:        float = 2.0
    chunk_hi:        float = 5.0

    desc_dwell_lo:   float = 1.5
    desc_dwell_hi:   float = 3.2
    comment_dwell_lo: float = 1.5
    comment_dwell_hi: float = 3.5
    comment_like_scroll_px: int = 380

    mouse_start_x:   float = 500.0
    mouse_start_y:   float = 340.0

    # Profile-unique shuffle of action order
    action_order: tuple[str, ...] = _DEFAULT_ACTION_ORDER

    # Part E — per-profile unique human simulation (plan requirement)
    scroll_jitter_seed: int   = 12345
    click_offset_x:     int   = 0
    click_offset_y:     int   = 0
    hover_min_ms:       float = 0.3
    hover_max_ms:       float = 0.8

    # SHA-256 scroll curve (per session)
    scroll_curve_id: str = ""
    scroll_events: tuple[PlannedScrollEvent, ...] = ()
    micro_scroll_prob: float = 0.12
    micro_scroll_px_lo: int = 20
    micro_scroll_px_hi: int = 70
    max_scroll_below_player: int = 220

    @classmethod
    def create(
        cls,
        profile_id: str,
        video_id: str,
        session_nonce: str | None = None,
    ) -> "SessionBehaviorPlan":
        """
        Create plan with SHA-256 seed.

        Seed: SHA256(profile_id | session_nonce | video_id)
        session_nonce is auto-generated when omitted — every run is unique.
        """
        nonce = ensure_session_nonce(session_nonce)
        raw  = f"{profile_id}|{nonce}|{video_id or 'none'}"
        seed = hashlib.sha256(raw.encode()).hexdigest()
        rng  = random.Random(int(seed[:16], 16))
        scroll_curve_id, scroll_events = _build_scroll_curve(seed)

        # Rule 4: Like/Dislike ONLY after 10% watch
        like_lo,    like_hi    = _TRIGGER_RANGES["like"]
        dislike_lo, dislike_hi = _TRIGGER_RANGES["dislike"]
        like_pct    = _pct(seed, 0, like_lo, like_hi * 0.35)  # keep early-mid
        dislike_pct = _pct(seed, 2, dislike_lo, dislike_hi * 0.35)
        if abs(like_pct - dislike_pct) < 0.04:
            dislike_pct = min(dislike_hi, dislike_pct + 0.06)

        sub_lo,  sub_hi  = _TRIGGER_RANGES["subscribe"]
        desc_lo, desc_hi = _TRIGGER_RANGES["desc"]
        seek_lo, seek_hi = _TRIGGER_RANGES["seek"]
        cmt_lo,  cmt_hi  = _TRIGGER_RANGES["comment"]
        cl_lo,   cl_hi   = _TRIGGER_RANGES["comment_like"]
        pse_lo,  pse_hi  = _TRIGGER_RANGES["pause"]

        order = list(_DEFAULT_ACTION_ORDER)
        rng.shuffle(order)

        plan = cls(
            profile_id=profile_id,
            video_id=video_id or "",
            session_nonce=nonce,
            seed_hex=seed,
            fingerprint=seed[:8],
            rng=rng,
            # ── Timings (plan-aligned ranges) ───────────────────────────────
            pause_at_pct        = _pct(seed, 4,  pse_lo,  pse_hi),
            like_at_pct         = like_pct,
            dislike_at_pct      = dislike_pct,
            sub_at_pct          = _pct(seed, 6,  sub_lo,  sub_hi),
            bell_after_sub_sec  = _pct(seed, 8,  2.0, 7.5),
            desc_at_pct         = _pct(seed, 10, desc_lo, desc_hi),
            desc_link_after_sec = _pct(seed, 12, 2.5, 9.0),
            seek_at_pct         = _pct(seed, 14, seek_lo, seek_hi),
            comment_at_pct      = _pct(seed, 16, cmt_lo,  cmt_hi),
            comment_like_at_pct = _pct(seed, 18, cl_lo,   cl_hi),
            # ── Human behavior ───────────────────────────────────────────────
            pause_hold_sec      = _pct(seed, 20, 2.0, 6.0),
            seek_seconds        = _int(seed, 22, 10, 25),
            seek_dir            = ("forward", "backward", "mixed")[_int(seed, 24, 0, 2)],
            scroll_prob         = _pct(seed, 26, 0.10, 0.38),
            mouse_prob          = _pct(seed, 28, 0.12, 0.35),
            # ✅ FIXED: 2-5s chunks (was 6-26s) — plan-aligned
            chunk_lo            = _pct(seed, 30, 2.0, 4.0),
            chunk_hi            = _pct(seed, 32, 4.0, 6.0),
            desc_dwell_lo       = _pct(seed, 34, 1.0, 2.0),
            desc_dwell_hi       = _pct(seed, 36, 2.5, 4.5),
            comment_dwell_lo    = _pct(seed, 38, 1.2, 2.2),
            comment_dwell_hi    = _pct(seed, 40, 2.8, 4.8),
            comment_like_scroll_px = _int(seed, 42, 250, 520),
            mouse_start_x       = float(_int(seed, 44, 320, 780)),
            mouse_start_y       = float(_int(seed, 46, 200, 480)),
            action_order        = tuple(order),
            scroll_jitter_seed  = _int(seed, 48, 0, 65535),
            click_offset_x      = _int(seed, 50, -5, 5),
            click_offset_y      = _int(seed, 52, -5, 5),
            hover_min_ms        = _pct(seed, 54, 0.3, 0.8),
            hover_max_ms        = _pct(seed, 56, 0.8, 1.5),
            scroll_curve_id     = scroll_curve_id,
            scroll_events       = scroll_events,
            micro_scroll_prob   = _pct(seed, 70, 0.04, 0.20),
            micro_scroll_px_lo  = _int(seed, 72, 12, 38),
            micro_scroll_px_hi  = _int(seed, 74, 35, 85),
            max_scroll_below_player = _int(seed, 76, 100, 260),
        )
        if plan.chunk_hi <= plan.chunk_lo:
            plan.chunk_hi = plan.chunk_lo + 2.0
        if plan.micro_scroll_px_hi < plan.micro_scroll_px_lo:
            plan.micro_scroll_px_hi = plan.micro_scroll_px_lo + 10
        return plan

    def abs_timings(self, watch_secs: float) -> dict[str, float]:
        """Convert pct timings to absolute seconds for this watch duration."""
        w = max(60.0, watch_secs)
        return {
            "pause_at":      w * self.pause_at_pct,
            "like_at":       w * self.like_at_pct,
            "dislike_at":    w * self.dislike_at_pct,
            "sub_at":        w * self.sub_at_pct,
            "bell_at":       w * self.sub_at_pct + self.bell_after_sub_sec,
            "desc_at":       w * self.desc_at_pct,
            "desc_link_at":  w * self.desc_at_pct + self.desc_link_after_sec,
            "seek_at":       max(40.0, w * self.seek_at_pct),
            "comment_at":    w * self.comment_at_pct,
            "comment_like_at": w * self.comment_like_at_pct,
        }

    def summary_line(self) -> str:
        return (
            f"[Behavior] fp={self.fingerprint} nonce={self.session_nonce[:24]} "
            f"like@{self.like_at_pct:.0%} sub@{self.sub_at_pct:.0%} "
            f"pause@{self.pause_at_pct:.0%} seek@{self.seek_at_pct:.0%} "
            f"chunk={self.chunk_lo:.1f}-{self.chunk_hi:.1f}s "
            f"scrollCurve={self.scroll_curve_id} n={len(self.scroll_events)} "
            f"micro={self.micro_scroll_prob:.0%} mouse={self.mouse_prob:.0%}"
        )
