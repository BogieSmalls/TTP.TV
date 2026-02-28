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
