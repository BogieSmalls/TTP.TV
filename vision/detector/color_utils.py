"""NES palette matching and color utility functions.

The NES has a fixed 64-color palette. Each game uses subsets of these colors.
Zelda 1 uses specific palette entries for different elements (hearts, items, etc.).
This module provides color matching with tolerance for analog/capture variations.
"""

import numpy as np


# NES Palette — approximate BGR values for colors commonly used in Zelda 1
NES_COLORS = {
    'black':      np.array([0, 0, 0], dtype=np.uint8),
    'white':      np.array([255, 255, 255], dtype=np.uint8),
    'red':        np.array([68, 36, 184], dtype=np.uint8),      # heart red
    'blue':       np.array([184, 68, 0], dtype=np.uint8),        # blue ring/candle
    'green':      np.array([0, 168, 0], dtype=np.uint8),         # overworld green
    'gold':       np.array([0, 168, 216], dtype=np.uint8),       # triforce gold (BGR)
    'brown':      np.array([0, 80, 120], dtype=np.uint8),        # dungeon walls
    'dark_blue':  np.array([100, 24, 0], dtype=np.uint8),        # dungeon floors
}


def color_distance(pixel: np.ndarray, reference: np.ndarray) -> float:
    """Euclidean distance between two BGR pixel values."""
    return float(np.sqrt(np.sum((pixel.astype(float) - reference.astype(float)) ** 2)))


def color_ratio(tile: np.ndarray, reference: np.ndarray,
                tolerance: float = 40.0) -> float:
    """Calculate ratio of pixels in tile that match reference color within tolerance.

    Args:
        tile: BGR image region (H, W, 3).
        reference: BGR target color (3,).
        tolerance: Maximum Euclidean distance to count as a match.

    Returns:
        Float 0.0-1.0, ratio of matching pixels.
    """
    if tile.size == 0:
        return 0.0

    diff = np.sqrt(np.sum(
        (tile.astype(float) - reference.astype(float)) ** 2,
        axis=2,
    ))
    matches = diff < tolerance
    return float(np.sum(matches)) / float(matches.size)


def dominant_channel(tile: np.ndarray) -> str:
    """Determine which BGR channel is dominant in a tile.

    Returns: 'blue', 'green', or 'red'.
    """
    means = [float(np.mean(tile[:, :, i])) for i in range(3)]
    channels = ['blue', 'green', 'red']
    return channels[int(np.argmax(means))]


def average_color(tile: np.ndarray) -> np.ndarray:
    """Compute the average BGR color of a tile."""
    return np.mean(tile.reshape(-1, 3), axis=0).astype(np.uint8)
