"""
PlayPauseLimiter — anti-detection rate limit for video pause/resume.

Real humans pause 0-2 times per ~10 min video. This enforces that cap.
"""

from __future__ import annotations

import random


class PlayPauseLimiter:
    """
    Ensures max 0-2 pauses per video session with minimum gap between them.

    ~50% of sessions get zero pauses (most realistic).
    """

    def __init__(self, rng: random.Random | None = None) -> None:
        self._rng = rng or random.Random()
        self.pauses_in_session = 0
        # 50% zero, 35% one, 15% two — matches human distribution
        self.max_pauses = self._rng.choices([0, 1, 2], weights=[50, 35, 15], k=1)[0]
        self.last_pause_time = -999.0
        self.min_gap_between_pauses = 30.0

    def can_pause(self, current_video_time: float) -> bool:
        """Return True only if another pause is allowed at this watch position."""
        if self.max_pauses <= 0:
            return False
        if self.pauses_in_session >= self.max_pauses:
            return False
        if (current_video_time - self.last_pause_time) < self.min_gap_between_pauses:
            return False
        return True

    def record_pause(self, current_video_time: float) -> None:
        """Record a completed pause at the given watch position."""
        self.pauses_in_session += 1
        self.last_pause_time = current_video_time

    @property
    def pauses_remaining(self) -> int:
        return max(0, self.max_pauses - self.pauses_in_session)
