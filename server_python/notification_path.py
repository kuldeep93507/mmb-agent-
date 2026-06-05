"""
NotificationPath — Entry Path D for MMB AGENT 24/7

Flow:
  1. Click bell icon (top-right notification button)
  2. Wait for notification panel to open
  3. Scan notification items for one matching target video_id or title
  4. Hover on it (human-like) → click
  5. Verify URL contains /watch?v={video_id}

If any step fails → raises YouTubeManagerError so entropy.py
can fall back to keyword search (Path A).
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional

from server_python.yt_types import VideoTarget, YouTubeManagerError
from server_python.human_engine import wait_for_element

log = logging.getLogger("mmb.notification_path")


class NotificationPath:
    """
    Handles bell → notification panel → target video click.

    Args:
        tab      : nodriver Tab object
        target   : VideoTarget (has .video_id, .title, .channel_name)
        rng      : random.Random instance (per-profile seeded)
        log_fn   : callable for structured logging
        resolver : SemanticResolver instance (for crash-proof element finding)
    """

    def __init__(
        self,
        tab: Any,
        target: VideoTarget,
        *,
        rng,
        log_fn=None,
        resolver=None,
    ) -> None:
        self._tab = tab
        self._target = target
        self._rng = rng
        self._log = log_fn or (lambda m: log.info(m))
        self._resolver = resolver   # SemanticResolver (optional but recommended)

    # ── Main entry point ──────────────────────────────────────────────────────

    async def execute(self) -> bool:
        """
        Run the full notification entry path.
        Returns True if successfully landed on the target video watch page.
        Raises YouTubeManagerError on failure (caller falls back to keyword search).
        """
        self._log("[NotifPath] Starting notification entry path")

        # Step 1: Open notification panel
        await self._open_bell_panel()

        # Step 2: Find target notification
        notif_el = await self._find_target_notification()
        if notif_el is None:
            raise YouTubeManagerError(
                f"[NotifPath] Target video not found in notifications: "
                f"{self._target.video_id!r}"
            )

        # Step 3: Hover → click
        await self._hover_and_click(notif_el)

        # Step 4: Verify landed on correct video
        ok = await self._verify_navigation()
        if not ok:
            raise YouTubeManagerError(
                f"[NotifPath] Navigation did not land on /watch?v={self._target.video_id}"
            )

        self._log(f"[NotifPath] ✓ Landed on target video via notification")
        return True

    # ── Step 1: Open bell panel ───────────────────────────────────────────────

    async def _open_bell_panel(self) -> None:
        """Click the bell icon to open the notification panel."""
        self._log("[NotifPath] Looking for bell icon")

        bell = None

        # Try SemanticResolver first (has all stable aria selectors)
        if self._resolver:
            try:
                bell = await self._resolver.find("bell_button", timeout=8.0, required=False)
            except Exception:
                pass

        # Fallback: aria-based CSS (permanent selectors)
        if bell is None:
            bell_selectors = [
                'button[aria-label*="All notifications"]',
                'button[aria-label*="notifications"]',
                'button[aria-label*="Notifications"]',
                'ytd-notification-topbar-button-renderer button',
                '#notification-preference-button button',
            ]
            for sel in bell_selectors:
                try:
                    bell = await self._tab.find(sel, timeout=3)
                    if bell:
                        break
                except Exception:
                    pass

        if bell is None:
            raise YouTubeManagerError("[NotifPath] Bell icon not found on page")

        # Human pause before clicking bell
        await asyncio.sleep(self._rng.uniform(0.4, 1.2))

        # Hover first (human-like)
        try:
            await self._tab.evaluate(
                "(function(el){el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));"
                "el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));})(arguments[0])",
                bell
            )
        except Exception:
            pass

        await asyncio.sleep(self._rng.uniform(0.2, 0.5))

        try:
            await bell.click()
        except Exception:
            try:
                await self._tab.evaluate(
                    "(function(el){el.click();})(arguments[0])", bell
                )
            except Exception as e:
                raise YouTubeManagerError(f"[NotifPath] Bell click failed: {e}")

        self._log("[NotifPath] Bell clicked — waiting for panel")

        # Use smart-wait instead of busy-loop
        panel_found = False
        panel_selectors = (
            'ytd-multi-page-menu-renderer',
            'ytd-notification-renderer',
            '#notification-panel',
        )
        # Poll with exponential backoff — max 7.5s total
        import time as _time
        deadline = _time.monotonic() + 7.5
        while _time.monotonic() < deadline:
            for sel in panel_selectors:
                try:
                    el = await self._tab.find(sel, timeout=1)
                    if el:
                        panel_found = True
                        break
                except Exception:
                    pass
            if panel_found:
                break
            await asyncio.sleep(0.5)

        if not panel_found:
            raise YouTubeManagerError("[NotifPath] Notification panel did not open")

        self._log("[NotifPath] Notification panel open")
        await asyncio.sleep(self._rng.uniform(0.5, 1.0))

    # ── Step 2: Find target notification ─────────────────────────────────────

    async def _find_target_notification(self) -> Optional[Any]:
        """
        Scan notification items for one matching target video_id or title.
        Returns the clickable element or None.
        """
        self._log(f"[NotifPath] Scanning notifications for video {self._target.video_id!r}")

        # Get all notification renderer elements
        notif_items = []
        notif_css_list = [
            'ytd-notification-renderer',
            'ytd-notification-renderer a',
        ]

        for sel in notif_css_list:
            try:
                items = await self._tab.find_all(sel)
                if items:
                    notif_items = items
                    break
            except Exception:
                pass

        if not notif_items:
            self._log("[NotifPath] No notification items found in panel")
            return None

        self._log(f"[NotifPath] Found {len(notif_items)} notification items")

        video_id = self._target.video_id
        title_lower = (self._target.title or "").lower()
        channel_lower = (self._target.channel_name or "").lower()

        # Check each notification for a match
        for item in notif_items[:20]:  # scan up to 20
            try:
                # Get href to check video_id
                href = await self._tab.evaluate(
                    "(function(el){"
                    "  var a=el.tagName==='A'?el:el.querySelector('a[href]');"
                    "  return a?a.href:null;"
                    "})(arguments[0])",
                    item
                )

                if href and video_id in str(href):
                    self._log(f"[NotifPath] ✓ Found notification by video_id in href")
                    # Return the anchor element
                    try:
                        anchor = await self._tab.evaluate(
                            "(function(el){"
                            "  return el.tagName==='A'?el:el.querySelector('a[href]');"
                            "})(arguments[0])",
                            item
                        )
                        return anchor if anchor else item
                    except Exception:
                        return item

                # Also check text content for title match
                if title_lower:
                    text_content = await self._tab.evaluate(
                        "(function(el){return (el.innerText||el.textContent||'').toLowerCase();})"
                        "(arguments[0])",
                        item
                    )
                    text_content = str(text_content or "")

                    # Title match: check if majority of title words present
                    if title_lower and len(title_lower) > 5:
                        title_words = [w for w in title_lower.split() if len(w) > 3]
                        if title_words:
                            matches = sum(1 for w in title_words if w in text_content)
                            match_ratio = matches / len(title_words)
                            if match_ratio >= 0.6:
                                self._log(
                                    f"[NotifPath] ✓ Found notification by title match "
                                    f"({match_ratio:.0%})"
                                )
                                try:
                                    anchor = await self._tab.evaluate(
                                        "(function(el){"
                                        "  return el.tagName==='A'?el:el.querySelector('a[href]');"
                                        "})(arguments[0])",
                                        item
                                    )
                                    return anchor if anchor else item
                                except Exception:
                                    return item

            except Exception as e:
                log.debug(f"[NotifPath] Item scan error: {e}")
                continue

        self._log(f"[NotifPath] Target video not found in {len(notif_items)} notifications")
        return None

    # ── Step 3: Hover → click ─────────────────────────────────────────────────

    async def _hover_and_click(self, el: Any) -> None:
        """Human-like hover then click on the notification element."""
        try:
            # Scroll element into view
            await self._tab.evaluate(
                "(function(el){el.scrollIntoView({behavior:'smooth',block:'center'});})"
                "(arguments[0])",
                el
            )
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))

            # Hover events
            await self._tab.evaluate(
                "(function(el){"
                "  el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));"
                "  el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));"
                "  el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));"
                "})(arguments[0])",
                el
            )
            await asyncio.sleep(self._rng.uniform(0.5, 1.5))  # human dwell time

            # Click
            await el.click()
            self._log("[NotifPath] Notification item clicked")

        except Exception as e:
            # JS click fallback
            self._log(f"[NotifPath] Direct click failed ({e}), trying JS click")
            try:
                await self._tab.evaluate(
                    "(function(el){el.click();})(arguments[0])", el
                )
            except Exception as e2:
                raise YouTubeManagerError(f"[NotifPath] Cannot click notification: {e2}")

    # ── Step 4: Verify navigation ─────────────────────────────────────────────

    async def _verify_navigation(self) -> bool:
        """Wait up to 10s for URL to become /watch?v={video_id}."""
        video_id = self._target.video_id
        for _ in range(20):  # up to 10 seconds
            await asyncio.sleep(0.5)
            try:
                url = await self._tab.evaluate("window.location.href")
                url = str(url or "")
                if video_id in url and "/watch" in url:
                    return True
            except Exception:
                pass
        return False
