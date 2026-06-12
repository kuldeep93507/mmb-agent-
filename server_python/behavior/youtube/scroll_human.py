"""
Human-like scroll — SHA-256 curves, incremental steps, smooth return to player.

No window.scrollTo(0) teleport — scroll back in small eased chunks until
#movie_player sits near the top of the viewport (below YT header).
"""
from __future__ import annotations

import asyncio
import json
import math
import random
from typing import Any, Callable, Optional

_PLAYER_GAP_JS = """
(() => {
  const p = document.querySelector('#movie_player')
       || document.querySelector('ytd-watch-flexy #player')
       || document.querySelector('ytd-player');
  if (!p) return JSON.stringify({ ok: false, reason: 'no_player' });
  const r = p.getBoundingClientRect();
  const targetTop = 68;
  const gap = r.top - targetTop;
  return JSON.stringify({
    ok: true,
    gap: Math.round(gap),
    playerVisible: r.bottom > 40 && r.top < window.innerHeight * 0.85
  });
})()
"""


async def _eval_json(tab: Any, js: str, timeout: float = 5.0) -> dict:
    try:
        raw = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout,
        )
        val = getattr(raw, "value", raw)
        if isinstance(val, str):
            return json.loads(val)
        if isinstance(val, dict):
            return val
    except Exception:
        pass
    return {}


async def read_player_gap(tab: Any) -> Optional[int]:
    """
    gap = player.getBoundingClientRect().top - 68 (ideal top offset).
    Positive gap → player sits low in viewport → scroll page down (positive scrollBy).
    Negative gap → player scrolled off top → scroll page up (negative scrollBy).
  """
    data = await _eval_json(tab, _PLAYER_GAP_JS)
    if not data.get("ok"):
        return None
    return int(data.get("gap", 0))


async def is_player_in_view(tab: Any) -> bool:
    """True when #movie_player is in the primary watch zone."""
    data = await _eval_json(tab, _PLAYER_GAP_JS)
    if not data.get("ok"):
        return False
    if not data.get("playerVisible"):
        return False
    return abs(int(data.get("gap", 0))) <= 45


def _curve_ease(t: float, curve_id: str) -> float:
    """Map 0..1 progress to eased fraction — varies per session curve_id."""
    mode = (sum(ord(c) for c in (curve_id or "default")) % 4)
    if mode == 0:
        return t * t * (3.0 - 2.0 * t)
    if mode == 1:
        return 1.0 - (1.0 - t) ** 2.2
    if mode == 2:
        return t ** 1.8
    return (1.0 - math.cos(t * math.pi)) / 2.0


async def human_curve_scroll(
    tab: Any,
    total_px: int,
    rng: random.Random,
    *,
    curve_id: str = "",
) -> bool:
    """Scroll total_px in many small curved wheel steps — never one straight jump."""
    if not total_px:
        return True
    steps = rng.randint(6, 14)
    remaining = float(total_px)
    prev_ease = 0.0
    for i in range(steps):
        t = (i + 1) / steps
        ease = _curve_ease(t, curve_id)
        step = int(total_px * (ease - prev_ease))
        prev_ease = ease
        if i == steps - 1:
            step = int(round(remaining))
        else:
            step = max(-abs(total_px), min(abs(total_px), step))
        remaining -= step
        if step:
            await smooth_scroll_by(tab, step, rng, natural=True, curve_id=curve_id)
            await asyncio.sleep(rng.uniform(0.05, 0.16))
    return True


def _scroll_move_for_gap(gap: int, rng: random.Random) -> int:
    """Convert player gap to scrollBy delta (clamped human-sized step)."""
    move = int(gap * rng.uniform(0.30, 0.55))
    if abs(move) < 16:
        move = 16 if gap > 0 else -16 if gap < 0 else 0
    return max(-150, min(150, move))


async def smooth_scroll_by(
    tab: Any,
    px: int,
    rng: random.Random,
    *,
    natural: bool = True,
    curve_id: str = "",
) -> bool:
    """
    Incremental eased scroll.

    DETECTION FIX (2026): primary path now uses CDP **real mouseWheel events**
    (isTrusted=true) — fires genuine `wheel` events like a real mouse/trackpad.
    window.scrollBy() moves the page WITHOUT any wheel event, which is a bot
    signal (and was inconsistent with our CDP clicks). CDP wheel keeps clicks +
    scroll BOTH real. Falls back to the JS step-loop only if CDP is unavailable.
    """
    if not px:
        return True
    # ── Primary: real CDP wheel events ──────────────────────────────────────
    try:
        from server_python.cdp_mouse import cdp_scroll
        mx = getattr(tab, "_mmb_mouse_x", 640.0)
        my = getattr(tab, "_mmb_mouse_y", 360.0)
        # Prefer wheel over the player so YouTube actually scrolls the page.
        try:
            center = await _eval_json(tab, """
            (() => {
              const p = document.querySelector('#movie_player')
                   || document.querySelector('ytd-watch-flexy #player');
              if (!p) return null;
              const r = p.getBoundingClientRect();
              return JSON.stringify({
                x: Math.round(r.left + r.width * 0.5),
                y: Math.round(Math.min(r.bottom - 24, r.top + r.height * 0.45))
              });
            })()
            """)
            if center.get("x") and center.get("y"):
                mx = float(center["x"])
                my = float(center["y"])
                tab._mmb_mouse_x = mx
                tab._mmb_mouse_y = my
        except Exception:
            pass
        if await cdp_scroll(tab, float(px), rng, x=mx, y=my):
            await asyncio.sleep(rng.uniform(0.12, 0.35))
            return True
    except Exception:
        pass
    # ── Fallback: JS scrollBy (only if CDP wheel failed) ────────────────────
    try:
        if natural:
            steps = rng.randint(6, 12)
            remaining = float(px)
            prev_ease = 0.0
            for i in range(steps):
                t = (i + 1) / steps
                ease = _curve_ease(t, curve_id)
                step = int(px * (ease - prev_ease))
                prev_ease = ease
                if i == steps - 1:
                    step = int(round(remaining))
                else:
                    step = max(-abs(px), min(abs(px), step))
                    remaining -= step
                if step:
                    await tab.evaluate(
                        f"window.scrollBy({{ top: {step}, behavior: 'auto' }})",
                        return_by_value=True,
                    )
                await asyncio.sleep(rng.uniform(0.045, 0.14))
        else:
            await tab.evaluate(
                f"window.scrollBy({{ top: {px}, behavior: 'smooth' }})",
                return_by_value=True,
            )
            await asyncio.sleep(rng.uniform(0.25, 0.55))
        await asyncio.sleep(rng.uniform(0.12, 0.35))
        return True
    except Exception:
        return False


async def scroll_back_to_player(
    tab: Any,
    rng: random.Random,
    *,
    max_steps: int = 14,
    log_fn: Optional[Callable[[str], None]] = None,
    curve_id: str = "",
) -> bool:
    """
    Gradually scroll until the player is back in the primary watch zone.
    Replaces scrollTo(0) teleport.
    """
    _log = log_fn or (lambda _m: None)
    for step_i in range(max_steps):
        gap = await read_player_gap(tab)
        if gap is None:
            return False
        if abs(gap) <= 28:
            return True
        move = _scroll_move_for_gap(gap, rng)
        if not move:
            return True
        await smooth_scroll_by(tab, move, rng, curve_id=curve_id)
        await asyncio.sleep(rng.uniform(0.20, 0.48))
        if step_i == max_steps - 1:
            _log("[Scroll] return-to-player: max steps — final micro adjust")
            gap2 = await read_player_gap(tab)
            if gap2 is not None and abs(gap2) > 36:
                await smooth_scroll_by(
                    tab, max(-90, min(90, _scroll_move_for_gap(gap2, rng))), rng,
                    curve_id=curve_id,
                )
    return True


async def scroll_toward_element(
    tab: Any,
    selector: str,
    rng: random.Random,
    *,
    block: str = "center",
) -> bool:
    """Smooth approach to an element (comments, description) — not instant jump."""
    blk = json.dumps(block)
    parts = [s.strip() for s in selector.split(",") if s.strip()]
    sel_js = " || ".join(
        f"document.querySelector({json.dumps(p)})" for p in parts
    ) or "null"
    try:
        await tab.evaluate(
            f"""
            (() => {{
              const el = {sel_js};
              if (!el) return false;
              el.scrollIntoView({{ behavior: 'smooth', block: {blk}, inline: 'nearest' }});
              return true;
            }})()
            """,
            return_by_value=True,
        )
        await asyncio.sleep(rng.uniform(0.7, 1.6))
        return True
    except Exception:
        return False
