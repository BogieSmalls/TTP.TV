"""NES item sprite recognition using binary shape matching.

NES Zelda uses 8x16 pixel sprites for items. The same sprite data
produces different colors depending on the emulator palette, but the
pixel layout (which pixels are lit vs dark) is identical. By converting
both templates and captured tiles to binary masks, we match on shape
alone and eliminate palette differences.

Templates are loaded at their native NES resolution (8x16). When
matching, the template slides within the extraction region using
cv2.matchTemplate, tolerating positional offsets from imprecise
landmark placement.

Supports three contexts:
  - HUD B-item slot: black background, fixed position
  - Staircase/cave items: black background, known position
  - Dungeon floor items: mask out floor palette first, then match
"""

import cv2
import numpy as np

from .shape_matcher import BinaryShapeMatcher


# Items sharing identical shapes — disambiguated by color.
# Maps each item to (partner, 'blue'|'red'|'bright'|'warm' indicator).
# When shape scores tie, the tile's color picks the correct variant.
_SHAPE_TWINS = {
    'blue_candle': ('red_candle', 'blue'),
    'red_candle': ('blue_candle', 'red'),
    'boomerang': ('magical_boomerang', 'warm'),
    'magical_boomerang': ('boomerang', 'blue'),
    'potion_blue': ('potion_red', 'blue'),
    'potion_red': ('potion_blue', 'red'),
    'blue_ring': ('red_ring', 'blue'),
    'red_ring': ('blue_ring', 'red'),
    'sword_wood': ('sword_white', 'warm'),
    'sword_white': ('sword_wood', 'bright'),
    'arrow': ('silver_arrow', 'warm'),
    'silver_arrow': ('arrow', 'bright'),
    'wand': ('recorder', 'blue'),
    'recorder': ('wand', 'warm'),
}


class ItemReader:
    """Match NES item tiles against stored binary shape templates."""

    def __init__(self, template_dir: str, threshold: int = 10):
        """Load item templates from directory.

        Expects PNG files named by item (e.g., blue_candle.png).
        Templates should be at NES pixel resolution (typically 8x16).

        Args:
            template_dir: Path to directory containing item template images.
            threshold: Grayscale brightness threshold for binary mask.
                       Pixels above this become white (shape), below
                       become black (background).
        """
        self._matcher = BinaryShapeMatcher(template_dir, threshold)
        self._threshold = threshold

    @property
    def templates(self) -> dict[str, np.ndarray]:
        """Raw BGR template images keyed by item name."""
        return self._matcher.templates

    def read_item(self, tile: np.ndarray,
                  bg_colors: list[np.ndarray] | None = None) -> str | None:
        """Match a tile region against item templates using binary shapes.

        The tile can be larger than the templates — the template slides
        within the tile to find the best match position. This handles
        positional uncertainty from landmark placement.

        When two items share identical shapes (e.g., blue_candle vs
        red_candle), the tile's actual pixel color is used to pick
        the correct variant.

        Args:
            tile: BGR image, any size >= template size.
            bg_colors: Optional BGR colors to mask out (dungeon floor).

        Returns:
            Item name string (e.g., 'blue_candle') or None if no match.
        """
        scored = self._matcher.match_scored(tile, bg_colors)
        if not scored or scored[0][1] <= 0.3:
            return None

        best_item, best_score = scored[0]

        # Disambiguate shape twins by color
        if best_item in _SHAPE_TWINS:
            partner, _ = _SHAPE_TWINS[best_item]
            partner_score = next((s for n, s in scored if n == partner), 0.0)
            if abs(best_score - partner_score) < 0.05:
                best_item = self._pick_by_color(tile, best_item, partner)

        return best_item

    def read_item_scored(self, tile: np.ndarray,
                         bg_colors: list[np.ndarray] | None = None
                         ) -> list[tuple[str, float]]:
        """Match a tile and return all scores, sorted best-first.

        Useful for debugging and threshold tuning.
        """
        return self._matcher.match_scored(tile, bg_colors)

    def has_templates(self) -> bool:
        """Check if item templates are loaded."""
        return self._matcher.has_templates()

    def _pick_by_color(self, tile: np.ndarray,
                       item_a: str, item_b: str) -> str:
        """Disambiguate shape-identical items by tile color.

        Examines the bright (non-black) pixels in the tile and checks
        whether they're blue-dominant, red-dominant, warm, or bright.
        Returns the item whose color indicator matches.
        """
        gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
        # Use a higher threshold for color analysis than for shape matching.
        # On Twitch-compressed streams, dark HUD background bleeds into
        # slightly blue values (e.g. grayscale 15-25). At threshold=10 these
        # artifact pixels add blue bias, making red candle look blue.
        # Threshold 40 isolates actual sprite pixels from background noise.
        color_thresh = max(self._threshold, 40)
        bright = gray > color_thresh
        if np.sum(bright) < 5:
            return item_a  # not enough data, keep shape winner

        b_ch = tile[:, :, 0][bright].astype(float)
        g_ch = tile[:, :, 1][bright].astype(float)
        r_ch = tile[:, :, 2][bright].astype(float)
        avg_b, avg_g, avg_r = np.mean(b_ch), np.mean(g_ch), np.mean(r_ch)
        brightness = (avg_b + avg_g + avg_r) / 3.0

        # Classify the tile's dominant color
        if avg_b > avg_r + 15 and avg_b > avg_g:
            tile_color = 'blue'
        elif avg_r > avg_b + 15 and avg_r > avg_g:
            tile_color = 'red'
        elif brightness > 150:
            tile_color = 'bright'
        else:
            tile_color = 'warm'

        # Pick the item whose color indicator matches
        info_a = _SHAPE_TWINS.get(item_a)
        info_b = _SHAPE_TWINS.get(item_b)
        if info_a and info_a[1] == tile_color:
            return item_a
        if info_b and info_b[1] == tile_color:
            return item_b
        # Fallback: return the first item (shape winner)
        return item_a
