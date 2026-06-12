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

# Top-bar notification bell ONLY (not subscribe/channel bell — see V2 notifications_topbar_bell)
_BELL_SELECTORS = [
    'ytd-notification-topbar-button-renderer button[aria-label="Notifications"]',
    'ytd-notification-topbar-button-renderer button',
    'button[aria-label="Notifications"]',
    'button[aria-label*="All notifications" i]',
]

# Notification dropdown / panel (opens after top-bar bell click)
_PANEL_SELECTORS = [
    'ytd-multi-page-menu-renderer',
    'ytd-notification-renderer',
    '#contents ytd-notification-renderer',
]

_NOTIFICATION_ITEM_SELECTORS = (
    'ytd-notification-renderer',
    'ytd-notification-renderer a[href*="/watch"]',
    'ytd-notification-renderer a[href*="youtu.be"]',
)


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

    async def _scroll_notification_panel(self, passes: int = 1) -> None:
        """Scroll inside notification panel so older items become visible."""
        for _ in range(max(1, passes)):
            await _safe_eval(self._tab, """
            (() => {
                var panel = document.querySelector('ytd-multi-page-menu-renderer #items')
                         || document.querySelector('ytd-multi-page-menu-renderer #contents')
                         || document.querySelector('ytd-multi-page-menu-renderer');
                if (panel) panel.scrollTop += Math.round(280 + Math.random() * 180);
                return true;
            })()
            """, timeout=3.0)
            await asyncio.sleep(self._rng.uniform(0.4, 0.9))

    async def _collect_notification_items(self) -> list[dict]:
        """Return visible notification rows {href, text} from the open panel."""
        item_sels = json.dumps(list(_NOTIFICATION_ITEM_SELECTORS))
        raw = await _safe_eval(self._tab, f"""
        (() => {{
            var sels = {item_sels};
            var seen = new Set();
            var results = [];
            for (var s = 0; s < sels.length; s++) {{
                var nodes = document.querySelectorAll(sels[s]);
                for (var i = 0; i < nodes.length; i++) {{
                    var el = nodes[i];
                    var a = el.tagName === 'A' ? el : el.querySelector('a[href]');
                    if (!a) continue;
                    var href = a.href || a.getAttribute('href') || '';
                    if (!href || seen.has(href)) continue;
                    seen.add(href);
                    var text = (el.innerText || el.textContent || '').toLowerCase();
                    results.push({{ href: href, text: text.substring(0, 240) }});
                    if (results.length >= 40) return JSON.stringify(results);
                }}
            }}
            return JSON.stringify(results);
        }})()
        """, timeout=8.0)
        if not raw:
            return []
        try:
            return json.loads(str(raw)) or []
        except Exception:
            return []

    def _href_matches_target(self, href: str, video_id: str) -> bool:
        if not href or not video_id:
            return False
        h = href.lower()
        if video_id.lower() not in h:
            return False
        return "/watch" in h or "youtu.be/" in h or "v=" in h

    def _title_matches_notification(self, text: str, title_lower: str) -> bool:
        if not title_lower or len(title_lower) <= 5:
            return False
        words = [w for w in title_lower.split() if len(w) > 3]
        if not words:
            return False
        matches = sum(1 for w in words if w in text)
        return (matches / len(words)) >= 0.6

    async def _find_target_notification(self) -> Optional[str]:
        """
        Scan notification items BEFORE any click.
        Assigned task video must appear in the panel (video_id in watch href).
        Title-only match allowed only when href is already a verified watch link.
        """
        self._log(f"[NotifPath] Scanning notifications for video {self._target.video_id!r}")

        video_id    = self._target.video_id or ""
        channel_lower = (getattr(self._target, "channel_name", None) or "").lower()

        scroll_passes = self._rng.randint(2, 4)
        all_items: list[dict] = []

        for sp in range(1, scroll_passes + 1):
            self._log(f"[NotifPath] Scan pass {sp}/{scroll_passes}")
            batch = await self._collect_notification_items()
            for item in batch:
                href = item.get("href", "")
                if href and not any(x.get("href") == href for x in all_items):
                    all_items.append(item)
            if video_id and any(self._href_matches_target(i.get("href", ""), video_id) for i in batch):
                break
            if sp < scroll_passes:
                await self._scroll_notification_panel(passes=1)

        if not all_items:
            self._log("[NotifPath] No notification items found in panel")
            return None

        self._log(f"[NotifPath] Found {len(all_items)} notification items — matching assigned video")

        # Strict: assigned task video_id must appear in a watch/youtu.be href
        for item in all_items:
            href = item.get("href", "")
            if self._href_matches_target(href, video_id):
                text = item.get("text", "")
                if channel_lower and len(channel_lower) > 3 and channel_lower not in text:
                    self._log("[NotifPath] video_id matched but channel text mismatch — skip")
                    continue
                self._log(f"[NotifPath] ✓ Assigned video in notifications href={href[:70]}")
                return href

        self._log(
            f"[NotifPath] Assigned video {video_id!r} NOT in notifications "
            f"(scanned {len(all_items)} items) — will not click random notification"
        )
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
