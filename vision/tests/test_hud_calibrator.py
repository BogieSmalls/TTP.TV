import pytest
from detector.hud_calibrator import CalibrationResult


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


def test_calibration_result_defaults_unlocked():
    result = CalibrationResult()
    assert result.locked is False
    assert result.confidence == 0.0
    assert result.source_frame == -1
