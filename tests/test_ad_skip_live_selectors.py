"""Ad-skip engine must pick up healed selectors WITHOUT backend restart."""
from server_python.ad_skip_engine import skip_selector_count, _skip_selectors
from server_python.behavior.youtube import selectors as sel_mod


def test_selectors_loaded():
    assert skip_selector_count() >= 3


def test_healed_selector_visible_without_restart():
    """Self-Healing page apply → DESKTOP mutated in place → engine sees it live."""
    original = sel_mod.DESKTOP["ad_skip_button"]
    before = skip_selector_count()
    try:
        sel_mod.DESKTOP["ad_skip_button"] = ("button.test-healed-selector",) + tuple(original)
        after = skip_selector_count()
        assert after == before + 1
        assert _skip_selectors()[0] == "button.test-healed-selector"
    finally:
        sel_mod.DESKTOP["ad_skip_button"] = original
