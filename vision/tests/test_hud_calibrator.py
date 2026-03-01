import numpy as np
from detector.hud_calibrator import CalibrationResult, HudCalibrator
from detector.hud_reader import HudReader
from detector.nes_frame import NESFrame


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


def test_detect_life_text_threshold_boundary():
    """Exactly 5 red pixels (below threshold of 6) returns None."""
    cal = HudCalibrator()
    frame = _make_frame()
    frame[40, 176:181, 2] = 220  # 5 pixels, R channel
    frame[40, 176:181, 1] = 20
    frame[40, 176:181, 0] = 20
    assert cal._detect_life_text(frame) == (None, None)


def test_detect_life_text_six_pixels_found():
    """Exactly 6 red pixels (at threshold) is detected."""
    cal = HudCalibrator()
    frame = _make_frame()
    frame[40, 176:182, 2] = 220  # 6 pixels, R channel
    frame[40, 176:182, 1] = 20
    frame[40, 176:182, 0] = 20
    life_y, life_h = cal._detect_life_text(frame)
    assert life_y == 40
    assert life_h == 1


def test_detect_life_text_ratio_filter_rejects_orange():
    """Bright pixels that fail the R > G*2 ratio do not trigger detection."""
    cal = HudCalibrator()
    frame = _make_frame()
    # r=80, g=60: r > 50 passes but r > g*2 (80 < 120) fails → should return None
    frame[40:48, 176:200, 2] = 80   # R
    frame[40:48, 176:200, 1] = 60   # G (too high — fails ratio)
    frame[40:48, 176:200, 0] = 10   # B
    assert cal._detect_life_text(frame) == (None, None)


def test_detect_gameplay_boundary():
    """First non-black row below HUD should be detected."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint colored game area starting at y=68 (slightly offset)
    frame[68:, :, 1] = 80  # green tint in game area
    boundary_y = cal._detect_gameplay_boundary(frame, life_y=40)
    assert boundary_y is not None
    assert 68 <= boundary_y <= 72


def test_detect_b_a_borders():
    """Blue border pixels at B and A item positions should be found."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint blue at B-item left border (x≈128, y=16-31)
    frame[16:32, 128:130, 0] = 200  # B channel (index 0 in BGR)
    frame[16:32, 128:130, 1] = 20
    frame[16:32, 128:130, 2] = 20
    # Paint blue at A-item left border (x≈152, y=24-39)
    frame[24:40, 152:154, 0] = 200
    frame[24:40, 152:154, 1] = 20
    frame[24:40, 152:154, 2] = 20
    b_x, a_x = cal._detect_b_a_borders(frame)
    assert b_x is not None and 126 <= b_x <= 130
    assert a_x is not None and 150 <= a_x <= 154


def test_detect_digit_rows():
    """Bright pixel rows at rupee/key/bomb positions should be found."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint bright white at digit row positions
    frame[16:24, 96:130, :] = 200   # rupee digits
    frame[32:40, 100:134, :] = 200  # key digits
    frame[40:48, 100:134, :] = 200  # bomb digits
    rupee_y, key_y, bomb_y = cal._detect_digit_rows(frame)
    assert rupee_y is not None and 16 <= rupee_y <= 24
    assert key_y is not None and 32 <= key_y <= 40
    assert bomb_y is not None and 40 <= bomb_y <= 48


def test_detect_minimap_gray_rect():
    """Mid-gray rectangle in minimap region should be detected."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint gray at minimap position (x=16-79, y=12-52)
    frame[12:52, 16:80, :] = 110
    rect = cal._detect_minimap_gray_rect(frame)
    assert rect is not None
    x, y, w, h = rect
    assert abs(x - 16) <= 4
    assert abs(y - 12) <= 4
    assert abs(w - 64) <= 4  # full minimap width ≈ 64px
    assert abs(h - 40) <= 4  # full minimap height ≈ 40px


def _make_gameplay_frame() -> np.ndarray:
    """Frame with all HUD anchors present at standard NES positions."""
    frame = _make_frame()
    # LIFE text (red, x=176-199, y=40-47)
    frame[40:48, 176:200, 2] = 220
    frame[40:48, 176:200, 1] = 20
    frame[40:48, 176:200, 0] = 20
    # Gameplay area (bright below y=64)
    frame[64:, :, 1] = 80
    # B-item blue border (x=128, y=16-31)
    frame[16:32, 128:130, 0] = 200
    frame[16:32, 128:130, 1] = 20
    frame[16:32, 128:130, 2] = 20
    # A-item blue border (x=152, y=24-39)
    frame[24:40, 152:154, 0] = 200
    frame[24:40, 152:154, 1] = 20
    frame[24:40, 152:154, 2] = 20
    # Digit rows bright (rupee y=16-23, key y=32-39, bomb y=40-47)
    frame[16:24, 96:130, :] = 200
    frame[32:40, 100:134, :] = 200
    frame[40:48, 100:134, :] = 200
    return frame


def test_calibrate_single_high_confidence_frame_locks():
    """A frame with all anchors should produce confidence > 0.85 and lock."""
    cal = HudCalibrator()
    frame = _make_gameplay_frame()
    cal.calibrate(frame, frame_num=1)
    assert cal.result.locked is True
    assert cal.result.confidence >= 0.85
    assert cal.result.source_frame == 1


def test_calibrate_dark_frame_does_not_lock():
    """A black frame has no anchors; confidence stays low, no lock."""
    cal = HudCalibrator()
    cal.calibrate(_make_frame(), frame_num=1)
    assert cal.result.locked is False
    assert cal.result.confidence < 0.85


def test_calibrate_once_locked_stays_locked():
    """Once locked, subsequent calls do not change the locked result."""
    cal = HudCalibrator()
    frame = _make_gameplay_frame()
    cal.calibrate(frame, frame_num=1)
    assert cal.result.locked
    scale_x_before = cal.result.scale_x
    cal.calibrate(frame, frame_num=2)
    assert cal.result.scale_x == scale_x_before  # unchanged


def test_calibrate_scale_y_from_life_glyph():
    """With life_h=8, scale_y should be exactly 1.0."""
    cal = HudCalibrator()
    frame = _make_gameplay_frame()
    cal.calibrate(frame, frame_num=1)
    assert 0.9 <= cal.result.scale_y <= 1.1


def test_calibrate_gameplay_frames_seen_increments_post_lock():
    """After locking, each calibrate() call increments _gameplay_frames_seen."""
    cal = HudCalibrator()
    cal.calibrate(_make_gameplay_frame(), frame_num=1)
    assert cal.result.locked
    assert cal._gameplay_frames_seen == 0  # first post-lock call hasn't happened yet
    cal.calibrate(_make_gameplay_frame(), frame_num=2)
    assert cal._gameplay_frames_seen == 1
    cal.calibrate(_make_gameplay_frame(), frame_num=3)
    assert cal._gameplay_frames_seen == 2


def test_calibrate_spot_check_emits_warning_on_drift(caplog):
    """After SPOT_CHECK_INTERVAL post-lock frames, a drifted LIFE text logs a warning."""
    import logging as _logging
    from detector.hud_calibrator import SPOT_CHECK_INTERVAL, DRIFT_WARNING_PX

    cal = HudCalibrator()
    cal.calibrate(_make_gameplay_frame(), frame_num=1)
    assert cal.result.locked

    # Build a drifted frame: LIFE text moved down by DRIFT_WARNING_PX + 2 pixels
    drift_offset = DRIFT_WARNING_PX + 2
    drifted = _make_gameplay_frame()
    # Shift LIFE text pixels down: clear original position, repaint lower
    drifted[40:48, 176:200, :] = 0  # clear original LIFE text
    drifted[40 + drift_offset:48 + drift_offset, 176:200, 2] = 220
    drifted[40 + drift_offset:48 + drift_offset, 176:200, 1] = 20
    drifted[40 + drift_offset:48 + drift_offset, 176:200, 0] = 20

    # Call calibrate SPOT_CHECK_INTERVAL times post-lock with the drifted frame
    with caplog.at_level(_logging.WARNING, logger='detector.hud_calibrator'):
        for i in range(SPOT_CHECK_INTERVAL):
            cal.calibrate(drifted, frame_num=i + 2)

    assert any('drifted' in record.message.lower() for record in caplog.records)


def test_hud_reader_accepts_calibrator():
    """HudReader can be constructed with a calibrator param."""
    cal = HudCalibrator()
    reader = HudReader(calibrator=cal)
    assert reader is not None


def test_read_hearts_uses_calibrated_life_y():
    """With a locked calibrator, heart rows derive from life_y, not landmark."""
    cal = HudCalibrator()
    # Manually lock with life_y=40 (standard NES position)
    cal.result = CalibrationResult(
        anchor_x=0.0, anchor_y=0.0, scale_x=1.0, scale_y=1.0,
        confidence=1.0, locked=True, source_frame=0)
    cal._anchors.life_y = 40

    reader = HudReader(calibrator=cal)
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    # Paint 3 full hearts at heart row 1 (y=32-39, x=176-199)
    # heart_row1 = life_y - 8 = 40 - 8 = 32
    frame[32:40, 176:199, 2] = 200  # red (BGR channel 2)
    frame[32:40, 176:199, 1] = 30
    frame[32:40, 176:199, 0] = 30
    nf = NESFrame(frame, 1.0, 1.0)
    cur, max_h, half = reader.read_hearts(nf)
    # Should detect at least some hearts (not 0)
    assert cur >= 1
