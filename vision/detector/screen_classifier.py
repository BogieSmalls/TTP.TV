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

from .nes_frame import NESFrame

# ── Brightness thresholds ────────────────────────────────────────────────────
TRANSITION_BRIGHTNESS_MAX = 8
LOW_BRIGHTNESS_MAX = 25
SUBSCREEN_DARK_GAME_MAX = 30

# ── Gameplay area brightness ─────────────────────────────────────────────────
DUNGEON_BRIGHTNESS_MAX = 35
CAVE_BRIGHTNESS_MAX = 55

# ── Red text detection (LIFE / ROAR) ────────────────────────────────────────
RED_CHANNEL_MIN = 50
RED_TO_GREEN_RATIO = 2.0
RED_TO_BLUE_RATIO = 2.0

# ── Death flash ──────────────────────────────────────────────────────────────
DEATH_FLASH_RED_MIN = 100

# ── Death menu (CONTINUE / SAVE / RETRY) ────────────────────────────────────
DEATH_MENU_BRIGHTNESS_MAX = 30
DEATH_MENU_BRIGHTNESS_MIN = 3

DEATH_MENU_CENTER_Y = (80, 180)
DEATH_MENU_CENTER_X = (80, 220)

DEATH_MENU_CENTER_BRIGHT_MIN = 5
DEATH_MENU_CENTER_BRIGHT_MAX = 60

WHITE_PIXEL_THRESHOLD = 150
WHITE_RATIO_MIN = 0.02
WHITE_RATIO_MAX = 0.15

# ── Title screen ─────────────────────────────────────────────────────────────
TITLE_TOP_ROWS = 30
TITLE_TOP_BRIGHTNESS_MAX = 10

# ── Shifted HUD (subscreen scroll) ──────────────────────────────────────────
SHIFTED_HUD_Y_START = 100
SHIFTED_HUD_Y_END = 232
CONSECUTIVE_RED_ROWS_MIN = 4

MINIMAP_X_START = 16
MINIMAP_X_END = 80
MINIMAP_Y_ABOVE_LIFE = 8
MINIMAP_Y_BELOW_LIFE = 24
MINIMAP_CHANNEL_SPREAD_MAX = 30
MINIMAP_BRIGHTNESS_MIN = 40
MINIMAP_BRIGHTNESS_MAX = 140


class ScreenClassifier:
    """Classify NES Zelda 1 screen type from an NESFrame."""

    def __init__(self, life_row: int = 5):
        self._life_row = life_row

    def classify(self, nf: NESFrame) -> str:
        """Classify the current screen.

        Args:
            nf: NESFrame wrapping the native-resolution NES crop.

        Returns:
            One of: 'overworld', 'dungeon', 'cave', 'subscreen',
                    'death', 'title', 'transition'
        """
        if self._has_life_text(nf):
            return self._classify_gameplay(nf)

        src = nf.crop
        game_area = nf.game_area()
        full_brightness = float(np.mean(src))

        if full_brightness < TRANSITION_BRIGHTNESS_MAX:
            return 'transition'
        if self._is_death_flash(game_area):
            return 'death'
        if self._has_shifted_hud(nf):
            return 'subscreen'
        if self._is_death_menu(nf):
            return 'death'
        if self._is_title(nf):
            return 'title'
        if full_brightness < LOW_BRIGHTNESS_MAX:
            return 'transition'
        game_brightness = float(np.mean(game_area))
        if game_brightness < SUBSCREEN_DARK_GAME_MAX:
            return 'subscreen'
        return 'unknown'

    def _has_life_text(self, nf: NESFrame) -> bool:
        """Check for "-LIFE-" or "-ROAR-" red text in the standard HUD position."""
        tile = nf.tile(22, self._life_row)
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        return r > RED_CHANNEL_MIN and r > g * RED_TO_GREEN_RATIO and r > b * RED_TO_BLUE_RATIO

    def _classify_gameplay(self, nf: NESFrame) -> str:
        """Classify a frame known to have the gameplay HUD."""
        game_area = nf.game_area()
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

    def _is_death_menu(self, nf: NESFrame) -> bool:
        """Check for CONTINUE/SAVE/RETRY death menu."""
        src = nf.crop
        full_brightness = float(np.mean(src))
        if full_brightness > DEATH_MENU_BRIGHTNESS_MAX or full_brightness < DEATH_MENU_BRIGHTNESS_MIN:
            return False
        center = nf.region(DEATH_MENU_CENTER_X[0], DEATH_MENU_CENTER_Y[0],
                           DEATH_MENU_CENTER_X[1] - DEATH_MENU_CENTER_X[0],
                           DEATH_MENU_CENTER_Y[1] - DEATH_MENU_CENTER_Y[0])
        if center.size == 0:
            return False
        center_brightness = float(np.mean(center))
        if center_brightness < DEATH_MENU_CENTER_BRIGHT_MIN or center_brightness > DEATH_MENU_CENTER_BRIGHT_MAX:
            return False
        white_mask = np.mean(center, axis=2) > WHITE_PIXEL_THRESHOLD
        white_ratio = float(np.sum(white_mask)) / (center.shape[0] * center.shape[1])
        return WHITE_RATIO_MIN < white_ratio < WHITE_RATIO_MAX

    def _is_title(self, nf: NESFrame) -> bool:
        """Check for title screen or file select."""
        top = nf.region(0, 0, 256, TITLE_TOP_ROWS)
        return float(np.mean(top)) < TITLE_TOP_BRIGHTNESS_MAX

    def _has_shifted_hud(self, nf: NESFrame) -> bool:
        """Check if the HUD is shifted down (subscreen scroll).

        Detects:
        1. Red "-LIFE-" text below normal position (sliding Y scan)
        2. Minimap grey rectangle near the shifted LIFE text
        """
        src = nf.crop
        tw = nf.scale_coord(8, 'x')
        th = nf.scale_coord(8, 'y')
        x = nf.scale_coord(22 * 8 + nf.grid_dx, 'x')
        if x + tw > src.shape[1]:
            return False

        y_start = nf.scale_coord(SHIFTED_HUD_Y_START, 'y')
        y_end = min(nf.scale_coord(SHIFTED_HUD_Y_END, 'y'), src.shape[0] - th)
        step = max(1, round(nf.scale_y))

        life_y = None
        consecutive_red = 0
        for y in range(y_start, y_end, step):
            tile = src[y:y + th, x:x + tw]
            avg = np.mean(tile, axis=(0, 1))
            r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
            if r > RED_CHANNEL_MIN and r > g * RED_TO_GREEN_RATIO and r > b * RED_TO_BLUE_RATIO:
                consecutive_red += 1
                if consecutive_red >= CONSECUTIVE_RED_ROWS_MIN and life_y is None:
                    life_y = y - (CONSECUTIVE_RED_ROWS_MIN - 1) * step
            else:
                consecutive_red = 0

        if life_y is None:
            return False

        map_y_above = nf.scale_coord(MINIMAP_Y_ABOVE_LIFE, 'y')
        map_y_below = nf.scale_coord(MINIMAP_Y_BELOW_LIFE, 'y')
        mx1 = nf.scale_coord(MINIMAP_X_START, 'x')
        mx2 = nf.scale_coord(MINIMAP_X_END, 'x')
        map_y = max(0, life_y - map_y_above)
        map_y2 = min(src.shape[0], life_y + map_y_below)
        if map_y2 - map_y < th or mx2 <= mx1:
            return False
        map_region = src[map_y:map_y2, mx1:mx2]
        avg_map = np.mean(map_region, axis=(0, 1))
        channel_spread = float(max(avg_map) - min(avg_map))
        brightness = float(np.mean(avg_map))
        return (channel_spread < MINIMAP_CHANNEL_SPREAD_MAX
                and MINIMAP_BRIGHTNESS_MIN < brightness < MINIMAP_BRIGHTNESS_MAX)
