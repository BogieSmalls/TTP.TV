"""Tests for InventoryAccumulator — event-based inventory tracking for Z1R."""

import pytest

from detector.inventory_accumulator import (
    InventoryAccumulator, ALL_ITEMS, UPGRADE_IMPLIES,
)


@pytest.fixture
def acc():
    return InventoryAccumulator()


class TestEmptyState:
    """Fresh accumulator has no items."""

    def test_all_items_false(self, acc):
        inv = acc.get_inventory()
        assert all(v is False for v in inv.values())

    def test_all_items_present(self, acc):
        inv = acc.get_inventory()
        for item in ALL_ITEMS:
            assert item in inv


class TestBItemChange:
    """b_item_change events add the B-item to inventory."""

    def test_single_b_item(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: blue_candle',
        })
        inv = acc.get_inventory()
        assert inv['blue_candle'] is True

    def test_b_item_with_was(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: red_candle (was blue_candle)',
        })
        inv = acc.get_inventory()
        assert inv['red_candle'] is True
        # Upgrade chain: red_candle implies blue_candle
        assert inv['blue_candle'] is True

    def test_b_item_bomb(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: bomb',
        })
        inv = acc.get_inventory()
        assert inv['bombs'] is True

    def test_b_item_potion_blue(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: potion_blue',
        })
        inv = acc.get_inventory()
        assert inv['blue_potion'] is True
        # Implies letter
        assert inv['letter'] is True

    def test_b_item_potion_red(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: potion_red',
        })
        inv = acc.get_inventory()
        assert inv['red_potion'] is True
        assert inv['blue_potion'] is True
        assert inv['letter'] is True


class TestUpgradeChains:
    """Upgrade items imply their base items."""

    def test_magical_boomerang_implies_boomerang(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: magical_boomerang',
        })
        inv = acc.get_inventory()
        assert inv['magical_boomerang'] is True
        assert inv['boomerang'] is True

    def test_silver_arrow_implies_arrow_and_bow(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: silver_arrow',
        })
        inv = acc.get_inventory()
        assert inv['silver_arrow'] is True
        assert inv['arrow'] is True
        assert inv['bow'] is True

    def test_red_ring_implies_blue_ring(self, acc):
        acc._add_item('red_ring')
        inv = acc.get_inventory()
        assert inv['red_ring'] is True
        assert inv['blue_ring'] is True


class TestStaircaseItem:
    """staircase_item_acquired events add items."""

    def test_staircase_pickup(self, acc):
        acc.process_event({
            'event': 'staircase_item_acquired',
            'item': 'raft',
            'dungeon_level': 4,
        })
        inv = acc.get_inventory()
        assert inv['raft'] is True

    def test_staircase_book(self, acc):
        acc.process_event({
            'event': 'staircase_item_acquired',
            'item': 'book',
            'dungeon_level': 3,
        })
        inv = acc.get_inventory()
        assert inv['book'] is True


class TestFloorItemPickup:
    """item_obtained events add items."""

    def test_floor_pickup(self, acc):
        acc.process_event({
            'event': 'item_obtained',
            'item': 'magic_key',
            'dungeon_level': 7,
        })
        inv = acc.get_inventory()
        assert inv['magic_key'] is True


class TestSwordUpgrade:
    """sword_upgrade events track sword progression."""

    def test_wooden_sword(self, acc):
        acc.process_event({
            'event': 'sword_upgrade',
            'description': 'Picked up Wooden Sword',
        })
        inv = acc.get_inventory()
        # Sword items are tracked but not in the main 18 overlay items
        # The accumulator just records them
        assert 'wood_sword' in acc._obtained

    def test_white_sword(self, acc):
        acc.process_event({
            'event': 'sword_upgrade',
            'description': 'Picked up White Sword',
        })
        assert 'white_sword' in acc._obtained
        assert 'wood_sword' in acc._obtained  # implied

    def test_magical_sword(self, acc):
        acc.process_event({
            'event': 'sword_upgrade',
            'description': 'Picked up Magical Sword',
        })
        assert 'magical_sword' in acc._obtained
        assert 'white_sword' in acc._obtained
        assert 'wood_sword' in acc._obtained


class TestSubscreenSeeding:
    """process_subscreen seeds from vanilla reader."""

    def test_seed_from_subscreen(self, acc):
        acc.process_subscreen({
            'raft': True,
            'ladder': False,
            'book': True,
        })
        inv = acc.get_inventory()
        assert inv['raft'] is True
        assert inv['book'] is True
        assert inv['ladder'] is False


class TestFullSequence:
    """Replay a realistic event sequence."""

    def test_race_event_sequence(self, acc):
        events = [
            {'event': 'b_item_change', 'description': 'B-item: bomb'},
            {'event': 'b_item_change', 'description': 'B-item: boomerang (was bomb)'},
            {'event': 'staircase_item_acquired', 'item': 'raft', 'dungeon_level': 4},
            {'event': 'b_item_change', 'description': 'B-item: blue_candle (was boomerang)'},
            {'event': 'item_obtained', 'item': 'power_bracelet', 'dungeon_level': 2},
            {'event': 'b_item_change', 'description': 'B-item: red_candle (was blue_candle)'},
            {'event': 'sword_upgrade', 'description': 'Picked up White Sword'},
        ]
        for evt in events:
            acc.process_event(evt)

        inv = acc.get_inventory()
        assert inv['bombs'] is True
        assert inv['boomerang'] is True
        assert inv['raft'] is True
        assert inv['blue_candle'] is True
        assert inv['red_candle'] is True
        assert inv['power_bracelet'] is True
        # Items NOT seen should still be False
        assert inv['wand'] is False
        assert inv['recorder'] is False
        assert inv['magic_key'] is False


class TestReset:
    """Reset clears accumulated state."""

    def test_reset(self, acc):
        acc.process_event({
            'event': 'b_item_change',
            'description': 'B-item: bomb',
        })
        assert acc.get_inventory()['bombs'] is True
        acc.reset()
        assert acc.get_inventory()['bombs'] is False


class TestUnknownEvents:
    """Unknown event types should be ignored gracefully."""

    def test_unknown_event(self, acc):
        acc.process_event({'event': 'unknown_event_type'})
        inv = acc.get_inventory()
        assert all(v is False for v in inv.values())

    def test_empty_event(self, acc):
        acc.process_event({})
        inv = acc.get_inventory()
        assert all(v is False for v in inv.values())
