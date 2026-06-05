"""
Notification entry path — V2 wrapper.

Bell → notification panel → target video click.
Delegates to server_python.notification_path with V2 selectors via resolver.
"""

from __future__ import annotations

from server_python.notification_path import NotificationPath

from behavior.youtube.anti_detect import human_delay, page_is_safe
from behavior.youtube.safe_actions import safe_click
from behavior.youtube.selectors import DESKTOP

__all__ = ["NotificationPath", "open_bell_panel_v2"]


async def open_bell_panel_v2(tab) -> bool:
    """
    Open topbar notification bell using V2 selectors.

    Args:
        tab: nodriver Tab.

    Returns:
        True if bell clicked and panel likely open.
    """
    if not await page_is_safe(tab):
        return False
    await human_delay(1.0, 2.0)
    return await safe_click(tab, DESKTOP["notifications_topbar_bell"], action_name="NOTIF_BELL")
