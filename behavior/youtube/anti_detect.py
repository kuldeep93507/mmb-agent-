"""
Anti-detection primitives — Rules A-K from MMB Agent master prompt.

YouTube bot detection = BEHAVIOR based. Selectors safe hain, usage human hona chahiye.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Optional

from nodriver import cdp

log = logging.getLogger("mmb.anti_detect")

_rng = random.Random()

# Per-profile daily caps (Rule J) — override via config
DAILY_CAPS = {
    "likes": (20, 40),
    "subscribes": (5, 10),
    "comments": (3, 8),
    "videos_watched": (15, 30),
}


def get_rng(seed: Optional[int] = None) -> random.Random:
    """Seeded RNG per profile — consistent human variance."""
    if seed is not None:
        return random.Random(seed)
    return _rng


async def human_delay(
    min_s: float = 2.5,
    max_s: float = 7.0,
    *,
    rng: Optional[random.Random] = None,
) -> None:
    """
    Realistic inter-action delay (Rule C).

    Humans don't click like-subscribe-comment in 0.5 seconds.
    """
    r = rng or _rng
    await asyncio.sleep(r.uniform(min_s, max_s))


async def move_mouse_bezier(
    tab: Any,
    target_x: float,
    target_y: float,
    *,
    from_x: Optional[float] = None,
    from_y: Optional[float] = None,
    steps: Optional[int] = None,
    rng: Optional[random.Random] = None,
) -> bool:
    """
    Bezier curve mouse path — NOT straight line (Rule A).

    Args:
        tab: nodriver Tab.
        target_x: Destination X.
        target_y: Destination Y.
        from_x: Start X (random offset if None).
        from_y: Start Y.
        steps: Bezier steps (15-30 random if None).
        rng: Profile RNG.

    Returns:
        True if movement succeeded.
    """
    from server_python.cdp_mouse import cdp_move_bezier

    r = rng or _rng
    fx = from_x if from_x is not None else target_x + r.uniform(-150, 150)
    fy = from_y if from_y is not None else target_y + r.uniform(-100, 100)
    n = steps or r.randint(15, 30)
    return await cdp_move_bezier(tab, fx, fy, target_x, target_y, r, steps=n)


async def human_click_element(
    tab: Any,
    element: Any,
    *,
    rng: Optional[random.Random] = None,
    hover: bool = True,
) -> bool:
    """
    Human-like click — Bezier move + hesitation + CDP click (Rule A).

    NEVER use raw element.click() for YouTube engagement buttons.

    Args:
        tab: nodriver Tab.
        element: nodriver Element.
        rng: Profile-seeded random.
        hover: Dwell on target before click.

    Returns:
        True on successful click.
    """
    from server_python.cdp_mouse import cdp_hover_then_click

    r = rng or _rng
    try:
        rect = await element.get_position()
        if not rect:
            # Fallback: evaluate bounding rect
            sel = getattr(element, "selector", "") or ""
            if sel:
                raw = await tab.evaluate(
                    f"""(() => {{
                        var el = document.querySelector({json.dumps(sel)});
                        if (!el) return null;
                        var b = el.getBoundingClientRect();
                        return JSON.stringify({{x: b.left, y: b.top, w: b.width, h: b.height}});
                    }})()""",
                    return_by_value=True,
                )
                val = raw.value if hasattr(raw, "value") else raw
                if val:
                    box = json.loads(str(val))
                    rect = type("R", (), box)()

        if not rect:
            return False

        w = getattr(rect, "width", None) or rect.get("w", 0) if isinstance(rect, dict) else getattr(rect, "w", 40)
        h = getattr(rect, "height", None) or rect.get("h", 0) if isinstance(rect, dict) else getattr(rect, "h", 40)
        x = (getattr(rect, "x", 0) if not isinstance(rect, dict) else rect.get("x", 0)) + w / 2 + r.randint(-5, 5)
        y = (getattr(rect, "y", 0) if not isinstance(rect, dict) else rect.get("y", 0)) + h / 2 + r.randint(-3, 3)

        if hover:
            ok = await cdp_hover_then_click(
                tab, x, y, r,
                dwell_min=0.05,
                dwell_max=0.18,
            )
        else:
            await asyncio.sleep(r.uniform(0.05, 0.18))
            from server_python.cdp_mouse import cdp_click
            ok = await cdp_click(tab, x, y)

        return bool(ok)
    except Exception as exc:
        log.debug("human_click_element failed: %s", exc)
        return False


async def human_type_text(
    tab: Any,
    text: str,
    *,
    rng: Optional[random.Random] = None,
    typo_rate: float = 0.03,
    think_rate: float = 0.08,
) -> None:
    """
    Human-like typing — variable speed, thinking pauses, occasional typos (Rule B).

    NEVER bulk paste into comment/search boxes.

    Args:
        tab: nodriver Tab.
        text: Text to type character by character.
        rng: Profile RNG.
        typo_rate: Probability of typo per character.
        think_rate: Probability of thinking pause.
    """
    r = rng or _rng
    typo_keys = list("asdfghjkl")

    for char in text:
        # Occasional typo + backspace (very human)
        if r.random() < typo_rate:
            wrong = r.choice(typo_keys)
            await tab.send(cdp.input_.insert_text(text=wrong))
            await asyncio.sleep(r.uniform(0.1, 0.2))
            await tab.send(cdp.input_.dispatch_key_event(
                type_="keyDown", key="Backspace", code="Backspace",
                windows_virtual_key_code=8,
            ))
            await tab.send(cdp.input_.dispatch_key_event(
                type_="keyUp", key="Backspace", code="Backspace",
                windows_virtual_key_code=8,
            ))
            await asyncio.sleep(r.uniform(0.08, 0.15))

        await tab.send(cdp.input_.insert_text(text=char))

        delay = max(0.05, min(0.4, r.gauss(0.12, 0.04)))
        await asyncio.sleep(delay)

        if r.random() < think_rate:
            await asyncio.sleep(r.uniform(0.4, 1.2))


async def page_is_safe(tab: Any, *, timeout: float = 3.0) -> bool:
    """
    Pre-action page health check (Rule K).

    Returns False on captcha, logout, or missing player.

    Args:
        tab: nodriver Tab.
        timeout: Max seconds for checks.

    Returns:
        True if page is safe for automation.
    """
    try:
        result = await tab.evaluate(
            """(() => {
                var body = (document.body && document.body.innerText) || '';
                if (/unusual traffic|captcha|verify you are human/i.test(body)) return 'captcha';
                var account = document.querySelector(
                    'button[aria-label*="Account menu" i], #avatar-btn, ytd-topbar-menu-button-renderer'
                );
                if (!account) return 'logged_out';
                var player = document.querySelector('#movie_player, .html5-video-player');
                if (!player) return 'no_player';
                return 'ok';
            })()""",
            return_by_value=True,
        )
        status = result.value if hasattr(result, "value") else result
        if status != "ok":
            log.warning("page_is_safe: blocked — %s", status)
            return False
        return True
    except Exception as exc:
        log.debug("page_is_safe error: %s", exc)
        return False


def shuffle_actions(actions: list, *, rng: Optional[random.Random] = None) -> list:
    """Randomize action order per session (Rule F)."""
    r = rng or _rng
    shuffled = actions.copy()
    r.shuffle(shuffled)
    return shuffled


def should_do_action(probability: float, *, rng: Optional[random.Random] = None) -> bool:
    """
    Probabilistic action — not every video gets liked (Rule F).

    Args:
        probability: 0.0-1.0 chance to perform action.

    Returns:
        True if action should run.
    """
    r = rng or _rng
    return r.random() < probability


def random_watch_percent(
    low: float = 0.40,
    high: float = 0.95,
    *,
    rng: Optional[random.Random] = None,
) -> float:
    """
    Random watch percentage — never exact same duration (Rule D).

    Returns:
        Float 0.0-1.0 representing how much of video to watch.
    """
    r = rng or _rng
    return r.uniform(low, high)
