"""
Safe browser action helpers — fallback chain pattern for all YouTube interactions.

Har action pe pehle selector #1 try karo, fail → #2 → #3 → JS API last resort.
Sab actions JSON-line logs mein jaate hain (logs/actions.jsonl).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, Sequence, Union

from nodriver import cdp

from behavior.youtube.anti_detect import (
    human_click_element,
    human_delay,
    human_type_text,
    page_is_safe,
    get_rng,
)

log = logging.getLogger("mmb.safe_actions")

ROOT = Path(__file__).resolve().parent.parent.parent
ACTION_LOG_DIR = ROOT / "logs"
ACTION_LOG_FILE = ACTION_LOG_DIR / "actions.jsonl"

SelectorInput = Union[str, Sequence[str], tuple]


def _normalize_selectors(selector_list: SelectorInput) -> list[str]:
    """Convert tuple/list/single string to flat selector list."""
    if isinstance(selector_list, str):
        return [selector_list]
    return list(selector_list)


def _action_log(
    *,
    action_name: str,
    success: bool,
    selector_index: Optional[int],
    selector: Optional[str],
    elapsed_ms: float,
    tab: Any = None,
    profile_name: str = "",
    proxy_ip: str = "",
    error: str = "",
    extra: Optional[dict] = None,
) -> None:
    """Write JSON-line action log — easy parsing ke liye."""
    url = ""
    video_id = ""
    try:
        if tab is not None:
            url = getattr(tab, "url", "") or ""
            if "v=" in url:
                video_id = url.split("v=")[1].split("&")[0]
    except Exception:
        pass

    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": action_name,
        "success": success,
        "selector_index": selector_index,
        "selector": selector,
        "elapsed_ms": round(elapsed_ms, 1),
        "url": url,
        "video_id": video_id,
        "profile": profile_name,
        "proxy_ip": proxy_ip,
        "error": error,
        **(extra or {}),
    }
    try:
        ACTION_LOG_DIR.mkdir(parents=True, exist_ok=True)
        with ACTION_LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as exc:
        log.warning("Action log write failed: %s", exc)

    if success:
        log.info(
            "✅ %s via #%s (%s) — %.0fms vid=%s",
            action_name,
            (selector_index or 0) + 1,
            (selector or "js")[:60],
            elapsed_ms,
            video_id or "?",
        )
    else:
        log.error("❌ %s ALL selectors failed — %.0fms — %s", action_name, elapsed_ms, error)


async def _cdp_click_at(tab: Any, selector: str) -> bool:
    """Real CDP mouse click at element center — JS .click() blocks bypass."""
    try:
        rect = await safe_eval_js(
            tab,
            f"""
            var el = document.querySelector({json.dumps(selector)});
            if (!el) return null;
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return JSON.stringify({{x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}});
            """,
            action_name="cdp_rect",
            log_result=False,
        )
        if not rect or str(rect) == "null":
            return False
        coords = json.loads(str(rect))
        x, y = float(coords["x"]), float(coords["y"])
        await tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
        await asyncio.sleep(0.08)
        await tab.send(
            cdp.input_.dispatch_mouse_event(
                type_="mousePressed",
                x=x,
                y=y,
                button=cdp.input_.MouseButton.LEFT,
                click_count=1,
            )
        )
        await asyncio.sleep(0.08)
        await tab.send(
            cdp.input_.dispatch_mouse_event(
                type_="mouseReleased",
                x=x,
                y=y,
                button=cdp.input_.MouseButton.LEFT,
                click_count=1,
            )
        )
        return True
    except Exception:
        return False


async def safe_find(
    tab: Any,
    selector_list: SelectorInput,
    *,
    timeout: float = 5.0,
    action_name: str = "FIND",
) -> tuple[Any | None, int, str]:
    """
    Try each selector in order. Return (element, index, selector) or (None, -1, "").

    Args:
        tab: nodriver Tab instance.
        selector_list: Ordered fallback selectors.
        timeout: Per-selector wait timeout in seconds.
        action_name: Label for logging.

    Returns:
        Tuple of (element or None, winning index, winning selector).
    """
    selectors = _normalize_selectors(selector_list)
    start = time.monotonic()

    for idx, selector in enumerate(selectors):
        try:
            element = await tab.select(selector, timeout=timeout)
            if element:
                elapsed = (time.monotonic() - start) * 1000
                _action_log(
                    action_name=action_name,
                    success=True,
                    selector_index=idx,
                    selector=selector,
                    elapsed_ms=elapsed,
                    tab=tab,
                )
                return element, idx, selector
        except Exception as exc:
            log.debug("⚠️  %s selector #%d failed: %s → %s", action_name, idx + 1, selector, exc)
            continue

    elapsed = (time.monotonic() - start) * 1000
    _action_log(
        action_name=action_name,
        success=False,
        selector_index=None,
        selector=None,
        elapsed_ms=elapsed,
        tab=tab,
        error=f"all {len(selectors)} selectors failed",
    )
    return None, -1, ""


async def safe_click(
    tab: Any,
    selector_list: SelectorInput,
    *,
    timeout: float = 5.0,
    action_name: str = "",
    use_cdp: bool = False,
    human: bool = True,
    check_page_safe: bool = True,
    profile_name: str = "",
    proxy_ip: str = "",
    rng: Any = None,
) -> bool:
    """
    Try each selector in order. Click first found element.

    Anti-detection (Rule A): default human=True uses Bezier mouse + CDP click.
    NEVER raw element.click() unless human=False explicitly.

    Args:
        tab: nodriver Tab.
        selector_list: Fallback chain.
        timeout: Per-selector timeout.
        action_name: Human-readable action label.
        use_cdp: Force legacy CDP rect click (skip Bezier).
        human: Use human_click_element (Bezier + hesitation).
        check_page_safe: Run page_is_safe() before clicking (Rule K).
        profile_name: Profile name for logs.
        proxy_ip: Proxy IP for logs.
        rng: Profile-seeded random for human behavior.

    Returns:
        True on success, False on total failure.
    """
    name = action_name or "CLICK"
    selectors = _normalize_selectors(selector_list)
    start = time.monotonic()
    r = rng or get_rng()

    if check_page_safe and not await page_is_safe(tab):
        _action_log(
            action_name=name,
            success=False,
            selector_index=None,
            selector=None,
            elapsed_ms=0,
            tab=tab,
            profile_name=profile_name,
            proxy_ip=proxy_ip,
            error="page_not_safe",
        )
        return False

    for idx, selector in enumerate(selectors):
        try:
            element = await tab.select(selector, timeout=timeout)
            if not element:
                continue

            clicked = False
            if use_cdp:
                clicked = await _cdp_click_at(tab, selector)
                method = "cdp_rect"
            elif human:
                clicked = await human_click_element(tab, element, rng=r)
                method = "human_bezier"
            else:
                await element.click()
                clicked = True
                method = "raw_click"

            if clicked:
                elapsed = (time.monotonic() - start) * 1000
                _action_log(
                    action_name=name,
                    success=True,
                    selector_index=idx,
                    selector=selector,
                    elapsed_ms=elapsed,
                    tab=tab,
                    profile_name=profile_name,
                    proxy_ip=proxy_ip,
                    extra={"method": method},
                )
                return True
        except Exception as exc:
            log.debug("⚠️  %s selector #%d failed: %s → %s", name, idx + 1, selector, exc)
            continue

    elapsed = (time.monotonic() - start) * 1000
    _action_log(
        action_name=name,
        success=False,
        selector_index=None,
        selector=None,
        elapsed_ms=elapsed,
        tab=tab,
        profile_name=profile_name,
        proxy_ip=proxy_ip,
        error=f"ALL {len(selectors)} selectors failed",
    )
    return False


async def safe_type(
    tab: Any,
    selector_list: SelectorInput,
    text: str,
    *,
    timeout: float = 5.0,
    action_name: str = "TYPE",
    human: bool = True,
    rng: Any = None,
) -> bool:
    """
    Find input via fallback chain, human-click, then type text.

    Anti-detection (Rule B): human=True uses gaussian delays + typos + thinking pauses.
    NEVER bulk paste.

    Args:
        tab: nodriver Tab.
        selector_list: Input element selectors.
        text: Text to type.
        timeout: Find timeout.
        action_name: Log label.
        human: Human-like typing with variable speed.
        rng: Profile-seeded random.

    Returns:
        True if typed successfully.
    """
    element, idx, selector = await safe_find(tab, selector_list, timeout=timeout, action_name=f"{action_name}_FIND")
    if not element:
        return False

    start = time.monotonic()
    r = rng or get_rng()
    try:
        await human_click_element(tab, element, rng=r)
        await asyncio.sleep(r.uniform(0.15, 0.4))
        if human:
            await human_type_text(tab, text, rng=r)
        else:
            await tab.send(cdp.input_.insert_text(text=text))

        elapsed = (time.monotonic() - start) * 1000
        _action_log(
            action_name=action_name,
            success=True,
            selector_index=idx,
            selector=selector,
            elapsed_ms=elapsed,
            tab=tab,
            extra={"text_len": len(text)},
        )
        return True
    except Exception as exc:
        elapsed = (time.monotonic() - start) * 1000
        _action_log(
            action_name=action_name,
            success=False,
            selector_index=idx,
            selector=selector,
            elapsed_ms=elapsed,
            tab=tab,
            error=str(exc),
        )
        return False


async def safe_wait(
    tab: Any,
    selector_list: SelectorInput,
    *,
    timeout: float = 15.0,
    action_name: str = "WAIT",
    poll_interval: float = 0.5,
) -> bool:
    """
    Poll until any selector matches or timeout.

    Returns:
        True if element appeared.
    """
    selectors = _normalize_selectors(selector_list)
    start = time.monotonic()
    deadline = start + timeout

    while time.monotonic() < deadline:
        for idx, selector in enumerate(selectors):
            try:
                element = await tab.select(selector, timeout=0.3)
                if element:
                    elapsed = (time.monotonic() - start) * 1000
                    _action_log(
                        action_name=action_name,
                        success=True,
                        selector_index=idx,
                        selector=selector,
                        elapsed_ms=elapsed,
                        tab=tab,
                    )
                    return True
            except Exception:
                continue
        await asyncio.sleep(poll_interval)

    elapsed = (time.monotonic() - start) * 1000
    _action_log(
        action_name=action_name,
        success=False,
        selector_index=None,
        selector=None,
        elapsed_ms=elapsed,
        tab=tab,
        error=f"timeout after {timeout}s",
    )
    return False


def _build_eval_js(code: str, *, wrap: bool) -> str:
    """
    Build executable JS for tab.evaluate.

    BUG FIX: multi-line scripts must NOT be wrapped as `return (var x; ...)`
    — that is a syntax error and nodriver returns ExceptionDetails while
    callers assumed success.
    """
    stripped = code.strip()
    if not stripped:
        return "() => null"

    # Already an IIFE / expression wrapper
    if stripped.startswith("(") and ("=>" in stripped or "function" in stripped):
        return stripped

    if not wrap:
        return f"(() => {{ {code} }})()"

    # Multi-statement block (var/for/return/newline) — use block body, not return(expr)
    if (
        "\n" in stripped
        or ";" in stripped
        or any(stripped.startswith(kw) for kw in ("var ", "let ", "const ", "for ", "if ", "try ", "return "))
    ):
        return f"(() => {{ {code} }})()"

    return f"(() => {{ return ({code}); }})()"


def _unwrap_eval_result(result: Any) -> tuple[Any, str]:
    """Return (value, error). Treat CDP JS exceptions as failure."""
    value = result.value if hasattr(result, "value") else result
    cls = type(value).__name__
    if cls == "ExceptionDetails":
        detail = str(value)
        try:
            exc = getattr(value, "exception", None)
            if exc:
                detail = str(getattr(exc, "description", None) or exc)
            text = getattr(value, "text", None)
            if text:
                detail = str(text)
        except Exception:
            pass
        return None, detail or "JS_EXCEPTION"
    if hasattr(result, "exception_details") and getattr(result, "exception_details", None):
        return None, "JS_EXCEPTION"
    return value, ""


async def safe_eval_js(
    tab: Any,
    code: str,
    *,
    action_name: str = "JS_EVAL",
    log_result: bool = True,
    wrap: bool = True,
) -> Any:
    """
    Run JS in page context with error logging.

    Args:
        tab: nodriver Tab.
        code: JS expression or statement.
        action_name: Log label.
        log_result: Write to action log.
        wrap: Wrap code in IIFE for evaluate.

    Returns:
        Evaluated value or None on failure.
    """
    start = time.monotonic()
    try:
        js_code = _build_eval_js(code, wrap=wrap)
        result = await tab.evaluate(js_code, return_by_value=True)
        value, js_err = _unwrap_eval_result(result)
        elapsed = (time.monotonic() - start) * 1000

        if js_err:
            if log_result:
                _action_log(
                    action_name=action_name,
                    success=False,
                    selector_index=None,
                    selector="js",
                    elapsed_ms=elapsed,
                    tab=tab,
                    error=js_err,
                    extra={"result_type": "ExceptionDetails"},
                )
            log.warning("JS eval exception [%s]: %s", action_name, js_err)
            return None

        if log_result:
            _action_log(
                action_name=action_name,
                success=True,
                selector_index=None,
                selector="js",
                elapsed_ms=elapsed,
                tab=tab,
                extra={"result_type": type(value).__name__},
            )
        return value
    except Exception as exc:
        elapsed = (time.monotonic() - start) * 1000
        tb = traceback.format_exc()
        if log_result:
            _action_log(
                action_name=action_name,
                success=False,
                selector_index=None,
                selector="js",
                elapsed_ms=elapsed,
                tab=tab,
                error=f"{exc}\n{tb}",
            )
        log.debug("JS eval failed [%s]: %s", action_name, exc)
        return None


async def safe_click_key(
    tab: Any,
    key: str,
    *,
    platform: str = "desktop",
    action_name: str = "",
    profile_name: str = "",
    proxy_ip: str = "",
) -> bool:
    """
    Click element by V2 DESKTOP/MOBILE key name.

    Args:
        tab: nodriver Tab.
        key: Selector key e.g. 'like_button'.
        platform: 'desktop' or 'mobile'.
        action_name: Override log label.

    Returns:
        True on success.
    """
    from behavior.youtube.selectors import DESKTOP, MOBILE

    pool = DESKTOP if platform == "desktop" else MOBILE
    selectors = pool.get(key)
    if not selectors:
        log.error("Unknown selector key: %s", key)
        return False
    if isinstance(selectors, dict):
        log.error("Key %s is a dict, not a selector tuple", key)
        return False

    return await safe_click(
        tab,
        selectors,
        action_name=action_name or key.upper(),
        profile_name=profile_name,
        proxy_ip=proxy_ip,
    )


async def safe_click_verified(
    tab: Any,
    selector_list: SelectorInput,
    *,
    action_name: str,
    verify_fn: Optional[Callable] = None,
    timeout: float = 5.0,
    profile_name: str = "",
    proxy_ip: str = "",
    rng: Any = None,
    capture_screenshots: bool | None = None,
) -> dict:
    """
    Click with optional post-action verification and audit trail.

    Returns dict: success, selector_used, verified, verify_details, screenshots, dom states.
    success=True ONLY when click succeeded AND (verify_fn is None OR verified=True).
    """
    from behavior.youtube.action_audit import ActionAudit
    from behavior.youtube.verify_actions import capture_dom_state

    audit = ActionAudit.current()
    if capture_screenshots is None:
        capture_screenshots = audit is not None

    name = action_name or "CLICK"
    selectors = _normalize_selectors(selector_list)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
    shot_dir = ACTION_LOG_DIR / "screenshots"
    before_shot = ""
    after_shot = ""

    if capture_screenshots:
        try:
            shot_dir.mkdir(parents=True, exist_ok=True)
            before_shot = str(shot_dir / f"{name}_{ts}_before.png")
            await tab.save_screenshot(before_shot, format="png")
        except Exception:
            before_shot = ""

    dom_before = await capture_dom_state(tab, name)
    start = time.monotonic()

    for idx, selector in enumerate(selectors):
        try:
            element = await tab.select(selector, timeout=timeout)
            if not element:
                continue

            clicked = await human_click_element(tab, element, rng=rng or get_rng())
            if not clicked:
                continue

            await asyncio.sleep(0.5)

            if capture_screenshots:
                try:
                    after_shot = str(shot_dir / f"{name}_{ts}_after_s{idx}.png")
                    await tab.save_screenshot(after_shot, format="png")
                except Exception:
                    after_shot = ""

            dom_after = await capture_dom_state(tab, name)
            verified = None
            verify_details = ""
            if verify_fn is not None:
                verified = bool(await verify_fn(tab))
                verify_details = f"verify_fn returned {verified}"
                if not verified:
                    log.error(
                        "❌ [%s] click on #%d (%s) but VERIFICATION FAILED",
                        name, idx + 1, selector[:60],
                    )
                    continue

            elapsed = (time.monotonic() - start) * 1000
            _action_log(
                action_name=name,
                success=True,
                selector_index=idx,
                selector=selector,
                elapsed_ms=elapsed,
                tab=tab,
                profile_name=profile_name,
                proxy_ip=proxy_ip,
                extra={"verified": verified, "method": "human_bezier_verified"},
            )
            if audit:
                audit.record(
                    name.lower(),
                    selector_used=selector,
                    click_registered=True,
                    verified=verified if verify_fn else None,
                    screenshot_before=before_shot,
                    screenshot_after=after_shot,
                    reason=verify_details,
                    dom_before=dom_before,
                    dom_after=dom_after,
                )
            return {
                "success": True,
                "selector_used": selector,
                "selector_index": idx,
                "screenshot_before": before_shot,
                "screenshot_after": after_shot,
                "dom_state_before": dom_before,
                "dom_state_after": dom_after,
                "verified": verified,
                "verify_details": verify_details,
            }
        except Exception as exc:
            log.debug("[%s] selector #%d failed: %s", name, idx + 1, exc)
            continue

    elapsed = (time.monotonic() - start) * 1000
    _action_log(
        action_name=name,
        success=False,
        selector_index=None,
        selector=None,
        elapsed_ms=elapsed,
        tab=tab,
        profile_name=profile_name,
        proxy_ip=proxy_ip,
        error=f"ALL {len(selectors)} selectors failed or verify failed",
    )
    fail_result = {
        "success": False,
        "selector_used": None,
        "selector_index": -1,
        "screenshot_before": before_shot,
        "screenshot_after": after_shot,
        "dom_state_before": dom_before,
        "dom_state_after": {},
        "verified": False if verify_fn else None,
        "verify_details": "all selectors failed or verification failed",
    }
    if audit:
        audit.record(
            name.lower(),
            selector_used=selectors[0] if selectors else "—",
            click_registered=False,
            verified=False if verify_fn else None,
            screenshot_before=before_shot,
            screenshot_after=after_shot,
            reason=fail_result["verify_details"],
            dom_before=dom_before,
        )
    return fail_result
