# vision/tests/test_race_item_tracker.py
from detector.game_logic import RaceItemTracker


def test_item_seen_recorded():
    """Detecting a floor item records its location."""
    tracker = RaceItemTracker()
    tracker.item_seen('magical_boomerang', map_position=45, frame=100)
    locs = tracker.get_locations()
    assert 'magical_boomerang' in locs
    assert locs['magical_boomerang']['map_position'] == 45


def test_item_seen_overwrites_with_same_location():
    """Seeing the same item twice at the same location doesn't duplicate."""
    tracker = RaceItemTracker()
    tracker.item_seen('bow', map_position=10, frame=1)
    tracker.item_seen('bow', map_position=10, frame=2)
    locs = tracker.get_locations()
    assert len([k for k in locs if k == 'bow']) == 1


def test_item_obtained_marks_obtained():
    """After item_obtained, get_locations shows obtained=True."""
    tracker = RaceItemTracker()
    tracker.item_seen('silver_arrows', map_position=22, frame=50)
    tracker.item_obtained('silver_arrows', frame=60)
    locs = tracker.get_locations()
    assert locs['silver_arrows']['obtained'] is True


def test_item_not_obtained_stays_false():
    """Seen but not obtained item has obtained=False."""
    tracker = RaceItemTracker()
    tracker.item_seen('red_candle', map_position=7, frame=30)
    locs = tracker.get_locations()
    assert locs['red_candle']['obtained'] is False


def test_multiple_items_tracked_independently():
    tracker = RaceItemTracker()
    tracker.item_seen('bow', map_position=5, frame=1)
    tracker.item_seen('arrows', map_position=12, frame=2)
    locs = tracker.get_locations()
    assert locs['bow']['map_position'] == 5
    assert locs['arrows']['map_position'] == 12
