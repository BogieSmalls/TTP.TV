"""Tests for InventoryReader SWAP detection with NESFrame."""
import numpy as np
import pytest
from detector.inventory_reader import InventoryReader
from detector.nes_frame import NESFrame


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
    nf = NESFrame(frame, 1.0, 1.0)
    assert reader._is_z1r_swap(nf) is True


def test_no_swap_at_canonical():
    reader = InventoryReader()
    frame = _make_swap_frame(has_swap=False)
    nf = NESFrame(frame, 1.0, 1.0)
    assert reader._is_z1r_swap(nf) is False


def test_swap_detected_at_native_scale():
    reader = InventoryReader()
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_swap_frame(has_swap=True, scale_x=scale_x, scale_y=scale_y)
    nf = NESFrame(frame, scale_x, scale_y)
    assert reader._is_z1r_swap(nf) is True


def test_no_swap_at_native_scale():
    reader = InventoryReader()
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_swap_frame(has_swap=False, scale_x=scale_x, scale_y=scale_y)
    nf = NESFrame(frame, scale_x, scale_y)
    assert reader._is_z1r_swap(nf) is False
