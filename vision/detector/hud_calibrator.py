"""HUD anchor-based calibration for NES Zelda 1 streams.

Detects reference points (LIFE text, B/A item borders, HUD/gameplay boundary,
digit rows, minimap gray rect) to compute a locked affine mapping from NES
pixel coordinates to canonical frame pixel coordinates.
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np  # used by anchor detection methods added in Tasks 2-4


# ─── NES reference constants ──────────────────────────────────────────────────
# All coordinates are in canonical NES 256x240 space.
LIFE_NES_Y = 40          # LIFE text row 5 top
LIFE_NES_X = 176         # LIFE text col 22 left edge
GAMEPLAY_NES_Y = 64      # first row of game area (below HUD)
RUPEE_ROW_NES_Y = 19     # center of rupee digit row 2
KEY_ROW_NES_Y = 35       # center of key digit row 4
BOMB_ROW_NES_Y = 43      # center of bomb digit row 5
B_ITEM_NES_X = 128       # B-item sprite left edge (col 16)
A_ITEM_NES_X = 152       # A-item/sword left edge (col 19)
B_TO_A_NES_PX = A_ITEM_NES_X - B_ITEM_NES_X
HIGH_CONFIDENCE = 0.85   # lock threshold
SPOT_CHECK_INTERVAL = 300  # gameplay frames between spot-checks
DRIFT_WARNING_PX = 3     # warn if locked values drift > this many pixels


@dataclass
class CalibrationAnchors:
    """Raw detected pixel positions of each HUD reference point."""
    life_y: int | None = None
    life_h: int | None = None
    gameplay_y: int | None = None
    b_item_x: int | None = None
    a_item_x: int | None = None
    level_text_x: int | None = None
    rupee_row_y: int | None = None
    key_row_y: int | None = None
    bomb_row_y: int | None = None
    minimap_gray_rect: tuple[int, int, int, int] | None = None  # (x,y,w,h)


@dataclass
class CalibrationResult:
    """Locked affine mapping: NES pixel → canonical frame pixel."""
    anchor_x: float = 0.0
    anchor_y: float = 0.0
    scale_x: float = 1.0
    scale_y: float = 1.0
    confidence: float = 0.0
    locked: bool = False
    source_frame: int = -1

    def nes_to_px(self, nes_x: int, nes_y: int) -> tuple[int, int]:
        """Map a NES pixel coordinate to canonical frame pixel coordinate."""
        px_x = int(round(self.anchor_x + nes_x * self.scale_x))
        px_y = int(round(self.anchor_y + nes_y * self.scale_y))
        return px_x, px_y


class HudCalibrator:
    """Detects HUD reference anchors and maintains a locked calibration result."""

    # Scan bounds for LIFE text (generous to handle stream offsets)
    _LIFE_SCAN_X1, _LIFE_SCAN_X2 = 160, 230
    _LIFE_SCAN_Y1, _LIFE_SCAN_Y2 = 0, 64

    def __init__(self) -> None:
        self.result = CalibrationResult()
        self._anchors = CalibrationAnchors()
        self._gameplay_frames_seen = 0
        self._last_spot_check = 0

    def _detect_life_text(self, frame: np.ndarray) -> tuple[int | None, int | None]:
        """Scan for the -LIFE- red text cluster; return (top_y, height) or (None, None)."""
        region = frame[self._LIFE_SCAN_Y1:self._LIFE_SCAN_Y2,
                       self._LIFE_SCAN_X1:self._LIFE_SCAN_X2]
        r = region[:, :, 2].astype(np.int16)
        g = region[:, :, 1].astype(np.int16)
        b = region[:, :, 0].astype(np.int16)
        red_mask = (r > 50) & (r > g * 2) & (r > b * 2)
        if red_mask.sum() < 6:
            return None, None
        rows = np.any(red_mask, axis=1)
        row_indices = np.where(rows)[0]
        if len(row_indices) == 0:
            return None, None
        top_y = int(row_indices[0]) + self._LIFE_SCAN_Y1
        bot_y = int(row_indices[-1]) + self._LIFE_SCAN_Y1
        return top_y, max(1, bot_y - top_y + 1)

    def _detect_gameplay_boundary(self, frame: np.ndarray,
                                  life_y: int) -> int | None:
        """Scan downward from life_y+20 until first non-black row. Returns y."""
        start_y = min(life_y + 20, 239)
        for y in range(start_y, min(start_y + 60, 240)):
            row = frame[y, :, :]
            if float(np.mean(row)) > 15:
                return y
        return None

    def _detect_b_a_borders(self, frame: np.ndarray
                             ) -> tuple[int | None, int | None]:
        """Detect left edges of B-item and A-item blue borders."""
        # B-item is at NES x≈128, y≈16-31; A-item at x≈152, y≈24-39
        b_x = a_x = None
        region_y1, region_y2 = 8, 48
        for x in range(115, 170):
            col = frame[region_y1:region_y2, x, :]
            blue_ch = col[:, 0].astype(int)
            red_ch = col[:, 2].astype(int)
            green_ch = col[:, 1].astype(int)
            blue_pixels = int(np.sum((blue_ch > 150) & (blue_ch > red_ch * 2) & (blue_ch > green_ch * 2)))
            if blue_pixels >= 4:
                if b_x is None and x < 142:
                    b_x = x
                elif b_x is not None and a_x is None and x > b_x + 10:
                    a_x = x
                if b_x is not None and a_x is not None:
                    break
        return b_x, a_x

    def _detect_digit_rows(self, frame: np.ndarray
                           ) -> tuple[int | None, int | None, int | None]:
        """Find rupee, key, bomb digit row centers from bright pixel scan."""
        # Digit columns are in x range 80-140; scan that strip for bright rows
        strip = frame[8:56, 80:140, :]
        brightness = np.mean(strip, axis=(1, 2))
        rupee_y = key_y = bomb_y = None
        # Rupee row ≈ y=15-24 → strip rows 7-16
        for y_off in range(7, 17):
            if brightness[y_off] > 30:
                rupee_y = y_off + 8
                break
        # Key row ≈ y=32-39 → strip rows 24-31
        for y_off in range(24, 32):
            if brightness[y_off] > 30:
                key_y = y_off + 8
                break
        # Bomb row ≈ y=40-48 → strip rows 32-41
        for y_off in range(32, 42):
            if brightness[y_off] > 30:
                bomb_y = y_off + 8
                break
        return rupee_y, key_y, bomb_y

    def _detect_minimap_gray_rect(self, frame: np.ndarray
                                   ) -> tuple[int, int, int, int] | None:
        """Find mid-gray rectangle in minimap region (x=16-79, y=12-52). Returns (x, y, w, h) in canonical frame coords, or None."""
        region = frame[12:52, 16:80, :]
        r = region[:, :, 2].astype(int)
        g = region[:, :, 1].astype(int)
        b = region[:, :, 0].astype(int)
        gray_mask = ((r >= 80) & (r <= 140) & (g >= 80) & (g <= 140)
                     & (b >= 80) & (b <= 140)).astype(np.uint8)
        if gray_mask.sum() < 20:
            return None
        coords = np.argwhere(gray_mask)
        y0, x0 = int(coords[:, 0].min()), int(coords[:, 1].min())
        y1, x1 = int(coords[:, 0].max()), int(coords[:, 1].max())
        return x0 + 16, y0 + 12, x1 - x0 + 1, y1 - y0 + 1

    def calibrate(self, frame: np.ndarray, frame_num: int) -> None:
        """Detect all anchors, compute scales, lock on first high-confidence result."""
        # 1. Detect anchors
        life_y, life_h = self._detect_life_text(frame)
        self._anchors.life_y = life_y
        self._anchors.life_h = life_h

        gameplay_y = None
        if life_y is not None:
            gameplay_y = self._detect_gameplay_boundary(frame, life_y)
        self._anchors.gameplay_y = gameplay_y

        b_x, a_x = self._detect_b_a_borders(frame)
        self._anchors.b_item_x = b_x
        self._anchors.a_item_x = a_x

        rupee_y, key_y, bomb_y = self._detect_digit_rows(frame)
        self._anchors.rupee_row_y = rupee_y
        self._anchors.key_row_y = key_y
        self._anchors.bomb_row_y = bomb_y

        self._anchors.minimap_gray_rect = self._detect_minimap_gray_rect(frame)

        # 2. Compute scales from available measurements
        scale_y_measures: list[float] = []
        if life_h is not None:
            scale_y_measures.append(life_h / 8.0)
        if life_y is not None and gameplay_y is not None:
            scale_y_measures.append((gameplay_y - life_y) / (GAMEPLAY_NES_Y - LIFE_NES_Y))
        if rupee_y is not None and bomb_y is not None:
            scale_y_measures.append(
                (bomb_y - rupee_y) / (BOMB_ROW_NES_Y - RUPEE_ROW_NES_Y))

        scale_x_measures: list[float] = []
        if b_x is not None and a_x is not None:
            scale_x_measures.append((a_x - b_x) / B_TO_A_NES_PX)

        # 3. Confidence = fraction of anchor groups detected
        n_detected = sum([
            life_y is not None,
            gameplay_y is not None,
            b_x is not None and a_x is not None,
            rupee_y is not None,
            key_y is not None,
            bomb_y is not None,
            self._anchors.minimap_gray_rect is not None,
        ])
        confidence = n_detected / 7.0

        # 4. Build candidate result
        scale_y = float(np.mean(scale_y_measures)) if scale_y_measures else 1.0
        scale_x = float(np.mean(scale_x_measures)) if scale_x_measures else scale_y
        anchor_y = (life_y - LIFE_NES_Y * scale_y) if life_y is not None else 0.0
        anchor_x = (b_x - B_ITEM_NES_X * scale_x) if b_x is not None else 0.0

        # 5. Lock on first high-confidence result; spot-check thereafter
        if not self.result.locked:
            if confidence >= HIGH_CONFIDENCE:
                self.result = CalibrationResult(
                    anchor_x=anchor_x, anchor_y=anchor_y,
                    scale_x=scale_x, scale_y=scale_y,
                    confidence=confidence, locked=True, source_frame=frame_num)
            else:
                # Update best-effort (not locked)
                self.result = CalibrationResult(
                    anchor_x=anchor_x, anchor_y=anchor_y,
                    scale_x=scale_x, scale_y=scale_y,
                    confidence=confidence, locked=False, source_frame=frame_num)
        else:
            self._gameplay_frames_seen += 1
            if self._gameplay_frames_seen - self._last_spot_check >= SPOT_CHECK_INTERVAL:
                self._last_spot_check = self._gameplay_frames_seen
                if life_y is not None:
                    drift = abs(life_y - self.result.nes_to_px(LIFE_NES_X, LIFE_NES_Y)[1])
                    if drift > DRIFT_WARNING_PX:
                        import logging
                        logging.getLogger(__name__).warning(
                            f'HudCalibrator: LIFE text drifted {drift}px from locked position '
                            f'(frame {frame_num}). Calibration may be stale.')
