"""
Related video actions — sidebar & endscreen clicks via V2 selectors.

Thin wrapper over behavior.youtube.desktop for agent_manager / entropy use.
"""

from __future__ import annotations

from typing import Any, Tuple

from behavior.youtube.desktop import click_related_video, click_endscreen_video
from behavior.youtube.selectors import DESKTOP
from behavior.youtube.safe_actions import safe_click


async def click_sidebar_video(tab: Any, index: int = 0) -> Tuple[bool, str]:
    """
    Click related sidebar video by index.

    Args:
        tab: nodriver Tab.
        index: Zero-based index in sidebar list.

    Returns:
        (success, proof_string)
    """
    ok = await click_related_video(tab, index=index)
    return ok, f"SIDEBAR_CLICK index={index}"


async def click_endscreen_suggestion(tab: Any, index: int = 0) -> Tuple[bool, str]:
    """
    Click endscreen videowall suggestion.

    Args:
        tab: nodriver Tab.
        index: 0-11 suggestion index.

    Returns:
        (success, proof_string)
    """
    ok = await click_endscreen_video(tab, index=index)
    return ok, f"ENDSCREEN_CLICK index={index}"


async def click_related_link(tab: Any) -> bool:
    """Click first related video link via V2 selector chain."""
    links = DESKTOP.get("related_video_link", ())
    return await safe_click(tab, links, action_name="RELATED_LINK")
