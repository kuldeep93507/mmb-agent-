"""
SidebarVideoManager — Related/Sidebar Video Handler for MMB AGENT 24/7

Rules (STRICT — user defined):
  1. Sirf OWN CHANNEL ki videos click karo (own_channel_names list se match)
  2. Profile ne us video ko pehle dekha h? → SKIP (watch_history check)
  3. Koi match nahi mila → SILENT SKIP (no error, no fallback to random)
  4. Hover → dwell → click (human-like, tab mein hi)

Flow:
  1. Sidebar scan karo — ytd-compact-video-renderer cards
  2. Har card ka channel name check karo (own_channel_names mein h?)
  3. Video ID extract karo, watch_history check karo
  4. First valid match: hover → pause → click
  5. Navigation verify karo (/watch?v=NEW_ID)
  6. Mark watched in history
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Optional

from server_python.watch_history import mark_watched, has_watched

log = logging.getLogger("mmb.sidebar_video")


class SidebarVideoManager:
    """
    Manages sidebar/related video clicking — own channel only, unwatched only.

    Args:
        tab               : nodriver Tab object
        profile_id        : current profile's ID (for watch_history)
        own_channel_names : list of channel names/handles owned by user
                            e.g. ["MyChannel", "@mychannel", "My Channel Official"]
        rng               : random.Random (per-profile seeded)
        log_fn            : callable for structured logging
    """

    def __init__(
        self,
        tab: Any,
        profile_id: str,
        own_channel_names: list[str],
        *,
        rng,
        log_fn=None,
    ) -> None:
        self._tab = tab
        self._profile_id = profile_id
        # Normalize channel names for matching
        self._own_channels: list[str] = [
            c.lstrip("@").strip().lower()
            for c in (own_channel_names or [])
            if c
        ]
        self._rng = rng
        self._log = log_fn or (lambda m: log.info(m))

    # ── Main entry point ──────────────────────────────────────────────────────

    async def find_and_click(self) -> bool:
        """
        Scan sidebar, find an own-channel unwatched video, and click it.
        Returns True if a video was clicked, False if silent skip.
        Never raises an exception — always fails gracefully.
        """
        if not self._own_channels:
            self._log("[Sidebar] No own_channel_names configured — silent skip")
            return False

        self._log(
            f"[Sidebar] Scanning for own-channel videos | "
            f"channels={self._own_channels}"
        )

        try:
            cards = await self._get_sidebar_cards()
        except Exception as e:
            self._log(f"[Sidebar] Sidebar scan error — silent skip: {e}")
            return False

        if not cards:
            self._log("[Sidebar] No sidebar cards found — silent skip")
            return False

        self._log(f"[Sidebar] Found {len(cards)} sidebar cards — filtering")

        for card in cards:
            video_id = card.get("video_id", "")
            channel  = card.get("channel", "").lstrip("@").strip().lower()
            title    = card.get("title", "")
            href     = card.get("href", "")

            if not video_id or not href:
                continue

            # Rule 1: Must be own channel
            if not self._is_own_channel(channel):
                continue

            # Rule 2: Must not be watched by this profile
            if has_watched(self._profile_id, video_id):
                self._log(
                    f"[Sidebar] Already watched {video_id!r} ({title[:30]!r}) — skipping"
                )
                continue

            # Found a valid candidate
            self._log(
                f"[Sidebar] ✓ Own-channel unwatched video found: "
                f"{title[:40]!r} | {video_id!r} | channel={channel!r}"
            )

            clicked = await self._hover_and_click(video_id, href, title)
            if clicked:
                # Verify navigation
                nav_ok = await self._verify_navigation(video_id)
                if nav_ok:
                    mark_watched(self._profile_id, video_id)
                    self._log(
                        f"[Sidebar] ✓ Navigated to related video {video_id!r} "
                        f"and marked as watched"
                    )
                    return True
                else:
                    self._log(
                        f"[Sidebar] Click registered but URL didn't change to "
                        f"{video_id!r} — silent skip"
                    )
                    return False

        self._log(
            f"[Sidebar] No own-channel unwatched video in {len(cards)} cards — "
            "silent skip"
        )
        return False

    # ── Sidebar card extraction ───────────────────────────────────────────────

    async def _get_sidebar_cards(self) -> list[dict]:
        """
        Extract all sidebar video cards via JS.
        Returns list of dicts: {video_id, title, channel, href}
        Uses current YT DOM structure (2024/2025).
        """
        try:
            result = await self._tab.evaluate(
                """
                (function() {
                    var cards = [];
                    var seen = new Set();

                    // Primary: ytd-compact-video-renderer (sidebar/related)
                    var els = document.querySelectorAll(
                        'ytd-compact-video-renderer, '
                        + '#secondary ytd-compact-video-renderer, '
                        + '#related ytd-compact-video-renderer'
                    );

                    for (var i = 0; i < els.length && cards.length < 30; i++) {
                        var el = els[i];

                        // Title — try multiple selectors in priority order
                        var titleEl = el.querySelector(
                            '#video-title, '
                            + 'a#video-title, '
                            + 'span#video-title, '
                            + 'h3 a, '
                            + 'a[href*="/watch"] span'
                        );
                        var title = titleEl
                            ? (titleEl.getAttribute('title') || titleEl.innerText || '').trim()
                            : '';

                        // Channel — updated for 2024/2025 YT DOM
                        // Try multiple selectors as YT keeps changing this
                        var channelEl = (
                            el.querySelector('ytd-channel-name yt-formatted-string') ||
                            el.querySelector('ytd-channel-name span.yt-core-attributed-string') ||
                            el.querySelector('ytd-channel-name a') ||
                            el.querySelector('#channel-name a') ||
                            el.querySelector('#channel-name yt-formatted-string') ||
                            el.querySelector('a.yt-formatted-string[href*="/@"]') ||
                            el.querySelector('a.yt-formatted-string[href*="/channel/"]') ||
                            el.querySelector('.ytd-channel-name')
                        );
                        var channel = channelEl
                            ? (channelEl.getAttribute('title') || channelEl.innerText || channelEl.textContent || '').trim()
                            : '';

                        // Link/href
                        var linkEl = (
                            el.querySelector('a#thumbnail') ||
                            el.querySelector('a[href*="/watch"]')
                        );
                        var href = linkEl
                            ? (linkEl.href || linkEl.getAttribute('href') || '')
                            : '';

                        if (!href || seen.has(href)) continue;
                        seen.add(href);

                        // Extract video_id from href
                        var videoId = '';
                        var m = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
                        if (m) videoId = m[1];

                        if (!videoId) continue;

                        cards.push({
                            video_id: videoId,
                            title:    title,
                            channel:  channel,
                            href:     href
                        });
                    }
                    return JSON.stringify(cards);
                })()
                """,
                return_by_value=True,
            )

            # Parse result
            raw = result if isinstance(result, str) else getattr(result, "value", "")
            if not raw:
                return []
            data = json.loads(raw)
            if isinstance(data, list):
                return data
        except Exception as e:
            log.debug(f"[Sidebar] _get_sidebar_cards error: {e}")
        return []

    # ── Channel match ─────────────────────────────────────────────────────────

    def _is_own_channel(self, card_channel: str) -> bool:
        """
        Check if card's channel matches any of the user's own channels.
        Flexible: partial match OK (handles "Channel Name" vs "Channel Name Official")
        """
        if not card_channel:
            return False
        card_lower = card_channel.lower()
        for own in self._own_channels:
            if not own:
                continue
            # Direct contains match (both directions)
            if own in card_lower or card_lower in own:
                return True
        return False

    # ── Hover → click ─────────────────────────────────────────────────────────

    async def _hover_and_click(self, video_id: str, href: str, title: str) -> bool:
        """
        Human-like hover → dwell → click on the sidebar card.
        """
        try:
            # Scroll card into view first
            await self._tab.evaluate(
                f"""(function() {{
                    var a = document.querySelector('a[href*="{video_id}"]');
                    if (a) a.scrollIntoView({{behavior: 'smooth', block: 'center'}});
                }})()""",
                return_by_value=True,
            )
            await asyncio.sleep(self._rng.uniform(0.4, 0.9))

            # Hover events (human-like)
            await self._tab.evaluate(
                f"""(function() {{
                    var a = document.querySelector('a[href*="{video_id}"]');
                    if (!a) return;
                    a.dispatchEvent(new MouseEvent('mouseover', {{bubbles: true}}));
                    a.dispatchEvent(new MouseEvent('mouseenter', {{bubbles: true}}));
                    a.dispatchEvent(new MouseEvent('mousemove', {{
                        bubbles: true, clientX: 120, clientY: 300
                    }}));
                }})()""",
                return_by_value=True,
            )

            # Human dwell on card — 0.8 to 2.5 seconds
            dwell = self._rng.uniform(0.8, 2.5)
            self._log(
                f"[Sidebar] Hovering on {title[:30]!r} for {dwell:.1f}s..."
            )
            await asyncio.sleep(dwell)

            # Click
            clicked = await self._tab.evaluate(
                f"""(function() {{
                    var a = document.querySelector('a[href*="{video_id}"]');
                    if (a) {{ a.click(); return true; }}
                    return false;
                }})()""",
                return_by_value=True,
            )
            raw = clicked if isinstance(clicked, bool) else getattr(clicked, "value", False)

            if raw:
                self._log(f"[Sidebar] Clicked {video_id!r} ✓")
                return True

            # Fallback: navigate directly
            self._log(f"[Sidebar] JS click failed — navigating directly to {video_id!r}")
            full_url = (
                href if href.startswith("http")
                else f"https://www.youtube.com{href}"
            )
            try:
                await asyncio.wait_for(self._tab.get(full_url), timeout=15.0)
                return True
            except Exception as nav_e:
                self._log(f"[Sidebar] Direct nav also failed: {nav_e}")
                return False

        except Exception as e:
            self._log(f"[Sidebar] Hover/click error: {e}")
            return False

    # ── Verify navigation ─────────────────────────────────────────────────────

    async def _verify_navigation(self, video_id: str, timeout: float = 12.0) -> bool:
        """Wait until URL contains /watch?v={video_id}."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(0.5)
            try:
                url = await self._tab.evaluate(
                    "window.location.href", return_by_value=True
                )
                url_str = url if isinstance(url, str) else getattr(url, "value", "")
                if video_id in str(url_str) and "/watch" in str(url_str):
                    return True
            except Exception:
                pass
        return False
