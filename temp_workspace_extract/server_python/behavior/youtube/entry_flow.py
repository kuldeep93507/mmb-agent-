"""
behavior.youtube.entry_flow — Consent/cookie banner dismissal.

FIXED:
  ✅ _CONSENT_SELECTORS was passed via Python str() into JS — invalid format.
     Python list str() gives single-quoted strings which JS cannot parse.
     Fixed: use json.dumps() to produce valid JSON array for JS.
  ✅ tab.evaluate() wrapped with asyncio.wait_for timeout=8s (no hang).
"""
from __future__ import annotations

import asyncio
import json
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

# Pre-serialise once at import time — valid JSON, not Python repr
_CONSENT_SELECTORS_JSON = json.dumps(_CONSENT_SELECTORS)


async def accept_consent_if_present(tab: Any) -> bool:
    """
    Dismiss YouTube consent/cookie popup if present.
    Returns True if a consent button was clicked.

    FIX: Previously used str(_CONSENT_SELECTORS) which produced Python-style
    single-quoted list — JS cannot parse that. Now uses json.dumps() which
    produces valid JSON double-quoted array.
    """
    if not tab:
        return False
    try:
        # FIX: json.dumps produces valid JS array — str() produced broken Python repr
        js = f"""
        (() => {{
            var sels = {_CONSENT_SELECTORS_JSON};
            for (var i = 0; i < sels.length; i++) {{
                var btn = document.querySelector(sels[i]);
                if (btn && btn.offsetParent !== null) {{
                    btn.click();
                    return 'clicked:' + sels[i];
                }}
            }}
            return null;
        }})()
        """
        # FIX: asyncio.wait_for prevents infinite hang if tab is unresponsive
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=8.0
        )
        val = getattr(result, "value", result)
        if val and str(val).startswith("clicked"):
            log.info("Consent dismissed: %s", val)
            await asyncio.sleep(1.0)
            return True
    except asyncio.TimeoutError:
        log.debug("consent check timed out (no popup present)")
    except Exception as e:
        log.debug("consent error: %s", e)
    return False
