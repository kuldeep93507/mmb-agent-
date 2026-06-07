"""Tests for MultiloginProvider.start_profile — MLX launcher port flow."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from server_python.providers.multilogin import (
    MultiloginProvider,
    _parse_wmic_process_pairs,
)

PROFILE_ID = "c58a40dc-1111-2222-3333-444455556666"
FOLDER_ID = "fake-folder"


def _make_provider() -> MultiloginProvider:
    prov = MultiloginProvider(token="fake-token")
    prov.folder_id = FOLDER_ID
    return prov


def test_parse_wmic_process_pairs_combined_block() -> None:
    stdout = (
        "ProcessId=123\r\r\n"
        f"CommandLine=chrome.exe --client-session-id={PROFILE_ID}\r\r\n"
        "\r\r\n"
    )
    pairs = _parse_wmic_process_pairs(stdout)
    assert pairs == [(123, f"chrome.exe --client-session-id={PROFILE_ID}")]


def test_parse_wmic_process_pairs_split_blocks() -> None:
    long_cmd = (
        "C:\\Users\\kulde\\mlx\\deps\\mimic_148.2\\chrome.exe "
        f"--client-session-id={PROFILE_ID} "
        + "--proxy-server=socks5://1.2.3.4:9999 " * 20
    )
    stdout = f"ProcessId=61224\r\r\n\r\r\nCommandLine={long_cmd}\r\r\n\r\r\n"
    pairs = _parse_wmic_process_pairs(stdout)
    assert len(pairs) == 1
    assert pairs[0][0] == 61224
    assert f"client-session-id={PROFILE_ID}" in pairs[0][1]


def test_find_main_chrome_process_skips_renderer() -> None:
    prov = _make_provider()
    pairs = [
        (100, f'chrome.exe --type=renderer --client-session-id={PROFILE_ID}'),
        (200, f'chrome.exe --client-session-id={PROFILE_ID}'),
    ]
    pid, cmd = prov._find_main_chrome_process(PROFILE_ID, pairs)
    assert pid == 200
    assert "--type=" not in cmd


def test_parse_launcher_start_response_port() -> None:
    prov = _make_provider()
    txt = '{"data":{"port":"53726"},"status":{"http_code":200}}'
    parsed = prov._parse_launcher_start_response(200, txt)
    assert parsed == {"port": 53726}


def test_parse_launcher_start_response_already_running() -> None:
    prov = _make_provider()
    txt = '{"status":{"error_code":"PROFILE_ALREADY_RUNNING","message":"browser process is running"}}'
    parsed = prov._parse_launcher_start_response(400, txt)
    assert parsed == {"already_running": True}


@pytest.mark.asyncio
async def test_start_profile_uses_launcher_port() -> None:
    prov = _make_provider()
    start_txt = '{"data":{"port":53726},"status":{"http_code":200}}'

    with patch.object(prov, "_get_token", new=AsyncMock(return_value="fake-token")), \
         patch.object(prov, "_call_launcher", new=AsyncMock(return_value=(200, start_txt))), \
         patch.object(prov, "_verify_cdp_with_retry", new=AsyncMock(return_value=True)) as verify:
        result = await prov.start_profile(PROFILE_ID)

    assert result["code"] == 0
    assert result["data"]["cdpPort"] == 53726
    verify.assert_awaited_once_with(53726, timeout=45)


@pytest.mark.asyncio
async def test_start_profile_already_running_stops_and_retries() -> None:
    prov = _make_provider()
    busy = '{"status":{"error_code":"PROFILE_ALREADY_RUNNING","message":"browser process is running"}}'
    ok = '{"data":{"port":55123},"status":{"http_code":200}}'

    with patch.object(prov, "_get_token", new=AsyncMock(return_value="fake-token")), \
         patch.object(prov, "_call_launcher", new=AsyncMock(side_effect=[(400, busy), (200, ok)])), \
         patch.object(prov, "_launcher_stop_profile", new=AsyncMock()) as stop, \
         patch.object(prov, "_verify_cdp_with_retry", new=AsyncMock(return_value=True)), \
         patch("server_python.providers.multilogin.asyncio.sleep", new=AsyncMock()):
        result = await prov.start_profile(PROFILE_ID)

    stop.assert_awaited_once_with(PROFILE_ID)
    assert result["data"]["cdpPort"] == 55123


@pytest.mark.asyncio
async def test_start_profile_cdp_unreachable_raises() -> None:
    prov = _make_provider()
    start_txt = '{"data":{"port":53726},"status":{"http_code":200}}'

    with patch.object(prov, "_get_token", new=AsyncMock(return_value="fake-token")), \
         patch.object(prov, "_call_launcher", new=AsyncMock(return_value=(200, start_txt))), \
         patch.object(prov, "_verify_cdp_with_retry", new=AsyncMock(return_value=False)):
        with pytest.raises(RuntimeError, match="CDP port 53726 not accessible"):
            await prov.start_profile(PROFILE_ID)


@pytest.mark.asyncio
async def test_verify_cdp_with_retry_polls_until_ready() -> None:
    prov = _make_provider()
    probe = AsyncMock(side_effect=[False, False, True])

    with patch.object(prov, "_verify_cdp", new=probe), \
         patch("server_python.providers.multilogin.asyncio.sleep", new=AsyncMock()):
        ok = await prov._verify_cdp_with_retry(35550, timeout=30)

    assert ok is True
    assert probe.await_count == 3


@pytest.mark.asyncio
async def test_verify_cdp_rejects_node_endpoint() -> None:
    prov = _make_provider()

    class FakeResponse:
        status = 200

        async def json(self, content_type=None):
            return {"Browser": "node.js/v22.22.0"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    class FakeSession:
        def get(self, *args, **kwargs):
            return FakeResponse()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    with patch("server_python.providers.multilogin.aiohttp.ClientSession", return_value=FakeSession()):
        ok = await prov._verify_cdp(34964)

    assert ok is False
