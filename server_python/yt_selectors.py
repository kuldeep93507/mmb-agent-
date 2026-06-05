"""
Central Selector Map — MMB AGENT 24/7 (V2 Bridge)

Single source of truth: behavior.youtube.selectors (670 permanent selectors).
This module builds SELECTOR_MAP for SemanticResolver backward compatibility.

Purana code SELECTOR_MAP keys use karta hai — V2 DESKTOP tuples se auto-generate.
"""

from __future__ import annotations

from typing import List, Optional, TypedDict

from behavior.youtube.selectors import DESKTOP, MOBILE, JS_API


class SelectorEntry(TypedDict, total=False):
    css: List[str]
    xpath: List[str]
    aria: List[str]
    text: List[str]
    js_hint: Optional[str]


def _tuple_to_entry(selectors: tuple | list) -> SelectorEntry:
    """Convert V2 selector tuple to legacy SelectorEntry."""
    css_list = list(selectors)
    aria_labels: list[str] = []
    for sel in css_list:
        if "aria-label" in sel:
            # Extract substring hints for aria strategy
            if "*=" in sel:
                part = sel.split("*=")[1].strip().strip('"\'[] i)')
                aria_labels.append(part.replace('"', "").replace("'", ""))
    return {
        "css": css_list,
        "xpath": [],
        "aria": aria_labels,
        "text": [],
        "js_hint": f"document.querySelector({css_list[0]!r})" if css_list else None,
    }


def _build_selector_map() -> dict[str, SelectorEntry]:
    """Build SELECTOR_MAP from V2 DESKTOP + legacy aliases."""
    mapping: dict[str, SelectorEntry] = {}

    for key, value in DESKTOP.items():
        if isinstance(value, tuple):
            mapping[key] = _tuple_to_entry(value)

    # Legacy key aliases — purane resolver keys ab bhi kaam karenge
    _ALIASES: dict[str, str] = {
        "skip_ad_button": "ad_skip_button",
        "play_pause_button": "play_button",
        "settings_button": "settings_gear_button",
        "autoplay_toggle": "autoplay_toggle_button",
        "bell_button": "bell_notification_button",
        "comment_box": "comment_input_placeholder_click",
        "comment_input_active": "comment_input_active_typing",
        "search_box": "search_input",
        "search_button": "search_submit_button",
        "video_player": "player_root",
        "ad_playing_indicator": "ad_detection_combined",
        "sidebar_video_item": "related_video_item",
        "top_bell_icon": "notifications_topbar_bell",
        "consent_accept_button": "consent_accept",
        "quality_menu": "settings_menu_popup",
        "ad_overlay_close": "ad_overlay_close",
    }

    for old_key, new_key in _ALIASES.items():
        if new_key in mapping and old_key not in mapping:
            mapping[old_key] = mapping[new_key]
        elif new_key in DESKTOP and isinstance(DESKTOP[new_key], tuple) and old_key not in mapping:
            mapping[old_key] = _tuple_to_entry(DESKTOP[new_key])

    # Merge pause into play_pause if needed
    if "play_button" in mapping and "pause_button" in mapping:
        combined_css = mapping["play_button"]["css"] + mapping["pause_button"]["css"]
        mapping["play_pause_button"] = {
            **mapping.get("play_pause_button", mapping["play_button"]),
            "css": list(dict.fromkeys(combined_css)),
        }

    return mapping


SELECTOR_MAP: dict[str, SelectorEntry] = _build_selector_map()

# Re-export V2 pools for direct access
DESKTOP_SELECTORS = DESKTOP
MOBILE_SELECTORS = MOBILE
JS_API_COMMANDS = JS_API


def get(key: str) -> SelectorEntry:
    """Return selector entry or empty dict if key not found."""
    return SELECTOR_MAP.get(key, {})


def all_css(key: str) -> list[str]:
    """Return all CSS selectors for a key."""
    return SELECTOR_MAP.get(key, {}).get("css", [])


def all_xpath(key: str) -> list[str]:
    """Return all XPath selectors for a key."""
    return SELECTOR_MAP.get(key, {}).get("xpath", [])


def aria_css_selectors(key: str) -> list[str]:
    """Return only aria-label-based CSS selectors (most stable)."""
    return [s for s in all_css(key) if "aria-label" in s]


def v2_selectors(key: str, platform: str = "desktop") -> tuple:
    """Get raw V2 selector tuple by key."""
    pool = DESKTOP if platform == "desktop" else MOBILE
    val = pool.get(key, ())
    return val if isinstance(val, tuple) else ()
