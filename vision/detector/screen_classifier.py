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
        # Native crop support — set per-frame via set_native_crop()
        self._native_crop: np.ndarray | None = None
        self._scale_x: float = 1.0
        self._scale_y: float = 1.0

    def set_native_crop(self, crop_frame: np.ndarray,
                        scale_x: float, scale_y: float) -> None:
        """Provide the native-resolution crop for this frame.

        When set, all pixel reads use stream-space coordinates computed from
        scale_x = crop_w/256, scale_y = crop_h/240. Dramatically improves
        reliability by avoiding Twitch H.264 DCT artifacts that smear 8×8 tiles
        when the frame is downscaled to 256×240.

        Args:
            crop_frame: The NES game region at native stream resolution
                        (shape: crop_h × crop_w, BGR).
            scale_x:    crop_w / 256.0
            scale_y:    crop_h / 240.0
        """
        self._native_crop = crop_frame
        self._scale_x = scale_x
        self._scale_y = scale_y

    def clear_native_crop(self) -> None:
        """Release the native crop reference (call after each frame)."""
        self._native_crop = None

    def _af(self, canonical: np.ndarray) -> np.ndarray:
        """Return active frame: native crop if set, else canonical."""
        return self._native_crop if self._native_crop is not None else canonical

    def _sc(self, nes_x: int, nes_y: int,
            nes_w: int = 8, nes_h: int = 8) -> tuple[int, int, int, int]:
        """Scale NES pixel coords to active-frame coords.

        Returns (x, y, w, h) in the active frame's coordinate space.
        When native crop is set, multiplies by scale factors.
        When no native crop, returns NES coords unchanged (1:1).
        """
        if self._native_crop is not None:
            return (round(nes_x * self._scale_x),
                    round(nes_y * self._scale_y),
                    max(1, round(nes_w * self._scale_x)),
                    max(1, round(nes_h * self._scale_y)))
        return nes_x, nes_y, nes_w, nes_h

    def classify(self, frame: np.ndarray) -> str:
        """Classify the current screen.

        Args:
            frame: 256x240 BGR frame.

        Returns:
            One of: 'overworld', 'dungeon', 'cave', 'subscreen', 'death', 'title', 'transition'
        """
        if self._has_life_text(frame):
            return self._classify_gameplay(frame)

        src = self._af(frame)
        hud_h = round(64 * self._scale_y) if self._native_crop is not None else 64
        game_area = src[hud_h:, :, :]
        full_brightness = float(np.mean(src))

        if full_brightness < TRANSITION_BRIGHTNESS_MAX:
            return 'transition'
        if self._is_death_flash(game_area):
            return 'death'
        if self._has_shifted_hud(frame):
            return 'subscreen'
        if self._is_death_menu(frame):
            return 'death'
        if self._is_title(frame):
            return 'title'
        if full_brightness < LOW_BRIGHTNESS_MAX:
            return 'transition'
        game_brightness = float(np.mean(game_area))
        if game_brightness < SUBSCREEN_DARK_GAME_MAX:
            return 'subscreen'
        return 'unknown'

    def _has_life_text(self, frame: np.ndarray) -> bool:
        """Check for "-LIFE-" or "-ROAR-" red text in the standard HUD position.

        This is the most reliable gameplay indicator. The text is at the
        detected LIFE row (typically row 4-5), col 22.
        """
        src = self._af(frame)
        x, y, w, h = self._sc(22 * 8 + self.grid_dx, self._life_row * 8 + self.grid_dy)
        if y + h > src.shape[0] or x + w > src.shape[1]:
            return False
        tile = src[y:y + h, x:x + w]
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        return r > RED_CHANNEL_MIN and r > g * RED_TO_GREEN_RATIO and r > b * RED_TO_BLUE_RATIO

    def _classify_gameplay(self, frame: np.ndarray) -> str:
        """Classify a frame known to have the gameplay HUD."""
        src = self._af(frame)
        hud_h = round(64 * self._scale_y) if self._native_crop is not None else 64
        game_area = src[hud_h:, :, :]
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
        src = self._af(frame)
        full_brightness = float(np.mean(src))
        if full_brightness > DEATH_MENU_BRIGHTNESS_MAX or full_brightness < DEATH_MENU_BRIGHTNESS_MIN:
            return False
        cy1 = round(DEATH_MENU_CENTER_Y[0] * self._scale_y) if self._native_crop is not None else DEATH_MENU_CENTER_Y[0]
        cy2 = round(DEATH_MENU_CENTER_Y[1] * self._scale_y) if self._native_crop is not None else DEATH_MENU_CENTER_Y[1]
        cx1 = round(DEATH_MENU_CENTER_X[0] * self._scale_x) if self._native_crop is not None else DEATH_MENU_CENTER_X[0]
        cx2 = round(DEATH_MENU_CENTER_X[1] * self._scale_x) if self._native_crop is not None else DEATH_MENU_CENTER_X[1]
        center = src[cy1:cy2, cx1:cx2, :]
        if center.size == 0:
            return False
        center_brightness = float(np.mean(center))
        if center_brightness < DEATH_MENU_CENTER_BRIGHT_MIN or center_brightness > DEATH_MENU_CENTER_BRIGHT_MAX:
            return False
        white_mask = np.mean(center, axis=2) > WHITE_PIXEL_THRESHOLD
        white_ratio = float(np.sum(white_mask)) / (center.shape[0] * center.shape[1])
        return WHITE_RATIO_MIN < white_ratio < WHITE_RATIO_MAX

    def _is_title(self, frame: np.ndarray) -> bool:
        """Check for title screen or file select.

        The title screen has no HUD. The top area is very dark.
        """
        src = self._af(frame)
        top_rows = round(TITLE_TOP_ROWS * self._scale_y) if self._native_crop is not None else TITLE_TOP_ROWS
        top = src[0:top_rows, :, :]
        return float(np.mean(top)) < TITLE_TOP_BRIGHTNESS_MAX

    def _has_shifted_hud(self, frame: np.ndarray) -> bool:
        """Check if the HUD is shifted down (item-get screen or subscreen scroll).

        When the subscreen opens or a dungeon item is obtained, the HUD scrolls
        down. We detect this by finding:
        1. The "-LIFE-" red text at the standard HUD x-position (sliding Y scan)
        2. The minimap grey rectangle near the expected position

        Both checks together prevent false positives from intro/story text
        screens which have red text but no minimap.
        """
        src = self._af(frame)
        x, _, tw, th = self._sc(22 * 8 + self.grid_dx, 0)
        if x + tw > src.shape[1]:
            return False

        y_start = round(SHIFTED_HUD_Y_START * self._scale_y) if self._native_crop is not None else SHIFTED_HUD_Y_START
        y_end   = round(SHIFTED_HUD_Y_END   * self._scale_y) if self._native_crop is not None else SHIFTED_HUD_Y_END
        y_end = min(y_end, src.shape[0] - th)
        step = max(1, round(self._scale_y)) if self._native_crop is not None else 1

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

        map_y_above = round(MINIMAP_Y_ABOVE_LIFE * self._scale_y) if self._native_crop is not None else MINIMAP_Y_ABOVE_LIFE
        map_y_below = round(MINIMAP_Y_BELOW_LIFE * self._scale_y) if self._native_crop is not None else MINIMAP_Y_BELOW_LIFE
        mx1 = round(MINIMAP_X_START * self._scale_x) if self._native_crop is not None else MINIMAP_X_START
        mx2 = round(MINIMAP_X_END   * self._scale_x) if self._native_crop is not None else MINIMAP_X_END
        map_y   = max(0, life_y - map_y_above)
        map_y2  = min(src.shape[0], life_y + map_y_below)
        if map_y2 - map_y < th or mx2 <= mx1:
            return False
        map_region = src[map_y:map_y2, mx1:mx2]
        avg_map = np.mean(map_region, axis=(0, 1))
        channel_spread = float(max(avg_map) - min(avg_map))
        brightness = float(np.mean(avg_map))
        return (channel_spread < MINIMAP_CHANNEL_SPREAD_MAX
                and MINIMAP_BRIGHTNESS_MIN < brightness < MINIMAP_BRIGHTNESS_MAX)
