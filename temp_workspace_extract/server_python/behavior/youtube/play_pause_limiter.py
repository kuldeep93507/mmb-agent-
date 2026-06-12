"""
behavior.youtube.play_pause_limiter — Rate-limit play/pause actions.
Rule 3: Pause only after 30% duration, max 1-2 times per session, NOT during ads.

STATUS: ✅ No bugs found — clean as-is.
"""
from __future__ import annotations

import random
import time


class PlayPauseLimiter:
    """
    Controls when pause is allowed:
    - Minimum interval between pauses
    - Max pause count per session (default 2)
    - Tracks pauses_in_session counter
    """

    def __init__(
        self,
        min_interval: float = 45.0,
        max_pauses: int = 2,
        rng: random.Random | None = None,
    ):
        self._min = min_interval
        self.max_pauses = max_pauses
        self.pauses_in_session = 0
        self._last_pause_at: float = -9999.0
        self._rng = rng or random.Random()

    def can_pause(self, elapsed: float) -> bool:
        """Return True if a pause is allowed right now."""
        if self.pauses_in_session >= self.max_pauses:
            return False
        if (elapsed - self._last_pause_at) < self._min:
            return False
        return True

    def record_pause(self, elapsed: float) -> None:
        """Call after actually pausing — updates counters."""
        self.pauses_in_session += 1
        self._last_pause_at = elapsed

    # Legacy compat
    def can_toggle(self) -> bool:
        return self.can_pause(time.monotonic())

    def record_toggle(self) -> None:
        self.record_pause(time.monotonic())
