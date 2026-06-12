"""
Ad click + advertiser site visit — once per video when profile has adClickEnabled.

Flow: ad detected → wait 10–15s → CDP click visit-advertiser link → new tab dwell
→ close/switch back → resume YouTube playback.
"""
from __future__ import annotations

import asyncio
import json
import random
import time
from typing import Any, Callable, Optional

import logging

log = logging.getLogger("mmb.ad_click")

try:
    from nodriver import cdp as _cdp
    _NODRIVER_OK = True
except ImportError:
    _cdp = None
    _NODRIVER_OK = False

from server_python.behavior.youtube.selectors import DESKTOP
from server_python.behavior.youtube.state import is_ad_playing


def _visit_selectors() -> tuple[str, ...]:
    return tuple(dict.fromkeys(DESKTOP.get("ad_visit_advertiser_link", ())))


async def _eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    try:
        wrapped = f"JSON.stringify(({js}))"
        result = await asyncio.wait_for(
            tab.evaluate(wrapped, return_by_value=True),
            timeout=timeout,
        )
        val = getattr(result, "value", result)
        if isinstance(val, str):
            return json.loads(val)
        return val
    except Exception:
        return None


async def find_ad_click_target(tab: Any) -> Optional[dict]:
    """First visible 'Visit advertiser' / ad URL control on player."""
    sels_json = json.dumps(list(_visit_selectors()))
    raw = await _eval(tab, f"""
    (() => {{
        function pack(el, selector) {{
            var r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) return null;
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return null;
            var href = el.href || el.getAttribute('href') || '';
            if (!href && el.closest) {{
                var a = el.closest('a[href]');
                if (a) href = a.href || '';
            }}
            return {{
                selector: selector,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                href: (href || '').substring(0, 200),
                text: (el.innerText || el.getAttribute('aria-label') || '').substring(0, 48)
            }};
        }}
        var sels = {sels_json};
        for (var i = 0; i < sels.length; i++) {{
            var nodes = document.querySelectorAll(sels[i]);
            for (var n = 0; n < nodes.length; n++) {{
                var hit = pack(nodes[n], sels[i]);
                if (hit) return hit;
            }}
        }}
        var player = document.querySelector('#movie_player, .html5-video-player');
        if (player) {{
            var links = player.querySelectorAll('a[href], .ytp-visit-advertiser-link, [class*="visit-advertiser"]');
            for (var j = 0; j < links.length; j++) {{
                var hit2 = pack(links[j], 'player-ad-link');
                if (hit2) return hit2;
            }}
        }}
        return null;
    }})()
    """)
    return raw if isinstance(raw, dict) else None


async def wait_ad_click_window(
    tab: Any,
    *,
    delay_min: float,
    delay_max: float,
    timeout: float,
    log_fn: Callable[[str], None],
    rng: random.Random,
) -> Optional[dict]:
    """Wait until ad is showing + dwell 10–15s, return click target."""
    deadline = time.monotonic() + timeout
    dwell = rng.uniform(float(delay_min), float(delay_max))
    ad_seen_at: Optional[float] = None

    while time.monotonic() < deadline:
        if not await is_ad_playing(tab):
            if ad_seen_at is not None:
                log_fn("[AdClick] Ad ended before click window — skip click")
                return None
            await asyncio.sleep(0.4)
            continue

        if ad_seen_at is None:
            ad_seen_at = time.monotonic()
            log_fn(f"[AdClick] Ad detected — dwell {dwell:.1f}s before click…")

        if time.monotonic() - ad_seen_at >= dwell:
            target = await find_ad_click_target(tab)
            if target:
                return target
            log_fn("[AdClick] Dwell done but no visit-advertiser link — skip click")
            return None

        await asyncio.sleep(0.35)

    log_fn("[AdClick] Timeout waiting for ad click window")
    return None


async def cdp_click_target(
    tab: Any,
    target: dict,
    rng: random.Random,
    *,
    mouse_x: float,
    mouse_y: float,
) -> tuple[bool, float, float]:
    x = float(target.get("x", 0)) + rng.uniform(-6, 6)
    y = float(target.get("y", 0)) + rng.uniform(-4, 4)
    try:
        from server_python.cdp_mouse import cdp_hover_then_click
        if await cdp_hover_then_click(
            tab, x, y, rng,
            from_x=mouse_x, from_y=mouse_y,
            dwell_min=0.4, dwell_max=1.2,
        ):
            return True, x, y
    except Exception:
        pass
    if _NODRIVER_OK and _cdp is not None:
        try:
            await tab.send(_cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
            await asyncio.sleep(0.1)
            await tab.send(_cdp.input_.dispatch_mouse_event(
                type_="mousePressed", x=x, y=y,
                button=_cdp.input_.MouseButton.LEFT, click_count=1,
            ))
            await asyncio.sleep(0.08)
            await tab.send(_cdp.input_.dispatch_mouse_event(
                type_="mouseReleased", x=x, y=y,
                button=_cdp.input_.MouseButton.LEFT, click_count=1,
            ))
            return True, x, y
        except Exception:
            pass
    return False, mouse_x, mouse_y


async def visit_advertiser_and_return(
    browser: Any,
    youtube_tab: Any,
    *,
    visit_sec: int,
    tabs_before: int,
    log_fn: Callable[[str], None],
    rng: random.Random,
) -> bool:
    """Dwell on advertiser tab, then return to YouTube tab."""
    visit_tab = youtube_tab
    try:
        if browser:
            tabs = list(browser.tabs)
            if len(tabs) > tabs_before:
                visit_tab = tabs[-1]
                try:
                    if hasattr(visit_tab, "activate"):
                        await visit_tab.activate()
                except Exception:
                    pass
                log_fn("[AdClick] Switched to advertiser tab")
    except Exception:
        pass

    dwell = max(1, int(visit_sec))
    log_fn(f"[AdClick] Visiting advertiser site {dwell}s…")
    deadline = time.monotonic() + dwell
    while time.monotonic() < deadline:
        pause = min(rng.uniform(2.0, 5.0), deadline - time.monotonic())
        if pause <= 0:
            break
        await asyncio.sleep(pause)
        try:
            move = rng.choice(["down", "down", "up"])
            px = rng.randint(60, 180) if move != "up" else -rng.randint(40, 120)
            await visit_tab.evaluate(
                f"window.scrollBy({{ top: {px}, behavior: 'smooth' }})",
                return_by_value=True,
            )
        except Exception:
            pass

    try:
        if browser:
            tabs = list(browser.tabs)
            if len(tabs) > tabs_before:
                try:
                    await visit_tab.close()
                except Exception:
                    pass
            try:
                if hasattr(youtube_tab, "activate"):
                    await youtube_tab.activate()
            except Exception:
                pass
            log_fn("[AdClick] Closed advertiser tab — back on YouTube")
            return True
    except Exception as e:
        log_fn(f"[AdClick] Return tab note: {e}")

    try:
        await youtube_tab.get("about:blank")
    except Exception:
        pass
    return True


async def resume_youtube_playback(tab: Any, log_fn: Callable[[str], None]) -> bool:
    from server_python.behavior.youtube import desktop as yt_desktop
    from server_python.behavior.youtube.player_focus import focus_player
    from server_python.human_engine import wait_for_player

    await asyncio.sleep(1.0)
    await focus_player(tab)
    await yt_desktop.play(tab)
    ready = await wait_for_player(tab, timeout=35.0)
    if not ready:
        await focus_player(tab)
        await yt_desktop.play(tab)
        ready = await wait_for_player(tab, timeout=18.0)
    log_fn(f"[AdClick] YouTube resumed after ad visit: {ready}")
    return ready


async def try_ad_click_once_per_video(
    tab: Any,
    browser: Any,
    *,
    delay_min: float,
    delay_max: float,
    visit_sec: int,
    log_fn: Callable[[str], None],
    rng: random.Random,
    mouse_x: float = 640.0,
    mouse_y: float = 360.0,
) -> tuple[bool, str, float, float]:
    """
    One ad click attempt for this video. Returns (success, proof, mx, my).
    """
    if not await is_ad_playing(tab):
        return False, "NO_AD", mouse_x, mouse_y

    tabs_before = 0
    try:
        if browser:
            tabs_before = len(list(browser.tabs))
    except Exception:
        pass

    target = await wait_ad_click_window(
        tab,
        delay_min=delay_min,
        delay_max=delay_max,
        timeout=max(45.0, delay_max + 25.0),
        log_fn=log_fn,
        rng=rng,
    )
    if not target:
        return False, "NO_CLICK_TARGET", mouse_x, mouse_y

    clicked, mx, my = await cdp_click_target(tab, target, rng, mouse_x=mouse_x, mouse_y=mouse_y)
    if not clicked:
        return False, "CLICK_FAILED", mx, my

    log_fn(f"[AdClick] Clicked advertiser link ({target.get('text', '')[:32]!r})")
    await asyncio.sleep(2.0)

    await visit_advertiser_and_return(
        browser, tab,
        visit_sec=visit_sec,
        tabs_before=tabs_before,
        log_fn=log_fn,
        rng=rng,
    )
    await resume_youtube_playback(tab, log_fn)
    return True, "VERIFIED_AD_CLICK_VISIT", mx, my
