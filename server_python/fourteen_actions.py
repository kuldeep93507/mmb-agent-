"""
fourteen_actions — Engine bridge to V2 FOURTEEN_ACTIONS master map.

Usage:
    from server_python.fourteen_actions import get_spec, verify_log_for, click_keys_for
"""
from __future__ import annotations

from server_python.behavior.youtube.selectors import DESKTOP, FOURTEEN_ACTIONS, JS_API

# Keys in watch-engine test order (dislike often OFF in live tests)
ALL_KEYS = tuple(FOURTEEN_ACTIONS.keys())


def get_spec(action_key: str) -> dict:
    if action_key not in FOURTEEN_ACTIONS:
        raise KeyError(f"Unknown action {action_key!r} — expected one of {ALL_KEYS}")
    return FOURTEEN_ACTIONS[action_key]


def click_keys_for(action_key: str) -> tuple[str, ...]:
    return tuple(get_spec(action_key).get("click_keys") or ())


def selectors_for(action_key: str) -> tuple[str, ...]:
    """Flat tuple of all CSS selectors for an action (all click_keys merged)."""
    out: list[str] = []
    seen: set[str] = set()
    for k in click_keys_for(action_key):
        for sel in DESKTOP.get(k, ()):
            if sel not in seen:
                seen.add(sel)
                out.append(sel)
    return tuple(out)


def verify_log_for(action_key: str) -> str:
    return str(get_spec(action_key).get("verify_log") or "")


def js_state_key(action_key: str) -> str | None:
    return get_spec(action_key).get("js_state")


def js_state_snippet(action_key: str) -> str | None:
    key = js_state_key(action_key)
    if not key:
        return None
    return JS_API.get(key)


def engine_path(action_key: str) -> str:
    return str(get_spec(action_key).get("engine") or "")
