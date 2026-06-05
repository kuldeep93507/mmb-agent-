"""
yt_helpers.py — shared utilities for YouTube bot.
log, js, human_pause, human_mouse_move, human_scroll
"""
import asyncio, json, random, time
from nodriver import cdp

_rng = random.Random()


def log(step: str, msg: str, ok: bool = True):
    mark = "OK  " if ok else "FAIL"
    print(f"  [{mark}] {step}: {msg}")


async def js(tab, code: str):
    """Run sync JS, return Python value."""
    try:
        r = await tab.evaluate(f"(() => {{ {code} }})()", return_by_value=True)
        return r.value if hasattr(r, "value") else r
    except Exception:
        return None


async def jsjson(tab, code: str):
    """Run JS that returns JSON string, parse and return Python object."""
    raw = await js(tab, code)
    try:
        return json.loads(str(raw)) if raw is not None else None
    except Exception:
        return raw


async def human_pause(min_s: float = 1.0, max_s: float = 2.5):
    """Human-like random pause between actions."""
    await asyncio.sleep(_rng.uniform(min_s, max_s))


async def human_mouse_move(tab, moves: int = 3):
    """Simulate random mouse movements on page — not tracked by YT, feels human."""
    for _ in range(moves):
        x = _rng.randint(300, 900)
        y = _rng.randint(200, 600)
        try:
            await tab.send(cdp.input_.dispatch_mouse_event(
                "mouseMoved", x=x, y=y
            ))
        except Exception:
            pass
        await asyncio.sleep(_rng.uniform(0.1, 0.3))


async def human_scroll(tab, delta: int = 300, steps: int = 3):
    """Smooth scroll in steps — human-like."""
    per_step = delta // steps
    for _ in range(steps):
        await js(tab, f"window.scrollBy(0, {per_step});")
        await asyncio.sleep(_rng.uniform(0.15, 0.4))


async def type_human(tab, text: str):
    """Character-by-character via insert_text — React compatible, not copy-paste."""
    for char in text:
        await tab.send(cdp.input_.insert_text(text=char))
        await asyncio.sleep(max(0.06, _rng.gauss(0.11, 0.03)))


async def wait_for_video_loaded(tab, timeout: float = 15.0) -> bool:
    """Wait until video has valid duration (actually loaded)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        dur = await js(tab, "return document.querySelector('video')?.duration || 0;")
        try:
            if float(str(dur)) > 0:
                return True
        except Exception:
            pass
        await asyncio.sleep(0.8)
    return False


async def refresh_tab(browser, sleep: float = 6.0):
    await asyncio.sleep(sleep)
    try:
        return browser.tabs[0]
    except Exception:
        return None
