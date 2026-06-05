"""Tests for refactored YouTubeAgent V2 helpers — mock tab, no browser."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server_python.agent_manager import YouTubeAgent


def _make_agent() -> YouTubeAgent:
    agent = YouTubeAgent("profile-test-001", 9222, {})
    agent.tab = MagicMock()
    return agent


@pytest.mark.asyncio
async def test_do_like_skips_when_already_liked() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.is_liked", new=AsyncMock(return_value=True)
    ), patch(
        "server_python.agent_manager.yt_desktop.like", new=AsyncMock()
    ) as mock_like:
        ok = await agent._do_like()
    assert ok is True
    mock_like.assert_not_called()


@pytest.mark.asyncio
async def test_do_like_delegates_to_desktop() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.is_liked", new=AsyncMock(return_value=False)
    ), patch(
        "server_python.agent_manager.yt_desktop.like",
        new=AsyncMock(return_value=(True, "LIKE=true")),
    ) as mock_like, patch.object(
        agent, "_scroll_to_video_top", new=AsyncMock()
    ), patch.object(
        agent, "_human_pause", new=AsyncMock()
    ):
        ok = await agent._do_like()
    assert ok is True
    mock_like.assert_called_once_with(agent.tab, want=True)


@pytest.mark.asyncio
async def test_do_subscribe_skips_when_subscribed() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.is_subscribed", new=AsyncMock(return_value=True)
    ), patch(
        "server_python.agent_manager.yt_desktop.subscribe", new=AsyncMock()
    ) as mock_sub:
        ok = await agent._do_subscribe()
    assert ok is True
    mock_sub.assert_not_called()


@pytest.mark.asyncio
async def test_do_dislike_skips_when_already_disliked() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.is_disliked", new=AsyncMock(return_value=True)
    ), patch(
        "server_python.agent_manager.yt_desktop.dislike", new=AsyncMock()
    ) as mock_dislike:
        ok = await agent._do_dislike()
    assert ok is True
    mock_dislike.assert_not_called()


@pytest.mark.asyncio
async def test_get_duration_delegates_to_state() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.get_video_duration_when_ready",
        new=AsyncMock(return_value=312.5),
    ) as mock_dur:
        dur = await agent._get_duration()
    assert dur == 312.5
    mock_dur.assert_called_once_with(agent.tab)


@pytest.mark.asyncio
async def test_apply_video_settings_delegates_disable_autoplay() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.yt_desktop.disable_autoplay",
        new=AsyncMock(return_value=True),
    ) as mock_auto:
        await agent._apply_video_settings()
    mock_auto.assert_called_once_with(agent.tab)


@pytest.mark.asyncio
async def test_do_comment_delegates_scroll_and_post() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.yt_desktop.scroll_to_comments", new=AsyncMock()
    ) as mock_scroll, patch(
        "server_python.agent_manager.yt_desktop.post_comment",
        new=AsyncMock(return_value=(True, "COMMENT_OK")),
    ) as mock_post, patch.object(
        agent, "_human_pause", new=AsyncMock()
    ):
        ok = await agent._do_comment("Great video!")
    assert ok is True
    mock_scroll.assert_called_once_with(agent.tab)
    mock_post.assert_called_once_with(agent.tab, "Great video!")


@pytest.mark.asyncio
async def test_dismiss_consent_delegates_entry_flow() -> None:
    agent = _make_agent()
    with patch(
        "server_python.agent_manager.accept_consent_if_present",
        new=AsyncMock(return_value=True),
    ) as mock_consent, patch.object(
        agent, "_human_pause", new=AsyncMock()
    ):
        await agent._dismiss_consent()
    mock_consent.assert_called_once_with(agent.tab)


@pytest.mark.asyncio
async def test_do_quality_change_maps_1080p() -> None:
    agent = _make_agent()
    with patch(
        "behavior.youtube.quality.change_quality",
        new=AsyncMock(return_value=(True, "QUALITY=1080p")),
    ) as mock_q:
        ok = await agent._do_quality_change("1080p")
    assert ok is True
    mock_q.assert_called_once()
    assert mock_q.call_args.args[1] == "1080p"


@pytest.mark.asyncio
async def test_scroll_uses_js_wrapper() -> None:
    agent = _make_agent()
    agent._natural_scroll = False
    with patch.object(agent, "_js", new=AsyncMock()) as mock_js, patch.object(
        agent, "_human_pause", new=AsyncMock()
    ):
        await agent._scroll(120)
    mock_js.assert_called_once_with(
        "window.scrollBy(0, 120)", action_name="SCROLL", wrap=False
    )
