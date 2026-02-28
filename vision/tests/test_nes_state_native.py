# vision/tests/test_nes_state_native.py
import numpy as np
import pytest
from detector.nes_state import NesStateDetector


def _make_native_dungeon_frame(crop_w=960, crop_h=720):
    """Full stream frame + crop params simulating a 960x720 game region."""
    stream = np.zeros((720, 1280, 3), dtype=np.uint8)
    crop_x, crop_y = 160, 0  # centered in 1280x720
    # Put red LIFE text at NES (177, 42) -> stream (160 + round(177*3.75), round(42*3.0))
    sx = crop_x + round(177 * (crop_w / 256))
    sy = crop_y + round(42  * (crop_h / 240))
    tw = max(1, round(8 * crop_w / 256))
    th = max(1, round(8 * crop_h / 240))
    stream[sy:sy + th, sx:sx + tw] = [0, 0, 200]
    # Dark game area
    game_y = crop_y + round(64 * crop_h / 240)
    stream[game_y:crop_y + crop_h, crop_x:crop_x + crop_w] = 20
    return stream, crop_x, crop_y, crop_w, crop_h


def test_set_native_frame_propagates_to_hud_reader():
    det = NesStateDetector('D:/Projects/Streaming/TTPRestream/vision/templates')
    stream, cx, cy, cw, ch = _make_native_dungeon_frame()
    det.set_native_frame(stream, cx, cy, cw, ch)
    assert det.hud_reader._stream_frame is not None
    assert det.hud_reader._scale_x == pytest.approx(cw / 256.0)
    det.clear_native_frame()
    assert det.hud_reader._stream_frame is None


def test_set_native_frame_propagates_to_screen_classifier():
    det = NesStateDetector('D:/Projects/Streaming/TTPRestream/vision/templates')
    stream, cx, cy, cw, ch = _make_native_dungeon_frame()
    det.set_native_frame(stream, cx, cy, cw, ch)
    assert det.screen_classifier._native_crop is not None
    assert det.screen_classifier._scale_x == pytest.approx(cw / 256.0)
    det.clear_native_frame()
    assert det.screen_classifier._native_crop is None
