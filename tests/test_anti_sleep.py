"""AntiSleep v2 — background resume helpers."""

from server_python.anti_sleep import (
    RESUME_PAUSED_VIDEO_JS,
    VISIBILITY_OVERRIDE_JS,
    AntiSleepKeeper,
)


def test_visibility_override_targets_yt_player():
    assert "playVideo" in VISIBILITY_OVERRIDE_JS
    assert "'hidden'" in VISIBILITY_OVERRIDE_JS


def test_resume_js_only_on_watch_page():
    assert "/watch" in RESUME_PAUSED_VIDEO_JS
    assert "playVideo" in RESUME_PAUSED_VIDEO_JS


def test_default_wake_interval():
    k = AntiSleepKeeper()
    assert k._interval == 5.0


def test_watch_phase_slower_interval_no_mouse_on_foreground():
    k = AntiSleepKeeper()
    k.set_watch_phase(True)
    assert k._watch_phase is True
    assert k._interval == 22.0
    k.set_watch_phase(False)
    assert k._interval == 8.0
