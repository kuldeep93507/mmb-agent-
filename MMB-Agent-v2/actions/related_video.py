"""
T2-02 — Related Videos Own Channel Only
========================================

Watch page ke sidebar mein related videos scan karo.
SIRF apne channel ka video mile to click karo.
Kabhi bhi random related video click nahi hoga.

Rules (hard-coded, non-negotiable):
  1. Own video_id match → click (most precise)
  2. Own channel_id in channelHref → click (channel-level)
  3. Koi match nahi → log + return None/False (no random click EVER)
  4. Har decision log hoga: found/not-found/skipped

Usage::
    from actions.related_video import find_own_related_video, click_related_if_own

    card = await find_own_related_video(tab, own_video_ids, own_channel_ids, log=log_fn)
    ok   = await click_related_if_own(
               tab,
               own_video_ids=own_video_ids,
               own_channel_ids=own_channel_ids,
               watch_seconds=60.0,
               rng=rng,
               log=log_fn,
               guardian=guardian_instance,
           )
"""

from __future__ import annotations

import asyncio
import json as _json
import random
import time
from typing import Callable, Optional, Set

from nodriver.core.tab import Tab


# ── JS scraper ───────────────────────────────────────────────────────────────

async def _js_scan_related_sidebar(tab: Tab) -> list[dict]:
    """
    Single JS IIFE — reads ALL ytd-compact-video-renderer cards in sidebar.

    Returns list of dicts:
        {href, title, channel, channelHref, video_id}

    Uses JSON.stringify → avoids nodriver RemoteObject issue on complex objects.
    Returns [] on any error (non-fatal).
    """
    try:
        result = await tab.evaluate(
            """
            (() => {
                // Sidebar containers — try all three known locations
                var containers = document.querySelectorAll(
                    '#secondary ytd-compact-video-renderer, '
                    + '#related ytd-compact-video-renderer, '
                    + 'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer'
                );

                var out = [];
                for (var i = 0; i < containers.length && out.length < 30; i++) {
                    var c = containers[i];

                    // Thumbnail anchor with href (most reliable link element)
                    var thumb = c.querySelector('a#thumbnail[href]');

                    // Title element — try both variants
                    var titleEl = c.querySelector('#video-title, a#video-title');

                    // Channel name anchor
                    var channelEl = c.querySelector(
                        '#channel-name a, ytd-channel-name a, .ytd-channel-name a'
                    );

                    var href = thumb ? (thumb.href || thumb.getAttribute('href') || '') : '';
                    if (!href) continue;  // no href = skip

                    var title   = titleEl
                        ? (titleEl.getAttribute('title') || titleEl.innerText || '').trim()
                        : '';
                    var channel = channelEl
                        ? (channelEl.innerText || channelEl.textContent || '').trim()
                        : '';
                    var channelHref = channelEl
                        ? (channelEl.href || channelEl.getAttribute('href') || '')
                        : '';

                    // Extract video_id from href  (?v=XXXXXXXXXXX or /watch?v=...)
                    var videoId = '';
                    var m = href.match(/[?&]v=([^&]+)/);
                    if (m) videoId = m[1];

                    out.push({
                        href: href,
                        title: title,
                        channel: channel,
                        channelHref: channelHref,
                        video_id: videoId
                    });
                }
                return JSON.stringify(out);
            })()
            """,
            return_by_value=True,
        )
        raw = result if isinstance(result, str) else getattr(result, "value", "[]")
        data = _json.loads(raw or "[]")
        return data if isinstance(data, list) else []
    except Exception:
        return []


# ── Core finder ──────────────────────────────────────────────────────────────

async def find_own_related_video(
    tab: Tab,
    own_video_ids: Set[str],
    own_channel_ids: Set[str],
    *,
    log: Optional[Callable[[str], None]] = None,
) -> Optional[dict]:
    """
    Scan related sidebar → find FIRST card that belongs to our own channel.

    Match priority (stricter first):
      1. video_id match  — exact video from our job list
      2. channel_id match — any video from our channel (channelHref contains channel_id)

    Parameters
    ----------
    tab           : Active nodriver Tab on the watch page.
    own_video_ids : Set of video_ids from our jobs (e.g. all JobDefinition.video_id).
    own_channel_ids : Set of channel_ids (UCxxxxxx) from our jobs.
    log           : Optional logging callable.

    Returns
    -------
    dict  → first matching card  {href, title, channel, channelHref, video_id}
    None  → no own channel video found (caller must NOT click randomly)
    """
    _log = log or (lambda msg: None)

    # Scroll sidebar to trigger lazy-loaded related cards.
    #
    # BUG FIXED (Sprint-3): previous code used `element.scrollTop += 300`.
    # YouTube wraps sidebar in shadow DOM / custom elements — scrollTop on
    # the outer container has no effect because the actual scrollable surface
    # is the inner shadow-root or the page itself.
    #
    # Fix: THREE-stage scroll strategy:
    #   1. window.scrollBy — always works (scrolls the page, triggers lazy load)
    #   2. scrollTop on every known sidebar selector (belt + suspenders)
    #   3. Wait 1.5s for lazy-rendered cards to paint
    try:
        await tab.evaluate(
            """
            (() => {
                // Stage 1: page-level scroll (works even with shadow DOM)
                window.scrollBy(0, 400);

                // Stage 2: attempt scrollTop on all known sidebar containers
                var selectors = [
                    '#secondary',
                    '#related',
                    'ytd-watch-next-secondary-results-renderer',
                    '#items.ytd-watch-next-secondary-results-renderer',
                ];
                for (var sel of selectors) {
                    var el = document.querySelector(sel);
                    if (el) {
                        el.scrollTop += 400;
                        // Also try scrollIntoView on last child (forces render)
                        var kids = el.children;
                        if (kids && kids.length > 0) {
                            kids[kids.length - 1].scrollIntoView({block: 'nearest'});
                        }
                    }
                }
            })()
            """,
            return_by_value=True,
        )
        await asyncio.sleep(1.5)   # raised from 1.0 — give lazy cards more time
    except Exception:
        pass

    cards = await _js_scan_related_sidebar(tab)
    _log(f"[RelatedVideo] Sidebar scan | {len(cards)} cards found")

    if not cards:
        _log("[RelatedVideo] Sidebar empty — no related cards")
        return None

    # ── Pass 1: exact video_id match ──────────────────────────────────────
    if own_video_ids:
        for card in cards:
            vid_id = card.get("video_id", "")
            if vid_id and vid_id in own_video_ids:
                _log(
                    f"[RelatedVideo] Match (video_id) | "
                    f"video_id={vid_id} title={card.get('title','')!r}"
                )
                return card

    # ── Pass 2: channel_id in channelHref ────────────────────────────────
    if own_channel_ids:
        for card in cards:
            ch_href = card.get("channelHref", "")
            for ch_id in own_channel_ids:
                if ch_id and ch_id in ch_href:
                    _log(
                        f"[RelatedVideo] Match (channel_id={ch_id}) | "
                        f"title={card.get('title','')!r} "
                        f"video_id={card.get('video_id','')}"
                    )
                    return card

    _log(
        f"[RelatedVideo] No own channel match in {len(cards)} cards "
        f"| own_videos={len(own_video_ids)} own_channels={len(own_channel_ids)}"
    )
    return None


# ── Click + watch ─────────────────────────────────────────────────────────────

async def _get_video_duration(tab: Tab) -> float:
    """
    Read actual video duration via JS after navigation.
    Returns duration in seconds, or 0.0 if not available.
    Polls for up to 10s (video element may not be ready immediately).
    """
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        try:
            result = await tab.evaluate(
                "(() => { var v = document.querySelector('video'); "
                "return v ? v.duration : 0; })()",
                return_by_value=True,
            )
            val = result if isinstance(result, (int, float)) else getattr(result, "value", 0)
            dur = float(val or 0)
            if dur > 5.0:   # valid duration (> 5s means video loaded)
                return dur
        except Exception:
            pass
        await asyncio.sleep(0.8)
    return 0.0


async def click_related_if_own(
    tab: Tab,
    *,
    own_video_ids: Set[str],
    own_channel_ids: Set[str],
    watch_pct_min: float = 0.90,
    watch_pct_max: float = 1.00,
    fallback_watch_seconds: float = 180.0,
    rng: Optional[random.Random] = None,
    log: Optional[Callable[[str], None]] = None,
    guardian=None,   # PlaybackGuardian — suppress during navigation + watch
) -> bool:
    """
    Find and click a related video ONLY if it belongs to our own channel.

    Execution flow:
      1. Scan sidebar (find_own_related_video)
      2. No match → log "No own video in related, skipping" → return False
      3. Match → JS click by video_id href (most reliable)
              → fallback: direct tab.get(full_url)
      4. Wait for /watch in URL (SPA navigation confirmation)
      5. Watch for watch_seconds with Gaussian chunks + occasional scroll
      6. Return True

    Rules:
      - Random related video is NEVER clicked.
      - Guardian is suppressed for navigation + full watch duration.
      - All steps are logged.

    Parameters
    ----------
    tab                  : Active nodriver Tab on the watch page.
    own_video_ids        : Set of video_ids we own.
    own_channel_ids      : Set of channel_ids (UCxxxxxx) we own.
    watch_pct_min        : Min fraction of video duration to watch (default 0.90 = 90%).
    watch_pct_max        : Max fraction of video duration to watch (default 1.00 = 100%).
    fallback_watch_seconds : Seconds to watch if duration unknown (default 180s).
    rng                  : Random generator (per-profile RNG preferred).
    log                  : Logging callable.
    guardian             : PlaybackGuardian instance (optional, suppress called if set).

    Returns
    -------
    True  → own video found, clicked, watched.
    False → no own video / click failed.
    """
    _log = log or (lambda msg: None)
    _rng = rng or random.Random()

    # Guard: both lists empty → nothing to match against
    if not own_video_ids and not own_channel_ids:
        _log("[RelatedVideo] Skipped — own_video_ids and own_channel_ids both empty")
        return False

    # ── Step 1: Find own video in sidebar ────────────────────────────────
    card = await find_own_related_video(
        tab,
        own_video_ids,
        own_channel_ids,
        log=_log,
    )

    if card is None:
        # Hard rule: no match → no click
        _log("[RelatedVideo] No own video in related, skipping")
        return False

    href      = card.get("href", "")
    video_id  = card.get("video_id", "")
    title     = card.get("title", "Unknown")

    _log(f"[RelatedVideo] Proceeding to click | video_id={video_id} title={title!r}")

    # ── Step 2: Suppress guardian before navigation ───────────────────────
    # BUG FIXED (Sprint-3): was suppress(25.0). Race condition:
    #   nav (~10s) + sleep (3s) + duration poll (up to 10s) = 23s worst case
    #   → guardian could resume BEFORE watch suppress (Step 5) was set.
    # Fix: use 45s here (generous navigation window). Step 5 will reset
    # suppress to (watch_target + 15s) which overrides this cleanly.
    if guardian is not None:
        guardian.suppress(45.0)   # nav + buffering + duration poll margin

    # ── Step 3: Click ─────────────────────────────────────────────────────
    clicked = False

    # Method A: JS click by video_id in href — SCOPED to sidebar containers only
    # (broad querySelector could match the current player thumbnail or share URLs)
    if video_id:
        try:
            result = await tab.evaluate(
                f"""
                (() => {{
                    var selectors = [
                        '#secondary a[href*="{video_id}"]',
                        '#related a[href*="{video_id}"]',
                        'ytd-watch-next-secondary-results-renderer a[href*="{video_id}"]'
                    ];
                    for (var s of selectors) {{
                        var a = document.querySelector(s);
                        if (a) {{ a.click(); return true; }}
                    }}
                    return false;
                }})()
                """,
                return_by_value=True,
            )
            val = result if isinstance(result, bool) else bool(getattr(result, "value", False))
            if val:
                _log(f"[RelatedVideo] JS click (video_id) fired")
                clicked = True
        except Exception as exc:
            _log(f"[RelatedVideo] JS click failed: {exc}")

    # Method B: direct tab.get() fallback
    if not clicked and href:
        try:
            full_url = href if href.startswith("http") else f"https://www.youtube.com{href}"
            _log(f"[RelatedVideo] Fallback tab.get | url={full_url[:70]}")
            await asyncio.wait_for(tab.get(full_url), timeout=20.0)
            clicked = True
        except Exception as exc:
            _log(f"[RelatedVideo] tab.get fallback failed: {exc}")
            return False

    if not clicked:
        _log("[RelatedVideo] Both click methods failed — skipping")
        return False

    # ── Step 4: Wait for /watch URL (SPA navigation confirm) ─────────────
    _log("[RelatedVideo] Waiting for /watch navigation...")
    nav_ok = False
    nav_deadline = time.monotonic() + 15.0
    while time.monotonic() < nav_deadline:
        try:
            r = await tab.evaluate("(() => window.location.href)()", return_by_value=True)
            url = r if isinstance(r, str) else getattr(r, "value", "")
            if url and "/watch" in url:
                _log(f"[RelatedVideo] Navigation OK | url={url[:70]}")
                nav_ok = True
                break
        except Exception:
            pass
        await asyncio.sleep(0.5)

    if not nav_ok:
        _log("[RelatedVideo] Navigation not confirmed — watching anyway (best-effort)")

    # Small human pause before watch starts
    await asyncio.sleep(_rng.uniform(1.5, 3.0))

    # ── Step 5: Get actual video duration → watch 90–100% ─────────────────
    duration = await _get_video_duration(tab)

    if duration > 5.0:
        # Normal path: watch 90–100% of actual video duration
        pct = _rng.uniform(watch_pct_min, watch_pct_max)
        watch_target = duration * pct
        _log(
            f"[RelatedVideo] Duration={duration:.0f}s | "
            f"Watching {pct:.0%} = {watch_target:.0f}s | "
            f"video_id={video_id}"
        )
    else:
        # Fallback: duration unknown (ad, DRM, slow load)
        watch_target = fallback_watch_seconds
        _log(
            f"[RelatedVideo] Duration unknown — fallback {watch_target:.0f}s | "
            f"video_id={video_id}"
        )

    # Suppress guardian for entire watch window + 15s buffer.
    # This OVERRIDES the navigation suppress (Step 2) — no gap possible
    # because we call suppress() here right before the loop starts.
    if guardian is not None:
        guardian.suppress(watch_target + 15.0)

    watch_start = time.monotonic()
    remaining   = watch_target

    while remaining > 0:
        # Gaussian-like chunk: 8–18s, clamped to remaining
        chunk = min(remaining, _rng.uniform(8.0, 18.0))
        await asyncio.sleep(chunk)
        remaining -= chunk

        # 20% chance: organic scroll (human reads description / comments)
        if _rng.random() < 0.20:
            try:
                await tab.evaluate(
                    f"(() => window.scrollBy(0, {_rng.randint(100, 300)}))()",
                    return_by_value=True,
                )
            except Exception:
                pass

        # 8% chance: seek back slightly (rewatching a part)
        if _rng.random() < 0.08:
            try:
                await tab.evaluate(
                    "(() => { var v = document.querySelector('video'); "
                    "if (v) v.currentTime = Math.max(0, v.currentTime - 5); })()",
                    return_by_value=True,
                )
            except Exception:
                pass

    actual = time.monotonic() - watch_start
    _log(
        f"[RelatedVideo] Done | watched={actual:.0f}s / {duration:.0f}s "
        f"({actual/duration*100:.0f}%) | video_id={video_id} title={title!r}"
        if duration > 0 else
        f"[RelatedVideo] Done | watched={actual:.0f}s | video_id={video_id}"
    )
    return True
