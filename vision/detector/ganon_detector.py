"""Ganon sprite detection via template matching.

Detects the Ganon boss sprite in the D9 game area as a fallback when
ROAR text detection is unreliable in Z1R.  Uses cv2.matchTemplate with
TM_CCOEFF_NORMED — the same proven approach as FloorItemDetector.

Only runs when screen_type == 'dungeon' AND dungeon_level == 9 to
avoid false positives and keep performance cost negligible.

Ganon is a 2x2 NES metatile (32x32 pixels) — much larger than items
(8x16), with a distinctive shape.  Templates cover blue (visible) and
red (hit-flash) animation frames.
"""

import os

import cv2
import numpy as np

from .nes_frame import NESFrame

# Default threshold — slightly lower than floor items (0.85) because
# enemy sprites suffer more from Twitch compression variance.
_DEFAULT_THRESHOLD = 0.80


class GanonDetector:
    """Detect the Ganon boss sprite in dungeon 9.

    Args:
        template_dir: Path to ``templates/enemies/`` containing
            ``ganon_*.png`` files (32x32 BGR, black background).
        score_threshold: Minimum TM_CCOEFF_NORMED score to accept.
    """

    def __init__(self, template_dir: str,
                 score_threshold: float = _DEFAULT_THRESHOLD):
        self._score_threshold = score_threshold
        self._templates: dict[str, np.ndarray] = {}

        if not os.path.isdir(template_dir):
            return

        for fname in sorted(os.listdir(template_dir)):
            if not fname.startswith('ganon_') or not fname.endswith('.png'):
                continue
            path = os.path.join(template_dir, fname)
            img = cv2.imread(path, cv2.IMREAD_COLOR)
            if img is not None:
                self._templates[os.path.splitext(fname)[0]] = \
                    img.astype(np.float32)

    def detect(self, nf: NESFrame, screen_type: str,
               dungeon_level: int) -> bool:
        """Check whether Ganon's sprite is visible in the game area.

        Only scans when in dungeon 9.  Returns False immediately for
        all other screen types or dungeon levels.

        Args:
            nf: NESFrame wrapping the native-resolution NES crop.
            screen_type: Current screen classification.
            dungeon_level: Current dungeon level (0 = overworld).

        Returns:
            True if Ganon sprite detected above threshold.
        """
        if screen_type != 'dungeon' or dungeon_level != 9:
            return False

        if not self._templates:
            return False

        game_area = nf.game_area_canonical().astype(np.float32)

        for tmpl in self._templates.values():
            th, tw = tmpl.shape[:2]
            gh, gw = game_area.shape[:2]
            if gh < th or gw < tw:
                continue

            result = cv2.matchTemplate(game_area, tmpl, cv2.TM_CCOEFF_NORMED)
            max_val = float(result.max()) if result.size > 0 else 0.0
            if max_val >= self._score_threshold:
                return True

        return False
