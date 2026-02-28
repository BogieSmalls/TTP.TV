import numpy as np
from detector.minimap_reader import MinimapReader, MinimapResult
from detector.hud_calibrator import HudCalibrator, CalibrationResult


def _make_locked_calibrator(life_y=40, rupee_y=19, key_y=35, bomb_y=43,
                             b_x=128, a_x=152) -> HudCalibrator:
    cal = HudCalibrator()
    cal.result = CalibrationResult(
        anchor_x=0.0, anchor_y=0.0, scale_x=1.0, scale_y=1.0,
        confidence=1.0, locked=True, source_frame=0)
    cal._anchors.life_y = life_y
    cal._anchors.rupee_row_y = rupee_y
    cal._anchors.key_row_y = key_y
    cal._anchors.bomb_row_y = bomb_y
    cal._anchors.b_item_x = b_x
    cal._anchors.a_item_x = a_x
    return cal


def test_minimap_reader_constructs():
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    assert mm is not None


def test_minimap_grid_cell_height():
    """cell_h = (bomb_y - rupee_y) / 6.0 = (43 - 19) / 6 = 4.0"""
    cal = _make_locked_calibrator(rupee_y=19, bomb_y=43)
    mm = MinimapReader(calibrator=cal)
    grid = mm._derive_grid()
    assert abs(grid['cell_h'] - 4.0) < 0.5


def test_minimap_grid_dungeon_cell_width():
    """Dungeon: 8 cols in 64px -> cell_w = 8.0"""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    grid = mm._derive_grid()
    assert abs(grid['cell_w_dungeon'] - 8.0) < 1.0


def test_minimap_grid_overworld_cell_width():
    """Overworld: 16 cols in 64px -> cell_w = 4.0"""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    grid = mm._derive_grid()
    assert abs(grid['cell_w_overworld'] - 4.0) < 1.0


def test_minimap_top_y_derived_from_rupee():
    """minimap_top_y = rupee_y - 1.5 * cell_h = 19 - 6 = 13"""
    cal = _make_locked_calibrator(rupee_y=19, bomb_y=43)
    mm = MinimapReader(calibrator=cal)
    grid = mm._derive_grid()
    assert abs(grid['minimap_top_y'] - 13.0) < 1.0


def _make_frame() -> np.ndarray:
    return np.zeros((240, 256, 3), dtype=np.uint8)


def test_detect_level_text_dungeon():
    """Non-black pixels in row 1 (y=8-15) indicate dungeon mode."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    frame = _make_frame()
    frame[8:16, 0:64, :] = 150  # LEVEL text
    assert mm._detect_level_text(frame) is not None


def test_detect_level_text_overworld():
    """No pixels in row 1 → overworld mode."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    assert mm._detect_level_text(_make_frame()) is None


def test_link_dot_detected_in_dungeon_minimap():
    """Bright dot in minimap → correct col/row returned."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    frame = _make_frame()
    # Paint bright dot at dungeon minimap col 2 row 1:
    # cell_w=8, cell_h=4, minimap_left=16, minimap_top=13
    # col2 center x = 16 + 8*1 + 4 = 28
    # row1 center y = 13 + 4*0 + 2 = 15
    frame[15:17, 28:30, :] = 255
    result = mm.read(frame, screen_type='dungeon', dungeon_level=2)
    assert result.mode == 'dungeon'
    assert result.col >= 1
    assert result.row >= 1
