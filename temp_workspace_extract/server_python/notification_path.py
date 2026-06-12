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

FIXED:
  ✅ Bug #1: tab.evaluate("...", element) — Playwright style arguments[0] passing
             does NOT work in nodriver. Fixed: all element operations use
             JS IIFE with querySelector instead of element argument passing.
  ✅ Bug #2: tab.find() / tab.find_all() — unreliable in nodriver.
             Replaced with tab.select() and JS querySelectorAll via evaluate().
  ✅ Bug #3: 'import time as _time' inside function → moved to top level.
  ✅ Bug #4: _verify_navigation() uses asyncio.wait_for timeout (no hang).
  ✅ Bug #5: All tab.evaluate() calls wrapped with asyncio.wait_for timeout.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Optional

from server_python.yt_types import VideoTarget, YouTubeManagerError

log = logging.getLogger("mmb.notification_path")

# FIX #3: time imported at top level (was 'import time as _time' inside function)

# Notification bell selectors (top-right of YouTube header)
_BELL_SELECTORS = [
    'button[aria-label*="All notifications"]',
    'button[aria-label*="notifications"]',
    'button[aria-label*="Notifications"]',
    'ytd-notification-topbar-button-renderer button',
    '#notification-preference-button button',
]

# Notification panel selectors
_PANEL_SELECTORS = [
    'ytd-multi-page-menu-renderer',
    'ytd-notification-renderer',
    '#notification-panel',
]


async def _safe_eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """FIX #5: All tab.evaluate with timeout protection."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout,
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        log.debug("[NotifPath] eval timeout after %.1fs", timeout)
        return None
    except Exception as e:
        log.debug("[NotifPath] eval error: %s", e)
        return None


class NotificationPath:
    """
    Handles bell → notification panel → target video click.

    Args:
        tab      : nodriver Tab object
        target   : VideoTarget (has .video_id, .title_hint, .channel_name)
        rng      : random.Random instance (per-profile seeded)
        log_fn   : callable for structured logging
        resolver : SemanticResolver instance (optional)
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
        self._tab      = tab
        self._target   = target
        self._rng      = rng
        self._log      = log_fn or (lambda m: log.info(m))
        self._resolver = resolver

    # ── Main entry point ──────────────────────────────────────────────────────

    async def execute(self) -> bool:
        """
        Run the full notification entry path.
        Returns True if successfully landed on the target video watch page.
        Raises YouTubeManagerError on failure (caller falls back to Path A).
        """
        self._log("[NotifPath] Starting notification entry path")

        # Step 1: Open notification panel
        await self._open_bell_panel()

        # Step 2: Find target notification
        notif_href = await self._find_target_notification()
        if notif_href is None:
            raise YouTubeManagerError(
                f"[NotifPath] Target video not found in notifications: "
                f"{self._target.video_id!r}"
            )

        # Step 3: Click the notification
        await self._click_notification(notif_href)

        # Step 4: Verify landed on correct video
        ok = await self._verify_navigation()
        if not ok:
            raise YouTubeManagerError(
                f"[NotifPath] Navigation did not land on /watch?v={self._target.video_id}"
            )

        self._log("[NotifPath] ✓ Landed on target video via notification")
        return True

    # ── Step 1: Open bell panel ───────────────────────────────────────────────

    async def _open_bell_panel(self) -> None:
        """
        Click the bell icon to open notification panel.
        FIX #2: Uses tab.select() instead of unreliable tab.find().
        """
        self._log("[NotifPath] Looking for bell icon")

        bell_sel = None

        # Try each selector with tab.select() (nodriver reliable method)
        for sel in _BELL_SELECTORS:
            try:
                el = await asyncio.wait_for(
                    self._tab.select(sel),
                    timeout=3.0,
                )
                if el:
                    bell_sel = sel
                    break
            except Exception:
                continue

        if not bell_sel:
            raise YouTubeManagerError("[NotifPath] Bell icon not found on page")

        # Human pause before clicking
        await asyncio.sleep(self._rng.uniform(0.4, 1.2))

        # FIX #1: Hover via IIFE JS (not arguments[0] pattern)
        await _safe_eval(self._tab, f"""
        (() => {{
            var el = document.querySelector({json.dumps(bell_sel)});
            if (el) {{
                el.dispatchEvent(new MouseEvent('mouseover', {{bubbles: true}}));
                el.dispatchEvent(new MouseEvent('mouseenter', {{bubbles: true}}));
            }}
        }})()
        """)

        await asyncio.sleep(self._rng.uniform(0.2, 0.5))

        # Click via JS IIFE (FIX #1: no arguments[0])
        clicked = await _safe_eval(self._tab, f"""
        (() => {{
            var el = document.querySelector({json.dumps(bell_sel)});
            if (!el) return false;
            el.click();
            return true;
        }})()
        """)

        if not clicked:
            raise YouTubeManagerError("[NotifPath] Bell click failed — element not found")

        self._log("[NotifPath] Bell clicked — waiting for panel")

        # Wait for notification panel (FIX #3: time from top-level import)
        panel_found = False
        deadline    = time.monotonic() + 7.5

        while time.monotonic() < deadline:
            for sel in _PANEL_SELECTORS:
                # FIX #2: Use JS querySelector instead of tab.find()
                exists = await _safe_eval(self._tab, f"""
                (() => !!document.querySelector({json.dumps(sel)}))()
                """, timeout=2.0)
                if exists:
                    panel_found = True
                    break
            if panel_found:
                break
            await asyncio.sleep(0.5)

        if not panel_found:
            raise YouTubeManagerError("[NotifPath] Notification panel did not open")

        self._log("[NotifPath] Notification panel open")
        await asyncio.sleep(self._rng.uniform(0.5, 1.0))

    # ── Step 2: Find target notification ─────────────────────────────────────

    async def _find_target_notification(self) -> Optional[str]:
        """
        Scan notification items for one matching target video_id or title.
        FIX #1: All element operations via JS IIFE (no arguments[0]).
        FIX #2: Uses JS querySelectorAll instead of tab.find_all().
        Returns the href string of the matching notification, or None.
        """
        self._log(f"[NotifPath] Scanning notifications for video {self._target.video_id!r}")

        video_id    = self._target.video_id or ""
        title_lower = (getattr(self._target, "title_hint", None) or
                       getattr(self._target, "title", None) or "").lower()
        title_json  = json.dumps(title_lower)
        vid_json    = json.dumps(video_id)

        # FIX #1 + #2: Single JS IIFE collects all notification data
        # No element argument passing — pure querySelector approach
        raw = await _safe_eval(self._tab, f"""
        (() => {{
            var items = document.querySelectorAll(
                'ytd-notification-renderer, ytd-notification-renderer a'
            );
            if (!items || items.length === 0) return null;

            var video_id  = {vid_json};
            var title_str = {title_json};
            var results   = [];

            for (var i = 0; i < Math.min(items.length, 20); i++) {{
                var el  = items[i];
                var a   = el.tagName === 'A' ? el : el.querySelector('a[href]');
                var href = a ? (a.href || a.getAttribute('href') || '') : '';
                var text = (el.innerText || el.textContent || '').toLowerCase();

                results.push({{
                    href:  href,
                    text:  text.substring(0, 200)
                }});
            }}
            return JSON.stringify(results);
        }})()
        """, timeout=8.0)

        if not raw:
            self._log("[NotifPath] No notification items found in panel")
            return None

        try:
            items = json.loads(str(raw))
        except Exception:
            self._log("[NotifPath] Failed to parse notification items JSON")
            return None

        if not items:
            self._log("[NotifPath] Notification panel is empty")
            return None

        self._log(f"[NotifPath] Found {len(items)} notification items — scanning")

        for item in items:
            href = item.get("href", "")
            text = item.get("text", "")

            # Method 1: exact video_id in href
            if video_id and video_id in href:
                self._log("[NotifPath] ✓ Found notification by video_id in href")
                return href

            # Method 2: title word match
            if title_lower and len(title_lower) > 5:
                title_words = [w for w in title_lower.split() if len(w) > 3]
                if title_words:
                    matches     = sum(1 for w in title_words if w in text)
                    match_ratio = matches / len(title_words)
                    if match_ratio >= 0.6:
                        self._log(
                            f"[NotifPath] ✓ Found notification by title match "
                            f"({match_ratio:.0%}) href={href[:60]}"
                        )
                        return href if href else None

        self._log(f"[NotifPath] Target video not found in {len(items)} notifications")
        return None

    # ── Step 3: Click notification ────────────────────────────────────────────

    async def _click_notification(self, href: str) -> None:
        """
        Click the notification by navigating to its href.
        FIX #1: No element argument passing. Use direct navigation.
        Human-like: scroll into view → hover → click or navigate.
        """
        self._log(f"[NotifPath] Clicking notification href={href[:60]}")

        # Try JS click on matching anchor first (stays within notification panel flow)
        href_json = json.dumps(href)
        clicked   = await _safe_eval(self._tab, f"""
        (() => {{
            // Find anchor by href
            var links = document.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i++) {{
                var h = links[i].href || links[i].getAttribute('href') || '';
                if (h === {href_json} || h.includes({json.dumps(href[:50])})) {{
                    links[i].scrollIntoView({{behavior: 'smooth', block: 'center'}});
                    links[i].dispatchEvent(new MouseEvent('mouseover', {{bubbles: true}}));
                    links[i].dispatchEvent(new MouseEvent('mouseenter', {{bubbles: true}}));
                    links[i].dispatchEvent(new MouseEvent('mousemove', {{bubbles: true}}));
                    return true;
                }}
            }}
            return false;
        }})()
        """)

        if clicked:
            # Human dwell time after hover
            await asyncio.sleep(self._rng.uniform(0.5, 1.5))

        # Now click or navigate
        nav_clicked = await _safe_eval(self._tab, f"""
        (() => {{
            var links = document.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i++) {{
                var h = links[i].href || links[i].getAttribute('href') || '';
                if (h === {href_json} || h.includes({json.dumps(href[:50])})) {{
                    links[i].click();
                    return true;
                }}
            }}
            return false;
        }})()
        """)

        if not nav_clicked:
            # Fallback: direct URL navigation
            self._log("[NotifPath] JS click failed — direct URL navigation")
            try:
                full_url = href if href.startswith("http") else f"https://www.youtube.com{href}"
                await asyncio.wait_for(self._tab.get(full_url), timeout=15.0)
            except Exception as e:
                raise YouTubeManagerError(f"[NotifPath] Cannot navigate to notification: {e}")

        self._log("[NotifPath] Notification clicked/navigated")

    # ── Step 4: Verify navigation ─────────────────────────────────────────────

    async def _verify_navigation(self) -> bool:
        """
        Wait up to 10s for URL to become /watch?v={video_id}.
        FIX #4: asyncio.wait_for on each eval (no infinite hang).
        """
        video_id = self._target.video_id or ""
        deadline = time.monotonic() + 10.0

        while time.monotonic() < deadline:
            await asyncio.sleep(0.5)
            url = await _safe_eval(
                self._tab,
                "(() => window.location.href)()",
                timeout=3.0,
            )
            if url and video_id in str(url) and "/watch" in str(url):
                return True

        return False
