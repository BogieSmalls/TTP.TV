import numpy as np
from detector.hud_calibrator import CalibrationResult, HudCalibrator


def _make_frame() -> np.ndarray:
    """Return a black 240x256x3 frame (BGR)."""
    return np.zeros((240, 256, 3), dtype=np.uint8)


def test_nes_to_px_identity():
    """With anchor_x=0, anchor_y=0, scale=1.0, NES coords = pixel coords."""
    result = CalibrationResult(anchor_x=0.0, anchor_y=0.0, scale_x=1.0, scale_y=1.0)
    assert result.nes_to_px(0, 0) == (0, 0)
    assert result.nes_to_px(128, 120) == (128, 120)


def test_nes_to_px_with_scale():
    """scale_x=2.0, scale_y=3.0 doubles/triples coordinates."""
    result = CalibrationResult(anchor_x=0.0, anchor_y=0.0, scale_x=2.0, scale_y=3.0)
    assert result.nes_to_px(10, 10) == (20, 30)


def test_nes_to_px_with_offset():
    """anchor_y=5 shifts all y results by 5."""
    result = CalibrationResult(anchor_x=0.0, anchor_y=5.0, scale_x=1.0, scale_y=1.0)
    assert result.nes_to_px(0, 0) == (0, 5)
    assert result.nes_to_px(10, 40) == (10, 45)


def test_nes_to_px_combined_scale_and_offset():
    """Scale and offset applied together: anchor + nes_coord * scale."""
    result = CalibrationResult(anchor_x=10.0, anchor_y=20.0, scale_x=4.0, scale_y=3.0)
    # x: 10 + 5*4 = 30.  y: 20 + 8*3 = 44
    assert result.nes_to_px(5, 8) == (30, 44)


def test_calibration_result_defaults_unlocked():
    result = CalibrationResult()
    assert result.locked is False
    assert result.confidence == 0.0
    assert result.source_frame == -1


def test_detect_life_text_finds_red_cluster():
    """Red pixel cluster at LIFE position should be found."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint red pixels at LIFE position: x=176-199, y=40-47
    # Note: OpenCV uses BGR order
    frame[40:48, 176:200, 2] = 220  # R channel (index 2 in BGR)
    frame[40:48, 176:200, 1] = 20   # G channel (low)
    frame[40:48, 176:200, 0] = 20   # B channel (low)
    life_y, life_h = cal._detect_life_text(frame)
    assert life_y is not None
    assert 38 <= life_y <= 42  # within 2px of actual
    assert 6 <= life_h <= 10   # within 2px of 8


def test_detect_life_text_returns_none_on_dark_frame():
    cal = HudCalibrator()
    frame = _make_frame()
    life_y, life_h = cal._detect_life_text(frame)
    assert life_y is None
    assert life_h is None
