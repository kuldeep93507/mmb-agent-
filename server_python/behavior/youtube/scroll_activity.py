"""
behavior.youtube.scroll_activity — SHA-256 planned scroll during watch.

Uses SessionBehaviorPlan.scroll_events (0–4 per session) + smooth_scroll_by.
"""
from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, TYPE_CHECKING

from server_python.behavior.youtube.scroll_human import (
    read_player_gap,
    scroll_back_to_player,
    smooth_scroll_by,
)

if TYPE_CHECKING:
    from server_python.session_behavior import SessionBehaviorPlan


@dataclass
class ScrollActivity:
    """A single planned scroll event."""
    name: str
    at_time: float
    delta_px: int = 0
    index: int = field(default=0)


class ScrollActivityPlanner:
    """
    Executes SHA-planned scroll events during watch.
    Returns True from tick_and_run when a scroll fired (caller may set scrolled_away).
    """

    def __init__(
        self,
        watch_secs: float = 120.0,
        behavior: Optional["SessionBehaviorPlan"] = None,
        rng: Optional[random.Random] = None,
        enabled: bool = True,
        log_fn: Optional[Callable] = None,
    ):
        self._behavior = behavior
        self._rng = (behavior.rng if behavior else None) or rng or random.Random()
        self._enabled = enabled
        self._log = log_fn or (lambda msg: None)
        self._watch_secs = watch_secs
        self.activities: List[ScrollActivity] = []
        self._completed_keys: set[int] = set()

        if enabled and watch_secs > 30 and behavior and behavior.scroll_events:
            for i, ev in enumerate(behavior.scroll_events):
                self.activities.append(ScrollActivity(
                    name=ev.kind,
                    at_time=max(12.0, min(watch_secs - 8.0, watch_secs * ev.at_pct)),
                    delta_px=ev.delta_px,
                    index=i,
                ))

    @property
    def planned_count(self) -> int:
        return len(self.activities)

    @property
    def completed(self) -> List[str]:
        return [a.name for a in self.activities if a.index in self._completed_keys]

    async def tick_and_run(self, tab: Any, elapsed: float, guardian: Any) -> bool:
        if not self._enabled:
            return False

        fired = False
        for activity in self.activities:
            if activity.index in self._completed_keys:
                continue
            if elapsed >= activity.at_time:
                ok = await self._run_scroll(tab, activity)
                self._completed_keys.add(activity.index)
                if ok:
                    self._log(
                        f"[ScrollCurve] {activity.name}#{activity.index} "
                        f"Δ{activity.delta_px:+d}px @ {elapsed:.0f}s "
                        f"(curve={getattr(self._behavior, 'scroll_curve_id', '?')})"
                    )
                fired = True
        return fired

    async def _run_scroll(self, tab: Any, activity: ScrollActivity) -> bool:
        try:
            px = activity.delta_px
            max_below = getattr(self._behavior, "max_scroll_below_player", 220)
            if px > 0:
                px = min(px, 90)
                gap = await read_player_gap(tab)
                if gap is not None and gap < -max_below * 0.35:
                    px = min(px, 35)
            curve_id = getattr(self._behavior, "scroll_curve_id", "") or ""
            await smooth_scroll_by(tab, px, self._rng, natural=True, curve_id=curve_id)
            await asyncio.sleep(self._rng.uniform(0.35, 1.0))
            if px > 28:
                await scroll_back_to_player(
                    tab, self._rng, log_fn=self._log, max_steps=18, curve_id=curve_id,
                )
            return True
        except asyncio.TimeoutError:
            self._log("[ScrollCurve] scroll timeout")
            return False
        except Exception as e:
            self._log(f"[ScrollCurve] scroll error: {e}")
            return False
