"""Template-match NES digits (0-9) at known HUD positions.

NES Zelda uses 8x8 pixel bitmap font tiles for all numeric displays.
We store reference templates for each digit and match incoming tiles
using normalized cross-correlation.
"""

import os

import cv2
import numpy as np


class DigitReader:
    """Match 8x8 NES digit tiles against stored templates."""

    def __init__(self, template_dir: str):
        """Load digit templates from directory.

        Expects files named 0.png through 9.png, each 8x8 pixels.

        Args:
            template_dir: Path to directory containing digit template images.
        """
        self.templates: dict[int, np.ndarray] = {}
        self._template_grays: dict[int, np.ndarray] = {}

        if os.path.isdir(template_dir):
            for d in range(10):
                path = os.path.join(template_dir, f'{d}.png')
                if os.path.exists(path):
                    img = cv2.imread(path, cv2.IMREAD_COLOR)
                    if img is not None:
                        # Ensure 8x8
                        if img.shape[:2] != (8, 8):
                            img = cv2.resize(img, (8, 8),
                                             interpolation=cv2.INTER_NEAREST)
                        self.templates[d] = img
                        self._template_grays[d] = np.max(img, axis=2).astype(np.uint8)

    @property
    def template_grays(self) -> dict[int, np.ndarray]:
        """Grayscale (max-channel) digit templates keyed by digit value.

        Each template is an 8×8 uint8 array suitable for cv2.matchTemplate.
        Used by callers that need direct template sliding (e.g. multi-digit
        counter reading, dungeon level detection).
        """
        return self._template_grays

    def read_digit(self, tile: np.ndarray) -> int | None:
        """Match a single 8x8 tile against digit templates.

        Uses normalized cross-correlation (TM_CCOEFF_NORMED) on grayscale
        images for robustness against color palette variations between
        emulators, real hardware, and different stream capture setups.

        Args:
            tile: numpy array of shape (8, 8, 3) in BGR.

        Returns:
            Matched digit (0-9) or None if no confident match.
        """
        digit, _ = self.read_digit_with_score(tile)
        return digit

    def read_digit_with_score(self, tile: np.ndarray) -> tuple[int | None, float]:
        """Match a single 8x8 tile and return both the digit and match score.

        Exposes the normalized cross-correlation score alongside the digit so
        callers can distinguish a confident match (score ~0.7-0.9 on clean
        streams) from a low-confidence coincidental match (e.g. the hex "A"
        glyph matching "0" at ~0.58).

        Args:
            tile: numpy array of shape (8, 8, 3) in BGR.

        Returns:
            (digit, score) — digit is None (with raw best_score) when no
            template exceeds the 0.15 confidence threshold.
        """
        if not self.templates:
            return None, 0.0

        if tile.shape[:2] != (8, 8):
            tile = cv2.resize(tile, (8, 8), interpolation=cv2.INTER_NEAREST)

        # Use per-channel maximum instead of weighted grayscale.
        # Weighted grayscale (0.114*B + 0.587*G + 0.299*R) produces dark
        # values (~69) for blue-channel digits found in custom ROMs, making
        # NCC scores unreliable. Max-channel preserves full brightness for
        # any single-hue digit (blue, red, white) while keeping dark
        # backgrounds at 0 — the pattern is what matters, not the hue.
        tile_gray = np.max(tile, axis=2).astype(np.uint8)

        best_score = 0.0
        best_digit = None

        for digit, template in self.templates.items():
            tmpl_gray = self._template_grays.get(digit)
            if tmpl_gray is None:
                tmpl_gray = np.max(template, axis=2).astype(np.uint8)
                self._template_grays[digit] = tmpl_gray
            result = cv2.matchTemplate(tile_gray, tmpl_gray, cv2.TM_CCOEFF_NORMED)
            score = float(result[0][0])
            if score > best_score:
                best_score = score
                best_digit = digit

        # Confidence threshold — stream captures with non-integer resize
        # produce distorted tiles that score 0.2-0.4 even for correct matches.
        # Empty/dark tiles score near 0.0, so 0.15 safely separates digits.
        if best_score > 0.15 and best_digit is not None:
            return best_digit, best_score
        return None, best_score

    def has_templates(self) -> bool:
        """Check if digit templates are loaded."""
        return len(self.templates) > 0
