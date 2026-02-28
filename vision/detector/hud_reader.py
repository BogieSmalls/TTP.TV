"""Read HUD elements from the NES Zelda 1 frame.

The HUD occupies the top 64 pixels (rows 0-63) of the 256x240 frame.
Layout (approximate tile positions, each tile = 8x8 pixels):

  Minimap (left)  |  B-item  A-item  |  -LIFE-  Hearts
                   |  Rupee count     |  Hearts row 2
                   |  Key count       |
                   |  Bomb count      |

Note: The NES pixel grid may not align exactly with the canonical 256x240
frame due to crop/resize. A grid offset (dx, dy) compensates for this.
Typical offset: dx=1, dy=2 (detected per-stream from the auto-crop).
"""

import cv2
import numpy as np
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .digit_reader import DigitReader
    from .item_reader import ItemReader
    from .hud_calibrator import HudCalibrator


# NES Zelda heart colors (approximate BGR values)
# These may vary slightly between emulators and real hardware
HEART_RED_BGR = np.array([68, 36, 184], dtype=np.uint8)  # bright red in NES palette


class HudReader:
    """Read heart count, rupees, keys, bombs, and dungeon level from the HUD."""

    # Heart positions in the 256x240 frame
    # Hearts are displayed in rows at fixed positions
    # Row 1: y ~= 32, x starts at ~176, 8px apart
    # Row 2: y ~= 40, same x positions
    HEART_ROW_1_Y = 32
    HEART_ROW_2_Y = 40
    HEART_START_X = 176
    HEART_SPACING = 8

    # Digit positions for rupees, keys, bombs (tile column, tile row)
    # The "X" symbol is at col 12, digits start at col 13
    RUPEE_DIGIT_COLS = [12, 13, 14]  # hundreds, tens, ones
    RUPEE_DIGIT_ROW = 2
    KEY_DIGIT_COLS = [13, 14]  # up to 2 digits (keys can exceed 9 in Z1R)
    KEY_DIGIT_ROW = 4
    BOMB_DIGIT_COLS = [13, 14]  # up to 2 digits (bombs are 3 rows below rupees)
    BOMB_DIGIT_ROW = 5

    # LEVEL-X digit position in dungeon HUD
    LEVEL_DIGIT_COL = 8
    LEVEL_DIGIT_ROW = 1

    # LEVEL text tiles (cols 2-7, row 1) - used to verify dungeon HUD
    LEVEL_TEXT_COLS = (2, 7)  # start, end (inclusive)
    LEVEL_TEXT_ROW = 1

    def __init__(self, grid_offset: tuple[int, int] = (1, 2), life_row: int = 5,
                 landmarks: list[dict] | None = None,
                 calibrator: 'HudCalibrator | None' = None):
        """Initialize HUD reader.

        Args:
            grid_offset: (dx, dy) pixel offset to align NES tile grid.
            life_row: The actual tile row where -LIFE- text appears in the
                      canonical frame. Standard is row 5, but crop/overscan
                      differences can shift it to row 3-6. All other HUD
                      positions are adjusted relative to this anchor.
            landmarks: Optional list of landmark dicts from crop profile.
                       When provided, overrides all position constants
                       with actual pixel positions from the canonical frame.
                       This is more accurate than life_row shift when the
                       crop has a non-standard aspect ratio.
            calibrator: Optional HudCalibrator instance. When locked, heart row
                        positions are derived from the detected LIFE-text y
                        coordinate rather than static landmark or grid positions.
        """
        self.grid_dx, self.grid_dy = grid_offset
        # Bake life_row shift into instance positions — no runtime adjustment needed
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

        # Stream-resolution tile extraction (set per-frame via set_stream_source)
        self._stream_frame = None
        self._crop_x = 0
        self._crop_y = 0
        self._scale_x = 1.0
        self._scale_y = 1.0

        # LIFE landmark region for robust is_hud_present (set by _apply_landmarks)
        self._life_region = None  # (x, y, w, h) in NES pixel coords, or None

        self._calibrator = calibrator

        # When landmarks are available, override positions directly
        if landmarks:
            self._apply_landmarks(landmarks)

    def _has_landmark(self, label: str) -> bool:
        return hasattr(self, '_landmarks') and label in self._landmarks

    def _get_landmark(self, label: str) -> dict:
        return self._landmarks[label]

    def _apply_landmarks(self, landmarks: list[dict]) -> None:
        """Override HUD positions using landmark pixel positions.

        Landmarks are approximate guides ("look here"). All readers store
        raw landmark dicts and extract full landmark regions for region-based
        matching — no tile grid needed. Grid-based fallback positions are NOT
        derived from landmark pixels at runtime.
        """
        lm_map = {lm['label']: lm for lm in landmarks}
        self._landmarks = lm_map

        if '-LIFE-' in lm_map:
            lm = lm_map['-LIFE-']
            self._life_region = (lm['x'], lm['y'], lm.get('w', 40), lm.get('h', 8))

    def set_stream_source(self, stream_frame: np.ndarray,
                          crop_x: int, crop_y: int,
                          crop_w: int, crop_h: int) -> None:
        """Provide the raw stream frame for tile extraction at native resolution.

        When set, _extract() maps NES pixel positions to stream coordinates
        and extracts tiles at stream resolution, resizing each to the exact
        NES tile size. This bypasses distortion from non-integer resize ratios
        that affect the 256x240 canonical frame.
        """
        self._stream_frame = stream_frame
        self._crop_x = crop_x
        self._crop_y = crop_y
        self._scale_x = crop_w / 256.0
        self._scale_y = crop_h / 240.0

    def clear_stream_source(self) -> None:
        """Clear the stream frame reference."""
        self._stream_frame = None

    def _extract(self, frame: np.ndarray, nes_x: int, nes_y: int,
                 w: int = 8, h: int = 8) -> np.ndarray:
        """Extract a region from the best available source.

        When a stream source is set, maps NES pixel coords to stream coords,
        extracts at stream resolution, and resizes to (w, h). Otherwise
        slices the canonical frame directly.
        """
        if self._stream_frame is not None:
            sf = self._stream_frame
            fh, fw = sf.shape[:2]
            # Map NES coords to stream coords
            sx = self._crop_x + nes_x * self._scale_x
            sy = self._crop_y + nes_y * self._scale_y
            sw = w * self._scale_x
            sh = h * self._scale_y
            # Integer bounds
            sx1 = int(round(sx))
            sy1 = int(round(sy))
            sx2 = int(round(sx + sw))
            sy2 = int(round(sy + sh))
            # Clamp to frame
            sx1_c, sx2_c = max(0, sx1), min(fw, sx2)
            sy1_c, sy2_c = max(0, sy1), min(fh, sy2)
            if sy2_c <= sy1_c or sx2_c <= sx1_c:
                return np.zeros((h, w, 3), dtype=np.uint8)
            region = sf[sy1_c:sy2_c, sx1_c:sx2_c]
            # Pad if region was clamped (e.g. negative crop_y)
            if sx1 < 0 or sy1 < 0 or sx2 > fw or sy2 > fh:
                full_h = max(sy2 - sy1, 1)
                full_w = max(sx2 - sx1, 1)
                full = np.zeros((full_h, full_w, 3), dtype=np.uint8)
                dy_off = sy1_c - sy1
                dx_off = sx1_c - sx1
                full[dy_off:dy_off + region.shape[0],
                     dx_off:dx_off + region.shape[1]] = region
                region = full
            return cv2.resize(region, (w, h), interpolation=cv2.INTER_NEAREST)
        # Fallback: canonical frame
        return frame[max(0, nes_y):max(0, nes_y) + h,
                     max(0, nes_x):max(0, nes_x) + w]

    def _tile(self, frame: np.ndarray, col: int, row: int) -> np.ndarray:
        """Extract an 8x8 tile at the given grid position with offset correction."""
        x = col * 8 + self.grid_dx
        y = row * 8 + self.grid_dy
        return self._extract(frame, x, y, 8, 8)

    def is_hud_present(self, frame: np.ndarray) -> bool:
        """Check if the Zelda HUD is present by looking for "-LIFE-" red text.

        This guards against misclassified screens (ROM menus, title cards)
        that get through the screen classifier and would produce garbage
        HUD readings.
        """
        if self._life_region is not None:
            # When landmarks provide the LIFE region, check for any bright text.
            # Custom sprite sets may use non-red colors (pink, white, blue, etc.)
            # so we check brightness rather than hue. The landmark position was
            # calibrated by the user, so presence of bright pixels = HUD present.
            lx, ly, lw, lh = self._life_region
            region = self._extract(frame, lx, ly, lw, lh)
            gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
            bright_px = np.sum(gray > 60)
            # LIFE text spans ~5 chars across ~40px; threshold at 10 bright pixels
            return int(bright_px) > 10

        tile = self._tile(frame, self.LIFE_TEXT_START_COL, self.LIFE_TEXT_ROW)
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        return r > 50 and r > g * 2 and r > b * 2

    def read_hearts(self, frame: np.ndarray) -> tuple[int, int, bool]:
        """Read heart count from the HUD.

        Returns:
            (current_hearts, max_hearts, has_half_heart)
        """
        # Landmark path: extract full region, normalize, scan slices
        if self._has_landmark('Hearts'):
            lm = self._get_landmark('Hearts')
            region = self._extract(frame, lm['x'], lm['y'],
                                   lm['w'], lm['h'])
            # Normalize to standard heart grid: 64px wide (8×8), 16px tall (2 rows)
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

            # Deduplication: when r2_cur > r1_cur, row0 hearts are duplicates
            # of row8 (extreme vertical distortion, e.g. blessedbe_). Use row8
            # as the authoritative source. Two sub-cases:
            #   r1_max == r1_cur: row0 is all-full-or-empty (no partial slots)
            #     → row0 content fully duplicates row8; use r2 counts alone.
            #   r1_max > r1_cur: row0 has empty-container slots that represent
            #     NES row2 containers absent from row8 (e.g. bbqdotgov 10-heart
            #     frame where tops of 2 hearts "stand in" for NES row2 empties).
            #     → Use r2 current, but add the extra empties to max.
            if r2_cur > r1_cur:
                if r1_max == r1_cur:
                    return r2_cur, r2_max, r2_half
                extra_empties = r1_max - r1_cur
                return r2_cur, r2_max + extra_empties, r2_half
            return r1_cur + r2_cur, r1_max + r2_max, r1_half or r2_half

        # Grid-based fallback (no landmarks available)
        current = 0
        max_hearts = 0
        has_half = False

        # Grid-based positions — calibrator override is only applied in the
        # landmark path above.  The calibrator's _detect_life_text can
        # misidentify life_y on canonical 256x240 golden frames (picks up
        # rupee/heart red pixels), so we rely on the tile grid here.
        heart_row1_y = self.HEART_ROW_1_Y + self.grid_dy
        heart_row2_y = self.HEART_ROW_2_Y + self.grid_dy

        for row_y in [heart_row1_y, heart_row2_y]:
            for i in range(8):  # max 8 hearts per row
                x = self.HEART_START_X + self.grid_dx + i * self.HEART_SPACING  # no row shift for x
                if x + 8 > 256:
                    break

                tile = self._extract(frame, x, row_y, 8, 8)
                red_ratio = self._red_ratio(tile)

                if red_ratio > 0.4:
                    # Mostly red = full heart (NES full heart ≈ 0.44-0.50)
                    current += 1
                    max_hearts += 1
                elif red_ratio > 0.1:
                    # Partial red = half heart
                    has_half = True
                    max_hearts += 1
                elif self._has_heart_outline(tile):
                    # Has outline but no red = empty container
                    max_hearts += 1
                # else: no heart at this position, stop counting this row
                else:
                    break

        return current, max_hearts, has_half

    def read_rupees(self, frame: np.ndarray, digit_reader: 'DigitReader') -> int:
        """Read rupee count from HUD digits."""
        if self._has_landmark('Rupees'):
            lm = self._get_landmark('Rupees')
            value = self._read_counter_at_y(frame, digit_reader, lm['y'],
                                            self.RUPEE_DIGIT_COLS)
        else:
            value = self._read_counter_tiles(frame, digit_reader,
                                              self.RUPEE_DIGIT_COLS, self.RUPEE_DIGIT_ROW)
        # Z1R caps rupees at 255. Values above indicate the hundreds tile
        # captured part of the adjacent rupee icon ("X"), producing a false
        # leading digit. Drop it.
        if value > 255:
            value = value % 100
        return value

    # Minimum template-match score considered a confident digit read.
    # Real digits on calibrated streams score ~0.7-0.9. The hex "A" glyph
    # (Z1R Master Key display) matches "0" at ~0.58 — below this threshold.
    _DIGIT_CONFIDENT_SCORE = 0.65

    def read_keys(self, frame: np.ndarray, digit_reader: 'DigitReader') -> tuple[int, bool]:
        """Read key count and master key status from HUD digits.

        Returns:
            (key_count, has_master_key). When the tile shows "A" instead of
            a digit, has_master_key is True and key_count is 0.
        """
        if self._has_landmark('Keys'):
            lm = self._get_landmark('Keys')
            first_x = self.KEY_DIGIT_COLS[0] * 8  # absolute NES column — no grid_dx
            first_tile = self._extract(frame, first_x, lm['y'], 8, 8)
        else:
            first_tile = self._tile(frame, self.KEY_DIGIT_COLS[0], self.KEY_DIGIT_ROW)

        first_d, first_score = digit_reader.read_digit_with_score(first_tile)

        # dy+1 fallback: on streams with a non-integer vertical scale (e.g.
        # 4.5× for 1080p), some HUD rows sit 1px below the global grid offset.
        # Before declaring Master Key, check if shifting +1 gives a confident
        # read — if so, use that offset for the full counter read too.
        dy_adj = 0
        if not self._has_landmark('Keys') \
                and (first_d is None or first_score < self._DIGIT_CONFIDENT_SCORE) \
                and float(np.mean(first_tile)) > 20:
            x = self.KEY_DIGIT_COLS[0] * 8 + self.grid_dx
            y = self.KEY_DIGIT_ROW * 8 + self.grid_dy + 1
            if y + 8 <= 240:
                adj_tile = self._extract(frame, x, y, 8, 8)
                adj_d, adj_score = digit_reader.read_digit_with_score(adj_tile)
                if adj_score > first_score:
                    first_tile, first_d, first_score = adj_tile, adj_d, adj_score
                    dy_adj = 1

        # Master Key "A": bright tile with no confident digit match.
        # Case 1: "A" is so different it matches nothing above 0.15 → first_d is None.
        # Case 2: "A" coincidentally matches "0" at ~0.58 (below _DIGIT_CONFIDENT_SCORE).
        if (first_d is None or first_score < self._DIGIT_CONFIDENT_SCORE) \
                and float(np.mean(first_tile)) > 20:
            return 0, True

        if self._has_landmark('Keys'):
            lm = self._get_landmark('Keys')
            count = self._read_counter_at_y(frame, digit_reader, lm['y'],
                                            self.KEY_DIGIT_COLS)
        else:
            count = self._read_counter_tiles(frame, digit_reader,
                                              self.KEY_DIGIT_COLS, self.KEY_DIGIT_ROW,
                                              dy_adj)
        return count, False

    def read_bombs(self, frame: np.ndarray, digit_reader: 'DigitReader') -> int:
        """Read bomb count from HUD digits."""
        if self._has_landmark('Bombs'):
            lm = self._get_landmark('Bombs')
            return self._read_counter_at_y(frame, digit_reader, lm['y'],
                                           self.BOMB_DIGIT_COLS)
        # dy+1 fallback: the bomb row can sit 1px below the global grid offset
        # on streams with non-integer vertical scale (e.g. 4.5× for 1080p).
        # Check confidence of primary read; if low, retry with dy+1.
        x = self.BOMB_DIGIT_COLS[0] * 8 + self.grid_dx
        y = self.BOMB_DIGIT_ROW * 8 + self.grid_dy
        primary_tile = self._extract(frame, x, y, 8, 8)
        _, primary_score = digit_reader.read_digit_with_score(primary_tile)
        dy_adj = 0
        if primary_score < self._DIGIT_CONFIDENT_SCORE \
                and float(np.mean(primary_tile)) > 20 \
                and y + 1 + 8 <= 240:
            dy_adj = 1
        return self._read_counter_tiles(frame, digit_reader,
                                         self.BOMB_DIGIT_COLS, self.BOMB_DIGIT_ROW,
                                         dy_adj, min_score=0.35)

    def read_dungeon_level(self, frame: np.ndarray, digit_reader: 'DigitReader') -> int:
        """Read dungeon level (1-9) from the LEVEL-X text in the HUD.

        Returns 0 if no LEVEL text is detected (not in a dungeon).
        """
        # Landmark path: extract full LVL region, check text, slide digit templates
        if self._has_landmark('LVL'):
            lm = self._get_landmark('LVL')
            region = self._extract(frame, lm['x'], lm['y'],
                                   lm['w'], lm['h'])
            rw = region.shape[1]
            # Verify LEVEL text: check brightness of left 2/3
            left_w = max(1, rw * 2 // 3)
            left_region = region[:, :left_w]
            if np.mean(left_region) < 50:
                return 0
            # White text check: LEVEL text is bright white (V > 180).
            # Overworld minimap has gray squares (V ≈ 100-150, S ≈ 0)
            # that pass brightness and saturation checks. Requiring truly
            # white pixels (V > 180, S < 40) distinguishes real text from
            # medium-gray minimap fill.
            hsv = cv2.cvtColor(left_region, cv2.COLOR_BGR2HSV)
            white_mask = (hsv[:, :, 2] > 180) & (hsv[:, :, 1] < 40)
            total_px = left_region.shape[0] * left_region.shape[1]
            if np.sum(white_mask) < total_px * 0.15:
                return 0
            # Digit is in the right portion of the LEVEL-X text.
            # Extract the right third (with overlap) and slide digit templates.
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
        # Verify LEVEL text is present by checking brightness in the text area.
        # Threshold 50 filters out the overworld minimap (same pixel region,
        # but dimmer than the bright white LEVEL text in dungeons).
        text_start_col = self.LEVEL_TEXT_COLS[0]
        text_end_col = self.LEVEL_TEXT_COLS[1]
        rx = text_start_col * 8 + self.grid_dx
        ry = self.LEVEL_TEXT_ROW * 8 + self.grid_dy
        rw = (text_end_col + 1 - text_start_col) * 8
        text_region = self._extract(frame, rx, ry, rw, 8)
        if np.mean(text_region) < 50:
            return 0
        # White text check: LEVEL text is bright white (V > 180).
        # Overworld minimap has gray squares (V ≈ 100-150, S ≈ 0)
        # that pass brightness and saturation checks. Requiring truly
        # white pixels (V > 180, S < 40) distinguishes real text from
        # medium-gray minimap fill.
        hsv = cv2.cvtColor(text_region, cv2.COLOR_BGR2HSV)
        white_mask = (hsv[:, :, 2] > 180) & (hsv[:, :, 1] < 40)
        total_px = text_region.shape[0] * text_region.shape[1]
        if np.sum(white_mask) < total_px * 0.15:
            return 0

        # Extract and read the level digit; require minimum match score
        # to avoid false reads from noise. The brightness threshold above
        # is the primary guard (overworld minimap is <5 brightness);
        # this score check is secondary defense.
        digit_tile = self._tile(frame, self.LEVEL_DIGIT_COL, self.LEVEL_DIGIT_ROW)
        result, score = digit_reader.read_digit_with_score(digit_tile)
        if result is not None and 1 <= result <= 9 and score >= 0.3:
            return result
        return 0

    # ─── Sword from HUD ───

    SWORD_COL = 19   # tile column (x≈152 → col 19)
    SWORD_ROW = 3    # tile row (y≈24 → row 3)

    def read_sword(self, frame: np.ndarray) -> int:
        """Read sword level from the HUD sword indicator during gameplay.

        Returns:
            0 = no sword, 1 = wood, 2 = white, 3 = magical
        """
        # Landmark path: use A-item region, lower-right quadrant to avoid
        # the "A" label text and the blue HUD border on the left edge.
        if self._has_landmark('A'):
            lm = self._get_landmark('A')
            region = self._extract(frame, lm['x'], lm['y'], lm['w'], lm['h'])
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

        # Grid-based fallback
        tile = self._tile(frame, self.SWORD_COL, self.SWORD_ROW)
        if float(np.mean(tile)) < 15:
            return 0
        avg = np.mean(tile, axis=(0, 1))
        brightness = float(np.mean(avg))
        # Magical sword: blue/teal dominant (Blue > Red in BGR)
        if avg[0] > avg[2] + 20:
            return 3
        # White sword: very bright
        if brightness > 160:
            return 2
        # Wood sword (brown/tan)
        return 1

    # ─── B-Item from HUD ───

    B_ITEM_Y = 16    # pixel row of B-item sprite
    B_ITEM_X = 128   # pixel col of B-item sprite

    def read_b_item(self, frame: np.ndarray,
                    item_reader: 'ItemReader | None' = None) -> str | None:
        """Read the B-item sprite from the HUD during gameplay.

        Uses sliding binary shape template matching when an ItemReader is
        provided. The extraction region is slightly larger than the sprite
        so the template can slide to find the best alignment.

        Falls back to color heuristics when no ItemReader is available.

        Args:
            frame: Canonical 256x240 BGR frame.
            item_reader: Optional ItemReader for template-based matching.

        Returns:
            Item name string or None if empty.
        """
        # Landmark path: use full B landmark region (larger than fixed 16×24)
        if self._has_landmark('B'):
            lm = self._get_landmark('B')
            # Grid-snap y to align sprite with NES tile boundary
            tile_row = round((lm['y'] - self.grid_dy) / 8)
            nes_y = tile_row * 8 + self.grid_dy
            region = self._extract(frame, lm['x'], nes_y,
                                   lm['w'], lm['h'])
        else:
            # Grid-based fallback
            y = self.B_ITEM_Y + self.grid_dy
            x = self.B_ITEM_X + self.grid_dx
            # Extract a region larger than the sprite for sliding template match.
            # The actual sprite is 8x16. We extract 10x24: 2px of horizontal
            # slide room while keeping the right blue HUD border out of frame
            # (border starts ~12px from B_ITEM_X and pollutes color analysis).
            region = self._extract(frame, x, y, 10, 24)
        if float(np.mean(region)) < 10:
            return None

        # Template matching (preferred — distinguishes same-color items)
        # Only accept items that can actually appear in the B-button slot.
        _B_ITEMS = {
            'boomerang', 'magical_boomerang', 'bomb', 'bow',
            'blue_candle', 'red_candle', 'recorder', 'wand',
            'bait', 'letter', 'potion_blue', 'potion_red',
        }
        if item_reader is not None and item_reader.has_templates():
            result = item_reader.read_item(region)
            if result is not None and result in _B_ITEMS:
                return result

        # Color heuristic fallback (use center 8x16 for color analysis)
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

    # "-LIFE-" / "-ROAR-" text in the HUD at row 5, cols 22-25
    # "-" at col 20, "L" at col 22, "I" at col 23, "F" at col 24, "E" at col 25, "-" at col 26
    # The 2nd character (col 23) distinguishes: "I" (narrow) vs "O" (wide)
    LIFE_TEXT_ROW = 5
    LIFE_TEXT_START_COL = 22  # "L" or "R"
    LIFE_CHAR2_COL = 23      # "I" in LIFE, "O" in ROAR

    def read_life_roar(self, frame: np.ndarray) -> bool:
        """Detect whether HUD shows -ROAR- instead of -LIFE-.

        Returns True if ROAR detected (Gannon nearby), False otherwise.
        """
        # Verify red text is present in the LIFE/ROAR area
        if self._life_region is not None:
            lx, ly, lw, lh = self._life_region
            region = self._extract(frame, lx, ly, lw, lh)
            r_ch = region[:, :, 2].astype(float)
            g_ch = region[:, :, 1].astype(float)
            b_ch = region[:, :, 0].astype(float)
            if int(np.sum((r_ch > 80) & (r_ch > g_ch * 2) & (r_ch > b_ch * 2))) < 10:
                return False
        else:
            text_tile = self._tile(frame, self.LIFE_TEXT_START_COL, self.LIFE_TEXT_ROW)
            avg = np.mean(text_tile, axis=(0, 1))
            r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
            if r < 50 or r < g * 2 or r < b * 2:
                return False

        # Phase 2: Compare 2nd character — "I" (narrow) in LIFE vs "O" (wide) in ROAR
        # Use proportional extraction from LIFE region when available
        if self._life_region is not None:
            lx, ly, lw, lh = self._life_region
            region = self._extract(frame, lx, ly, lw, lh)
            # Estimate character slots from landmark width (each NES char ≈ 8px)
            num_chars = max(1, round(lw / 8))
            rw = region.shape[1]
            # Second character (index 1): "I" in LIFE, "O" in ROAR
            c_start = int(round(rw / num_chars))
            c_end = int(round(rw / num_chars * 2))
            if c_start >= c_end or c_start >= rw:
                return False
            char_slice = region[:, c_start:c_end]
            tile = cv2.resize(char_slice, (8, 8), interpolation=cv2.INTER_NEAREST)
        else:
            tile = self._tile(frame, self.LIFE_CHAR2_COL, self.LIFE_TEXT_ROW)

        if float(np.mean(tile)) < 15:
            return False
        bright = tile.mean(axis=2) > 40
        col_sums = bright.sum(axis=0).astype(float)
        total = max(float(col_sums.sum()), 1.0)
        center = float(col_sums[2:6].sum())
        # Wide spread (low center ratio) indicates "O" = ROAR
        return (center / total) < 0.55

    # ─── Minimap Position ───

    MINIMAP_Y1 = 12
    MINIMAP_Y2 = 52
    MINIMAP_OW_X1 = 16   # overworld: 16 rooms wide
    MINIMAP_OW_X2 = 80
    MINIMAP_DG_X1 = 16   # dungeon: same physical region as overworld
    MINIMAP_DG_X2 = 80   # 64px wide, mapped to 8 rooms (8px each)
    MINIMAP_ROWS = 8

    def read_minimap_position(self, frame: np.ndarray, is_dungeon: bool = False) -> int:
        """Read player position from the minimap dot.

        Overworld: returns 0-127 (16 cols × 8 rows).
        Dungeon: returns 0-63 (8 cols × 8 rows).
        Returns 0 if position cannot be determined.
        """
        grid_cols = 8 if is_dungeon else 16
        x1 = (self.MINIMAP_DG_X1 if is_dungeon else self.MINIMAP_OW_X1) + self.grid_dx
        x2 = (self.MINIMAP_DG_X2 if is_dungeon else self.MINIMAP_OW_X2) + self.grid_dx
        y1 = self.MINIMAP_Y1 + self.grid_dy
        y2 = self.MINIMAP_Y2 + self.grid_dy

        minimap = self._extract(frame, x1, y1, x2 - x1, y2 - y1)
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

        # Use largest connected component to filter scattered noise pixels.
        # The player dot is a tight cluster; noise pixels are isolated.
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

    def _read_counter_at_y(self, frame: np.ndarray, digit_reader: 'DigitReader',
                           lm_y: int, cols: list[int],
                           min_score: float = 0.5) -> int:
        """Read a multi-digit counter at grid-aligned columns and a landmark y position.

        Uses lm_y directly (the pixel-measured landmark position) without snapping
        to the NES tile grid. Snapping caused 1px y misalignment for streams where
        the landmark doesn't fall exactly on a tile boundary (e.g. custom aspect
        ratio ROMs), producing wrong digit reads. Landmark column constants
        (RUPEE_DIGIT_COLS etc.) are defined in absolute NES tile space, so
        adding grid_dx would over-shift the extraction window.

        min_score filters out weak template matches from adjacent HUD icons
        (e.g. the rupee x icon at col 12 which can match digit shapes at ~0.3).
        Real digit matches on calibrated streams score 0.7-0.9.

        Uses max-channel brightness for the dark-tile skip so that single-hue
        digits (e.g. blue-channel-only) are not incorrectly skipped.
        """
        digits = []
        for col in cols:
            x = col * 8  # absolute NES column — no grid_dx
            tile = self._extract(frame, x, lm_y, 8, 8)
            if np.mean(np.max(tile, axis=2)) < 10:
                continue
            d, score = digit_reader.read_digit_with_score(tile)
            if d is not None and score >= min_score:
                digits.append(d)
        if not digits:
            return 0
        return int(''.join(str(d) for d in digits))

    def _read_counter_tiles(self, frame: np.ndarray, digit_reader: 'DigitReader',
                            cols: list[int], row: int, dy_adj: int = 0,
                            min_score: float = 0.5) -> int:
        """Read a multi-digit counter from tile positions (grid-based fallback).

        dy_adj offsets the extraction by that many NES pixels relative to
        grid_dy — used when a specific HUD row is known to sit 1px above or
        below the global grid offset (e.g. the bomb row on 4.5× scale streams).

        min_score filters out weak template matches caused by adjacent HUD
        icons (e.g. the rupee "×" icon at col 12 which weakly matches "2").
        Real digit matches score 0.7-1.0; icon false matches score ~0.4.
        """
        digits = []
        for col in cols:
            if dy_adj:
                x = col * 8 + self.grid_dx
                y = row * 8 + self.grid_dy + dy_adj
                tile = self._extract(frame, x, y, 8, 8)
            else:
                tile = self._tile(frame, col, row)
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
        """Fraction of warm-red pixels (R > 100, R > G*1.3, R > B*1.3).

        A looser variant of _red_ratio that detects both standard red hearts
        (R/G ~3-5) and custom warm-pink hearts (R/G ~1.34-1.36), while still
        rejecting NES empty heart container outlines (R/G ~1.24-1.28).

        Threshold chosen based on empirical data:
          blessedbe_ warm fill: R/G = 1.34-1.36 (passes 1.3x)
          bbqdotgov empty outline: R/G = 1.24-1.28 (fails 1.3x)
        """
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
        # Red-dominant pixels: R > 100 and R > G*2 and R > B*2
        red_mask = (r > 100) & (r > g * 1.5) & (r > b * 1.5)
        return float(np.sum(red_mask)) / float(red_mask.size)

    def _has_heart_outline(self, tile: np.ndarray) -> bool:
        """Check if a tile has a heart container outline (no fill)."""
        brightness = np.mean(tile)
        red_ratio = self._red_ratio(tile)
        # NES empty heart containers are white/grey outlines with
        # brightness ~50+. Threshold at 40 avoids false positives
        # from resize artifacts (~30-40 brightness).
        return brightness > 40 and red_ratio < 0.1
