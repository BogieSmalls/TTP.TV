# vision/tests/test_player_item_tracker.py
import pytest
from detector.game_logic import PlayerItemTracker


def test_b_item_arrows_implies_bow():
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('arrows')
    assert tracker.get_items()['bow'] is True
    assert tracker.arrows_level >= 1


def test_b_item_change_sets_item():
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('blue_candle')
    assert tracker.get_items()['blue_candle'] is True


def test_red_candle_clears_blue():
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('blue_candle')
    tracker.update_from_b_item('red_candle')
    items = tracker.get_items()
    assert items['red_candle'] is True
    assert items['blue_candle'] is False


def test_red_ring_clears_blue_ring():
    tracker = PlayerItemTracker()
    tracker.update_item_obtained('blue_ring')
    tracker.update_item_obtained('red_ring')
    items = tracker.get_items()
    assert items['red_ring'] is True
    assert items['blue_ring'] is False


def test_magical_boomerang_clears_boomerang():
    tracker = PlayerItemTracker()
    tracker.update_item_obtained('boomerang')
    tracker.update_item_obtained('magical_boomerang')
    items = tracker.get_items()
    assert items['magical_boomerang'] is True
    assert items['boomerang'] is False


def test_sword_level_never_decreases():
    tracker = PlayerItemTracker()
    tracker.update_sword_level(3)
    tracker.update_sword_level(1)
    assert tracker.sword_level == 3


def test_arrows_level_never_decreases():
    tracker = PlayerItemTracker()
    tracker.update_arrows_level(2)
    tracker.update_arrows_level(1)
    assert tracker.arrows_level == 2


def test_silver_arrows_does_not_imply_bow():
    tracker = PlayerItemTracker()
    tracker.update_arrows_level(2)
    assert tracker.get_items().get('bow', False) is False


def test_arrows_in_b_slot_implies_bow():
    """If arrows appear in B-slot, bow must be in inventory."""
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('arrows')
    assert tracker.get_items()['bow'] is True


def test_subscreen_merge_true_overrides():
    """True from subscreen sets item True."""
    tracker = PlayerItemTracker()
    merged = tracker.merge_subscreen({'bow': True, 'blue_candle': False})
    assert tracker.get_items()['bow'] is True


def test_subscreen_merge_false_does_not_clear_known_true():
    """False from subscreen does NOT clear an already-True item."""
    tracker = PlayerItemTracker()
    tracker.update_item_obtained('blue_candle')
    tracker.merge_subscreen({'blue_candle': False})
    assert tracker.get_items()['blue_candle'] is True
