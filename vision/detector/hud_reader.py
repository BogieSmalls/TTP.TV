"""Read HUD elements from the NES Zelda 1 frame.

The HUD occupies the top 64 pixels (rows 0-63) of the 256x240 frame.
Layout (approximate tile positions, each tile = 8x8 pixels):

  Minimap (left)  |  B-item  A-item  |  -LIFE-  Hearts
                   |  Rupee count     |  Hearts row 2
                   |  Key count       |
                   |  Bomb count      |

All pixel extraction is done via the NESFrame abstraction, which maps
NES pixel coordinates to native stream resolution and back.
"""

import cv2
import numpy as np
from typing import TYPE_CHECKING

from .nes_frame import NESFrame

if TYPE_CHECKING:
    from .digit_reader import DigitReader
    from .item_reader import ItemReader
    from .hud_calibrator import HudCalibrator


# NES Zelda heart colors (approximate BGR values)
HEART_RED_BGR = np.array([68, 36, 184], dtype=np.uint8)


class HudReader:
    """Read heart count, rupees, keys, bombs, and dungeon level from the HUD."""

    # Heart positions in the 256x240 frame
    HEART_ROW_1_Y = 32
    HEART_ROW_2_Y = 40
    HEART_START_X = 176
    HEART_SPACING = 8

    # Digit positions for rupees, keys, bombs (tile column, tile row)
    RUPEE_DIGIT_COLS = [12, 13, 14]
    RUPEE_DIGIT_ROW = 2
    KEY_DIGIT_COLS = [13, 14]
    KEY_DIGIT_ROW = 4
    BOMB_DIGIT_COLS = [13, 14]
    BOMB_DIGIT_ROW = 5

    # LEVEL-X digit position in dungeon HUD
    LEVEL_DIGIT_COL = 8
    LEVEL_DIGIT_ROW = 1

    # LEVEL text tiles (cols 2-7, row 1)
    LEVEL_TEXT_COLS = (2, 7)
    LEVEL_TEXT_ROW = 1

    def __init__(self, life_row: int = 5,
                 landmarks: list[dict] | None = None,
                 calibrator: 'HudCalibrator | None' = None):
        """Initialize HUD reader.

        Args:
            life_row: The actual tile row where -LIFE- text appears.
                      Standard is row 5. All other HUD positions are
                      adjusted relative to this anchor.
            landmarks: Optional list of landmark dicts from crop profile.
            calibrator: Optional HudCalibrator instance.
        """
        # Bake life_row shift into instance positions
        _shift = life_row - 5
        self.LIFE_TEXT_ROW = 5 + _shift
        self.LEVEL_TEXT_ROW = 1 + _shift
        self.LEVEL_DIGIT_ROW = 1 + _shift
        self.RUPEE_DIGIT_ROW = 2 + _shift
        self.KEY_DIGIT_ROW = 4 + _shift
        self.BOMB_DIGIT_ROW = 5 + _shift
        self.SWORD_ROW = 3 + _shift
        self.HEART_ROW_1_Y = 32 + _shift * 8
        self.HEART_ROW_2_Y = 40 + _shift * 8
        self.B_ITEM_Y = 16 + _shift * 8
        self.MINIMAP_Y1 = 12 + _shift * 8
        self.MINIMAP_Y2 = 52 + _shift * 8

        # LIFE landmark region for robust is_hud_present
        self._life_region = None  # (x, y, w, h) in NES pixel coords

        self._calibrator = calibrator

        if landmarks:
            self._apply_landmarks(landmarks)

    def _has_landmark(self, label: str) -> bool:
        return hasattr(self, '_landmarks') and label in self._landmarks

    def _get_landmark(self, label: str) -> dict:
        return self._landmarks[label]

    def _apply_landmarks(self, landmarks: list[dict]) -> None:
        """Override HUD positions using landmark pixel positions."""
        lm_map = {lm['label']: lm for lm in landmarks}
        self._landmarks = lm_map

        if '-LIFE-' in lm_map:
            lm = lm_map['-LIFE-']
            self._life_region = (lm['x'], lm['y'], lm.get('w', 40), lm.get('h', 8))

    def is_hud_present(self, nf: NESFrame) -> bool:
        """Check if the Zelda HUD is present by looking for "-LIFE-" red text."""
        if self._life_region is not None:
            lx, ly, lw, lh = self._life_region
            region = nf.extract(lx, ly, lw, lh)
            gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
            bright_px = np.sum(gray > 60)
            return int(bright_px) > 10

        tile = nf.tile(self.LIFE_TEXT_START_COL, self.LIFE_TEXT_ROW)
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        return r > 50 and r > g * 2 and r > b * 2

    def read_hearts(self, nf: NESFrame) -> tuple[int, int, bool]:
        """Read heart count from the HUD.

        Returns:
            (current_hearts, max_hearts, has_half_heart)
        """
        if self._has_landmark('Hearts'):
            lm = self._get_landmark('Hearts')
            region = nf.extract(lm['x'], lm['y'], lm['w'], lm['h'])
            norm = cv2.resize(region, (64, 16), interpolation=cv2.INTER_NEAREST)

            row_results = []
            for row_start in (0, 8):
                row_cur = 0
                row_max = 0
                row_half = False
                for i in range(8):
                    tile = norm[row_start:row_start + 8, i * 8:(i + 1) * 8]
                    sat_r = self._sat_ratio(tile)
                    if sat_r > 0.4:
                        row_cur += 1
                        row_max += 1
                    elif sat_r > 0.1:
                        row_half = True
                        row_max += 1
                    elif self._has_heart_outline(tile):
                        row_max += 1
                    else:
                        break
                row_results.append((row_cur, row_max, row_half))

            r1_cur, r1_max, r1_half = row_results[0]
            r2_cur, r2_max, r2_half = row_results[1]

            if r2_cur > r1_cur:
                if r1_max == r1_cur:
                    return r2_cur, r2_max, r2_half
                extra_empties = r1_max - r1_cur
                return r2_cur, r2_max + extra_empties, r2_half
            return r1_cur + r2_cur, r1_max + r2_max, r1_half or r2_half

        # Grid-based fallback
        current = 0
        max_hearts = 0
        has_half = False

        heart_row1_y = self.HEART_ROW_1_Y + nf.grid_dy
        heart_row2_y = self.HEART_ROW_2_Y + nf.grid_dy

        for row_y in [heart_row1_y, heart_row2_y]:
            for i in range(8):
                x = self.HEART_START_X + nf.grid_dx + i * self.HEART_SPACING
                if x + 8 > 256:
                    break

                tile = nf.extract(x, row_y, 8, 8)
                red_ratio = self._red_ratio(tile)

                if red_ratio > 0.4:
                    current += 1
                    max_hearts += 1
                elif red_ratio > 0.1:
                    has_half = True
                    max_hearts += 1
                elif self._has_heart_outline(tile):
                    max_hearts += 1
                else:
                    break

        return current, max_hearts, has_half

    def read_rupees(self, nf: NESFrame, digit_reader: 'DigitReader') -> int:
        """Read rupee count from HUD digits."""
        if self._has_landmark('Rupees'):
            lm = self._get_landmark('Rupees')
            value = self._read_counter_at_y(nf, digit_reader, lm['y'],
                                            self.RUPEE_DIGIT_COLS)
        else:
            value = self._read_counter_tiles(nf, digit_reader,
                                              self.RUPEE_DIGIT_COLS, self.RUPEE_DIGIT_ROW)
        if value > 255:
            value = value % 100
        return value

    _DIGIT_CONFIDENT_SCORE = 0.65

    def read_keys(self, nf: NESFrame, digit_reader: 'DigitReader') -> tuple[int, bool]:
        """Read key count and master key status from HUD digits.

        Returns:
            (key_count, has_master_key).
        """
        if self._has_landmark('Keys'):
            lm = self._get_landmark('Keys')
            first_x = self.KEY_DIGIT_COLS[0] * 8
            first_tile = nf.extract(first_x, lm['y'], 8, 8)
        else:
            first_tile = nf.tile(self.KEY_DIGIT_COLS[0], self.KEY_DIGIT_ROW)

        first_d, first_score = digit_reader.read_digit_with_score(first_tile)

        # dy+1 fallback for non-integer vertical scale
        dy_adj = 0
        if not self._has_landmark('Keys') \
                and (first_d is None or first_score < self._DIGIT_CONFIDENT_SCORE) \
                and float(np.mean(first_tile)) > 20:
            x = self.KEY_DIGIT_COLS[0] * 8 + nf.grid_dx
            y = self.KEY_DIGIT_ROW * 8 + nf.grid_dy + 1
            if y + 8 <= 240:
                adj_tile = nf.extract(x, y, 8, 8)
                adj_d, adj_score = digit_reader.read_digit_with_score(adj_tile)
                if adj_score > first_score:
                    first_tile, first_d, first_score = adj_tile, adj_d, adj_score
                    dy_adj = 1

        if (first_d is None or first_score < self._DIGIT_CONFIDENT_SCORE) \
                and float(np.mean(first_tile)) > 20:
            return 0, True

        if self._has_landmark('Keys'):
            lm = self._get_landmark('Keys')
            count = self._read_counter_at_y(nf, digit_reader, lm['y'],
                                            self.KEY_DIGIT_COLS)
        else:
            count = self._read_counter_tiles(nf, digit_reader,
                                              self.KEY_DIGIT_COLS, self.KEY_DIGIT_ROW,
                                              dy_adj)
        return count, False

    def read_bombs(self, nf: NESFrame, digit_reader: 'DigitReader') -> int:
        """Read bomb count from HUD digits."""
        if self._has_landmark('Bombs'):
            lm = self._get_landmark('Bombs')
            return self._read_counter_at_y(nf, digit_reader, lm['y'],
                                           self.BOMB_DIGIT_COLS)
        x = self.BOMB_DIGIT_COLS[0] * 8 + nf.grid_dx
        y = self.BOMB_DIGIT_ROW * 8 + nf.grid_dy
        primary_tile = nf.extract(x, y, 8, 8)
        _, primary_score = digit_reader.read_digit_with_score(primary_tile)
        dy_adj = 0
        if primary_score < self._DIGIT_CONFIDENT_SCORE \
                and float(np.mean(primary_tile)) > 20 \
                and y + 1 + 8 <= 240:
            dy_adj = 1
        return self._read_counter_tiles(nf, digit_reader,
                                         self.BOMB_DIGIT_COLS, self.BOMB_DIGIT_ROW,
                                         dy_adj, min_score=0.35)

    def read_dungeon_level(self, nf: NESFrame, digit_reader: 'DigitReader') -> int:
        """Read dungeon level (1-9) from the LEVEL-X text in the HUD.

        Returns 0 if no LEVEL text is detected (not in a dungeon).
        """
        if self._has_landmark('LVL'):
            lm = self._get_landmark('LVL')
            region = nf.extract(lm['x'], lm['y'], lm['w'], lm['h'])
            rw = region.shape[1]
            left_w = max(1, rw * 2 // 3)
            left_region = region[:, :left_w]
            if np.mean(left_region) < 50:
                return 0
            hsv = cv2.cvtColor(left_region, cv2.COLOR_BGR2HSV)
            white_mask = (hsv[:, :, 2] > 180) & (hsv[:, :, 1] < 40)
            total_px = left_region.shape[0] * left_region.shape[1]
            if np.sum(white_mask) < total_px * 0.15:
                return 0
            right_start = max(0, rw * 2 // 3 - 4)
            digit_strip = region[:, right_start:]
            gray = cv2.cvtColor(digit_strip, cv2.COLOR_BGR2GRAY)
            if gray.shape[0] != 8:
                gray = cv2.resize(gray, (gray.shape[1], 8),
                                  interpolation=cv2.INTER_NEAREST)
            if gray.shape[1] < 8:
                return 0
            best_score = 0.3
            best_digit = 0
            for d in range(1, 10):
                tmpl = digit_reader.template_grays.get(d)
                if tmpl is None:
                    continue
                result = cv2.matchTemplate(gray, tmpl, cv2.TM_CCOEFF_NORMED)
                score = float(np.max(result))
                if score > best_score:
                    best_score = score
                    best_digit = d
            return best_digit

        # Grid-based fallback
        text_start_col = self.LEVEL_TEXT_COLS[0]
        text_end_col = self.LEVEL_TEXT_COLS[1]
        rx = text_start_col * 8 + nf.grid_dx
        ry = self.LEVEL_TEXT_ROW * 8 + nf.grid_dy
        rw = (text_end_col + 1 - text_start_col) * 8
        text_region = nf.extract(rx, ry, rw, 8)
        if np.mean(text_region) < 50:
            return 0
        hsv = cv2.cvtColor(text_region, cv2.COLOR_BGR2HSV)
        white_mask = (hsv[:, :, 2] > 180) & (hsv[:, :, 1] < 40)
        total_px = text_region.shape[0] * text_region.shape[1]
        if np.sum(white_mask) < total_px * 0.15:
            return 0

        digit_tile = nf.tile(self.LEVEL_DIGIT_COL, self.LEVEL_DIGIT_ROW)
        result, score = digit_reader.read_digit_with_score(digit_tile)
        if result is not None and 1 <= result <= 9 and score >= 0.3:
            return result
        return 0

    # ─── Sword from HUD ───

    SWORD_COL = 19
    SWORD_ROW = 3

    def read_sword(self, nf: NESFrame) -> int:
        """Read sword level from the HUD sword indicator during gameplay.

        Returns:
            0 = no sword, 1 = wood, 2 = white, 3 = magical
        """
        if self._has_landmark('A'):
            lm = self._get_landmark('A')
            region = nf.extract(lm['x'], lm['y'], lm['w'], lm['h'])
            rh, rw = region.shape[:2]
            sub = region[rh // 2:, rw // 2:]
            if sub.size == 0 or float(np.mean(sub)) < 15:
                return 0
            avg = np.mean(sub, axis=(0, 1))
            brightness = float(np.mean(avg))
            if avg[0] > avg[2] + 20:
                return 3
            if brightness > 160:
                return 2
            return 1

        tile = nf.tile(self.SWORD_COL, self.SWORD_ROW)
        if float(np.mean(tile)) < 15:
            return 0
        avg = np.mean(tile, axis=(0, 1))
        brightness = float(np.mean(avg))
        if avg[0] > avg[2] + 20:
            return 3
        if brightness > 160:
            return 2
        return 1

    # ─── B-Item from HUD ───

    B_ITEM_Y = 16
    B_ITEM_X = 128

    def read_b_item(self, nf: NESFrame,
                    item_reader: 'ItemReader | None' = None) -> str | None:
        """Read the B-item sprite from the HUD during gameplay."""
        if self._has_landmark('B'):
            lm = self._get_landmark('B')
            tile_row = round((lm['y'] - nf.grid_dy) / 8)
            nes_y = tile_row * 8 + nf.grid_dy
            region = nf.extract(lm['x'], nes_y, lm['w'], lm['h'])
        else:
            y = self.B_ITEM_Y + nf.grid_dy
            x = self.B_ITEM_X + nf.grid_dx
            region = nf.extract(x, y, 10, 24)
        if float(np.mean(region)) < 10:
            return None

        _B_ITEMS = {
            'boomerang', 'magical_boomerang', 'bomb', 'bow',
            'blue_candle', 'red_candle', 'recorder', 'wand',
            'bait', 'letter', 'potion_blue', 'potion_red',
        }
        if item_reader is not None and item_reader.has_templates():
            result = item_reader.read_item(region)
            if result is not None and result in _B_ITEMS:
                return result

        # Color heuristic fallback
        ch, cw = region.shape[:2]
        cx, cy = max(0, (cw - 8) // 2), max(0, (ch - 16) // 2)
        tile = region[cy:cy + 16, cx:cx + 8]
        if tile.size == 0 or float(np.mean(tile)) < 15:
            return None
        avg = np.mean(tile, axis=(0, 1))
        b, g, r = float(avg[0]), float(avg[1]), float(avg[2])
        brightness = float(np.mean(avg))
        if r > b + 30 and r > g + 30:
            return 'candle'
        if b > r + 30 and b > g + 30:
            return 'boomerang'
        if g > r + 20 and g > b + 20:
            return 'recorder'
        if brightness > 150 and abs(r - g) < 20 and abs(r - b) < 20:
            return 'bow'
        if brightness > 60:
            return 'unknown'
        return None

    # ─── LIFE/ROAR Detection ───

    LIFE_TEXT_ROW = 5
    LIFE_TEXT_START_COL = 22
    LIFE_CHAR2_COL = 23

    def read_life_roar(self, nf: NESFrame) -> bool:
        """Detect whether HUD shows -ROAR- instead of -LIFE-.

        Returns True if ROAR detected (Gannon nearby), False otherwise.
        """
        if self._life_region is not None:
            lx, ly, lw, lh = self._life_region
            region = nf.extract(lx, ly, lw, lh)
            r_ch = region[:, :, 2].astype(float)
            g_ch = region[:, :, 1].astype(float)
            b_ch = region[:, :, 0].astype(float)
            if int(np.sum((r_ch > 80) & (r_ch > g_ch * 2) & (r_ch > b_ch * 2))) < 10:
                return False
        else:
            text_tile = nf.tile(self.LIFE_TEXT_START_COL, self.LIFE_TEXT_ROW)
            avg = np.mean(text_tile, axis=(0, 1))
            r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
            if r < 50 or r < g * 2 or r < b * 2:
                return False

        if self._life_region is not None:
            lx, ly, lw, lh = self._life_region
            region = nf.extract(lx, ly, lw, lh)
            num_chars = max(1, round(lw / 8))
            rw = region.shape[1]
            c_start = int(round(rw / num_chars))
            c_end = int(round(rw / num_chars * 2))
            if c_start >= c_end or c_start >= rw:
                return False
            char_slice = region[:, c_start:c_end]
            tile = cv2.resize(char_slice, (8, 8), interpolation=cv2.INTER_NEAREST)
        else:
            tile = nf.tile(self.LIFE_CHAR2_COL, self.LIFE_TEXT_ROW)

        if float(np.mean(tile)) < 15:
            return False
        bright = tile.mean(axis=2) > 40
        col_sums = bright.sum(axis=0).astype(float)
        total = max(float(col_sums.sum()), 1.0)
        center = float(col_sums[2:6].sum())
        return (center / total) < 0.55

    # ─── Minimap Position ───

    MINIMAP_Y1 = 12
    MINIMAP_Y2 = 52
    MINIMAP_OW_X1 = 16
    MINIMAP_OW_X2 = 80
    MINIMAP_DG_X1 = 16
    MINIMAP_DG_X2 = 80
    MINIMAP_ROWS = 8

    def read_minimap_position(self, nf: NESFrame, is_dungeon: bool = False) -> int:
        """Read player position from the minimap dot.

        Overworld: returns 0-127 (16 cols x 8 rows).
        Dungeon: returns 0-63 (8 cols x 8 rows).
        """
        grid_cols = 8 if is_dungeon else 16
        x1 = (self.MINIMAP_DG_X1 if is_dungeon else self.MINIMAP_OW_X1) + nf.grid_dx
        x2 = (self.MINIMAP_DG_X2 if is_dungeon else self.MINIMAP_OW_X2) + nf.grid_dx
        y1 = self.MINIMAP_Y1 + nf.grid_dy
        y2 = self.MINIMAP_Y2 + nf.grid_dy

        minimap = nf.extract(x1, y1, x2 - x1, y2 - y1)
        if minimap.size == 0:
            return 0

        gray = np.mean(minimap, axis=2)
        max_bright = float(np.max(gray))
        if max_bright < 60:
            return 0
        threshold = max(max_bright * 0.7, 50)

        bright_mask = (gray > threshold).astype(np.uint8)
        bright_coords = np.argwhere(bright_mask)
        if len(bright_coords) == 0:
            return 0

        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(bright_mask)
        if num_labels <= 1:
            return 0
        best_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        cluster = np.argwhere(labels == best_label)

        center_y = float(np.mean(cluster[:, 0]))
        center_x = float(np.mean(cluster[:, 1]))

        map_h = y2 - y1
        map_w = x2 - x1
        col = int(center_x / map_w * grid_cols)
        row = int(center_y / map_h * self.MINIMAP_ROWS)
        col = max(0, min(col, grid_cols - 1))
        row = max(0, min(row, self.MINIMAP_ROWS - 1))

        return row * grid_cols + col

    # ─── Internal helpers ───

    def _read_counter_at_y(self, nf: NESFrame, digit_reader: 'DigitReader',
                           lm_y: int, cols: list[int],
                           min_score: float = 0.5) -> int:
        """Read a multi-digit counter at landmark y position."""
        digits = []
        for col in cols:
            x = col * 8  # absolute NES column — no grid_dx
            tile = nf.extract(x, lm_y, 8, 8)
            if np.mean(np.max(tile, axis=2)) < 10:
                continue
            d, score = digit_reader.read_digit_with_score(tile)
            if d is not None and score >= min_score:
                digits.append(d)
        if not digits:
            return 0
        return int(''.join(str(d) for d in digits))

    def _read_counter_tiles(self, nf: NESFrame, digit_reader: 'DigitReader',
                            cols: list[int], row: int, dy_adj: int = 0,
                            min_score: float = 0.5) -> int:
        """Read a multi-digit counter from tile positions (grid-based fallback)."""
        digits = []
        for col in cols:
            if dy_adj:
                x = col * 8 + nf.grid_dx
                y = row * 8 + nf.grid_dy + dy_adj
                tile = nf.extract(x, y, 8, 8)
            else:
                tile = nf.tile(col, row)
            gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
            if np.mean(gray) < 10:
                continue
            d, score = digit_reader.read_digit_with_score(tile)
            if d is not None and score >= min_score:
                digits.append(d)

        if not digits:
            return 0
        return int(''.join(str(d) for d in digits))

    def _sat_ratio(self, tile: np.ndarray) -> float:
        """Fraction of warm-red pixels (R > 100, R > G*1.3, R > B*1.3)."""
        if tile.size == 0:
            return 0.0
        r = tile[:, :, 2].astype(float)
        g = tile[:, :, 1].astype(float)
        b = tile[:, :, 0].astype(float)
        warm_mask = (r > 100) & (r > g * 1.3) & (r > b * 1.3)
        return float(np.sum(warm_mask)) / float(warm_mask.size)

    def _red_ratio(self, tile: np.ndarray) -> float:
        """Calculate the ratio of red-ish pixels in a tile."""
        if tile.size == 0:
            return 0.0
        r = tile[:, :, 2].astype(float)
        g = tile[:, :, 1].astype(float)
        b = tile[:, :, 0].astype(float)
        red_mask = (r > 100) & (r > g * 1.5) & (r > b * 1.5)
        return float(np.sum(red_mask)) / float(red_mask.size)

    def _has_heart_outline(self, tile: np.ndarray) -> bool:
        """Check if a tile has a heart container outline (no fill)."""
        brightness = np.mean(tile)
        red_ratio = self._red_ratio(tile)
        return brightness > 40 and red_ratio < 0.1
