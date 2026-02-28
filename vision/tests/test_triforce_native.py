# vision/tests/test_triforce_native.py
import numpy as np
import pytest
from detector.triforce_reader import TriforceReader


def _make_triforce_subscreen(life_y_nes=180, num_pieces=3, scale_x=1.0, scale_y=1.0):
    """Create a frame with LIFE text + N gold triforce clusters at native scale."""
    w = round(256 * scale_x)
    h = round(240 * scale_y)
    frame = np.zeros((h, w, 3), dtype=np.uint8)

    # Red LIFE text at life_y_nes scaled
    lx = round((22 * 8 + 1) * scale_x)
    ly = round(life_y_nes * scale_y)
    tw, th = max(1, round(8 * scale_x)), max(1, round(8 * scale_y))
    frame[ly:ly + th, lx:lx + tw] = [0, 0, 200]

    # Gold triforce clusters above LIFE
    piece_x_positions = [92, 110, 128]
    for px in piece_x_positions[:num_pieces]:
        cx = round(px * scale_x)
        cy = round((life_y_nes - 60) * scale_y)
        pw, ph = max(4, round(10 * scale_x)), max(4, round(10 * scale_y))
        frame[cy:cy + ph, cx:cx + pw] = [0, 150, 200]  # BGR orange/gold

    return frame


def test_triforce_at_canonical_scale():
    reader = TriforceReader(grid_offset=(1, 2))
    frame = _make_triforce_subscreen(num_pieces=3)
    result = reader.read_triforce(frame)
    assert sum(result) == 3


def test_triforce_at_native_scale_3x():
    """TriforceReader finds triforce pieces at 3x native scale."""
    reader = TriforceReader(grid_offset=(1, 2))
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_triforce_subscreen(num_pieces=2, scale_x=scale_x, scale_y=scale_y)
    reader.set_native_crop(frame, scale_x, scale_y)
    result = reader.read_triforce(frame)
    reader.clear_native_crop()
    assert sum(result) == 2


def test_triforce_clear_native_crop():
    reader = TriforceReader(grid_offset=(1, 2))
    frame = _make_triforce_subscreen(num_pieces=1, scale_x=3.75, scale_y=3.0)
    reader.set_native_crop(frame, 3.75, 3.0)
    reader.clear_native_crop()
    # After clear, should not crash on canonical input
    canonical = _make_triforce_subscreen(num_pieces=1)
    assert isinstance(reader.read_triforce(canonical), list)
