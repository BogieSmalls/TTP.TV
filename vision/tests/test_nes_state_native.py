# vision/tests/test_nes_state_native.py
"""Tests for NesStateDetector with NESFrame at native resolution.

Replaces old tests that tested set_native_frame/clear_native_frame
propagation to sub-detectors. With NESFrame, all detectors receive
the NESFrame directly via detect(nf).
"""
import numpy as np
import pytest
from detector.nes_state import NesStateDetector, GameState
from detector.nes_frame import NESFrame, extract_nes_crop


def _make_native_nes_region(crop_w=960, crop_h=720):
    """Create a native-resolution NES region with red LIFE text and dark game area."""
    region = np.zeros((crop_h, crop_w, 3), dtype=np.uint8)
    scale_x = crop_w / 256.0
    scale_y = crop_h / 240.0
    # Red LIFE text at NES (177, 42)
    sx = round(177 * scale_x)
    sy = round(42 * scale_y)
    tw = max(1, round(8 * scale_x))
    th = max(1, round(8 * scale_y))
    region[sy:sy + th, sx:sx + tw] = [0, 0, 200]
    # Dark game area
    game_y = round(64 * scale_y)
    region[game_y:, :] = 20
    return region, scale_x, scale_y


def test_detect_with_native_nesframe():
    """NesStateDetector.detect() works with a native-resolution NESFrame."""
    det = NesStateDetector()
    region, sx, sy = _make_native_nes_region()
    nf = NESFrame(region, sx, sy)
    state = det.detect(nf)
    assert isinstance(state, GameState)
    # Should detect as gameplay (LIFE text present)
    assert state.screen_type in ('overworld', 'dungeon', 'cave')


def test_detect_with_canonical_nesframe():
    """NesStateDetector.detect() works with a 256x240 canonical NESFrame."""
    det = NesStateDetector()
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    nf = NESFrame(frame, 1.0, 1.0)
    state = det.detect(nf)
    assert isinstance(state, GameState)


def test_extract_nes_crop_basic():
    """extract_nes_crop extracts the correct region from a stream frame."""
    stream = np.full((720, 1280, 3), 128, dtype=np.uint8)
    crop = extract_nes_crop(stream, 160, 0, 960, 720)
    assert crop.shape == (720, 960, 3)
    assert np.all(crop == 128)


def test_extract_nes_crop_negative_y_pads():
    """Negative crop_y pads with black pixels instead of wrapping."""
    stream = np.full((720, 1280, 3), 128, dtype=np.uint8)
    crop = extract_nes_crop(stream, 160, -25, 960, 720)
    assert crop.shape == (720, 960, 3)
    # First 25 rows should be black padding
    assert np.all(crop[:25, :] == 0)
    # Remaining rows should carry stream content
    assert np.any(crop[25:, :] > 0)


def test_detect_returns_all_gamestate_fields():
    """detect() returns GameState with all expected fields."""
    det = NesStateDetector()
    region, sx, sy = _make_native_nes_region()
    nf = NESFrame(region, sx, sy)
    state = det.detect(nf)
    assert hasattr(state, 'screen_type')
    assert hasattr(state, 'dungeon_level')
    assert hasattr(state, 'hearts_current')
    assert hasattr(state, 'rupees')
    assert hasattr(state, 'keys')
    assert hasattr(state, 'bombs')
    assert hasattr(state, 'b_item')
    assert hasattr(state, 'map_position')
    assert hasattr(state, 'dungeon_map_rooms')
    assert hasattr(state, 'triforce_room')
