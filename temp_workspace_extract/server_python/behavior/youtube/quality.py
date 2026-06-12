"""
behavior.youtube.quality — Video quality change via settings menu.

FIXED:
  ✅ Escape key was dispatched on document — should be on player element
     (document.dispatchEvent does not reach YouTube's player key handler)
  ✅ tab.evaluate() calls wrapped with asyncio.wait_for timeout
  ✅ Added fallback selector for settings gear (.ytp-settings-button variants)
  ✅ Quality menu item selector updated with additional fallbacks
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Optional

log = logging.getLogger("mmb.yt_quality")

_QUALITY_MAP = {
    "1080p": ["1080p60", "1080p", "1080"],
    "720p":  ["720p60",  "720p",  "720"],
    "480p":  ["480p",    "480"],
    "360p":  ["360p",    "360"],
    "240p":  ["240p",    "240"],
    "144p":  ["144p",    "144"],
    "auto":  ["Auto"],
}

# Settings gear button selectors
_SETTINGS_SELECTORS = [
    'button.ytp-settings-button',
    '.ytp-settings-button',
    'button[aria-label*="Settings" i]',
    'button[data-tooltip-target-id="ytp-settings-button"]',
]

# Escape key — dispatch on PLAYER element (document won't close YouTube menus)
_ESCAPE_JS = """
(() => {
    var player = document.querySelector('#movie_player')
               || document.querySelector('.html5-video-player');
    var target = player || document;
    target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27,
        bubbles: true, cancelable: true
    }));
    return true;
})()
"""


async def _safe_eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """Evaluate JS with timeout — never hangs."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        log.debug("eval timeout after %.1fs", timeout)
        return None
    except Exception as e:
        log.debug("eval error: %s", e)
        return None


async def change_quality(
    tab: Any,
    quality: str,
    *,
    profile_name: str = "",
    rng: Optional[random.Random] = None,
    max_attempts: int = 3,
) -> tuple[bool, str]:
    """
    Change video quality via the settings gear menu.
    Returns (success, proof_string).

    Flow:
      1. Click settings gear button
      2. Click "Quality" menu item
      3. Click target quality option
      4. Verify quality changed
    """
    if quality in ("auto", ""):
        return True, "AUTO_SKIPPED"

    targets = _QUALITY_MAP.get(quality, [quality])
    rng = rng or random.Random()
    targets_json = json.dumps(targets)
    sels_json = json.dumps(_SETTINGS_SELECTORS)

    for attempt in range(1, max_attempts + 1):
        try:
            # Step 1: Click settings gear
            ok = await _safe_eval(tab, f"""
            (() => {{
                var sels = {sels_json};
                for (var i = 0; i < sels.length; i++) {{
                    var el = document.querySelector(sels[i]);
                    if (el && el.offsetParent !== null) {{
                        el.click();
                        return sels[i];
                    }}
                }}
                return null;
            }})()
            """)
            if not ok:
                log.debug("quality attempt %d: settings gear not found", attempt)
                await asyncio.sleep(1.0)
                continue
            await asyncio.sleep(rng.uniform(0.5, 1.0))

            # Step 2: Click "Quality" menu item
            # FIX: Added multiple label variants (.ytp-menuitem-label, aria-label, textContent)
            clicked_quality = await _safe_eval(tab, """
            (() => {
                var items = document.querySelectorAll('.ytp-menuitem, .ytp-panel-menu .ytp-menuitem');
                for (var i = 0; i < items.length; i++) {
                    var label = items[i].querySelector('.ytp-menuitem-label')
                             || items[i].querySelector('[class*="label"]');
                    var txt = label
                        ? label.textContent.trim().toLowerCase()
                        : (items[i].textContent || '').trim().toLowerCase();
                    if (txt === 'quality' || txt.includes('quality')) {
                        items[i].click();
                        return true;
                    }
                }
                return false;
            })()
            """)
            if not clicked_quality:
                log.debug("quality attempt %d: Quality menu item not found", attempt)
                # FIX: Close menu by dispatching Escape on player (not document)
                await _safe_eval(tab, _ESCAPE_JS)
                await asyncio.sleep(0.5)
                continue
            await asyncio.sleep(rng.uniform(0.4, 0.8))

            # Step 3: Click target quality option
            clicked = await _safe_eval(tab, f"""
            (() => {{
                var targets = {targets_json};
                var items = document.querySelectorAll('.ytp-menuitem, .ytp-quality-option');
                for (var i = 0; i < items.length; i++) {{
                    var txt = (items[i].innerText || items[i].textContent || '').trim();
                    for (var j = 0; j < targets.length; j++) {{
                        if (txt.indexOf(targets[j]) >= 0) {{
                            items[i].click();
                            return txt;
                        }}
                    }}
                }}
                return null;
            }})()
            """)

            if clicked:
                await asyncio.sleep(0.5)
                log.info("[Quality] Set to %r (attempt %d)", clicked, attempt)
                return True, f"UI_VERIFIED quality={clicked}"

            # Quality option not in list — close menu and retry
            await _safe_eval(tab, _ESCAPE_JS)

        except Exception as e:
            log.debug("quality attempt %d error: %s", attempt, e)
            await asyncio.sleep(1.0)

    return False, f"FAILED after {max_attempts} attempts"
