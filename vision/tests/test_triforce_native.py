# vision/tests/test_triforce_native.py
"""Tests for TriforceReader with NESFrame at various resolutions."""
import numpy as np
import pytest
from detector.triforce_reader import TriforceReader
from detector.nes_frame import NESFrame


def _make_triforce_subscreen(life_y_nes=180, num_pieces=3, scale_x=1.0, scale_y=1.0):
    """Create a frame with LIFE text + N gold triforce clusters at given scale."""
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
    reader = TriforceReader()
    frame = _make_triforce_subscreen(num_pieces=3)
    nf = NESFrame(frame, 1.0, 1.0, grid_dx=1, grid_dy=2)
    result = reader.read_triforce(nf)
    assert sum(result) == 3


def test_triforce_at_native_scale_3x():
    """TriforceReader finds triforce pieces at 3x native scale."""
    reader = TriforceReader()
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_triforce_subscreen(num_pieces=2, scale_x=scale_x, scale_y=scale_y)
    nf = NESFrame(frame, scale_x, scale_y, grid_dx=1, grid_dy=2)
    result = reader.read_triforce(nf)
    assert sum(result) == 2


def test_triforce_canonical_returns_list():
    """read_triforce always returns a list of booleans."""
    reader = TriforceReader()
    frame = _make_triforce_subscreen(num_pieces=1)
    nf = NESFrame(frame, 1.0, 1.0, grid_dx=1, grid_dy=2)
    result = reader.read_triforce(nf)
    assert isinstance(result, list)
