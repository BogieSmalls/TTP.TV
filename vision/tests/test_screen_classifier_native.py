# vision/tests/test_screen_classifier_native.py
"""Tests for ScreenClassifier with NESFrame at various resolutions."""
import numpy as np
import pytest
from detector.screen_classifier import ScreenClassifier
from detector.nes_frame import NESFrame


def _make_canonical_dungeon_frame(grid_dx=1, grid_dy=2, life_row=5):
    """Create a 256x240 frame with red LIFE text and dark game area."""
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    # Dark game area (dungeon brightness)
    frame[64:, :] = 20
    # Red LIFE text at (22*8+dx, life_row*8+dy) = (177, 42) for dx=1,dy=2,row=5
    x = 22 * 8 + grid_dx
    y = life_row * 8 + grid_dy
    frame[y:y+8, x:x+8] = [0, 0, 200]  # BGR red
    return frame


def _scale_frame(frame, scale_x, scale_y):
    """Upscale a canonical frame to simulate native stream resolution."""
    import cv2
    h, w = frame.shape[:2]
    return cv2.resize(frame, (round(w * scale_x), round(h * scale_y)),
                      interpolation=cv2.INTER_NEAREST)


def test_classify_dungeon_at_canonical_resolution():
    """ScreenClassifier correctly identifies dungeon at 1:1 canonical scale."""
    clf = ScreenClassifier(life_row=5)
    canonical = _make_canonical_dungeon_frame()
    nf = NESFrame(canonical, 1.0, 1.0, grid_dx=1, grid_dy=2)
    assert clf.classify(nf) == 'dungeon'


def test_classify_dungeon_at_native_resolution():
    """ScreenClassifier correctly identifies dungeon at 3.75x3.0 native scale."""
    clf = ScreenClassifier(life_row=5)
    canonical = _make_canonical_dungeon_frame()
    scale_x, scale_y = 960 / 256, 720 / 240
    native = _scale_frame(canonical, scale_x, scale_y)
    nf = NESFrame(native, scale_x, scale_y, grid_dx=1, grid_dy=2)
    assert clf.classify(nf) == 'dungeon'


def test_classify_dark_frame_not_gameplay():
    """A fully black frame should not be classified as gameplay."""
    clf = ScreenClassifier(life_row=5)
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    nf = NESFrame(frame, 1.0, 1.0)
    result = clf.classify(nf)
    assert result not in ('overworld', 'dungeon', 'cave')
