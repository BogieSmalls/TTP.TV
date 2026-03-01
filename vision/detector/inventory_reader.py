"""Inventory reader for NES Zelda 1 subscreen.

Detects which items the player has collected by examining fixed-position
item slots on the subscreen (Select button screen). Also detects sword
level and the currently selected B-item.

All coordinates are in NES 256x240 space, mapped to native resolution
via the NESFrame wrapper.
"""

import numpy as np
from .color_utils import dominant_channel, color_distance
from .nes_frame import NESFrame

# NES Zelda 1 subscreen item slot positions (y, x) and tile size.
# Active items (selectable as B-item) — 2 rows of 4
ACTIVE_ITEM_SLOTS = {
    'boomerang':  (72, 128, 8, 8),   # (y, x, h, w)
    'bombs':      (72, 152, 8, 8),
    'bow':        (72, 176, 8, 8),
    'candle':     (72, 200, 8, 8),
    'recorder':   (88, 128, 8, 8),
    'food':       (88, 152, 8, 8),
    'potion':     (88, 176, 8, 8),   # letter -> blue potion -> red potion
    'magic_rod':  (88, 200, 8, 8),
}

# Passive items (not selectable, shown in a row below active items)
PASSIVE_ITEM_SLOTS = {
    'raft':            (112, 128, 8, 8),
    'book':            (112, 144, 8, 8),
    'ring':            (112, 160, 8, 8),
    'ladder':          (112, 176, 8, 8),
    'magic_key':       (112, 192, 8, 8),
    'power_bracelet':  (112, 208, 8, 8),
}

# Sword indicator position in the HUD area
SWORD_REGION = (24, 152, 8, 8)  # y, x, h, w

# B-item display position in the HUD
B_ITEM_REGION = (16, 128, 16, 16)  # y, x, h, w (larger area)

# Brightness threshold — slots darker than this are empty
EMPTY_THRESHOLD = 15

# NES color references (BGR)
RED_BGR = np.array([68, 36, 184], dtype=np.uint8)
BLUE_BGR = np.array([184, 100, 0], dtype=np.uint8)
BROWN_BGR = np.array([0, 120, 136], dtype=np.uint8)
WHITE_BGR = np.array([236, 236, 236], dtype=np.uint8)


def _tile_occupied(tile: np.ndarray) -> bool:
    """Check if a tile contains an item (is not empty/black)."""
    return float(np.mean(tile)) > EMPTY_THRESHOLD


class InventoryReader:
    """Read inventory items from the NES Zelda 1 subscreen.

    Note: Z1R (Zelda 1 Randomizer) replaces the vanilla inventory grid with
    a "SWAP" interface that shows only the B-item selector and triforce
    display — no item grid.  When a Z1R SWAP layout is detected, read_items()
    returns an empty dict.  Item tracking for Z1R relies on HUD B-item and
    sword-level changes during gameplay instead.
    """

    def read_items(self, nf: NESFrame) -> dict:
        """Read all inventory item slots.

        Args:
            nf: NESFrame wrapping the native-resolution NES crop.

        Returns:
            Dict of item_name -> True/False, or {} if Z1R SWAP layout.
        """
        if self._is_z1r_swap(nf):
            return {}

        items = {}

        for name, (y, x, h, w) in ACTIVE_ITEM_SLOTS.items():
            tile = nf.extract(x, y, w, h)
            items[name] = _tile_occupied(tile)

        for name, (y, x, h, w) in PASSIVE_ITEM_SLOTS.items():
            tile = nf.extract(x, y, w, h)
            items[name] = _tile_occupied(tile)

        # Detect item upgrades based on color
        items = self._detect_upgrades(nf, items)

        return items

    def _is_z1r_swap(self, nf: NESFrame) -> bool:
        """Detect Z1R SWAP layout by checking for red "SWAP" text near top.

        The Z1R subscreen shows red "SWAP" text at approximately y=0-18,
        x=28-68 (varies with scroll position).  Vanilla Zelda shows white
        "INVENTORY" text instead.

        Also returns True for partial-scroll subscreens where the item grid
        area (y=48-120, x=128+) would overlap with game area or triforce
        display and produce garbage readings.
        """
        # Check for red text in top 40 rows, x=24-72
        src = nf.crop
        region = nf.region(24, 0, 48, 40)
        if region.size == 0:
            return False
        r = region[:, :, 2].astype(float)
        g = region[:, :, 1].astype(float)
        b = region[:, :, 0].astype(float)
        red_mask = (r > 50) & (r > g * 2) & (r > b * 2)
        red_count = int(np.sum(red_mask))
        if red_count >= 10:
            return True

        # Fallback: detect partial-scroll subscreen where SWAP text is
        # off-screen.  On a partial scroll, the subscreen content (dark) is
        # at the top, and the game area (bright) is still visible below.
        # Require: dark top (y=0-60) AND bright bottom (y=160-220).
        top_region = nf.region(0, 0, 256, 60)
        bot_region = nf.region(0, 160, 256, 60)
        if top_region.size > 0 and bot_region.size > 0:
            top_bright = float(np.mean(top_region))
            bottom_bright = float(np.mean(bot_region))
            if top_bright < 30 and bottom_bright > 80:
                return True

        return False

    def read_sword_level(self, nf: NESFrame) -> int:
        """Detect sword level from the HUD sword indicator.

        Returns:
            0 = no sword, 1 = wood, 2 = white, 3 = magical
        """
        y, x, h, w = SWORD_REGION
        tile = nf.extract(x, y, w, h)

        if not _tile_occupied(tile):
            return 0

        avg = np.mean(tile, axis=(0, 1))
        brightness = float(np.mean(avg))

        # Magical sword has a distinctive blue/teal tint
        if avg[0] > avg[2] + 20:  # Blue channel > Red channel (BGR)
            return 3

        # White sword is very bright
        if brightness > 160:
            return 2

        # Wood sword (brown/tan)
        return 1

    def read_b_item(self, nf: NESFrame) -> str | None:
        """Detect the currently selected B-item from the HUD.

        Returns:
            Item name string or None if no B-item.
        """
        y, x, h, w = B_ITEM_REGION
        tile = nf.extract(x, y, w, h)

        if not _tile_occupied(tile):
            return None

        # Match against known item colors/shapes
        dominant = dominant_channel(tile)
        avg_brightness = float(np.mean(tile))

        if avg_brightness < EMPTY_THRESHOLD:
            return None

        # Basic color-based identification
        if dominant == 'red':
            return 'candle'  # or red potion
        elif dominant == 'blue':
            return 'boomerang'  # or blue potion
        elif dominant == 'green':
            return 'recorder'

        return 'unknown'

    def _detect_upgrades(self, nf: NESFrame, items: dict) -> dict:
        """Detect item upgrades based on tile color.

        Some items upgrade in-place with color changes:
        - boomerang (blue) -> magic boomerang (red-ish)
        - blue candle (blue) -> red candle (red)
        - letter -> blue potion (blue) -> red potion (red)
        """
        # Boomerang upgrade: magic boomerang is red-tinted
        if items.get('boomerang'):
            y, x, h, w = ACTIVE_ITEM_SLOTS['boomerang']
            tile = nf.extract(x, y, w, h)
            dominant = dominant_channel(tile)
            if dominant == 'red':
                items['boomerang'] = False
                items['magic_boomerang'] = True
            else:
                items['magic_boomerang'] = False

        # Candle upgrade: blue candle -> red candle
        if items.get('candle'):
            y, x, h, w = ACTIVE_ITEM_SLOTS['candle']
            tile = nf.extract(x, y, w, h)
            dominant = dominant_channel(tile)
            if dominant == 'red':
                items['red_candle'] = True
                items['blue_candle'] = False
            else:
                items['blue_candle'] = True
                items['red_candle'] = False

        # Potion slot upgrades: letter -> blue potion -> red potion
        if items.get('potion'):
            y, x, h, w = ACTIVE_ITEM_SLOTS['potion']
            tile = nf.extract(x, y, w, h)
            dominant = dominant_channel(tile)
            if dominant == 'red':
                items['red_potion'] = True
                items['blue_potion'] = False
                items['letter'] = False
            elif dominant == 'blue':
                items['blue_potion'] = True
                items['red_potion'] = False
                items['letter'] = False
            else:
                items['letter'] = True
                items['blue_potion'] = False
                items['red_potion'] = False

        # Ring detection: blue ring vs red ring
        if items.get('ring'):
            y, x, h, w = PASSIVE_ITEM_SLOTS['ring']
            tile = nf.extract(x, y, w, h)
            dominant = dominant_channel(tile)
            if dominant == 'red':
                items['red_ring'] = True
                items['blue_ring'] = False
            else:
                items['blue_ring'] = True
                items['red_ring'] = False

        return items
