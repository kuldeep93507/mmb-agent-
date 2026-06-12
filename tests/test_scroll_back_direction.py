"""scroll_back_to_player gap → scroll direction (no browser)."""
from __future__ import annotations

import random

from server_python.behavior.youtube.scroll_human import _scroll_move_for_gap


def test_gap_positive_scrolls_down_toward_player():
    """Player low in viewport (large positive gap) → positive scrollBy."""
    rng = random.Random(0)
    move = _scroll_move_for_gap(140, rng)
    assert move > 0


def test_gap_negative_scrolls_up_toward_player():
    """Player above viewport (negative gap) → negative scrollBy."""
    rng = random.Random(0)
    move = _scroll_move_for_gap(-220, rng)
    assert move < 0
