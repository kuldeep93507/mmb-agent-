"""
behavior.youtube.scroll_activity — Plans human-like scroll activity during watch.
"""
from __future__ import annotations
import asyncio
import random
from dataclasses import dataclass
from typing import Any, Callable, List, Optional


@dataclass
class ScrollActivity:
    """A single planned scroll event."""
    name: str       # e.g. "idle_scroll"
    at_time: float  # seconds into watch when this fires


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

        # Build the activity plan
        self.activities: List[ScrollActivity] = []
        self.completed: List[str] = []

        if enabled and watch_secs > 30:
            self._build_plan(watch_secs)

    # ------------------------------------------------------------------
    # Public properties
    # ------------------------------------------------------------------

    @property
    def planned_count(self) -> int:
        return len(self.activities)

    # ------------------------------------------------------------------
    # Plan builder
    # ------------------------------------------------------------------

    def _build_plan(self, watch_secs: float) -> None:
        """Generate 1-3 scroll events spaced across the watch window."""
        # Avoid first 15s (setup) and last 10s
        earliest = 15.0
        latest = max(earliest + 10, watch_secs - 10.0)
        if latest <= earliest:
            return

        # Number of scroll breaks: 1 for short videos, up to 3 for long ones
        n = 1
        if watch_secs > 120:
            n = 2
        if watch_secs > 300:
            n = self._rng.randint(2, 3)

        # Space them out evenly with jitter
        segment = (latest - earliest) / n
        t = earliest
        for i in range(n):
            jitter = self._rng.uniform(0, segment * 0.6)
            fire_at = t + jitter
            if fire_at > latest:
                fire_at = latest
            self.activities.append(ScrollActivity(name="idle_scroll", at_time=fire_at))
            t += segment

    # ------------------------------------------------------------------
    # Tick (called every watch loop iteration)
    # ------------------------------------------------------------------

    async def tick_and_run(self, tab: Any, elapsed: float, guardian: Any) -> bool:
        """
        Check if any planned scroll is due. Execute it and return True if fired.
        Should be called once per watch-loop chunk.
        """
        if not self._enabled:
            return False

        fired = False
        for activity in self.activities:
            if activity.name in self.completed:
                continue
            if elapsed >= activity.at_time:
                ok = await self._run_scroll(tab, activity)
                self.completed.append(activity.name)
                if ok:
                    self._log(
                        f"[ScrollActivity] {activity.name} @ {elapsed:.0f}s "
                        f"(planned {activity.at_time:.0f}s)"
                    )
                    fired = True
        return fired

    # ------------------------------------------------------------------
    # Scroll executor
    # ------------------------------------------------------------------

    async def _run_scroll(self, tab: Any, activity: ScrollActivity) -> bool:
        """Execute a natural scroll sequence."""
        try:
            direction = "down" if self._rng.random() < 0.75 else "up"
            px = self._rng.randint(80, 350)

            # Scroll in JS — smooth, human-like
            scroll_js = f"""
            (() => {{
                var delta = {px if direction == 'down' else -px};
                window.scrollBy({{ top: delta, behavior: 'smooth' }});
                return true;
            }})()
            """
            await tab.evaluate(scroll_js, return_by_value=True)
            await asyncio.sleep(self._rng.uniform(0.8, 2.5))
            return True
        except Exception as e:
            self._log(f"[ScrollActivity] scroll error: {e}")
            return False

    # ------------------------------------------------------------------
    # Legacy helpers (kept for any old call sites)
    # ------------------------------------------------------------------

    def next_scroll_px(self) -> int:
        direction = 1 if self._rng.random() < 0.75 else -1
        amount = self._rng.randint(80, 350)
        return direction * amount

    def next_wait_seconds(self) -> float:
        return self._rng.uniform(8.0, 30.0)
