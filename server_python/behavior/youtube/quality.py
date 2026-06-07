"""
behavior.youtube.quality — Video quality change via settings menu.
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
    "720p": ["720p60", "720p", "720"],
    "480p": ["480p", "480"],
    "360p": ["360p", "360"],
    "240p": ["240p", "240"],
    "144p": ["144p", "144"],
    "auto": ["Auto"],
}


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
    """
    if quality in ("auto", ""):
        return True, "AUTO_SKIPPED"

    targets = _QUALITY_MAP.get(quality, [quality])
    rng = rng or random.Random()

    for attempt in range(1, max_attempts + 1):
        try:
            # 1. Click settings gear
            ok = await _click_selector(tab, [
                'button.ytp-settings-button',
                'button[aria-label*="Settings" i]',
                '.ytp-settings-button',
            ])
            if not ok:
                continue
            await asyncio.sleep(rng.uniform(0.5, 1.0))

            # 2. Find and click "Quality" menu item
            clicked_quality = await tab.evaluate("""
            (() => {
                var items = document.querySelectorAll('.ytp-menuitem');
                for (var i = 0; i < items.length; i++) {
                    var label = items[i].querySelector('.ytp-menuitem-label');
                    if (label && label.textContent.trim().toLowerCase() === 'quality') {
                        items[i].click(); return true;
                    }
                }
                return false;
            })()
            """, return_by_value=True)
            clicked_quality = getattr(clicked_quality, "value", clicked_quality)
            if not clicked_quality:
                await tab.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))", return_by_value=True)
                continue
            await asyncio.sleep(rng.uniform(0.4, 0.8))

            # 3. Click the target quality option
            targets_json = json.dumps(targets)
            clicked = await tab.evaluate(f"""
            (() => {{
                var targets = {targets_json};
                var items = document.querySelectorAll('.ytp-menuitem');
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
            """, return_by_value=True)
            clicked_val = getattr(clicked, "value", clicked)

            if clicked_val:
                await asyncio.sleep(0.5)
                return True, f"UI_VERIFIED quality={clicked_val}"

            # Close menu
            await tab.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))", return_by_value=True)

        except Exception as e:
            log.debug("quality attempt %d error: %s", attempt, e)
        await asyncio.sleep(1.0)

    return False, f"FAILED after {max_attempts} attempts"


async def _click_selector(tab: Any, selectors: list[str]) -> bool:
    sels_json = json.dumps(selectors)
    try:
        result = await tab.evaluate(f"""
        (() => {{
            var sels = {sels_json};
            for (var i = 0; i < sels.length; i++) {{
                var el = document.querySelector(sels[i]);
                if (el && el.offsetParent !== null) {{ el.click(); return true; }}
            }}
            return false;
        }})()
        """, return_by_value=True)
        return bool(getattr(result, "value", result))
    except Exception:
        return False
