"""Event-based inventory accumulation for Z1R.

Z1R uses a SWAP subscreen that the InventoryReader cannot parse, so
``GameState.items`` is always ``{}`` during Z1R races.  This class builds
a cumulative inventory by observing game events emitted by the
GameLogicValidator (b_item_change, staircase_item_acquired, item_obtained,
sword_upgrade) and inferring which items the player has obtained.

Upgrade chains are respected — seeing ``red_candle`` implies
``blue_candle`` was previously obtained, etc.
"""

# ── Upgrade chains ──
# If we see the upgraded item, the base item was necessarily obtained first.
# Maps: upgraded_item -> [implied_items]
UPGRADE_IMPLIES: dict[str, list[str]] = {
    'red_candle':         ['blue_candle'],
    'magical_boomerang':  ['boomerang'],
    'silver_arrow':       ['arrow', 'bow'],
    'red_ring':           ['blue_ring'],
    'red_potion':         ['blue_potion', 'letter'],
    'blue_potion':        ['letter'],
    'magical_shield':     [],  # no prerequisite
    'white_sword':        ['wood_sword'],
    'magical_sword':      ['wood_sword', 'white_sword'],
}

# B-item names that map directly to an inventory slot.
# Some b_item names from HudReader differ slightly from inventory slot names.
_B_ITEM_TO_INVENTORY: dict[str, str] = {
    'boomerang':          'boomerang',
    'magical_boomerang':  'magical_boomerang',
    'bomb':               'bombs',
    'bow':                'bow',
    'arrow':              'arrow',
    'silver_arrow':       'silver_arrow',
    'blue_candle':        'blue_candle',
    'red_candle':         'red_candle',
    'recorder':           'recorder',
    'bait':               'bait',
    'letter':             'letter',
    'potion_blue':        'blue_potion',
    'potion_red':         'red_potion',
    'wand':               'wand',
}

# All trackable inventory items (the 18 that the overlay displays).
ALL_ITEMS: list[str] = [
    'boomerang', 'magical_boomerang',
    'bombs', 'bow', 'arrow', 'silver_arrow',
    'blue_candle', 'red_candle',
    'recorder', 'bait', 'letter',
    'blue_potion', 'red_potion',
    'wand', 'magical_shield',
    'raft', 'book', 'blue_ring', 'red_ring',
    'ladder', 'magic_key', 'power_bracelet',
]


class InventoryAccumulator:
    """Builds a cumulative inventory dict from game events.

    Usage::

        acc = InventoryAccumulator()
        # After each frame's events:
        for event in new_events:
            acc.process_event(event)
        inventory = acc.get_inventory()
    """

    def __init__(self):
        self._obtained: set[str] = set()

    def process_event(self, event: dict) -> None:
        """Update inventory knowledge from a single game event.

        Recognised event types:
        - ``b_item_change`` — the new B-item is now known
        - ``staircase_item_acquired`` — item picked up from staircase pedestal
        - ``item_obtained`` — floor item picked up (player stayed in room)
        - ``sword_upgrade`` — sword level increased (handled via description)
        """
        etype = event.get('event', '')

        if etype == 'b_item_change':
            self._add_from_b_item(event.get('description', ''))

        elif etype == 'staircase_item_acquired':
            item = event.get('item')
            if item:
                self._add_item(item)

        elif etype == 'item_obtained':
            item = event.get('item')
            if item:
                self._add_item(item)

        elif etype == 'sword_upgrade':
            desc = event.get('description', '')
            if 'Magical Sword' in desc:
                self._add_item('magical_sword')
            elif 'White Sword' in desc:
                self._add_item('white_sword')
            elif 'Wooden Sword' in desc:
                self._add_item('wood_sword')

    def process_subscreen(self, items: dict) -> None:
        """Seed from the vanilla inventory reader (non-Z1R).

        If the inventory reader returns a populated dict (vanilla ROM),
        merge all True items into the accumulator.
        """
        for name, has_it in items.items():
            if has_it:
                self._add_item(name)

    def get_inventory(self) -> dict[str, bool]:
        """Return the full inventory dict (all tracked items)."""
        return {name: (name in self._obtained) for name in ALL_ITEMS}

    def reset(self) -> None:
        """Clear all accumulated inventory."""
        self._obtained.clear()

    def _add_item(self, name: str) -> None:
        """Record an item as obtained, including upgrade-implied items."""
        self._obtained.add(name)

        # Apply upgrade chain implications
        implied = UPGRADE_IMPLIES.get(name, [])
        for imp in implied:
            self._obtained.add(imp)

    def _add_from_b_item(self, description: str) -> None:
        """Extract the b-item name from a b_item_change event description.

        Event descriptions look like: ``B-item: blue_candle (was bomb)``
        """
        # Parse "B-item: <name>" or "B-item: <name> (was <old>)"
        if not description.startswith('B-item: '):
            return

        rest = description[len('B-item: '):]
        # Strip "(was ...)" suffix if present
        paren = rest.find(' (was ')
        if paren >= 0:
            b_item_name = rest[:paren]
        else:
            b_item_name = rest

        # Map b_item name to inventory name
        inv_name = _B_ITEM_TO_INVENTORY.get(b_item_name, b_item_name)
        self._add_item(inv_name)
