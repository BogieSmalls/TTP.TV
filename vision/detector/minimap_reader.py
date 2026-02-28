"""Full minimap reading: grid derivation, dot detection, tile recognition."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import numpy as np
import cv2
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .hud_calibrator import HudCalibrator

# NES reference constants
MINIMAP_NES_X1 = 16
MINIMAP_NES_X2 = 80   # 64px wide
MINIMAP_NES_ROWS = 8
MINIMAP_DG_COLS = 8
MINIMAP_OW_COLS = 16
RUPEE_NES_Y = 19      # center of rupee digit row
BOMB_NES_Y = 43       # center of bomb digit row
TILE_MATCH_THRESHOLD = 0.80


@dataclass
class MinimapResult:
    col: int = 0               # 1-based
    row: int = 0               # 1-based
    mode: str = 'unknown'      # 'overworld' | 'dungeon'
    dungeon_map_rooms: int | None = None   # bitmask of blue cells (map)
    triforce_room: tuple[int, int] | None = None
    zelda_room: tuple[int, int] | None = None
    collected_triforce: tuple[int, int] | None = None
    tile_match_id: int | None = None
    tile_match_score: float = 0.0
    map_position: int = 0      # backward-compat integer


class MinimapReader:
    """Reads player minimap position and room metadata."""

    def __init__(self, calibrator: 'HudCalibrator',
                 overworld_rooms_dir: str = 'content/overworld_rooms') -> None:
        self._calibrator = calibrator
        self._rooms_dir = Path(overworld_rooms_dir)
        self._prev_frame: np.ndarray | None = None
        self._ow_templates: dict[int, np.ndarray] = {}  # lazy-loaded

    def _derive_grid(self) -> dict:
        """Compute minimap grid dimensions from calibrated anchor positions."""
        cal = self._calibrator
        rupee_y = cal._anchors.rupee_row_y or RUPEE_NES_Y
        bomb_y = cal._anchors.bomb_row_y or BOMB_NES_Y
        cell_h = (bomb_y - rupee_y) / 6.0
        # rupee_y is center of MM row-pair 1-2, which is 1.5 cells from top
        minimap_top_y = rupee_y - 1.5 * cell_h

        left_px, _ = cal.result.nes_to_px(MINIMAP_NES_X1, 0)
        right_px, _ = cal.result.nes_to_px(MINIMAP_NES_X2, 0)
        minimap_w = max(right_px - left_px, 1)
        cell_w_dungeon = minimap_w / MINIMAP_DG_COLS
        cell_w_overworld = minimap_w / MINIMAP_OW_COLS

        return {
            'cell_h': cell_h,
            'minimap_top_y': minimap_top_y,
            'minimap_left_x': left_px,
            'minimap_right_x': right_px,
            'cell_w_dungeon': cell_w_dungeon,
            'cell_w_overworld': cell_w_overworld,
            'minimap_h': cell_h * MINIMAP_NES_ROWS,
        }
