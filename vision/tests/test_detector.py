"""Golden-frame regression tests for NesStateDetector."""
from pathlib import Path

import pytest

GOLDEN_FRAMES_DIR = Path(__file__).parent / "golden_frames"
GAMEPLAY_TYPES = {"overworld", "dungeon", "cave"}

# Discover frame names at collection time so parametrize works cleanly
_FRAME_NAMES = sorted(
    p.stem
    for p in GOLDEN_FRAMES_DIR.glob("*.png")
    if (GOLDEN_FRAMES_DIR / f"{p.stem}.json").exists()
)


def _get_frame(golden_frames, name):
    for gf in golden_frames:
        if gf["name"] == name:
            return gf
    return None


# ---------------------------------------------------------------------------
# test_screen_classification
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("frame_name", _FRAME_NAMES)
def test_screen_classification(detector, golden_frames, frame_name):
    """Screen type matches baseline for every golden frame."""
    gf = _get_frame(golden_frames, frame_name)
    assert gf is not None, f"Frame {frame_name!r} not in golden_frames fixture"
    state = detector.detect(gf["frame"])
    expected_type = gf["expected"]["screen_type"]
    assert state.screen_type == expected_type, (
        f"{frame_name}: expected {expected_type!r}, got {state.screen_type!r}"
    )


# ---------------------------------------------------------------------------
# test_hud_present
# ---------------------------------------------------------------------------

def test_hud_present_gameplay(detector, golden_frames):
    """Gameplay frames (overworld/dungeon/cave) are classified as gameplay."""
    gameplay = [gf for gf in golden_frames if gf["expected"]["screen_type"] in GAMEPLAY_TYPES]
    assert gameplay, "No gameplay golden frames found"
    for gf in gameplay:
        state = detector.detect(gf["frame"])
        assert state.screen_type in GAMEPLAY_TYPES, (
            f"{gf['name']}: expected gameplay screen_type, got {state.screen_type!r}"
        )


def test_hud_present_non_gameplay(detector, golden_frames):
    """Non-gameplay frames are not classified as gameplay types."""
    non_gameplay = [gf for gf in golden_frames if gf["expected"]["screen_type"] not in GAMEPLAY_TYPES]
    assert non_gameplay, "No non-gameplay golden frames found"
    for gf in non_gameplay:
        state = detector.detect(gf["frame"])
        assert state.screen_type not in GAMEPLAY_TYPES, (
            f"{gf['name']}: expected non-gameplay screen_type, got {state.screen_type!r}"
        )


# ---------------------------------------------------------------------------
# test_hearts_reading
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("frame_name", _FRAME_NAMES)
def test_hearts_reading(detector, golden_frames, frame_name):
    """Hearts current and max are within ±1 of baseline on gameplay frames."""
    gf = _get_frame(golden_frames, frame_name)
    assert gf is not None, f"Frame {frame_name!r} not in golden_frames fixture"
    expected = gf["expected"]
    if "hearts_current" not in expected:
        pytest.skip(f"{frame_name}: no hearts expected (non-gameplay frame)")
    state = detector.detect(gf["frame"])
    exp_cur = expected["hearts_current"]
    exp_max = expected["hearts_max"]
    assert abs(state.hearts_current - exp_cur) <= 1, (
        f"{frame_name}: hearts_current expected {exp_cur} ±1, got {state.hearts_current}"
    )
    assert abs(state.hearts_max - exp_max) <= 1, (
        f"{frame_name}: hearts_max expected {exp_max} ±1, got {state.hearts_max}"
    )


# ---------------------------------------------------------------------------
# test_keys_bombs_reading
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("frame_name", _FRAME_NAMES)
def test_keys_bombs_reading(detector, golden_frames, frame_name):
    """Keys and bombs match baseline exactly on frames that specify them."""
    gf = _get_frame(golden_frames, frame_name)
    assert gf is not None, f"Frame {frame_name!r} not in golden_frames fixture"
    expected = gf["expected"]
    if "keys" not in expected and "bombs" not in expected:
        pytest.skip(f"{frame_name}: no keys/bombs expected")
    state = detector.detect(gf["frame"])
    if "keys" in expected:
        assert state.keys == expected["keys"], (
            f"{frame_name}: keys expected {expected['keys']}, got {state.keys}"
        )
    if "bombs" in expected:
        assert state.bombs == expected["bombs"], (
            f"{frame_name}: bombs expected {expected['bombs']}, got {state.bombs}"
        )
