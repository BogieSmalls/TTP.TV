"""HUD anchor-based calibration for NES Zelda 1 streams.

Detects reference points (LIFE text, B/A item borders, HUD/gameplay boundary,
digit rows, minimap gray rect) to compute a locked affine mapping from NES
pixel coordinates to canonical frame pixel coordinates.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np


# ─── NES reference constants ──────────────────────────────────────────────────
# All y values are top-of-region in canonical NES 256x240 space.
LIFE_NES_Y = 40          # LIFE text row 5 top
LIFE_NES_X = 176         # LIFE text col 22 left edge
GAMEPLAY_NES_Y = 64      # first row of game area (below HUD)
RUPEE_ROW_NES_Y = 19     # center of rupee digit row 2
KEY_ROW_NES_Y = 35       # center of key digit row 4
BOMB_ROW_NES_Y = 43      # center of bomb digit row 5
B_ITEM_NES_X = 128       # B-item sprite left edge (col 16)
A_ITEM_NES_X = 152       # A-item/sword left edge (col 19)
B_TO_A_NES_PX = 24       # A_ITEM_NES_X - B_ITEM_NES_X
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
