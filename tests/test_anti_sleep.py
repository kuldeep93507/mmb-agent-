"""AntiSleep v2 — 3-pass verification (unit, no live browser)."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server_python.anti_sleep import VISIBILITY_OVERRIDE_JS, AntiSleepKeeper


@pytest.mark.asyncio
async def test_visibility_override_js_structure():
    """Pass 1: JS must override hidden + visibilityState."""
    assert "__mmbAntiSleepV2" in VISIBILITY_OVERRIDE_JS
    assert "'hidden'" in VISIBILITY_OVERRIDE_JS
    assert "visibilityState" in VISIBILITY_OVERRIDE_JS
    assert "visible" in VISIBILITY_OVERRIDE_JS


@pytest.mark.asyncio
async def test_start_stop_lifecycle():
    """Pass 2: start registers script, wake loop runs, stop cancels cleanly."""
    tab = AsyncMock()
    tab.evaluate = AsyncMock(return_value="ok")
    tab.send = AsyncMock()
    tab.activate = AsyncMock()
    tab.target = None

    logs: list[str] = []
    keeper = AntiSleepKeeper(log_fn=logs.append, wake_interval=0.05)

    await keeper.start(tab)
    assert keeper._running is True
    assert keeper._script_registered or tab.send.called
    await asyncio.sleep(0.12)
    assert keeper._wake_count >= 1

    await keeper.stop()
    assert keeper._running is False
    assert any("started" in m for m in logs)
    assert any("Stopped" in m for m in logs)


@pytest.mark.asyncio
async def test_bring_to_foreground_calls_cdp():
    """Pass 3: foreground wake hits lifecycle + visibility + mouse."""
    tab = AsyncMock()
    tab.evaluate = AsyncMock(return_value="ok")
    tab.send = AsyncMock()
    tab.activate = AsyncMock()

    keeper = AntiSleepKeeper()
    keeper._tab = tab
    keeper._running = True

    await keeper.bring_to_foreground("test-reason")

    tab.evaluate.assert_called()
    assert tab.send.call_count >= 1
    tab.activate.assert_called_once()


@pytest.mark.asyncio
async def test_on_page_load_reinjects():
    """Pass 4: after navigation, visibility + lifecycle re-applied."""
    tab = AsyncMock()
    tab.evaluate = AsyncMock(return_value="ok")
    tab.send = AsyncMock()

    keeper = AntiSleepKeeper()
    keeper._tab = tab

    with patch("server_python.anti_sleep.AntiSleepKeeper.set_lifecycle_active", new_callable=AsyncMock) as life:
        life.return_value = True
        await keeper.on_page_load("test-nav")

    tab.evaluate.assert_called_once()
    life.assert_called_once()


@pytest.mark.asyncio
async def test_entropy_wake_fn_called():
    """Pass 5: entropy engine calls wake_fn on navigation."""
    from server_python.entropy import BehavioralEntropyEngine
    from server_python.yt_types import VideoTarget

    calls: list[str] = []

    async def wake(reason: str) -> None:
        calls.append(reason)

    engine = BehavioralEntropyEngine("profile-test-123", __import__("random").Random(1), print, wake_fn=wake)
    tab = AsyncMock()
    tab.url = "https://www.youtube.com/"
    target = VideoTarget(video_id="dQw4w9WgXcQ", title_hint="test")

    await engine.execute_for_source(tab, target, source="direct")

    assert "nav-start" in calls
