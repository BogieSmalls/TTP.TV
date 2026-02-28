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

    def _detect_level_text(self, frame: np.ndarray) -> int | None:
        """Return left edge x of LEVEL text if present in row 1, else None."""
        row1 = frame[8:16, 0:64, :]
        brightness = np.mean(row1, axis=2)
        bright_cols = np.where(np.any(brightness > 20, axis=0))[0]
        if len(bright_cols) == 0:
            return None
        return int(bright_cols[0])

    def _find_link_dot(self, minimap_region: np.ndarray,
                       grid: dict, is_dungeon: bool
                       ) -> tuple[int, int] | None:
        """Find the brightest pixel cluster; return (col, row) 1-based or None."""
        gray = np.mean(minimap_region, axis=2)
        threshold = float(np.max(gray)) * 0.8
        if threshold < 80:
            return None
        bright_mask = (gray > threshold).astype(np.uint8)
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(bright_mask)
        if num_labels <= 1:
            return None
        best_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        cy, cx = centroids[best_label][1], centroids[best_label][0]
        cell_w = grid['cell_w_dungeon'] if is_dungeon else grid['cell_w_overworld']
        cell_h = grid['cell_h']
        map_h = grid['minimap_h']
        map_w = minimap_region.shape[1]
        cols = MINIMAP_DG_COLS if is_dungeon else MINIMAP_OW_COLS
        col = max(1, min(cols, int(cx / map_w * cols) + 1))
        row = max(1, min(MINIMAP_NES_ROWS, int(cy / map_h * MINIMAP_NES_ROWS) + 1))
        return col, row

    def _detect_dungeon_map(self, minimap: np.ndarray, grid: dict) -> int:
        """Scan 64 dungeon cells for royal blue backgrounds; return bitmask."""
        bitmask = 0
        cell_h = grid['cell_h']
        cell_w = grid['cell_w_dungeon']
        for row in range(MINIMAP_NES_ROWS):
            for col in range(MINIMAP_DG_COLS):
                y0 = int(row * cell_h)
                x0 = int(col * cell_w)
                y1 = min(int(y0 + cell_h), minimap.shape[0])
                x1 = min(int(x0 + cell_w), minimap.shape[1])
                cell = minimap[y0:y1, x0:x1]
                if cell.size == 0:
                    continue
                b = cell[:, :, 0].astype(int)
                r = cell[:, :, 2].astype(int)
                g = cell[:, :, 1].astype(int)
                blue_px = int(np.sum((b > 150) & (b > r * 2) & (b > g * 2)))
                if blue_px >= 2:
                    bitmask |= 1 << (row * MINIMAP_DG_COLS + col)
        return bitmask

    def _detect_flashing_dot(self, curr: np.ndarray, prev: np.ndarray,
                              grid: dict) -> tuple[int, int] | None:
        """Find red dot present now but not in prev frame (flashing)."""
        r_curr = curr[:, :, 2].astype(int)
        g_curr = curr[:, :, 1].astype(int)
        b_curr = curr[:, :, 0].astype(int)
        r_prev = prev[:, :, 2].astype(int)
        red_now = (r_curr > 150) & (r_curr > g_curr * 2) & (r_curr > b_curr * 2)
        red_before = r_prev > 100
        flashing = red_now & ~red_before
        if flashing.sum() < 2:
            return None
        coords = np.argwhere(flashing)
        cy, cx = float(np.mean(coords[:, 0])), float(np.mean(coords[:, 1]))
        cell_w = grid['cell_w_dungeon']
        cell_h = grid['cell_h']
        col = max(1, min(MINIMAP_DG_COLS, int(cx / cell_w) + 1))
        row = max(1, min(MINIMAP_NES_ROWS, int(cy / cell_h) + 1))
        return col, row

    def _load_ow_template(self, col: int, row: int) -> np.ndarray | None:
        """Load overworld room reference tile; cache in memory."""
        key = (col - 1) * MINIMAP_NES_ROWS + (row - 1)  # 0-based room index
        if key in self._ow_templates:
            return self._ow_templates[key]
        path = self._rooms_dir / f'C{col}_R{row}.jpg'
        if not path.exists():
            return None
        img = cv2.imread(str(path))
        self._ow_templates[key] = img
        return img

    def _histogram_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        """Normalized histogram dot product similarity (0-1) between two BGR images."""
        b_resized = cv2.resize(b, (a.shape[1], a.shape[0]),
                               interpolation=cv2.INTER_AREA)
        score = 0.0
        for ch in range(3):
            h_a = cv2.calcHist([a], [ch], None, [64], [0, 256]).flatten()
            h_b = cv2.calcHist([b_resized], [ch], None, [64], [0, 256]).flatten()
            norm_a = np.linalg.norm(h_a)
            norm_b = np.linalg.norm(h_b)
            if norm_a > 0 and norm_b > 0:
                score += float(np.dot(h_a / norm_a, h_b / norm_b))
        return score / 3.0

    def _identify_overworld_tile(self, frame: np.ndarray,
                                  minimap_col: int, minimap_row: int
                                  ) -> tuple[int | None, float]:
        """Compare gameplay area against reference tiles; return (room_id, score)."""
        gameplay = frame[64:240, :, :]  # below HUD
        # Pass 1: minimap prior
        tmpl = self._load_ow_template(minimap_col, minimap_row)
        if tmpl is not None:
            score = self._histogram_similarity(gameplay, tmpl)
            if score >= TILE_MATCH_THRESHOLD:
                room_id = (minimap_row - 1) * MINIMAP_OW_COLS + (minimap_col - 1)
                return room_id, score

        # Pass 2: 3x3 neighborhood
        best_id, best_score = None, 0.0
        for dc in (-1, 0, 1):
            for dr in (-1, 0, 1):
                if dc == 0 and dr == 0:
                    continue
                nc, nr = minimap_col + dc, minimap_row + dr
                if not (1 <= nc <= MINIMAP_OW_COLS and 1 <= nr <= MINIMAP_NES_ROWS):
                    continue
                tmpl = self._load_ow_template(nc, nr)
                if tmpl is None:
                    continue
                score = self._histogram_similarity(gameplay, tmpl)
                if score > best_score:
                    best_score = score
                    if score >= TILE_MATCH_THRESHOLD:
                        best_id = (nr - 1) * MINIMAP_OW_COLS + (nc - 1)
        return best_id, best_score

    def _detect_faint_gray_dot(self, minimap: np.ndarray, grid: dict,
                                exclude: tuple[int, int] | None
                                ) -> tuple[int, int] | None:
        """Find faint static gray dot (collected triforce marker)."""
        gray = np.mean(minimap, axis=2)
        faint_mask = ((gray > 40) & (gray < 90)).astype(np.uint8)
        if faint_mask.sum() < 2:
            return None
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(faint_mask)
        if num_labels <= 1:
            return None
        best_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        cy, cx = centroids[best_label][1], centroids[best_label][0]
        cell_w = grid['cell_w_dungeon']
        cell_h = grid['cell_h']
        col = max(1, min(MINIMAP_DG_COLS, int(cx / cell_w) + 1))
        row = max(1, min(MINIMAP_NES_ROWS, int(cy / cell_h) + 1))
        if exclude and (col, row) == exclude:
            return None  # same cell as Link — not a separate dot
        return col, row

    def read(self, frame: np.ndarray, screen_type: str,
             dungeon_level: int = 0) -> MinimapResult:
        """Read minimap position and metadata from frame."""
        result = MinimapResult()
        grid = self._derive_grid()

        # Determine mode from LEVEL text (overrides screen classifier)
        level_x = self._detect_level_text(frame)
        is_dungeon = level_x is not None or screen_type == 'dungeon'
        result.mode = 'dungeon' if is_dungeon else 'overworld'

        # Extract minimap pixel region
        x1 = int(grid['minimap_left_x'])
        y1 = int(grid['minimap_top_y'])
        x2 = int(grid['minimap_right_x'])
        y2 = int(y1 + grid['minimap_h'])
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(255, x2), min(239, y2)
        if x2 <= x1 or y2 <= y1:
            return result

        minimap = frame[y1:y2, x1:x2]

        # Find Link dot
        dot = self._find_link_dot(minimap, grid, is_dungeon)
        if dot is not None:
            result.col, result.row = dot
            cols = MINIMAP_DG_COLS if is_dungeon else MINIMAP_OW_COLS
            result.map_position = (result.row - 1) * cols + (result.col - 1)

        # Dungeon map bitmask (blue cell backgrounds)
        if is_dungeon:
            result.dungeon_map_rooms = self._detect_dungeon_map(minimap, grid)

        # Multi-dot detection: flashing red (triforce/Zelda) and faint gray
        if is_dungeon and self._prev_frame is not None:
            prev_minimap = self._prev_frame[y1:y2, x1:x2]
            flashing = self._detect_flashing_dot(minimap, prev_minimap, grid)
            if flashing is not None:
                if dungeon_level == 9:
                    result.zelda_room = flashing
                else:
                    result.triforce_room = flashing
            result.collected_triforce = self._detect_faint_gray_dot(
                minimap, grid, exclude=dot)

        # Overworld tile recognition
        if not is_dungeon and result.col > 0 and result.row > 0:
            tile_id, tile_score = self._identify_overworld_tile(
                frame, result.col, result.row)
            result.tile_match_id = tile_id
            result.tile_match_score = tile_score

        self._prev_frame = frame.copy()
        return result
