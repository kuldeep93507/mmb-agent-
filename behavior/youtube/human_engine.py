"""
Human engine — V2 wrapper over server_python.human_engine + anti-detection.

Purana human_engine server_python mein hai; yahan V2 selectors integrate kiye.
"""

from __future__ import annotations

# Re-export core primitives from server_python (battle-tested)
from server_python.human_engine import (
    wait_for_element,
    wait_for_any_element,
    wait_for_player,
    send_keys_human,
    find_exact_text_button,
    take_failure_screenshot,
)

from behavior.youtube.anti_detect import human_delay, page_is_safe, get_rng
from behavior.youtube.safe_actions import safe_click, safe_find, safe_wait
from behavior.youtube.selectors import DESKTOP

__all__ = [
    "wait_for_element",
    "wait_for_any_element",
    "wait_for_player",
    "send_keys_human",
    "find_exact_text_button",
    "take_failure_screenshot",
    "wait_for_v2_element",
    "safe_wait_player",
]


async def wait_for_v2_element(tab, key: str, *, timeout: float = 20.0, label: str = "") -> bool:
    """
    Wait for V2 DESKTOP selector key to appear.

    Args:
        tab: nodriver Tab.
        key: DESKTOP dict key e.g. 'like_button'.
        timeout: Max wait seconds.
        label: Log label.

    Returns:
        True if element found.
    """
    selectors = DESKTOP.get(key, ())
    if not selectors or isinstance(selectors, dict):
        return False
    return await safe_wait(tab, selectors, timeout=timeout, action_name=label or key.upper())


async def safe_wait_player(tab, *, timeout: float = 30.0) -> bool:
    """Wait for #movie_player with page safety check."""
    if not await page_is_safe(tab):
        return False
    return await safe_wait(tab, DESKTOP["player_root"], timeout=timeout, action_name="PLAYER_READY")
