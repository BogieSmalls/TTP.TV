"""Classify the current NES screen type.

The Legend of Zelda has several distinct screen modes:
- Overworld: Bright outdoor areas with green/brown terrain
- Dungeon: Dark rooms with specific wall/floor patterns
- Cave: Shops, item caves, old man caves
- Subscreen: Inventory/pause screen (scrolls up from gameplay)
- Death: Screen goes red/dark on Link's death
- Title: Title screen / file select
- Transition: Screen is scrolling between rooms
"""

import numpy as np

# ── Brightness thresholds ────────────────────────────────────────────────────
# Frame-level mean brightness for overall screen classification.

# Nearly black: screen scrolling or fade-to-black transition.
TRANSITION_BRIGHTNESS_MAX = 8

# Low brightness fallback: no HUD + dim → likely transition.
LOW_BRIGHTNESS_MAX = 25

# Game area brightness for dark-bg subscreen classification.
SUBSCREEN_DARK_GAME_MAX = 30

# ── Gameplay area brightness ─────────────────────────────────────────────────
# Classify overworld/dungeon/cave by average game area (rows 64-240) brightness.

DUNGEON_BRIGHTNESS_MAX = 35
CAVE_BRIGHTNESS_MAX = 55

# ── Red text detection (LIFE / ROAR) ────────────────────────────────────────
# Red channel must exceed these thresholds to confirm NES red HUD text.
# Applied to 8×8 tile average at the LIFE text position.

RED_CHANNEL_MIN = 50          # Minimum red channel average
RED_TO_GREEN_RATIO = 2.0      # Red must be > green × this
RED_TO_BLUE_RATIO = 2.0       # Red must be > blue × this

# ── Death flash ──────────────────────────────────────────────────────────────
# Death animation: game area floods red.

DEATH_FLASH_RED_MIN = 100     # Red channel average across game area

# ── Death menu (CONTINUE / SAVE / RETRY) ────────────────────────────────────
# Mostly-black screen with white text centered.

DEATH_MENU_BRIGHTNESS_MAX = 30   # Full frame must be dark
DEATH_MENU_BRIGHTNESS_MIN = 3    # But not pure black (content present)

# Center region where menu text appears (pixel coordinates in 256×240 frame).
DEATH_MENU_CENTER_Y = (80, 180)
DEATH_MENU_CENTER_X = (80, 220)

DEATH_MENU_CENTER_BRIGHT_MIN = 5    # Some text must be visible
DEATH_MENU_CENTER_BRIGHT_MAX = 60   # But not too bright overall

# White text pixel detection within center region.
WHITE_PIXEL_THRESHOLD = 150         # Per-pixel mean > this = "white"
WHITE_RATIO_MIN = 0.02              # At least 2% white text
WHITE_RATIO_MAX = 0.15              # At most 15% white text

# ── Title screen ─────────────────────────────────────────────────────────────
# Title/file-select: no HUD, very dark top area.

TITLE_TOP_ROWS = 30                 # Check brightness of top N rows
TITLE_TOP_BRIGHTNESS_MAX = 10       # Top must be very dark

# ── Shifted HUD (subscreen scroll) ──────────────────────────────────────────
# When the subscreen scrolls open, the HUD shifts down. We scan vertically
# for LIFE text below its normal position.

SHIFTED_HUD_Y_START = 100           # Start scanning for shifted LIFE text
SHIFTED_HUD_Y_END = 232             # Max scan Y (LIFE can appear at y=218+)
CONSECUTIVE_RED_ROWS_MIN = 4        # Require N consecutive red rows

# Minimap confirmation: grey rectangle near the shifted LIFE text.
MINIMAP_X_START = 16
MINIMAP_X_END = 80
MINIMAP_Y_ABOVE_LIFE = 8            # Check from life_y - this ...
MINIMAP_Y_BELOW_LIFE = 24           # ... to life_y + this
MINIMAP_CHANNEL_SPREAD_MAX = 30     # Grey: RGB channels within this range
MINIMAP_BRIGHTNESS_MIN = 40         # Not too dark
MINIMAP_BRIGHTNESS_MAX = 140        # Not too bright


class ScreenClassifier:
    """Classify NES Zelda 1 screen type from a 256x240 frame."""

    def __init__(self, grid_offset: tuple[int, int] = (1, 2), life_row: int = 5):
        self.grid_dx, self.grid_dy = grid_offset
        self._life_row = life_row

    def classify(self, frame: np.ndarray) -> str:
        """Classify the current screen.

        Args:
            frame: 256x240 BGR frame.

        Returns:
            One of: 'overworld', 'dungeon', 'cave', 'subscreen', 'death', 'title', 'transition'
        """
        # PRIMARY CHECK: Is the gameplay HUD present?
        # The "-LIFE-" (or "-ROAR-") text at a fixed HUD position is the most
        # reliable indicator of a gameplay screen. If present, the screen is
        # NEVER a subscreen, title, death menu, or transition.
        if self._has_life_text(frame):
            return self._classify_gameplay(frame)

        # No HUD — determine which non-gameplay screen type
        game_area = frame[64:240, :, :]
        full_brightness = float(np.mean(frame))

        # Nearly black = transition (screen scrolling or fade)
        if full_brightness < TRANSITION_BRIGHTNESS_MAX:
            return 'transition'

        # Death animation: heavy red flash across game area
        if self._is_death_flash(game_area):
            return 'death'

        # Subscreen: HUD shifted down (inventory, item-get, triforce collection).
        # Must check BEFORE death menu — subscreens have dark bg + white text
        # that can fool the death menu detector.
        if self._has_shifted_hud(frame):
            return 'subscreen'

        # Death menu: CONTINUE/SAVE/RETRY on black background
        if self._is_death_menu(frame):
            return 'death'

        # Title screen: very dark top area (no HUD at all)
        if self._is_title(frame):
            return 'title'

        # Low brightness with some content = probably transition
        if full_brightness < LOW_BRIGHTNESS_MAX:
            return 'transition'

        # Moderate brightness without HUD — could be subscreen or unknown
        # Check for inventory-like layout (dark background with scattered bright spots)
        game_brightness = float(np.mean(game_area))
        if game_brightness < SUBSCREEN_DARK_GAME_MAX:
            return 'subscreen'

        return 'unknown'

    def _has_life_text(self, frame: np.ndarray) -> bool:
        """Check for "-LIFE-" or "-ROAR-" red text in the standard HUD position.

        This is the most reliable gameplay indicator. The text is at the
        detected LIFE row (typically row 4-5), col 22.
        """
        y = self._life_row * 8 + self.grid_dy
        x = 22 * 8 + self.grid_dx
        if y + 8 > frame.shape[0] or x + 8 > frame.shape[1]:
            return False
        tile = frame[y:y + 8, x:x + 8]
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        return r > RED_CHANNEL_MIN and r > g * RED_TO_GREEN_RATIO and r > b * RED_TO_BLUE_RATIO

    def _classify_gameplay(self, frame: np.ndarray) -> str:
        """Classify a frame known to have the gameplay HUD."""
        game_area = frame[64:240, :, :]
        avg_brightness = float(np.mean(game_area))

        if avg_brightness < DUNGEON_BRIGHTNESS_MAX:
            return 'dungeon'
        elif avg_brightness < CAVE_BRIGHTNESS_MAX:
            return 'cave'
        else:
            return 'overworld'

    def _is_death_flash(self, game_area: np.ndarray) -> bool:
        """Check for death animation (screen flashes red)."""
        red_mean = float(np.mean(game_area[:, :, 2]))
        green_mean = float(np.mean(game_area[:, :, 1]))
        blue_mean = float(np.mean(game_area[:, :, 0]))
        return (red_mean > DEATH_FLASH_RED_MIN
                and red_mean > green_mean * RED_TO_GREEN_RATIO
                and red_mean > blue_mean * RED_TO_BLUE_RATIO)

    def _is_death_menu(self, frame: np.ndarray) -> bool:
        """Check for CONTINUE/SAVE/RETRY death menu.

        This screen has white text centered on a black background, with a small
        red heart icon. No HUD is present.
        """
        full_brightness = float(np.mean(frame))
        if full_brightness > DEATH_MENU_BRIGHTNESS_MAX or full_brightness < DEATH_MENU_BRIGHTNESS_MIN:
            return False

        # Check for white pixels in the center area (text region)
        cy1, cy2 = DEATH_MENU_CENTER_Y
        cx1, cx2 = DEATH_MENU_CENTER_X
        center = frame[cy1:cy2, cx1:cx2, :]
        center_brightness = float(np.mean(center))
        if center_brightness < DEATH_MENU_CENTER_BRIGHT_MIN or center_brightness > DEATH_MENU_CENTER_BRIGHT_MAX:
            return False

        # Count bright white pixels in center (text characters)
        white_mask = np.mean(center, axis=2) > WHITE_PIXEL_THRESHOLD
        white_ratio = float(np.sum(white_mask)) / (center.shape[0] * center.shape[1])
        return WHITE_RATIO_MIN < white_ratio < WHITE_RATIO_MAX

    def _is_title(self, frame: np.ndarray) -> bool:
        """Check for title screen or file select.

        The title screen has no HUD. The top area is very dark.
        """
        top = frame[0:TITLE_TOP_ROWS, :, :]
        avg_top = float(np.mean(top))
        return avg_top < TITLE_TOP_BRIGHTNESS_MAX

    def _has_shifted_hud(self, frame: np.ndarray) -> bool:
        """Check if the HUD is shifted down (item-get screen or subscreen scroll).

        When the subscreen opens or a dungeon item is obtained, the HUD scrolls
        down. We detect this by finding:
        1. The "-LIFE-" red text at the standard HUD x-position (sliding Y scan)
        2. The minimap grey rectangle near the expected position

        Both checks together prevent false positives from intro/story text
        screens which have red text but no minimap.
        """
        x = 22 * 8 + self.grid_dx
        if x + 8 > frame.shape[1]:
            return False

        y_end = min(SHIFTED_HUD_Y_END, frame.shape[0] - 8)

        # Step 1: Find LIFE text (N+ consecutive strong-red rows)
        life_y = None
        consecutive_red = 0
        for y in range(SHIFTED_HUD_Y_START, y_end):
            tile = frame[y:y + 8, x:x + 8]
            avg = np.mean(tile, axis=(0, 1))
            r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
            if r > RED_CHANNEL_MIN and r > g * RED_TO_GREEN_RATIO and r > b * RED_TO_BLUE_RATIO:
                consecutive_red += 1
                if consecutive_red >= CONSECUTIVE_RED_ROWS_MIN and life_y is None:
                    life_y = y - (CONSECUTIVE_RED_ROWS_MIN - 1)
            else:
                consecutive_red = 0

        if life_y is None:
            return False

        # Step 2: Check for minimap grey rectangle near LIFE text.
        map_y = max(0, life_y - MINIMAP_Y_ABOVE_LIFE)
        map_y_end = min(frame.shape[0], life_y + MINIMAP_Y_BELOW_LIFE)
        if map_y_end - map_y < 8:
            return False

        map_region = frame[map_y:map_y_end, MINIMAP_X_START:MINIMAP_X_END]
        avg_map = np.mean(map_region, axis=(0, 1))
        channel_spread = float(max(avg_map) - min(avg_map))
        brightness = float(np.mean(avg_map))
        if channel_spread < MINIMAP_CHANNEL_SPREAD_MAX and MINIMAP_BRIGHTNESS_MIN < brightness < MINIMAP_BRIGHTNESS_MAX:
            return True

        return False
