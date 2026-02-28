"""Tests for native-resolution support in InventoryReader SWAP detection."""
import numpy as np
import pytest
from detector.inventory_reader import InventoryReader


def _make_swap_frame(has_swap=True, scale_x=1.0, scale_y=1.0):
    """Frame with red SWAP text in top-left (or blank if has_swap=False)."""
    w = round(256 * scale_x)
    h = round(240 * scale_y)
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    if has_swap:
        # Red pixels in SWAP region: y=5-35, x=30-70 in NES coords
        y1 = round(5 * scale_y)
        y2 = round(35 * scale_y)
        x1 = round(30 * scale_x)
        x2 = round(70 * scale_x)
        frame[y1:y2, x1:x2] = [0, 0, 180]  # BGR red
    return frame


def test_swap_detected_at_canonical():
    reader = InventoryReader()
    frame = _make_swap_frame(has_swap=True)
    assert reader._is_z1r_swap(frame) is True


def test_no_swap_at_canonical():
    reader = InventoryReader()
    frame = _make_swap_frame(has_swap=False)
    assert reader._is_z1r_swap(frame) is False


def test_swap_detected_at_native_scale():
    reader = InventoryReader()
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_swap_frame(has_swap=True, scale_x=scale_x, scale_y=scale_y)
    reader.set_native_crop(frame, scale_x, scale_y)
    result = reader._is_z1r_swap(frame)
    reader.clear_native_crop()
    assert result is True


def test_no_swap_at_native_scale():
    reader = InventoryReader()
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_swap_frame(has_swap=False, scale_x=scale_x, scale_y=scale_y)
    reader.set_native_crop(frame, scale_x, scale_y)
    result = reader._is_z1r_swap(frame)
    reader.clear_native_crop()
    assert result is False


def test_clear_native_crop_restores_canonical():
    reader = InventoryReader()
    scale_x, scale_y = 960 / 256, 720 / 240
    native_frame = _make_swap_frame(has_swap=True, scale_x=scale_x, scale_y=scale_y)
    canonical_frame = _make_swap_frame(has_swap=True)

    reader.set_native_crop(native_frame, scale_x, scale_y)
    reader.clear_native_crop()
    # After clear, canonical frame should still work correctly
    assert reader._is_z1r_swap(canonical_frame) is True
