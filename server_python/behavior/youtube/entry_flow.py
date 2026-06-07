"""
behavior.youtube.entry_flow — Consent/cookie banner dismissal.
"""
from __future__ import annotations
import asyncio
import logging
from typing import Any

log = logging.getLogger("mmb.yt_entry")

_CONSENT_SELECTORS = [
    'button[aria-label*="Accept all" i]',
    'button[aria-label*="Accept the use of cookies" i]',
    'ytd-button-renderer:has(button[aria-label*="Accept" i]) button',
    'button.yt-spec-button-shape-next--filled',
    '#yDmH0d button[jsname="b3VHJd"]',
    'form[action*="consent"] button[value="1"]',
    'form[action*="consent"] button[jsaction]',
    'button[jsname="higCR"]',
]


async def accept_consent_if_present(tab: Any) -> bool:
    """Dismiss YouTube consent/cookie popup if present. Returns True if clicked."""
    if not tab:
        return False
    try:
        result = await tab.evaluate("""
        (() => {
            var sels = """ + str(_CONSENT_SELECTORS) + """;
            for (var i = 0; i < sels.length; i++) {
                var btn = document.querySelector(sels[i]);
                if (btn && btn.offsetParent !== null) {
                    btn.click();
                    return 'clicked:' + sels[i];
                }
            }
            return null;
        })()
        """, return_by_value=True)
        val = getattr(result, "value", result)
        if val and str(val).startswith("clicked"):
            log.info("Consent dismissed: %s", val)
            await asyncio.sleep(1.0)
            return True
    except Exception as e:
        log.debug("consent error: %s", e)
    return False
