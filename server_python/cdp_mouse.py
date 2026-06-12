"""
CDP mouse helpers — real pointer movement (Bezier) for human-like behavior.
Used by engagement watch loop + like/subscribe hover-click.
All functions fail silently / return False — callers keep JS fallbacks.
"""

from __future__ import annotations

import asyncio
import math
import random
from typing import Any


def _bezier_point(t: float, p0: float, p1: float, p2: float, p3: float) -> float:
    u = 1.0 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3


def bezier_path(
    x0: float, y0: float, x1: float, y1: float,
    steps: int, rng: random.Random,
) -> list[tuple[float, float]]:
    """Cubic Bezier with two random control points."""
    cx1 = x0 + (x1 - x0) * rng.uniform(0.2, 0.5) + rng.uniform(-80, 80)
    cy1 = y0 + (y1 - y0) * rng.uniform(0.1, 0.4) + rng.uniform(-60, 60)
    cx2 = x0 + (x1 - x0) * rng.uniform(0.5, 0.8) + rng.uniform(-80, 80)
    cy2 = y0 + (y1 - y0) * rng.uniform(0.6, 0.9) + rng.uniform(-60, 60)
    pts: list[tuple[float, float]] = []
    for i in range(1, max(2, steps) + 1):
        t = i / steps
        pts.append((
            _bezier_point(t, x0, cx1, cx2, x1),
            _bezier_point(t, y0, cy1, cy2, y1),
        ))
    return pts


async def cdp_move_to(tab: Any, x: float, y: float) -> bool:
    try:
        from nodriver import cdp
        await tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
        return True
    except Exception:
        return False


async def cdp_move_bezier(
    tab: Any,
    x0: float, y0: float, x1: float, y1: float,
    rng: random.Random,
    steps: int | None = None,
) -> bool:
    dist = math.hypot(x1 - x0, y1 - y0)
    n = steps or max(6, min(18, int(dist / 35)))
    try:
        for px, py in bezier_path(x0, y0, x1, y1, n, rng):
            if not await cdp_move_to(tab, px, py):
                return False
            await asyncio.sleep(rng.uniform(0.012, 0.035))
        return True
    except Exception:
        return False


async def cdp_scroll(
    tab: Any,
    delta_y: float,
    rng: random.Random,
    *,
    x: float = 640.0,
    y: float = 360.0,
) -> bool:
    """
    REAL human-like scroll via CDP mouseWheel events (isTrusted=true) — fires
    genuine `wheel` events, unlike window.scrollBy() which silently moves the
    page with NO wheel event (a bot signal). Sends the total delta in several
    randomized wheel "ticks" so it looks like a real mouse wheel / trackpad.
    Returns False on failure so callers can JS-fallback.
    """
    try:
        from nodriver import cdp
    except Exception:
        return False
    try:
        total = abs(float(delta_y))
        direction = 1.0 if delta_y >= 0 else -1.0
        if total < 1:
            return True
        # Variable curve: many small ticks at start, larger in middle, taper at end
        n_ticks = max(4, min(18, int(total / 28) + rng.randint(2, 5)))
        weights: list[float] = []
        for i in range(n_ticks):
            t = (i + 1) / n_ticks
            # Per-session curve shape (ease in-out with jitter)
            ease = t * t * (3.0 - 2.0 * t)
            prev = (i / n_ticks) ** 2 * (3.0 - 2.0 * (i / n_ticks)) if i else 0.0
            weights.append(max(0.04, ease - prev + rng.uniform(-0.02, 0.04)))
        wsum = sum(weights) or 1.0
        weights = [w / wsum for w in weights]
        for w in weights:
            tick = max(8.0, min(total, total * w * rng.uniform(0.85, 1.15)))
            total -= tick
            await tab.send(cdp.input_.dispatch_mouse_event(
                type_="mouseWheel",
                x=x + rng.uniform(-4, 4), y=y + rng.uniform(-4, 4),
                delta_x=rng.uniform(-1.5, 1.5) if rng.random() < 0.12 else 0.0,
                delta_y=direction * tick,
            ))
            await asyncio.sleep(rng.uniform(0.04, 0.11))
        return True
    except Exception:
        return False


async def cdp_click(tab: Any, x: float, y: float, *, modifiers: int = 0) -> bool:
    try:
        from nodriver import cdp
        await cdp_move_to(tab, x, y)
        await asyncio.sleep(0.05)
        await tab.send(cdp.input_.dispatch_mouse_event(
            type_="mousePressed", x=x, y=y,
            button=cdp.input_.MouseButton.LEFT, click_count=1,
            modifiers=modifiers,
        ))
        await asyncio.sleep(0.04)
        await tab.send(cdp.input_.dispatch_mouse_event(
            type_="mouseReleased", x=x, y=y,
            button=cdp.input_.MouseButton.LEFT, click_count=1,
            modifiers=modifiers,
        ))
        return True
    except Exception:
        return False


async def cdp_ctrl_click(tab: Any, x: float, y: float, rng: random.Random) -> bool:
    """Ctrl+click — opens link in new tab (browser default)."""
    fx = x + rng.uniform(-80, 80)
    fy = y + rng.uniform(-60, 60)
    if not await cdp_move_bezier(tab, fx, fy, x, y, rng):
        return await cdp_click(tab, x, y, modifiers=2)
    await asyncio.sleep(rng.uniform(0.25, 0.6))
    return await cdp_click(tab, x, y, modifiers=2)


async def cdp_hover_then_click(
    tab: Any,
    x: float, y: float,
    rng: random.Random,
    *,
    from_x: float | None = None,
    from_y: float | None = None,
    dwell_min: float = 0.35,
    dwell_max: float = 1.1,
) -> bool:
    """Bezier move to target, dwell (hover), then click."""
    fx = from_x if from_x is not None else x + rng.uniform(-120, 120)
    fy = from_y if from_y is not None else y + rng.uniform(-80, 80)
    if not await cdp_move_bezier(tab, fx, fy, x, y, rng):
        return await cdp_click(tab, x, y)
    await asyncio.sleep(rng.uniform(dwell_min, dwell_max))
    return await cdp_click(tab, x, y)


async def cdp_wander_player_area(
    tab: Any,
    last_x: float, last_y: float,
    rng: random.Random,
) -> tuple[float, float]:
    """
    Move within typical YouTube player / upper page area.
    Returns new (x, y) cursor position.
    """
    nx = rng.uniform(280, min(920, last_x + rng.uniform(-180, 180)))
    ny = rng.uniform(180, min(520, last_y + rng.uniform(-120, 120)))
    nx = max(120, min(1000, nx))
    ny = max(100, min(620, ny))
    ok = await cdp_move_bezier(tab, last_x, last_y, nx, ny, rng)
    if ok:
        return nx, ny
    return last_x, last_y
