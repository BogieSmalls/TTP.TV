"""Inventory reader for NES Zelda 1 subscreen.

Detects which items the player has collected by examining fixed-position
item slots on the subscreen (Select button screen). Also detects sword
level and the currently selected B-item.

All coordinates are for the canonical 256x240 NES frame.
"""

import numpy as np
from .color_utils import dominant_channel, color_distance

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


def _extract_tile(frame: np.ndarray, y: int, x: int, h: int, w: int) -> np.ndarray:
    """Extract a tile region from the frame."""
    return frame[y:y + h, x:x + w]


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

    def __init__(self):
        self._native_crop = None
        self._scale_x = 1.0
        self._scale_y = 1.0

    def set_native_crop(self, crop_frame: np.ndarray,
                        scale_x: float, scale_y: float) -> None:
        self._native_crop = crop_frame
        self._scale_x = scale_x
        self._scale_y = scale_y

    def clear_native_crop(self) -> None:
        self._native_crop = None

    def read_items(self, frame: np.ndarray) -> dict:
        """Read all inventory item slots.

        Args:
            frame: 256x240 BGR NES frame (must be on subscreen).

        Returns:
            Dict of item_name -> True/False, or {} if Z1R SWAP layout.
        """
        # Detect Z1R SWAP layout: "SWAP" red text at the top of the
        # subscreen (tile row ~1, col ~12-15).  Vanilla Zelda shows
        # "INVENTORY" white text instead.
        if self._is_z1r_swap(frame):
            return {}

        items = {}

        for name, (y, x, h, w) in ACTIVE_ITEM_SLOTS.items():
            tile = _extract_tile(frame, y, x, h, w)
            items[name] = _tile_occupied(tile)

        for name, (y, x, h, w) in PASSIVE_ITEM_SLOTS.items():
            tile = _extract_tile(frame, y, x, h, w)
            items[name] = _tile_occupied(tile)

        # Detect item upgrades based on color
        items = self._detect_upgrades(frame, items)

        return items

    def _is_z1r_swap(self, frame: np.ndarray) -> bool:
        """Detect Z1R SWAP layout by checking for red "SWAP" text near top.

        The Z1R subscreen shows red "SWAP" text at approximately y=0-18,
        x=28-68 (varies with scroll position).  Vanilla Zelda shows white
        "INVENTORY" text instead.

        Also returns True for partial-scroll subscreens where the item grid
        area (y=48-120, x=128+) would overlap with game area or triforce
        display and produce garbage readings.
        """
        # Check for red text in top 40 rows, x=24-72
        # SWAP text Y position varies with scroll state (y=0..35)
        src = self._native_crop if self._native_crop is not None else frame
        if self._native_crop is not None:
            y_max = round(40 * self._scale_y)
            x_min = round(24 * self._scale_x)
            x_max = round(72 * self._scale_x)
        else:
            y_max, x_min, x_max = 40, 24, 72
        region = src[0:y_max, x_min:x_max]
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
        if src.shape[0] > round(220 * self._scale_y):
            top_y   = round(60  * self._scale_y)
            bot_y1  = round(160 * self._scale_y)
            bot_y2  = round(220 * self._scale_y)
            top_bright    = float(np.mean(src[0:top_y, :, :]))
            bottom_bright = float(np.mean(src[bot_y1:bot_y2, :, :]))
            if top_bright < 30 and bottom_bright > 80:
                return True

        return False

    def read_sword_level(self, frame: np.ndarray) -> int:
        """Detect sword level from the HUD sword indicator.

        Returns:
            0 = no sword, 1 = wood, 2 = white, 3 = magical
        """
        y, x, h, w = SWORD_REGION
        tile = _extract_tile(frame, y, x, h, w)

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

    def read_b_item(self, frame: np.ndarray) -> str | None:
        """Detect the currently selected B-item from the HUD.

        Returns:
            Item name string or None if no B-item.
        """
        y, x, h, w = B_ITEM_REGION
        tile = _extract_tile(frame, y, x, h, w)

        if not _tile_occupied(tile):
            return None

        # Match against known item colors/shapes
        # For now, return a generic indicator — refinement needs real frame testing
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

    def _detect_upgrades(self, frame: np.ndarray, items: dict) -> dict:
        """Detect item upgrades based on tile color.

        Some items upgrade in-place with color changes:
        - boomerang (blue) -> magic boomerang (red-ish)
        - blue candle (blue) -> red candle (red)
        - letter -> blue potion (blue) -> red potion (red)
        """
        # Boomerang upgrade: magic boomerang is red-tinted
        if items.get('boomerang'):
            y, x, h, w = ACTIVE_ITEM_SLOTS['boomerang']
            tile = _extract_tile(frame, y, x, h, w)
            dominant = dominant_channel(tile)
            if dominant == 'red':
                items['boomerang'] = False
                items['magic_boomerang'] = True
            else:
                items['magic_boomerang'] = False

        # Candle upgrade: blue candle -> red candle
        if items.get('candle'):
            y, x, h, w = ACTIVE_ITEM_SLOTS['candle']
            tile = _extract_tile(frame, y, x, h, w)
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
            tile = _extract_tile(frame, y, x, h, w)
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
            tile = _extract_tile(frame, y, x, h, w)
            dominant = dominant_channel(tile)
            if dominant == 'red':
                items['red_ring'] = True
                items['blue_ring'] = False
            else:
                items['blue_ring'] = True
                items['red_ring'] = False

        return items
