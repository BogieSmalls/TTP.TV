"""Detect item sprites in the NES game area (below HUD).

Identifies specific items by their color and shape characteristics
at NES resolution (256x240). Currently detects:
- Triforce pieces: orange triangle, ~45px area, ~10x10 bbox

Used in conjunction with game_logic.py to track item-hold animations
(Link holding item overhead) across multiple frames.
"""

from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

from .nes_frame import NESFrame


@dataclass
class DetectedItem:
    """An item detected in the game area."""
    item_type: str       # 'triforce', 'heart_container', etc.
    x: int               # center x in game area coordinates
    y: int               # center y in game area coordinates (0 = top of game area)
    area: int            # pixel area of the detected cluster
    confidence: float    # 0.0 - 1.0


class ItemDetector:
    """Detects item sprites in the NES game area."""

    # Staircase pedestal hot zone (game area coordinates, y relative to HUD bottom)
    _PEDESTAL_X = 120       # left edge of extraction region
    _PEDESTAL_Y = 68        # top edge (game-area coords; full-frame = 132)
    _PEDESTAL_W = 32        # extraction width
    _PEDESTAL_H = 40        # extraction height
    _PEDESTAL_BRIGHTNESS_MAX = 40   # reject regions with too much non-item content
    _STAIRCASE_ITEM_THRESHOLD = 0.55  # higher than default 0.3 to reduce FPs

    # Orange color range for triforce pieces (BGR)
    # NES triforce orange: R≈200, G≈137, B≈35
    # Widened for stream compression artifacts
    _TRIFORCE_R_MIN = 150
    _TRIFORCE_G_MIN = 80
    _TRIFORCE_G_MAX = 200
    _TRIFORCE_B_MAX = 100

    # Triforce piece size constraints (at NES 256x240)
    _TRIFORCE_AREA_MIN = 25     # minimum pixel area
    _TRIFORCE_AREA_MAX = 80     # maximum pixel area
    _TRIFORCE_BBOX_MIN = 6      # minimum bbox dimension
    _TRIFORCE_BBOX_MAX = 18     # maximum bbox dimension

    def __init__(self, item_reader=None):
        self._item_reader = item_reader

    def detect_items(self, nf: NESFrame,
                     screen_type: str) -> list[DetectedItem]:
        """Detect items in the game area of a NES frame.

        Args:
            nf: NESFrame wrapping the native-resolution NES crop.
            screen_type: Current screen classification.

        Returns:
            List of detected items.
        """
        if screen_type not in ('dungeon', 'cave', 'overworld'):
            return []

        game_area = nf.game_area_canonical()  # 176 x 256 x 3
        items = []

        triforce = self._detect_triforce(game_area)
        if triforce is not None:
            items.append(triforce)

        # Staircase pedestal item detection (dungeon only)
        if screen_type == 'dungeon' and self._item_reader is not None:
            staircase = self._detect_staircase_item(game_area)
            if staircase is not None:
                items.append(staircase)

        return items

    def _detect_triforce(self, game_area: np.ndarray) -> Optional[DetectedItem]:
        """Detect a triforce piece sprite in the game area.

        The triforce piece is a small orange triangle (~10x10 NES pixels,
        ~45px area). It's visible both on the ground (before pickup) and
        above Link's head (during item-hold animation).

        Returns the best-matching triforce detection, or None.
        """
        b, g, r = cv2.split(game_area)

        # Orange pixel mask
        mask = ((r > self._TRIFORCE_R_MIN)
                & (g > self._TRIFORCE_G_MIN)
                & (g < self._TRIFORCE_G_MAX)
                & (b < self._TRIFORCE_B_MAX))
        mask_u8 = mask.astype(np.uint8) * 255

        # Find contours (clusters of orange pixels)
        contours, _ = cv2.findContours(
            mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        best: Optional[DetectedItem] = None
        best_score = 0.0

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < self._TRIFORCE_AREA_MIN or area > self._TRIFORCE_AREA_MAX:
                continue

            x, y, w, h = cv2.boundingRect(contour)
            if (w < self._TRIFORCE_BBOX_MIN or w > self._TRIFORCE_BBOX_MAX
                    or h < self._TRIFORCE_BBOX_MIN or h > self._TRIFORCE_BBOX_MAX):
                continue

            # Score based on how close to ideal triforce shape:
            # - Ideal area: ~45 pixels
            # - Roughly square aspect ratio (triangle fits in square bbox)
            # - Triangle fill ratio: area / (w * h) should be ~0.45 (triangle)
            area_score = 1.0 - abs(area - 45) / 45
            aspect = min(w, h) / max(w, h)
            aspect_score = aspect  # 1.0 for square, lower for elongated
            fill_ratio = area / (w * h)
            # Triangle should fill about 40-55% of its bounding box
            fill_score = 1.0 - abs(fill_ratio - 0.47) / 0.47

            confidence = (area_score * 0.4 + aspect_score * 0.3
                          + fill_score * 0.3)
            confidence = max(0.0, min(1.0, confidence))

            if confidence > best_score and confidence > 0.3:
                cx = x + w // 2
                cy = y + h // 2
                best = DetectedItem(
                    item_type='triforce',
                    x=cx, y=cy,
                    area=int(area),
                    confidence=confidence,
                )
                best_score = confidence

        return best

    def _detect_staircase_item(self, game_area: np.ndarray) -> Optional[DetectedItem]:
        """Detect an item on the staircase pedestal in a dungeon.

        Extracts a fixed 32x40 region around the pedestal position and runs
        binary shape template matching via ItemReader. An isolation brightness
        check rejects false positives when Link or enemies are in the region.

        Returns a DetectedItem or None.
        """
        x = self._PEDESTAL_X
        y = self._PEDESTAL_Y
        w = self._PEDESTAL_W
        h = self._PEDESTAL_H

        ga_h, ga_w = game_area.shape[:2]
        if y + h > ga_h or x + w > ga_w:
            return None

        region = game_area[y:y + h, x:x + w]

        # Isolation check: reject if too bright (Link/enemies present)
        gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
        if float(gray.mean()) > self._PEDESTAL_BRIGHTNESS_MAX:
            return None

        # Score check first (avoids unnecessary color disambiguation)
        scored = self._item_reader.read_item_scored(region)
        if not scored or scored[0][1] < self._STAIRCASE_ITEM_THRESHOLD:
            return None

        # Get disambiguated name (handles shape twins like red_ring/blue_ring)
        item_name = self._item_reader.read_item(region)
        if item_name is None:
            return None

        cx = x + w // 2
        cy = y + h // 2
        return DetectedItem(
            item_type=item_name,
            x=cx, y=cy,
            area=w * h,
            confidence=scored[0][1],
        )
