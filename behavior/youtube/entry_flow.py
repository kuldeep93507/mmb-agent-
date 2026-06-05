"""
YouTube entry flow — navigate to video, handle consent, dismiss overlays.

Bot start hone pe pehla flow yahan se chalta hai.
"""

from __future__ import annotations

import asyncio
from typing import Any, Tuple

from behavior.youtube.safe_actions import safe_click, safe_wait, safe_eval_js
from behavior.youtube.player_focus import focus_player, ensure_unmuted
from behavior.youtube.selectors import DESKTOP
from behavior.youtube import desktop as desktop_actions


async def accept_consent_if_present(tab: Any) -> bool:
    """Click Accept on GDPR/consent popup if shown."""
    consent_key = "consent_accept_all_button"
    selectors = DESKTOP.get(consent_key) or DESKTOP.get("consent_accept_button", ())
    if not selectors:
        return True
    return await safe_click(tab, selectors, action_name="CONSENT_ACCEPT", timeout=3)


async def navigate_to_video(tab: Any, video_url: str) -> Tuple[bool, str]:
    """
    Navigate to YouTube video URL and wait for player.

    Args:
        tab: nodriver Tab.
        video_url: Full YouTube watch URL.

    Returns:
        (success, proof_string)
    """
    try:
        await tab.get(video_url)
    except Exception as exc:
        return False, f"NAV_FAIL:{exc}"

    await asyncio.sleep(2.0)
    await accept_consent_if_present(tab)

    player_ok = await safe_wait(tab, DESKTOP["player_root"], timeout=20, action_name="PLAYER_LOAD")
    if not player_ok:
        return False, "PLAYER_NOT_FOUND"

    await focus_player(tab)
    await ensure_unmuted(tab)
    await desktop_actions.dismiss_tap_to_unmute(tab)

    vid = await safe_eval_js(
        tab,
        "new URL(window.location.href).searchParams.get('v') || ''",
        log_result=False,
    )
    return True, f"LOADED vid={vid}"


async def warm_entry(tab: Any, video_url: str, *, auto_play: bool = True) -> Tuple[bool, str]:
    """
    Full entry sequence: navigate → consent → unmute → optional play.

    Args:
        tab: nodriver Tab.
        video_url: Target video URL.
        auto_play: Start playback after load.

    Returns:
        (success, proof_string)
    """
    ok, proof = await navigate_to_video(tab, video_url)
    if not ok:
        return ok, proof

    if auto_play:
        played, play_proof = await desktop_actions.play(tab)
        return played, f"{proof} | {play_proof}"

    return ok, proof
