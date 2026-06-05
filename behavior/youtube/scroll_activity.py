"""
Human scroll activity during video watch — anti-detection behavior (Bug #4).

Sprinkles realistic scroll/read/hover patterns and always returns to the player.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from dataclasses import dataclass
from typing import Any, Callable, Awaitable

from behavior.youtube.anti_detect import move_mouse_bezier
from behavior.youtube.safe_actions import safe_click, safe_eval_js
from behavior.youtube.selectors import DESKTOP
from behavior.youtube.state import get_all_chapters

log = logging.getLogger("mmb.scroll_activity")

LogFn = Callable[[str], None]


@dataclass
class PlannedScrollActivity:
    """One scheduled scroll activity at a specific watch offset."""

    name: str
    at_time: float
    done: bool = False
    requires_chapters: bool = False


async def _smooth_scroll_by(tab: Any, delta: int, *, action_name: str) -> None:
    await safe_eval_js(
        tab,
        f"window.scrollBy({{top: {delta}, behavior: 'smooth'}})",
        action_name=action_name,
        wrap=False,
    )


async def scroll_back_to_player(tab: Any) -> None:
    """Scroll player back into view after reading below the fold."""
    await safe_eval_js(
        tab,
        """
        var p = document.querySelector('#movie_player, ytd-watch-flexy');
        if (p) p.scrollIntoView({behavior: 'smooth', block: 'center'});
        """,
        action_name="SCROLL_BACK_PLAYER",
        wrap=False,
    )
    await asyncio.sleep(0.8)


async def _hover_selector(tab: Any, selectors: tuple[str, ...], rng: random.Random) -> bool:
    """Move mouse to center of first visible element matching selectors."""
    sel_json = json.dumps(list(selectors))
    point = await safe_eval_js(
        tab,
        f"""
        var sels = {sel_json};
        for (var i = 0; i < sels.length; i++) {{
            var nodes = document.querySelectorAll(sels[i]);
            for (var j = 0; j < nodes.length; j++) {{
                var el = nodes[j];
                if (!el || !el.offsetParent) continue;
                var r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                return {{
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2)
                }};
            }}
        }}
        return null;
        """,
        action_name="SCROLL_HOVER_FIND",
        wrap=False,
        log_result=False,
    )
    if not isinstance(point, dict) or "x" not in point:
        return False
    await move_mouse_bezier(tab, float(point["x"]), float(point["y"]), rng=rng)
    await asyncio.sleep(rng.uniform(1.5, 3.5))
    return True


async def scroll_to_description_and_read(tab: Any, *, rng: random.Random) -> None:
    """Expand description, read, optional hashtag hover, optional collapse."""
    await safe_click(tab, DESKTOP["description_more_button"], action_name="SCROLL_DESC_EXPAND", timeout=3)
    await asyncio.sleep(rng.uniform(3.0, 6.0))

    if rng.random() < 0.15:
        hashtags = DESKTOP.get("hashtag_links", ())
        if hashtags:
            await _hover_selector(tab, hashtags, rng)
            await asyncio.sleep(rng.uniform(1.0, 2.5))

    if rng.random() < 0.40:
        await safe_click(tab, DESKTOP["description_less_button"], action_name="SCROLL_DESC_COLLAPSE", timeout=2)
        await asyncio.sleep(rng.uniform(0.5, 1.5))

    await scroll_back_to_player(tab)


async def scroll_to_comments_and_read(tab: Any, *, rng: random.Random) -> None:
    """Scroll to comments, read top threads, hover one, return to player."""
    await safe_eval_js(
        tab,
        """
        var section = document.querySelector('ytd-comments, #comments');
        if (section) section.scrollIntoView({behavior: 'smooth', block: 'center'});
        """,
        action_name="SCROLL_TO_COMMENTS",
        wrap=False,
    )
    await asyncio.sleep(rng.uniform(2.0, 4.5))

    for _ in range(rng.randint(2, 5)):
        delta = rng.randint(80, 200)
        await _smooth_scroll_by(tab, delta, action_name="SCROLL_COMMENTS_READ")
        await asyncio.sleep(rng.uniform(1.5, 3.5))

    threads = DESKTOP.get("comment_thread", ("ytd-comment-thread-renderer",))
    await _hover_selector(tab, threads, rng)
    await asyncio.sleep(rng.uniform(2.0, 5.0))

    await scroll_back_to_player(tab)


async def scroll_to_chapters_and_hover(tab: Any, *, rng: random.Random) -> None:
    """Scroll to chapter list and hover a card if chapters exist."""
    chapters = await get_all_chapters(tab)
    if not chapters:
        return

    section = DESKTOP.get("chapters_section_container", DESKTOP.get("chapter_item_card", ()))
    await safe_eval_js(
        tab,
        f"""
        var sels = {json.dumps(list(section))};
        for (var i = 0; i < sels.length; i++) {{
            var el = document.querySelector(sels[i]);
            if (el && el.offsetParent) {{
                el.scrollIntoView({{behavior: 'smooth', block: 'center'}});
                return true;
            }}
        }}
        return false;
        """,
        action_name="SCROLL_TO_CHAPTERS",
        wrap=False,
    )
    await asyncio.sleep(rng.uniform(1.5, 3.0))

    cards = DESKTOP.get("chapter_item_card", DESKTOP.get("chapter_item_link", ()))
    await _hover_selector(tab, cards, rng)
    await asyncio.sleep(rng.uniform(1.5, 3.0))
    await scroll_back_to_player(tab)


async def small_idle_scroll(tab: Any, *, rng: random.Random) -> None:
    """Small up/down scroll bursts — most common human behavior."""
    for _ in range(rng.randint(2, 4)):
        delta = rng.randint(-150, 150)
        await _smooth_scroll_by(tab, delta, action_name="SCROLL_IDLE")
        await asyncio.sleep(rng.uniform(1.5, 3.0))
    await scroll_back_to_player(tab)


_ACTION_RUNNERS: dict[str, Callable[..., Awaitable[None]]] = {
    "read_description": scroll_to_description_and_read,
    "read_comments": scroll_to_comments_and_read,
    "check_chapters": scroll_to_chapters_and_hover,
    "idle_scroll": small_idle_scroll,
}


def human_scroll_activity_plan(
    video_duration: float,
    rng: random.Random,
    *,
    enabled: bool = True,
) -> list[PlannedScrollActivity]:
    """
    Plan 1-3 realistic scroll activities spread across the watch session.

    Args:
        video_duration: Planned watch seconds (caps activity windows).
        rng: Session RNG for reproducible variance.
        enabled: False returns empty plan.

    Returns:
        Sorted list of planned activities.
    """
    if not enabled or video_duration < 20:
        return []

    dur = max(60.0, video_duration)
    candidates: list[PlannedScrollActivity] = []

    if rng.random() < 0.30:
        candidates.append(
            PlannedScrollActivity(
                "read_description",
                rng.uniform(15, min(45, dur * 0.25)),
            )
        )
    if rng.random() < 0.40:
        lo = min(60, dur * 0.15)
        hi = min(180, dur * 0.55)
        if hi > lo + 5:
            candidates.append(PlannedScrollActivity("read_comments", rng.uniform(lo, hi)))
    if rng.random() < 0.20:
        candidates.append(
            PlannedScrollActivity(
                "check_chapters",
                rng.uniform(20, min(60, dur * 0.3)),
                requires_chapters=True,
            )
        )
    if rng.random() < 0.60 or not candidates:
        lo = min(40, dur * 0.1)
        hi = min(120, dur * 0.45)
        candidates.append(PlannedScrollActivity("idle_scroll", rng.uniform(max(15, lo), max(lo + 5, hi))))

    # De-dupe by name (keep earliest)
    seen: set[str] = set()
    unique: list[PlannedScrollActivity] = []
    for act in sorted(candidates, key=lambda a: a.at_time):
        if act.name in seen:
            continue
        seen.add(act.name)
        unique.append(act)

    if not unique:
        unique.append(PlannedScrollActivity("idle_scroll", rng.uniform(25, min(90, dur * 0.35))))

    return unique[:3]


class ScrollActivityPlanner:
    """Executes planned scroll activities at the right watch timestamps."""

    def __init__(
        self,
        video_duration: float,
        rng: random.Random,
        *,
        enabled: bool = True,
        log_fn: LogFn | None = None,
    ) -> None:
        self._rng = rng
        self._log = log_fn or (lambda msg: log.info(msg))
        self.activities: list[PlannedScrollActivity] = human_scroll_activity_plan(
            video_duration, rng, enabled=enabled
        )
        self.completed: list[str] = []

    @property
    def planned_count(self) -> int:
        return len(self.activities)

    async def tick_and_run(self, tab: Any, elapsed: float, guardian: Any) -> bool:
        """
        Run the next due scroll activity (if any).

        Returns:
            True if an activity ran this tick.
        """
        for act in self.activities:
            if act.done or elapsed < act.at_time:
                continue

            if act.requires_chapters:
                chapters = await get_all_chapters(tab)
                if not chapters:
                    act.done = True
                    self._log(f"[ScrollActivity] skip {act.name} — no chapters")
                    continue

            runner = _ACTION_RUNNERS.get(act.name)
            if not runner:
                act.done = True
                continue

            guardian.suppress(20.0)
            self._log(f"[ScrollActivity] {act.name} @ {elapsed:.0f}s (planned {act.at_time:.0f}s)")
            scroll_y_before = await safe_eval_js(
                tab, "window.scrollY", action_name="SCROLL_Y_BEFORE", log_result=False
            )
            try:
                await runner(tab, rng=self._rng)
            except Exception as exc:
                self._log(f"[ScrollActivity] {act.name} error (non-fatal): {exc}")
            scroll_y_after = await safe_eval_js(
                tab, "window.scrollY", action_name="SCROLL_Y_AFTER", log_result=False
            )
            delta = 0.0
            try:
                delta = abs(float(scroll_y_after or 0) - float(scroll_y_before or 0))
                verified = delta >= 50
            except (TypeError, ValueError):
                verified = False
            from behavior.youtube.action_audit import ActionAudit
            audit = ActionAudit.current()
            if audit:
                audit.record(
                    f"scroll_{act.name}",
                    selector_used="scroll JS / smooth scrollBy",
                    click_registered=True,
                    verified=verified,
                    reason=f"scrollY {scroll_y_before}→{scroll_y_after} delta={delta:.0f}",
                )
            act.done = True
            self.completed.append(act.name)
            return True

        return False
