import os
import numpy as np
import pytest
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


def test_dungeon_map_bitmask_detected():
    """Blue cell backgrounds → dungeon_map_rooms bitmask set."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    frame = _make_frame()
    # Paint blue at dungeon minimap cell col=1,row=1 (1-based)
    # Minimap region: frame[13:45, 16:80]
    # Col1,Row1 in minimap region coords: x=0..8, y=0..4
    # In frame coords: x=16..24, y=13..17
    frame[13:17, 16:24, 0] = 200  # B channel (blue)
    frame[13:17, 16:24, 1] = 30
    frame[13:17, 16:24, 2] = 30
    result = mm.read(frame, screen_type='dungeon', dungeon_level=3)
    assert result.dungeon_map_rooms is not None
    assert result.dungeon_map_rooms > 0


def test_flashing_dot_detected_as_triforce_room():
    """Red dot present in one frame but not the previous = triforce room."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)

    # prev frame: bright Link dot at col1,row1; no red elsewhere
    prev = _make_frame()
    # Link dot in frame coords: y=15..17, x=20..22 (col1, row1 center)
    prev[15:17, 20:22, :] = 255   # Link dot at col1,row1

    # current frame: same Link dot + red dot at col2,row2
    curr = _make_frame()
    curr[15:17, 20:22, :] = 255   # Link dot
    # Red dot at col2,row2 in frame coords:
    # minimap region col2,row2 center: x=8+4=12, y=4+2=6
    # frame coords: y=13+6=19, x=16+12=28
    curr[19:21, 28:30, 2] = 220   # Red dot (triforce)
    curr[19:21, 28:30, 1] = 20
    curr[19:21, 28:30, 0] = 20

    mm._prev_frame = prev
    result = mm.read(curr, screen_type='dungeon', dungeon_level=3)
    assert result.triforce_room is not None


def test_l9_flashing_dot_is_zelda_room():
    """In dungeon_level=9, flashing dot is zelda_room not triforce_room."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    prev = _make_frame()
    prev[15:17, 20:22, :] = 255
    curr = _make_frame()
    curr[15:17, 20:22, :] = 255
    curr[19:21, 28:30, 2] = 220
    curr[19:21, 28:30, 1] = 20
    curr[19:21, 28:30, 0] = 20
    mm._prev_frame = prev
    result = mm.read(curr, screen_type='dungeon', dungeon_level=9)
    assert result.zelda_room is not None
    assert result.triforce_room is None


def test_load_ow_template_returns_array():
    """Loading C1_R1.jpg should return a numpy array if file exists."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal, overworld_rooms_dir='content/overworld_rooms')
    if not os.path.exists('content/overworld_rooms/C1_R1.jpg'):
        pytest.skip('overworld_rooms not present in test cwd')
    tmpl = mm._load_ow_template(col=1, row=1)
    assert tmpl is not None
    assert tmpl.shape[2] == 3  # BGR


def test_histogram_similarity_identical_images():
    """Same image compared to itself should score 1.0."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    img = np.random.randint(0, 255, (176, 256, 3), dtype=np.uint8)
    score = mm._histogram_similarity(img, img)
    assert score > 0.99


def test_histogram_similarity_different_images():
    """All-red vs all-blue should score well below match threshold.
    Note: score is ~0.33 because both share identical zero-green histograms."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    red = np.zeros((176, 256, 3), dtype=np.uint8)
    red[:, :, 2] = 255
    blue = np.zeros((176, 256, 3), dtype=np.uint8)
    blue[:, :, 0] = 255
    score = mm._histogram_similarity(red, blue)
    assert score < 0.5  # well below TILE_MATCH_THRESHOLD (0.80)
