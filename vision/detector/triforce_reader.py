"""Triforce reader for NES Zelda 1 subscreen.

Detects which of the 8 triforce pieces have been collected by scanning
for gold/orange pixel clusters in the triforce triangle display area.

The subscreen scroll position varies, so we first locate the "-LIFE-"
text as an anchor and compute the triforce region relative to it.

All coordinates are for the canonical 256x240 NES frame.
"""

import numpy as np


# Minimum number of gold pixels to consider a cluster as a collected piece
MIN_GOLD_PIXELS = 15

# The triforce region is located ABOVE the -LIFE- text by this offset range.
# Measured from subscreen screenshots: gold pieces are 50-90 pixels above LIFE.
TRIFORCE_Y_OFFSET_MIN = 45   # closest to LIFE
TRIFORCE_Y_OFFSET_MAX = 100  # farthest from LIFE

# X range of the triforce triangle on the subscreen
TRIFORCE_X_START = 85
TRIFORCE_X_END = 170

# Approximate X center positions for each of the 8 triforce pieces.
# Measured from known subscreen frames:
#   L3 (piece 3): center_x ≈ 105
#   L8 (piece 8): center_x ≈ 137
# The 8 pieces are arranged in a triangular grid within x=85..170.
# Mapping is approximate — we use X bins to identify piece index.
# Pieces are numbered 1-8 (dungeons 1-8), stored as indices 0-7.
PIECE_X_BINS = [
    (92, 110),    # piece index 0 (dungeon 1) — leftmost
    (110, 122),   # piece index 1 (dungeon 2)
    (97, 115),    # piece index 2 (dungeon 3) — verified: center_x≈105
    (122, 135),   # piece index 3 (dungeon 4) — center
    (85, 100),    # piece index 4 (dungeon 5) — far left
    (135, 148),   # piece index 5 (dungeon 6)
    (128, 145),   # piece index 6 (dungeon 7)
    (130, 150),   # piece index 7 (dungeon 8) — verified: center_x≈137
]


class TriforceReader:
    """Read triforce pieces from the NES Zelda 1 subscreen.

    Uses a dynamic scanning approach:
    1. Find the "-LIFE-" text Y position (scroll anchor)
    2. Define the triforce region relative to LIFE
    3. Find gold/orange pixel clusters
    4. Count total collected pieces
    """

    def __init__(self, grid_offset: tuple[int, int] = (1, 2)):
        self.grid_dx, self.grid_dy = grid_offset
        self._native_crop: np.ndarray | None = None
        self._scale_x: float = 1.0
        self._scale_y: float = 1.0

    def set_native_crop(self, crop_frame: np.ndarray,
                        scale_x: float, scale_y: float) -> None:
        """Provide the native-resolution crop for this frame."""
        self._native_crop = crop_frame
        self._scale_x = scale_x
        self._scale_y = scale_y

    def clear_native_crop(self) -> None:
        self._native_crop = None

    def _af(self, canonical: np.ndarray) -> np.ndarray:
        return self._native_crop if self._native_crop is not None else canonical

    def _s(self, v: float, axis: str) -> int:
        """Scale a NES pixel value along 'x' or 'y' axis."""
        if self._native_crop is None:
            return int(v)
        return round(v * (self._scale_x if axis == 'x' else self._scale_y))

    def read_triforce(self, frame: np.ndarray) -> list[bool]:
        """Detect which triforce pieces are collected.

        Args:
            frame: 256x240 BGR NES frame (must be on subscreen).

        Returns:
            List of 8 booleans, one per dungeon (1-8).
        """
        src = self._af(frame)
        life_y = self._find_life_y(frame)
        if life_y is None:
            return [False] * 8

        y_start = max(0, life_y - self._s(TRIFORCE_Y_OFFSET_MAX, 'y'))
        y_end   = max(0, life_y - self._s(TRIFORCE_Y_OFFSET_MIN, 'y'))
        x_start = self._s(TRIFORCE_X_START, 'x')
        x_end   = self._s(TRIFORCE_X_END, 'x')

        if y_end <= y_start or x_end <= x_start:
            return [False] * 8

        region = src[y_start:y_end, x_start:x_end]
        if region.size == 0:
            return [False] * 8

        gold_mask = self._gold_mask(region)
        total_gold = int(np.sum(gold_mask))
        if total_gold < MIN_GOLD_PIXELS:
            return [False] * 8

        gold_ys, gold_xs = np.where(gold_mask)
        abs_xs = gold_xs + x_start   # absolute X in src frame

        sorted_xs = np.sort(abs_xs)
        gap_threshold = max(8, self._s(8, 'x'))
        min_cluster_pixels = max(3, round(3 * max(self._scale_x, self._scale_y)))

        clusters = []
        cluster_start = int(sorted_xs[0])
        cluster_end   = int(sorted_xs[0])
        cluster_count = 1
        for x in sorted_xs[1:]:
            # Use strict < so two clusters separated by exactly gap_threshold pixels
            # remain distinct — triforce pieces at max separation are still separate items.
            if x - cluster_end < gap_threshold:
                cluster_end = int(x)
                cluster_count += 1
            else:
                if cluster_count >= min_cluster_pixels:
                    clusters.append((cluster_start + cluster_end) // 2)
                cluster_start = int(x)
                cluster_end   = int(x)
                cluster_count = 1
        if cluster_count >= min_cluster_pixels:
            clusters.append((cluster_start + cluster_end) // 2)

        self._last_cluster_centers = clusters
        self._last_num_collected = len(clusters)

        result = [False] * 8
        for i in range(min(len(clusters), 8)):
            result[i] = True
        return result

    def _find_life_y(self, frame: np.ndarray) -> int | None:
        """Find the Y position of the -LIFE- text on the subscreen.

        Scans y=100..232 for red text at the standard LIFE column position.
        Returns the Y where strong red was first found, or None.
        """
        src = self._af(frame)
        x  = self._s(22 * 8 + self.grid_dx, 'x')
        tw = max(1, self._s(8, 'x'))
        th = max(1, self._s(8, 'y'))
        y_start = self._s(100, 'y')
        y_end   = min(self._s(232, 'y'), src.shape[0] - th)
        if x + tw > src.shape[1]:
            return None
        for y in range(y_start, y_end):
            tile = src[y:y + th, x:x + tw]
            avg = np.mean(tile, axis=(0, 1))
            r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
            if r > 50 and r > g * 2 and r > b * 2:
                return y
        return None

    @staticmethod
    def _gold_mask(region: np.ndarray) -> np.ndarray:
        """Create a boolean mask of gold/orange pixels in a BGR region.

        Matches warm gold/orange tones: high red, medium green, low blue.
        This is more robust than strict Euclidean distance from a single
        reference color, handling JPEG compression and palette variation.
        """
        r = region[:, :, 2].astype(np.int16)
        g = region[:, :, 1].astype(np.int16)
        b = region[:, :, 0].astype(np.int16)

        return (r > 150) & (g > 80) & (b < 70) & (r > g)
