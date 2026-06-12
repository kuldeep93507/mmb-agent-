"""
behavior.youtube.scroll_activity — Plans human-like scroll activity during watch.

FIXED:
  ✅ completed list mein activity naam save hota tha — agar 2+ activities
     same naam hain (e.g. "idle_scroll") to sirf pehli chalti thi, baaki skip.
     Fix: ab completed set mein index-based unique key store hota hai.
  ✅ tab.evaluate() wrapped with asyncio.wait_for timeout.
"""
from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

@dataclass
class ScrollActivity:
    """A single planned scroll event."""
    name: str        # e.g. "idle_scroll"
    at_time: float   # seconds into watch when this fires
    index: int = field(default=0)  # FIX: unique index so same-named activities all run


class ScrollActivityPlanner:
    """
    Plans and executes human-like scroll events during a video watch session.

    Usage in agent_manager:
        planner = ScrollActivityPlanner(watch_secs, rng, enabled=True, log_fn=...)
        # in loop:
        if await planner.tick_and_run(tab, elapsed, guardian): ...
    """

    def __init__(
        self,
        watch_secs: float = 120.0,
        rng: Optional[random.Random] = None,
        enabled: bool = True,
        log_fn: Optional[Callable] = None,
    ):
        self._rng = rng or random.Random()
        self._enabled = enabled
        self._log = log_fn or (lambda msg: None)
        self._watch_secs = watch_secs

        self.activities: List[ScrollActivity] = []
        # FIX: Use set of unique keys (index-based), not name-based
        self._completed_keys: set[int] = set()

        if enabled and watch_secs > 30:
            self._build_plan(watch_secs)

    # ------------------------------------------------------------------
    # Public properties
    # ------------------------------------------------------------------

    @property
    def planned_count(self) -> int:
        return len(self.activities)

    @property
    def completed(self) -> List[str]:
        """Legacy compat — returns list of completed activity names."""
        return [a.name for a in self.activities if a.index in self._completed_keys]

    # ------------------------------------------------------------------
    # Plan builder
    # ------------------------------------------------------------------

    def _build_plan(self, watch_secs: float) -> None:
        """Generate 1-3 scroll events spaced across the watch window."""
        earliest = 15.0
        latest = max(earliest + 10, watch_secs - 10.0)
        if latest <= earliest:
            return

        # Number of scroll breaks based on video length
        n = 1
        if watch_secs > 120:
            n = 2
        if watch_secs > 300:
            n = self._rng.randint(2, 3)

        segment = (latest - earliest) / n
        t = earliest
        for i in range(n):
            jitter = self._rng.uniform(0, segment * 0.6)
            fire_at = min(t + jitter, latest)
            # FIX: each activity gets unique index — same name can fire multiple times
            self.activities.append(ScrollActivity(
                name="idle_scroll",
                at_time=fire_at,
                index=i
            ))
            t += segment

    # ------------------------------------------------------------------
    # Tick (called every watch loop iteration)
    # ------------------------------------------------------------------

    async def tick_and_run(self, tab: Any, elapsed: float, guardian: Any) -> bool:
        """
        Check if any planned scroll is due. Execute it and return True if fired.
        FIX: Uses index-based tracking — all activities with same name will fire.
        """
        if not self._enabled:
            return False

        fired = False
        for activity in self.activities:
            # FIX: check by unique index, not name
            if activity.index in self._completed_keys:
                continue
            if elapsed >= activity.at_time:
                ok = await self._run_scroll(tab, activity)
                self._completed_keys.add(activity.index)
                if ok:
                    self._log(
                        f"[ScrollActivity] {activity.name}#{activity.index} "
                        f"@ {elapsed:.0f}s (planned {activity.at_time:.0f}s)"
                    )
                fired = True
        return fired

    # ------------------------------------------------------------------
    # Scroll executor
    # ------------------------------------------------------------------

    async def _run_scroll(self, tab: Any, activity: ScrollActivity) -> bool:
        """Execute a natural scroll sequence with timeout protection."""
        try:
            direction = "down" if self._rng.random() < 0.75 else "up"
            px = self._rng.randint(80, 350)
            delta = px if direction == "down" else -px

            scroll_js = f"""
            (() => {{
                window.scrollBy({{ top: {delta}, behavior: 'smooth' }});
                return true;
            }})()
            """
            # FIX: timeout so a hung tab doesn't block the watch loop
            await asyncio.wait_for(
                tab.evaluate(scroll_js, return_by_value=True),
                timeout=5.0
            )
            await asyncio.sleep(self._rng.uniform(0.8, 2.5))
            return True
        except asyncio.TimeoutError:
            self._log(f"[ScrollActivity] scroll timeout (tab unresponsive)")
            return False
        except Exception as e:
            self._log(f"[ScrollActivity] scroll error: {e}")
            return False

    # ------------------------------------------------------------------
    # Legacy helpers
    # ------------------------------------------------------------------

    def next_scroll_px(self) -> int:
        direction = 1 if self._rng.random() < 0.75 else -1
        amount = self._rng.randint(80, 350)
        return direction * amount

    def next_wait_seconds(self) -> float:
        return self._rng.uniform(8.0, 30.0)
