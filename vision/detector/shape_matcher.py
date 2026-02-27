"""Generic binary shape template matcher.

Loads PNG templates from a directory, converts them to binary masks, and
matches query regions against them using cv2.matchTemplate (TM_CCOEFF_NORMED).

This is a domain-agnostic engine: it knows nothing about item names, color
twins, or Zelda-specific logic. Those concerns belong to callers such as
ItemReader.

Template images should be at NES pixel resolution (typically 8x16) and must
be PNG (lossless). The template slides within the query region, so the query
can be larger than the template — this tolerates positional uncertainty from
imprecise landmark placement.
"""

import os

import cv2
import numpy as np


class BinaryShapeMatcher:
    """Load PNG templates and match query regions via binary shape masks.

    NES sprites share the same pixel layout regardless of emulator palette.
    By thresholding both templates and query regions to binary (lit vs dark),
    we match on shape alone and ignore color differences.
    """

    def __init__(self, template_dir: str, threshold: int = 10):
        """Load templates from a directory of PNG files.

        Args:
            template_dir: Path to directory containing PNG template images,
                          named by their label (e.g., blue_candle.png).
            threshold: Grayscale brightness threshold for binary mask.
                       Pixels above this become white (shape), below
                       become black (background).
        """
        self.templates: dict[str, np.ndarray] = {}   # raw BGR images
        self._masks: dict[str, np.ndarray] = {}       # binary shape masks
        self._threshold = threshold

        if os.path.isdir(template_dir):
            for fname in sorted(os.listdir(template_dir)):
                if not fname.endswith('.png'):
                    continue
                name = os.path.splitext(fname)[0]
                path = os.path.join(template_dir, fname)
                img = cv2.imread(path, cv2.IMREAD_COLOR)
                if img is not None:
                    self.templates[name] = img
                    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                    _, mask = cv2.threshold(gray, threshold, 255,
                                            cv2.THRESH_BINARY)
                    self._masks[name] = mask

    def match(self, region: np.ndarray,
              bg_colors: list[np.ndarray] | None = None
              ) -> tuple[str, float] | None:
        """Return the best-matching template name and score, or None.

        Returns None if no template scores above 0.3 or if the region
        is too dark to contain a visible sprite.

        Args:
            region: BGR image region to match (any size >= template size).
            bg_colors: Optional list of BGR colors to zero out before
                       matching (e.g., dungeon floor tiles).

        Returns:
            (name, score) of the best match, or None.
        """
        scored = self.match_scored(region, bg_colors)
        if not scored or scored[0][1] <= 0.3:
            return None
        return scored[0]

    def match_scored(self, region: np.ndarray,
                     bg_colors: list[np.ndarray] | None = None
                     ) -> list[tuple[str, float]]:
        """Return all template scores sorted best-first.

        Useful for debugging, threshold tuning, and callers that need
        to compare top-N scores (e.g., for color-twin disambiguation).

        Args:
            region: BGR image region to match.
            bg_colors: Optional BGR colors to zero out before matching.

        Returns:
            List of (name, score) tuples, sorted by score descending.
            Empty list if no templates are loaded or region is too dark.
        """
        if not self._masks:
            return []

        region_mask = self._to_binary(region, bg_colors)
        if region_mask is None:
            return []

        scores = []
        for name, tmpl_mask in self._masks.items():
            score = self._score(region_mask, tmpl_mask)
            scores.append((name, score))

        scores.sort(key=lambda x: x[1], reverse=True)
        return scores

    def has_templates(self) -> bool:
        """Return True if at least one template was loaded."""
        return len(self.templates) > 0

    def _to_binary(self, region: np.ndarray,
                   bg_colors: list[np.ndarray] | None = None
                   ) -> np.ndarray | None:
        """Convert a region to a binary mask for matching.

        Returns None if the region contains fewer than 10 bright pixels
        (i.e., is effectively empty — no visible sprite present).
        """
        if bg_colors:
            region = self._zero_bg(region, bg_colors)

        gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, self._threshold, 255, cv2.THRESH_BINARY)

        if np.sum(mask > 0) < 10:
            return None

        return mask

    def _score(self, region_mask: np.ndarray,
               tmpl_mask: np.ndarray) -> float:
        """Compute the best normalized cross-correlation score.

        The template slides within the region (matchTemplate), so the region
        can be larger than the template to accommodate positional uncertainty.
        If the region is smaller than the template, it is zero-padded first.
        """
        th, tw = tmpl_mask.shape[:2]
        rh, rw = region_mask.shape[:2]

        if rh < th or rw < tw:
            padded = np.zeros((max(rh, th), max(rw, tw)), dtype=np.uint8)
            padded[:rh, :rw] = region_mask
            region_mask = padded

        result = cv2.matchTemplate(
            region_mask.astype(np.float32),
            tmpl_mask.astype(np.float32),
            cv2.TM_CCOEFF_NORMED)

        return float(np.max(result))

    def _zero_bg(self, region: np.ndarray,
                 bg_colors: list[np.ndarray],
                 tolerance: int = 30) -> np.ndarray:
        """Zero out pixels within tolerance of any background color."""
        result = region.copy()
        for color in bg_colors:
            diff = np.abs(region.astype(int) - color.reshape(1, 1, 3).astype(int))
            close = np.all(diff < tolerance, axis=2)
            result[close] = 0
        return result
