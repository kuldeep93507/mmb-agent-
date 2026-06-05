"""
SemanticResolver — Crash-proof self-healing element finder for MMB AGENT 24/7

Strategy order (each tried in sequence, first hit wins):
  1. CSS selectors      (from selectors.SELECTOR_MAP)
  2. XPath expressions  (via JS document.evaluate)
  3. aria-label match   (JS querySelectorAll + substring check)
  4. visible text match (JS TreeWalker innerText check)
  5. js_hint            (raw JS expression from selector map)
  6. AI screenshot      (Claude vision — last resort, only if ai_brain available)

On total failure:
  - Logs to SELECTOR_FAILURE_LOG (defined in yt_types.py)
  - Raises ElementNotFoundError (never a bare Exception)
  - Optionally saves screenshot for debugging
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from server_python.yt_types import ElementNotFoundError, SELECTOR_FAILURE_LOG, FAIL_SCREENSHOT_DIR
import server_python.yt_selectors as selectors_db

log = logging.getLogger("mmb.resolver")


# ── JS helpers (run inside page) ──────────────────────────────────────────────

_JS_CSS = """
(function(selector) {{
    try {{ return document.querySelector(selector); }}
    catch(e) {{ return null; }}
}})('{css}')
""".strip()

_JS_XPATH = """
(function(expr) {
    try {
        var r = document.evaluate(expr, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return r.singleNodeValue;
    } catch(e) { return null; }
})(arguments[0])
""".strip()

_JS_ARIA = """
(function(labels) {
    var all = document.querySelectorAll('[aria-label]');
    for (var i = 0; i < all.length; i++) {
        var lbl = (all[i].getAttribute('aria-label') || '').toLowerCase();
        for (var j = 0; j < labels.length; j++) {
            if (lbl.indexOf(labels[j].toLowerCase()) !== -1) return all[i];
        }
    }
    return null;
})(arguments[0])
""".strip()

_JS_TEXT = """
(function(texts) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
        var t = (node.innerText || node.textContent || '').toLowerCase().trim();
        for (var i = 0; i < texts.length; i++) {
            if (t.indexOf(texts[i].toLowerCase()) !== -1 && t.length < 200)
                return node;
        }
    }
    return null;
})(arguments[0])
""".strip()


class SemanticResolver:
    """
    Crash-proof element finder.

    Usage:
        resolver = SemanticResolver(tab, rng=rng, log_fn=log.info)
        el = await resolver.find("like_button")
        el = await resolver.find("like_button", timeout=10.0)
    """

    def __init__(
        self,
        tab: Any,
        *,
        rng=None,
        log_fn=None,
        ai_brain=None,
        timeout: float = 12.0,
    ) -> None:
        self._tab = tab
        self._rng = rng
        self._log = log_fn or (lambda m: log.info(m))
        self._ai = ai_brain          # optional ai_brain module reference
        self._default_timeout = timeout

    # ── Public API ────────────────────────────────────────────────────────────

    async def find(
        self,
        key: str,
        *,
        timeout: Optional[float] = None,
        required: bool = True,
    ) -> Any:
        """
        Find element by logical key (e.g. 'like_button').
        Returns element or None (if required=False).
        Raises ElementNotFoundError if required=True and not found.
        """
        timeout = timeout or self._default_timeout
        entry = selectors_db.get(key)

        if not entry:
            self._log(f"[Resolver] Unknown key: {key!r} — trying as raw CSS")
            entry = {"css": [key]}

        deadline = time.monotonic() + timeout
        attempt = 0

        while time.monotonic() < deadline:
            attempt += 1
            el = await self._try_all_strategies(key, entry)
            if el is not None:
                if attempt > 1:
                    self._log(f"[Resolver] ✓ Found {key!r} on attempt {attempt}")
                return el

            # Poll every 600ms before deadline
            remaining = deadline - time.monotonic()
            if remaining > 0.6:
                await asyncio.sleep(0.6)
            else:
                break

        # All strategies failed — last resort: AI screenshot
        el = await self._try_ai_fallback(key, entry)
        if el is not None:
            self._log(f"[Resolver] ✓ AI fallback found {key!r}")
            return el

        # Log failure
        await self._log_failure(key, entry)

        if required:
            raise ElementNotFoundError(
                f"SemanticResolver: could not find element '{key}' "
                f"after {timeout}s using all strategies"
            )
        return None

    async def find_all(self, key: str, *, timeout: float = 8.0) -> list:
        """
        Find all matching elements for a key.
        Tries CSS first, then JS querySelectorAll for each CSS, then XPath.
        """
        entry = selectors_db.get(key)
        css_list = entry.get("css", [])
        xpath_list = entry.get("xpath", [])
        results = []
        deadline = time.monotonic() + timeout

        while time.monotonic() < deadline and not results:
            # Strategy 1: CSS via nodriver find_all
            for css in css_list:
                try:
                    els = await self._tab.find_all(css)
                    if els:
                        results = els
                        break
                except Exception:
                    pass

            # Strategy 2: JS querySelectorAll (more reliable for custom elements)
            if not results:
                for css in css_list:
                    try:
                        import json as _json
                        raw = await self._tab.evaluate(
                            f"""(function(){{
                                var els = Array.from(document.querySelectorAll({_json.dumps(css)}));
                                return els.length;
                            }})()""",
                            return_by_value=True,
                        )
                        count = int(getattr(raw, "value", raw) or 0)
                        if count > 0:
                            # Return via tab.find_all again now that we know they exist
                            try:
                                els = await self._tab.find_all(css)
                                if els:
                                    results = els
                                    break
                            except Exception:
                                pass
                    except Exception:
                        pass

            # Strategy 3: XPath — collect all matching elements
            if not results and xpath_list:
                for xp in xpath_list:
                    try:
                        import json as _json
                        els = await self._tab.evaluate(
                            f"""(function(){{
                                var out=[];
                                try {{
                                    var snap=document.evaluate(
                                        {_json.dumps(xp)},document,null,
                                        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null
                                    );
                                    for(var i=0;i<snap.snapshotLength;i++)
                                        out.push(snap.snapshotItem(i));
                                }} catch(e) {{}}
                                return out.length;
                            }})()""",
                            return_by_value=True,
                        )
                        # XPath found something — try CSS from entry as proxy
                        count = int(getattr(els, "value", els) or 0)
                        if count > 0 and css_list:
                            try:
                                found = await self._tab.find_all(css_list[0])
                                if found:
                                    results = found
                                    break
                            except Exception:
                                pass
                    except Exception:
                        pass

            if not results:
                await asyncio.sleep(0.5)

        return results

    async def wait_visible(self, key: str, timeout: float = 15.0) -> Any:
        """Wait until element is visible (has offsetParent or getBoundingClientRect)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            el = await self.find(key, timeout=2.0, required=False)
            if el is not None:
                visible = await self._is_visible(el)
                if visible:
                    return el
            await asyncio.sleep(0.5)

        raise ElementNotFoundError(f"Element '{key}' not visible after {timeout}s")

    # ── Strategy 1: CSS ───────────────────────────────────────────────────────

    async def _try_css(self, css_list: list[str]) -> Any:
        for css in css_list:
            try:
                el = await self._tab.find(css, timeout=1)
                if el is not None:
                    return el
            except Exception:
                pass
            # Also try via JS querySelector
            try:
                safe_css = css.replace("'", "\\'")
                el = await self._tab.evaluate(f"document.querySelector('{safe_css}')")
                if el is not None:
                    return el
            except Exception:
                pass
        return None

    # ── Strategy 2: XPath ─────────────────────────────────────────────────────

    async def _try_xpath(self, xpath_list: list[str]) -> Any:
        for xp in xpath_list:
            try:
                # nodriver: use evaluate with JS document.evaluate
                js = f"""(function(){{
                    try{{
                        var r=document.evaluate({json.dumps(xp)},document,null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE,null);
                        return r.singleNodeValue;
                    }}catch(e){{return null;}}
                }})()"""
                el = await self._tab.evaluate(js)
                if el is not None:
                    return el
            except Exception:
                pass
        return None

    # ── Strategy 3: aria-label ────────────────────────────────────────────────

    async def _try_aria(self, aria_list: list[str]) -> Any:
        if not aria_list:
            return None
        try:
            js = f"""(function(labels){{
                var all=document.querySelectorAll('[aria-label]');
                for(var i=0;i<all.length;i++){{
                    var lbl=(all[i].getAttribute('aria-label')||'').toLowerCase();
                    for(var j=0;j<labels.length;j++){{
                        if(lbl.indexOf(labels[j].toLowerCase())!==-1) return all[i];
                    }}
                }}
                return null;
            }})({json.dumps(aria_list)})"""
            el = await self._tab.evaluate(js)
            return el if el is not None else None
        except Exception:
            return None

    # ── Strategy 4: visible text ──────────────────────────────────────────────

    async def _try_text(self, text_list: list[str]) -> Any:
        if not text_list:
            return None
        try:
            js = f"""(function(texts){{
                var all=document.querySelectorAll('button,a,[role="button"],[role="link"],span,div');
                for(var i=0;i<all.length;i++){{
                    var t=(all[i].innerText||all[i].textContent||'').toLowerCase().trim();
                    if(t.length>150) continue;
                    for(var j=0;j<texts.length;j++){{
                        if(t===texts[j].toLowerCase()||t.indexOf(texts[j].toLowerCase())!==-1)
                            return all[i];
                    }}
                }}
                return null;
            }})({json.dumps(text_list)})"""
            el = await self._tab.evaluate(js)
            return el if el is not None else None
        except Exception:
            return None

    # ── Strategy 5: js_hint ───────────────────────────────────────────────────

    async def _try_js_hint(self, js_hint: Optional[str]) -> Any:
        if not js_hint:
            return None
        try:
            el = await self._tab.evaluate(f"(function(){{return {js_hint}}})()")
            return el if el is not None else None
        except Exception:
            return None

    # ── Strategy 6: AI screenshot fallback ───────────────────────────────────

    async def _try_ai_fallback(self, key: str, entry: dict) -> Any:
        """
        Use Claude vision to find element in screenshot.
        Uses scan_page_for_element() which returns a CSS selector directly.
        """
        if self._ai is None:
            return None
        try:
            screenshot_bytes = await self._tab.screenshot()
            if not screenshot_bytes:
                return None

            b64 = base64.b64encode(screenshot_bytes).decode()

            # Build human-readable description from entry
            descriptions = []
            if entry.get("aria"):
                descriptions.append(f"aria-label: {entry['aria']}")
            if entry.get("text"):
                descriptions.append(f"text: {entry['text']}")
            descriptions.append(f"element: {key}")
            element_description = "; ".join(descriptions)

            # Use scan_page_for_element — returns {"found", "css_selector", ...}
            result = self._ai.scan_page_for_element(
                dom_summary="",          # empty — using screenshot
                element_description=element_description,
                screenshot_b64=b64,
            )

            if result and result.get("found") and result.get("css_selector"):
                css_str = result["css_selector"]
                self._log(f"[Resolver] AI scan found {key!r}: css={css_str!r}")
                try:
                    import json as _json
                    el = await self._tab.evaluate(
                        f"document.querySelector({_json.dumps(css_str)})"
                    )
                    if el is not None:
                        return el
                except Exception as e:
                    log.debug(f"[Resolver] AI CSS try failed: {e}")

            # Fallback: try text_to_click from AI if selector failed
            text_hint = result.get("text_to_click") if result else None
            if text_hint:
                try:
                    import json as _json
                    el = await self._tab.evaluate(
                        f"""(function(){{
                            var want={_json.dumps(text_hint.lower())};
                            var els=document.querySelectorAll(
                                'button,a,[role="button"],tp-yt-paper-button'
                            );
                            for(var i=0;i<els.length;i++){{
                                var t=(els[i].innerText||els[i].textContent||'').trim().toLowerCase();
                                if(t===want || t.startsWith(want)) return els[i];
                            }}
                            return null;
                        }})()"""
                    )
                    if el is not None:
                        self._log(f"[Resolver] AI text fallback found {key!r}: text={text_hint!r}")
                        return el
                except Exception:
                    pass

        except Exception as e:
            log.debug(f"[Resolver] AI fallback error: {e}")
        return None

    # ── All strategies ────────────────────────────────────────────────────────

    async def _try_all_strategies(self, key: str, entry: dict) -> Any:
        # Strategy 1: CSS
        css_list = entry.get("css", [])
        if css_list:
            el = await self._try_css(css_list)
            if el is not None:
                return el

        # Strategy 2: XPath
        xpath_list = entry.get("xpath", [])
        if xpath_list:
            el = await self._try_xpath(xpath_list)
            if el is not None:
                return el

        # Strategy 3: aria-label
        aria_list = entry.get("aria", [])
        if aria_list:
            el = await self._try_aria(aria_list)
            if el is not None:
                return el

        # Strategy 4: text
        text_list = entry.get("text", [])
        if text_list:
            el = await self._try_text(text_list)
            if el is not None:
                return el

        # Strategy 5: js_hint
        js_hint = entry.get("js_hint")
        if js_hint:
            el = await self._try_js_hint(js_hint)
            if el is not None:
                return el

        return None

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _is_visible(self, el: Any) -> bool:
        """Check if element is visible in the viewport."""
        try:
            result = await self._tab.evaluate(
                """(function(el){
                    if(!el) return false;
                    var rect=el.getBoundingClientRect();
                    return rect.width>0 && rect.height>0 &&
                           rect.top < window.innerHeight && rect.bottom > 0;
                })(arguments[0])""",
                el
            )
            return bool(result)
        except Exception:
            return True  # assume visible on error

    async def _get_current_url(self) -> str:
        try:
            return await self._tab.evaluate("window.location.href")
        except Exception:
            return "unknown"

    async def _log_failure(self, key: str, entry: dict) -> None:
        """Log selector failure to file for later analysis."""
        try:
            Path(SELECTOR_FAILURE_LOG).parent.mkdir(parents=True, exist_ok=True)
            with open(SELECTOR_FAILURE_LOG, "a", encoding="utf-8") as f:
                ts = time.strftime("%Y-%m-%d %H:%M:%S")
                url = await self._get_current_url()
                f.write(
                    f"[{ts}] FAILED key={key!r} url={url!r} "
                    f"css={entry.get('css',[])} "
                    f"aria={entry.get('aria',[])} "
                    f"text={entry.get('text',[])}\n"
                )
            self._log(f"[Resolver] ✗ FAILED to find {key!r} — logged to {SELECTOR_FAILURE_LOG}")
        except Exception as e:
            log.debug(f"[Resolver] Log failure error: {e}")

        # Optionally save screenshot
        try:
            Path(FAIL_SCREENSHOT_DIR).mkdir(parents=True, exist_ok=True)
            ts_file = time.strftime("%Y%m%d_%H%M%S")
            fname = Path(FAIL_SCREENSHOT_DIR) / f"fail_{key}_{ts_file}.png"
            screenshot_bytes = await self._tab.screenshot()
            if screenshot_bytes:
                fname.write_bytes(screenshot_bytes)
        except Exception:
            pass
