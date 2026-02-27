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

    def read_triforce(self, frame: np.ndarray) -> list[bool]:
        """Detect which triforce pieces are collected.

        Args:
            frame: 256x240 BGR NES frame (must be on subscreen).

        Returns:
            List of 8 booleans, one per dungeon (1-8).
        """
        # Step 1: Find -LIFE- text position (scroll anchor)
        life_y = self._find_life_y(frame)
        if life_y is None:
            return [False] * 8

        # Step 2: Define triforce scan region
        y_start = max(0, life_y - TRIFORCE_Y_OFFSET_MAX)
        y_end = max(0, life_y - TRIFORCE_Y_OFFSET_MIN)
        if y_end <= y_start:
            return [False] * 8

        # Step 3: Build gold pixel mask in the triforce region
        region = frame[y_start:y_end, TRIFORCE_X_START:TRIFORCE_X_END]
        if region.size == 0:
            return [False] * 8

        gold_mask = self._gold_mask(region)
        total_gold = int(np.sum(gold_mask))

        if total_gold < MIN_GOLD_PIXELS:
            return [False] * 8

        # Step 4: Find gold pixel X positions (relative to TRIFORCE_X_START)
        gold_ys, gold_xs = np.where(gold_mask)
        # Convert to absolute X coordinates
        abs_xs = gold_xs + TRIFORCE_X_START

        # Step 5: Count distinct gold clusters by X proximity
        # Sort X positions and split into clusters with gaps > 8px
        sorted_xs = np.sort(abs_xs)
        clusters = []
        cluster_start = sorted_xs[0]
        cluster_end = sorted_xs[0]
        cluster_count = 1

        for x in sorted_xs[1:]:
            if x - cluster_end <= 8:
                cluster_end = x
                cluster_count += 1
            else:
                if cluster_count >= 3:  # minimum pixels for a real piece
                    clusters.append((cluster_start + cluster_end) // 2)
                cluster_start = x
                cluster_end = x
                cluster_count = 1
        if cluster_count >= 3:
            clusters.append((cluster_start + cluster_end) // 2)

        # Step 6: Build result — mark pieces as collected based on cluster count
        # We know how many pieces are collected. For piece identification,
        # use the total count (more reliable than X-position mapping which
        # needs more calibration data).
        result = [False] * 8
        num_collected = len(clusters)

        # Store the cluster centers for potential future mapping
        self._last_cluster_centers = clusters
        self._last_num_collected = num_collected

        # Simple approach: set first N pieces to True based on count.
        # The game_logic validator's monotonic rule ensures pieces never
        # disappear, so even approximate placement works for tracking.
        # TODO: Use X-position mapping once we have all 8 piece positions calibrated.
        for i in range(min(num_collected, 8)):
            result[i] = True

        return result

    def _find_life_y(self, frame: np.ndarray) -> int | None:
        """Find the Y position of the -LIFE- text on the subscreen.

        Scans y=100..232 for red text at the standard LIFE column position.
        Returns the Y where strong red was first found, or None.
        """
        x = 22 * 8 + self.grid_dx
        if x + 8 > frame.shape[1]:
            return None

        for y in range(100, min(232, frame.shape[0] - 8)):
            tile = frame[y:y + 8, x:x + 8]
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
