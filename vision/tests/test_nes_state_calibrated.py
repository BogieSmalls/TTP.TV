# vision/tests/test_nes_state_calibrated.py
"""Tests for NesStateDetector wiring of HudCalibrator, MinimapReader,
PlayerItemTracker and RaceItemTracker, plus new GameState fields."""

import numpy as np
from detector.nes_state import NesStateDetector, GameState


def test_gamestate_has_new_fields():
    gs = GameState()
    assert hasattr(gs, 'dungeon_map_rooms')
    assert hasattr(gs, 'triforce_room')
    assert hasattr(gs, 'zelda_room')
    assert hasattr(gs, 'tile_match_id')
    assert hasattr(gs, 'tile_match_score')


def test_gamestate_new_field_defaults():
    gs = GameState()
    assert gs.dungeon_map_rooms is None
    assert gs.triforce_room is None
    assert gs.zelda_room is None
    assert gs.tile_match_id is None
    assert gs.tile_match_score == 0.0


def test_nes_state_detector_constructs_with_calibrator():
    det = NesStateDetector()
    assert hasattr(det, 'calibrator')
    assert hasattr(det, 'minimap')
    assert hasattr(det, 'player_items')
    assert hasattr(det, 'race_items')


def test_detect_returns_gamestate_with_new_fields():
    det = NesStateDetector()
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    state = det.detect(frame)
    assert isinstance(state, GameState)
    assert state.dungeon_map_rooms is None or isinstance(state.dungeon_map_rooms, int)


def test_calibrator_is_shared_with_hud_reader():
    """HudCalibrator instance should be the same object in both detector and hud_reader."""
    det = NesStateDetector()
    assert det.calibrator is det.hud_reader._calibrator


def test_calibrator_is_shared_with_minimap():
    """HudCalibrator instance should be the same object in both detector and minimap."""
    det = NesStateDetector()
    assert det.calibrator is det.minimap._calibrator
