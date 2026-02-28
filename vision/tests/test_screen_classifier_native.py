# vision/tests/test_screen_classifier_native.py
import numpy as np
import pytest
from detector.screen_classifier import ScreenClassifier


def _make_canonical_dungeon_frame(grid_dx=1, grid_dy=2, life_row=5):
    """Create a 256×240 frame with red LIFE text and dark game area."""
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


def test_classify_dungeon_at_native_resolution():
    """ScreenClassifier correctly identifies dungeon at 3.75×3.0 scale."""
    clf = ScreenClassifier(grid_offset=(1, 2), life_row=5)
    canonical = _make_canonical_dungeon_frame()
    # Simulate a 960×720 native crop (typical 4:3 1280×720 stream)
    scale_x, scale_y = 960 / 256, 720 / 240
    native = _scale_frame(canonical, scale_x, scale_y)
    clf.set_native_crop(native, scale_x, scale_y)
    result = clf.classify(canonical)  # canonical still passed, native overrides reads
    clf.clear_native_crop()
    assert result == 'dungeon'


def test_classify_without_native_still_works():
    """When no native crop is set, classify() uses the canonical frame as before."""
    clf = ScreenClassifier(grid_offset=(1, 2), life_row=5)
    canonical = _make_canonical_dungeon_frame()
    assert clf.classify(canonical) == 'dungeon'


def test_native_crop_cleared_after_clear():
    """After clear_native_crop(), uses canonical frame."""
    clf = ScreenClassifier(grid_offset=(1, 2), life_row=5)
    canonical = _make_canonical_dungeon_frame()
    native = _scale_frame(canonical, 3.75, 3.0)
    clf.set_native_crop(native, 3.75, 3.0)
    clf.clear_native_crop()
    # Should still work with canonical (no crash, correct result)
    assert clf.classify(canonical) == 'dungeon'
