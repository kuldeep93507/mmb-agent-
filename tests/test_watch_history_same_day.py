"""Same-day watch history skip rules."""
import time
from datetime import datetime, timedelta

from server_python.watch_history import (
    has_watched_today,
    mark_watched,
    should_skip_video,
    clear_history,
)


def test_same_day_skip_and_next_day_ok(tmp_path, monkeypatch):
    pid = "test-profile-same-day"
    vid = "abc12345678"

    monkeypatch.setattr(
        "server_python.watch_history._HISTORY_DIR",
        tmp_path,
    )
    clear_history(pid)

    assert should_skip_video(pid, vid) is False

    mark_watched(pid, vid, "Test Video")
    assert has_watched_today(pid, vid) is True
    assert should_skip_video(pid, vid) is True
    assert should_skip_video(pid, vid, allow_same_day_repeat=True) is False

    yesterday_ms = int((datetime.now() - timedelta(days=1)).timestamp() * 1000)
    clear_history(pid)
    from server_python.watch_history import _load_raw, _save_atomic

    data = _load_raw(pid)
    data["watched"] = [{"videoId": vid, "watchedAt": yesterday_ms, "videoTitle": "Old"}]
    _save_atomic(pid, data)

    assert has_watched_today(pid, vid) is False
    assert should_skip_video(pid, vid) is False


def test_legacy_zero_timestamp_not_skipped(tmp_path, monkeypatch):
    pid = "test-profile-legacy"
    vid = "legacy00001"

    monkeypatch.setattr("server_python.watch_history._HISTORY_DIR", tmp_path)
    clear_history(pid)

    from server_python.watch_history import _load_raw, _save_atomic

    data = _load_raw(pid)
    data["watched"] = [vid]
    _save_atomic(pid, data)

    assert should_skip_video(pid, vid) is False
