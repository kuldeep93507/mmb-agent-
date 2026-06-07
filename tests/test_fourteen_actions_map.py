"""Verify all 14 engagement actions map to real V2 selectors."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
_V2 = _ROOT / "MMB_YOUTUBE_SELECTORS_FINAL_V2.py"

_spec = importlib.util.spec_from_file_location("_v2", _V2)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

DESKTOP = _mod.DESKTOP
JS_API = _mod.JS_API
FOURTEEN_ACTIONS = _mod.FOURTEEN_ACTIONS
fourteen_action_selector_counts = _mod.fourteen_action_selector_counts

EXPECTED_KEYS = (
    "like", "dislike", "subscribe", "bell", "comment", "comment_like",
    "description_expand", "play_pause", "volume", "captions", "seek",
    "quality", "ad_skip", "autoplay_off",
)


def test_fourteen_actions_count() -> None:
    assert len(FOURTEEN_ACTIONS) == 14
    assert tuple(FOURTEEN_ACTIONS.keys()) == EXPECTED_KEYS


@pytest.mark.parametrize("action_key", EXPECTED_KEYS)
def test_each_action_has_click_keys_in_desktop(action_key: str) -> None:
    spec = FOURTEEN_ACTIONS[action_key]
    click_keys = spec.get("click_keys") or ()
    assert click_keys, f"{action_key} missing click_keys"
    for k in click_keys:
        assert k in DESKTOP, f"{action_key}: DESKTOP missing key {k!r}"
        val = DESKTOP[k]
        assert isinstance(val, tuple) and len(val) >= 1, f"{action_key}: {k} empty"


def test_ad_skip_has_full_selector_chain() -> None:
    assert len(DESKTOP["ad_skip_button"]) >= 30


def test_selector_counts_per_action() -> None:
    counts = fourteen_action_selector_counts()
    assert len(counts) == 14
    for key, n in counts.items():
        assert n >= 1, f"{key} has zero selectors"
    assert counts["ad_skip"] >= 30
    assert counts["like"] >= 5


def test_js_state_keys_exist_where_defined() -> None:
    for key, spec in FOURTEEN_ACTIONS.items():
        js_key = spec.get("js_state")
        if js_key and js_key not in ("current_time", "get_current_quality"):
            assert js_key in JS_API, f"{key}: JS_API missing {js_key!r}"


def test_fourteen_actions_engine_bridge() -> None:
    from server_python.fourteen_actions import (
        click_keys_for,
        engine_path,
        selectors_for,
        verify_log_for,
    )

    assert verify_log_for("ad_skip") == "✓ SKIP VERIFIED"
    assert "ad_skip_engine" in engine_path("ad_skip")
    assert len(selectors_for("ad_skip")) >= 30
    assert click_keys_for("like") == ("like_button",)

