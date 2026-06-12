"""
Consent dismissal + human scroll helpers for Google / Bing / DuckDuckGo entry paths.
"""
from __future__ import annotations

import asyncio
import random
import re
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import logging

log = logging.getLogger("mmb.external_search")

_CONSENT_JS = """
(() => {
  const sels = [
    '#L2AGLb', 'button#L2AGLb',
    'button[aria-label*="Accept all" i]', 'button[aria-label*="I agree" i]',
    'button[aria-label*="Accept" i]', 'button.tHlp8d',
    '#bnp_btn_accept', '#accept-btn', 'button#bnp_btn_accept',
    'button[data-testid="consent-banner-accept-all"]',
    'button[data-testid="consent-banner-accept"]',
    'a#hs-eu-confirmation-button', 'button.save-preference-btn-handler',
    'button.osano-cm-accept-all', 'button#onetrust-accept-btn-handler',
    'form[action*="consent"] button', '.fc-cta-consent',
  ];
  for (const sel of sels) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null) {
      btn.click();
      return 'clicked:' + sel;
    }
  }
  return null;
})()
"""


def normalize_youtube_href(href: str) -> str:
    """Unwrap Google/Bing redirect URLs → direct youtube.com/watch link."""
    h = (href or "").strip()
    if not h:
        return ""
    try:
        if "google." in h and "/url" in h:
            qs = parse_qs(urlparse(h).query)
            for key in ("url", "q", "u"):
                if qs.get(key):
                    h = unquote(qs[key][0])
                    break
        if "bing.com" in h and "/ck/a" in h:
            m = re.search(r"[?&]u=([^&]+)", h)
            if m:
                h = unquote(m.group(1))
    except Exception:
        pass
    if "youtu.be/" in h:
        vid = h.split("youtu.be/")[-1].split("?")[0][:11]
        if vid:
            return f"https://www.youtube.com/watch?v={vid}"
    if "youtube.com/watch" in h or "youtube.com/live" in h:
        return h.split("&pp=")[0].split("#")[0]
    return h


async def dismiss_engine_consent(tab: Any) -> bool:
    """Dismiss cookie/consent banners on search engines (best-effort)."""
    if not tab:
        return False
    try:
        result = await asyncio.wait_for(
            tab.evaluate(_CONSENT_JS, return_by_value=True),
            timeout=6.0,
        )
        val = getattr(result, "value", result)
        if val and str(val).startswith("clicked"):
            log.info("External consent dismissed: %s", val)
            await asyncio.sleep(random.uniform(0.8, 1.6))
            return True
    except Exception:
        pass
    return False


async def human_results_scroll(
    tab: Any,
    rng: random.Random,
    *,
    personality_speed: str = "normal",
    passes: int = 1,
    curve_id: str = "",
) -> None:
    """Incremental curved wheel scroll through SERP (not one big jump)."""
    from server_python.behavior.youtube.scroll_human import human_curve_scroll

    for _ in range(max(1, passes)):
        if personality_speed == "fast":
            px = rng.randint(140, 280)
        elif personality_speed == "slow":
            px = rng.randint(70, 160)
        else:
            px = rng.randint(100, 220)
        await human_curve_scroll(tab, px, rng, curve_id=curve_id)
        await asyncio.sleep(rng.uniform(0.7, 1.8))


async def _tab_url(tab: Any) -> str:
    try:
        raw = await asyncio.wait_for(
            tab.evaluate("location.href", return_by_value=True),
            timeout=5.0,
        )
        return str(getattr(raw, "value", raw) or "")
    except Exception:
        return ""


async def _wait_for_watch_url(tab: Any, timeout: float = 20.0) -> bool:
    import time as _time
    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        url = await _tab_url(tab)
        if url and ("/watch" in url or "youtu.be/" in url):
            return True
        await asyncio.sleep(0.5)
    return False


async def ensure_watch_playback(tab: Any, rng: random.Random, log_fn: Any) -> bool:
    """After SERP → YouTube, nudge player like a human (focus + CDP click + play API)."""
    from server_python.behavior.youtube import desktop as yt_desktop
    from server_python.behavior.youtube.player_focus import focus_player
    from server_python.human_engine import wait_for_player

    await asyncio.sleep(rng.uniform(1.0, 2.2))
    await focus_player(tab)
    await asyncio.sleep(rng.uniform(0.35, 0.85))

    try:
        raw = await asyncio.wait_for(
            tab.evaluate("""
            (() => {
              const p = document.querySelector('#movie_player')
                   || document.querySelector('.html5-video-player');
              if (!p) return null;
              const r = p.getBoundingClientRect();
              if (r.width < 8) return null;
              return JSON.stringify({
                x: Math.round(r.left + r.width * 0.48 + (Math.random() * 24 - 12)),
                y: Math.round(r.top + r.height * 0.42 + (Math.random() * 18 - 9))
              });
            })()
            """, return_by_value=True),
            timeout=6.0,
        )
        val = getattr(raw, "value", raw)
        if val:
            import json as _json
            pt = _json.loads(str(val))
            from server_python.cdp_mouse import cdp_hover_then_click
            await cdp_hover_then_click(
                tab, float(pt["x"]), float(pt["y"]), rng,
                dwell_min=0.35, dwell_max=1.1,
            )
    except Exception:
        pass

    await yt_desktop.play(tab)
    ready = await wait_for_player(tab, timeout=50.0)
    if not ready:
        await focus_player(tab)
        await yt_desktop.play(tab)
        ready = await wait_for_player(tab, timeout=22.0)
    log_fn(f"[External] Playback ready: {ready}")
    return ready


async def finish_watch_navigation(
    tab: Any,
    href: str,
    video_id: str,
    rng: random.Random,
    *,
    click_fn: Any,
    log_fn: Any,
) -> bool:
    """
    CDP human click on SERP result → wait for YouTube watch page → consent on YT.
    Fallback: direct watch URL only if click+redirect did not land in time.
    """
    from server_python.behavior.youtube.entry_flow import accept_consent_if_present

    clean = normalize_youtube_href(href)
    clicked = await click_fn(tab, video_id or "", href, rng)
    if not clicked and clean:
        log_fn("[External] Click missed — opening normalized watch URL")
        try:
            await tab.get(clean)
        except Exception:
            pass

    nav_ok = await _wait_for_watch_url(tab, timeout=28.0)
    if not nav_ok:
        url = await _tab_url(tab)
        if "google." in url and "/url" in url:
            await asyncio.sleep(rng.uniform(2.0, 4.0))
            nav_ok = await _wait_for_watch_url(tab, timeout=12.0)

    if not nav_ok and clean and "youtube.com/watch" in clean:
        log_fn("[External] Post-click fallback → watch URL")
        try:
            await tab.get(clean)
            nav_ok = await _wait_for_watch_url(tab, timeout=20.0)
        except Exception:
            nav_ok = False

    if nav_ok:
        try:
            await accept_consent_if_present(tab)
        except Exception:
            pass
        nav_ok = await ensure_watch_playback(tab, rng, log_fn)
        if nav_ok:
            log_fn("[External] YouTube watch page ready after SERP click")
    return nav_ok
