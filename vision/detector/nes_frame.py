"""NESFrame — native-resolution NES crop wrapper.

All vision detectors receive an NESFrame instead of raw numpy arrays.
NESFrame handles the mapping from NES pixel coordinates (256x240 space)
to native stream coordinates (e.g. 1376x1080) and back.

Key methods:
  extract(nes_x, nes_y, w, h) -> 8x8 (or wxh) tile for template matching
  tile(col, row)               -> grid-aligned 8x8 tile
  region(nes_x, nes_y, w, h)   -> native-res pixels (no resize)
  game_area()                  -> below-HUD game area at native res
"""

import cv2
import numpy as np


class NESFrame:
    """Thin wrapper around a native-resolution NES game region crop.

    All detectors work with this instead of raw frames. The crop is the
    NES game region extracted from the full stream frame at native
    stream resolution (e.g. 1376x1080 for a 1920x1080 stream).

    Args:
        crop: Native-resolution BGR crop of the NES game region.
        scale_x: Native pixels per NES pixel (horizontal).
                 E.g. crop_w / 256.0
        scale_y: Native pixels per NES pixel (vertical).
                 E.g. crop_h / 240.0
        grid_dx: NES tile grid horizontal offset (0-7).
        grid_dy: NES tile grid vertical offset (0-7).
    """

    __slots__ = ('crop', 'scale_x', 'scale_y', 'grid_dx', 'grid_dy')

    def __init__(self, crop: np.ndarray, scale_x: float, scale_y: float,
                 grid_dx: int = 0, grid_dy: int = 0):
        self.crop = crop
        self.scale_x = scale_x
        self.scale_y = scale_y
        self.grid_dx = grid_dx
        self.grid_dy = grid_dy

    def extract(self, nes_x: int, nes_y: int,
                w: int = 8, h: int = 8) -> np.ndarray:
        """Extract a tile/sprite at NES coordinates, resized to (w, h).

        Maps NES pixel coordinates to native-resolution coordinates,
        extracts the region at native resolution, then resizes back to
        the requested size using nearest-neighbor interpolation.

        Args:
            nes_x: NES x coordinate (0-255).
            nes_y: NES y coordinate (0-239).
            w: Output width (default 8).
            h: Output height (default 8).

        Returns:
            BGR array of shape (h, w, 3).
        """
        crop = self.crop
        ch, cw = crop.shape[:2]

        sx = nes_x * self.scale_x
        sy = nes_y * self.scale_y
        sw = w * self.scale_x
        sh = h * self.scale_y

        sx1 = int(round(sx))
        sy1 = int(round(sy))
        sx2 = int(round(sx + sw))
        sy2 = int(round(sy + sh))

        sx1_c = max(0, sx1)
        sy1_c = max(0, sy1)
        sx2_c = min(cw, sx2)
        sy2_c = min(ch, sy2)

        if sy2_c <= sy1_c or sx2_c <= sx1_c:
            return np.zeros((h, w, 3), dtype=np.uint8)

        region = crop[sy1_c:sy2_c, sx1_c:sx2_c]

        if sx1 < 0 or sy1 < 0 or sx2 > cw or sy2 > ch:
            full_h = max(sy2 - sy1, 1)
            full_w = max(sx2 - sx1, 1)
            full = np.zeros((full_h, full_w, 3), dtype=np.uint8)
            dy_off = sy1_c - sy1
            dx_off = sx1_c - sx1
            full[dy_off:dy_off + region.shape[0],
                 dx_off:dx_off + region.shape[1]] = region
            region = full

        return cv2.resize(region, (w, h), interpolation=cv2.INTER_NEAREST)

    def tile(self, col: int, row: int) -> np.ndarray:
        """Extract a grid-aligned 8x8 tile. Applies grid offset automatically."""
        x = col * 8 + self.grid_dx
        y = row * 8 + self.grid_dy
        return self.extract(x, y, 8, 8)

    def region(self, nes_x: int, nes_y: int,
               nes_w: int, nes_h: int) -> np.ndarray:
        """Extract a region at native resolution (NO resize).

        Use where more pixels = better accuracy: brightness checks,
        color analysis, minimap scanning, death flash detection, etc.
        """
        crop = self.crop
        ch, cw = crop.shape[:2]

        sx1 = int(round(nes_x * self.scale_x))
        sy1 = int(round(nes_y * self.scale_y))
        sx2 = int(round((nes_x + nes_w) * self.scale_x))
        sy2 = int(round((nes_y + nes_h) * self.scale_y))

        sx1 = max(0, sx1)
        sy1 = max(0, sy1)
        sx2 = min(cw, sx2)
        sy2 = min(ch, sy2)

        if sy2 <= sy1 or sx2 <= sx1:
            out_h = max(1, int(round(nes_h * self.scale_y)))
            out_w = max(1, int(round(nes_w * self.scale_x)))
            return np.zeros((out_h, out_w, 3), dtype=np.uint8)

        return crop[sy1:sy2, sx1:sx2]

    def game_area(self) -> np.ndarray:
        """Below-HUD game area at native resolution (NES rows 64-239)."""
        hud_h = int(round(64 * self.scale_y))
        return self.crop[hud_h:]

    def game_area_canonical(self) -> np.ndarray:
        """Below-HUD game area resized to canonical 256x176."""
        ga = self.game_area()
        return cv2.resize(ga, (256, 176), interpolation=cv2.INTER_NEAREST)

    def scale_coord(self, nes_val: float, axis: str) -> int:
        """Scale a NES coordinate to native pixels."""
        if axis == 'x':
            return int(round(nes_val * self.scale_x))
        return int(round(nes_val * self.scale_y))

    def to_canonical(self) -> np.ndarray:
        """Resize to canonical 256x240 for display/debugging only."""
        return cv2.resize(self.crop, (256, 240),
                          interpolation=cv2.INTER_NEAREST)


def extract_nes_crop(stream_frame: np.ndarray,
                     crop_x: int, crop_y: int,
                     crop_w: int, crop_h: int) -> np.ndarray:
    """Extract the NES game region from a full stream frame.

    Handles negative crop coordinates by padding with black pixels.
    """
    fh, fw = stream_frame.shape[:2]
    sy1 = max(0, crop_y)
    sy2 = min(fh, crop_y + crop_h)
    sx1 = max(0, crop_x)
    sx2 = min(fw, crop_x + crop_w)

    result = np.zeros((crop_h, crop_w, 3), dtype=np.uint8)
    if sy2 > sy1 and sx2 > sx1:
        dy_off = sy1 - crop_y
        dx_off = sx1 - crop_x
        result[dy_off:dy_off + (sy2 - sy1),
               dx_off:dx_off + (sx2 - sx1)] = stream_frame[sy1:sy2, sx1:sx2]
    return result
