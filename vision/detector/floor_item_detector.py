"""Floor item detection via full-color sliding template matching.

Detects item sprites sitting on dungeon/overworld floors at arbitrary
positions against textured backgrounds. Uses cv2.matchTemplate with
TM_CCOEFF_NORMED on full BGR images — color information discriminates
items from wall/door edges that confuse binary shape matching.

Performance: ~64ms per full scan (27 templates on 176x256 game area).
Mitigated by frame-diff guard (~0.05ms to skip unchanged frames) and
optional duty-cycle (run every Nth frame).

See FLOOR_DETECTION_PLAN.md for exploration results and design rationale.
"""

import os
from dataclasses import dataclass

import cv2
import numpy as np

from .item_reader import ItemReader, _SHAPE_TWINS
from .nes_frame import NESFrame

# Wall/border exclusion zone (pixels).  Items appear on the playable
# interior, not in the outer wall/door tiles.
_WALL_MARGIN = 16

# NMS suppression distances (pixels).  Items are 8x16 so detections
# within this window are considered duplicates.
_NMS_X_DIST = 8
_NMS_Y_DIST = 16

# Minimum change in mean pixel value to consider the frame "different"
# from the previous one.  Below this, floor detection is skipped.
_FRAME_DIFF_THRESHOLD = 0.5


@dataclass
class FloorItem:
    """An item detected on the floor of the game area."""
    name: str        # e.g. 'blue_candle', 'heart_container'
    x: int           # NES pixel x in game_area coordinates
    y: int           # NES pixel y in game_area coordinates
    score: float     # matchTemplate NCC score (0.85–1.0)


class FloorItemDetector:
    """Detect item sprites on dungeon/overworld floors.

    Uses full-color sliding template matching across all item templates.
    A frame-diff guard skips processing when the game area is unchanged.

    Args:
        item_reader: An initialised ItemReader (provides templates and
                     color disambiguation for shape twins).
        score_threshold: Minimum TM_CCOEFF_NORMED score to accept.
        wall_margin: Pixels of border to exclude from detections.
    """

    def __init__(self, item_reader: ItemReader,
                 score_threshold: float = 0.85,
                 wall_margin: int = _WALL_MARGIN,
                 drops_dir: str | None = None):
        self._item_reader = item_reader
        self._score_threshold = score_threshold
        self._wall_margin = wall_margin

        # Precompute float32 templates for matchTemplate
        self._tmpl_f32: dict[str, np.ndarray] = {}
        self._tmpl_sizes: dict[str, tuple[int, int]] = {}
        for name, tmpl in item_reader.templates.items():
            self._tmpl_f32[name] = tmpl.astype(np.float32)
            self._tmpl_sizes[name] = (tmpl.shape[0], tmpl.shape[1])

        # Load additional enemy-drop templates (clock, fairy, heart, rupee)
        if drops_dir and os.path.isdir(drops_dir):
            for fname in sorted(os.listdir(drops_dir)):
                if not fname.endswith('.png'):
                    continue
                name = os.path.splitext(fname)[0]
                path = os.path.join(drops_dir, fname)
                img = cv2.imread(path, cv2.IMREAD_COLOR)
                if img is not None:
                    self._tmpl_f32[name] = img.astype(np.float32)
                    self._tmpl_sizes[name] = (img.shape[0], img.shape[1])

        # Frame-diff guard state
        self._prev_game_area: np.ndarray | None = None
        self._prev_detections: list[FloorItem] = []

    def detect(self, nf: NESFrame, screen_type: str) -> list[FloorItem]:
        """Detect floor items in the NES game area.

        Only runs on dungeon or overworld screens.  Returns an empty
        list for other screen types or when the game area is unchanged.

        Args:
            nf: NESFrame wrapping the native-resolution NES crop.
            screen_type: Current screen classification.

        Returns:
            List of FloorItem detections, sorted by score descending.
        """
        if screen_type not in ('dungeon', 'overworld'):
            self._prev_game_area = None
            return []

        game_area = nf.game_area_canonical()  # 176 x 256 x 3

        # Frame-diff guard: skip if unchanged
        if self._prev_game_area is not None:
            diff = cv2.absdiff(self._prev_game_area, game_area)
            if float(np.mean(diff)) < _FRAME_DIFF_THRESHOLD:
                self._prev_game_area = game_area.copy()
                return self._prev_detections
        self._prev_game_area = game_area.copy()

        detections = self._scan(game_area)
        self._prev_detections = detections
        return detections

    def detect_game_area(self, game_area: np.ndarray) -> list[FloorItem]:
        """Detect floor items directly on a game_area (176x256 BGR).

        Bypasses screen_type check and frame-diff guard.  Useful for
        testing and one-shot analysis.
        """
        return self._scan(game_area)

    def _scan(self, game_area: np.ndarray) -> list[FloorItem]:
        """Run full-color sliding template matching on the game area."""
        h, w = game_area.shape[:2]
        margin = self._wall_margin
        ga_f = game_area.astype(np.float32)

        raw_detections: list[tuple[str, int, int, float]] = []
        for name, tmpl in self._tmpl_f32.items():
            th, tw = self._tmpl_sizes[name]
            if h < th or w < tw:
                continue

            result = cv2.matchTemplate(ga_f, tmpl, cv2.TM_CCOEFF_NORMED)
            locs = np.where(result >= self._score_threshold)
            for y, x in zip(*locs):
                # Wall margin filter
                if (x < margin or x + tw > w - margin
                        or y < margin or y + th > h - margin):
                    continue
                raw_detections.append((name, int(x), int(y),
                                       float(result[y, x])))

        # NMS: keep highest score per location
        kept = _nms(raw_detections, _NMS_X_DIST, _NMS_Y_DIST)

        # Disambiguate shape twins using color
        items: list[FloorItem] = []
        for name, x, y, score in kept:
            final_name = self._disambiguate(name, game_area, x, y)
            items.append(FloorItem(name=final_name, x=x, y=y, score=score))

        return items

    def _disambiguate(self, name: str, game_area: np.ndarray,
                      x: int, y: int) -> str:
        """Resolve shape twins (e.g. blue_ring vs red_ring) by color."""
        if name not in _SHAPE_TWINS:
            return name

        partner, _ = _SHAPE_TWINS[name]

        # Extract the tile region at the detection position
        th, tw = self._tmpl_sizes[name]
        tile = game_area[y:y + th, x:x + tw]

        # Reuse ItemReader's color disambiguation
        return self._item_reader._pick_by_color(tile, name, partner)


def _nms(detections: list[tuple[str, int, int, float]],
         x_dist: int, y_dist: int) -> list[tuple[str, int, int, float]]:
    """Non-maximum suppression: keep highest-scoring detection per location."""
    detections.sort(key=lambda d: d[3], reverse=True)
    kept: list[tuple[str, int, int, float]] = []
    for det in detections:
        _, x, y, _ = det
        if any(abs(x - kx) < x_dist and abs(y - ky) < y_dist
               for _, kx, ky, _ in kept):
            continue
        kept.append(det)
    return kept
