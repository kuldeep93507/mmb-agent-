"""
behavior.youtube.player_controls — Player control helpers (volume slider, etc.).

STATUS: ✅ No bugs found — clean as-is.
"""
from __future__ import annotations

import logging
from typing import Any

from server_python.behavior.youtube.state import get_volume_percent

log = logging.getLogger("mmb.yt_controls")


async def read_volume_slider_pct(tab: Any) -> int:
    """Read current volume from video element (0-100)."""
    return await get_volume_percent(tab)
