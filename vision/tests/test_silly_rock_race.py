"""Regression tests for HUD detection against silly-rock-8631 race frames.

Parses validation_silly_rock.json. For racers with stored crop profiles
(from the database), uses those directly. Falls back to calibrate_from_life_text()
for racers without profiles. Runs NesStateDetector.detect() and asserts against
hand-labeled expected values.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.nes_state import NesStateDetector
from detector.nes_frame import NESFrame
from detector.auto_crop import calibrate_from_life_text, find_grid_alignment

FRAMES_DIR = VISION_DIR.parent / "data" / "extracted-frames" / "silly-rock-8631-v2"
VALIDATION_JSON = VISION_DIR / "validation_silly_rock.json"
TEMPLATE_DIR = VISION_DIR / "templates"

GAMEPLAY_TYPES = {"overworld", "dungeon", "cave"}
CALIBRATION_CONFIDENCE_MIN = 0.3  # Below this → skip HUD assertions for that frame


# ─── Load validation data at collection time ─────────────────────────────────

def _load_validation():
    with open(VALIDATION_JSON) as f:
        return json.load(f)


_VALIDATION = _load_validation()

# Build parametrize list with per-racer xfail markers where appropriate.
# bort: crop aspect ratio is miscalibrated (670:535 ≠ 256:240), making 8px
#   tile template matching unreliable — digits land at non-standard x positions.
#   Exceptions: screen_type for finish frame and hearts for mid frame now pass
#   reliably via pixel-measured landmarks; those xfails have been promoted.
# blessedbe_: custom sprite ROM uses non-red hearts and blue digits where "0"
#   matches template "6" better than "0" — requires custom sprite support.
_XFAIL_REASONS: dict[str, str] = {
    "bort": "Miscalibrated aspect ratio",
    "blessedbe_": "Custom sprite ROMs not supported yet",
}

# Frame IDs that have been promoted to reliable PASS for specific tests.
# The per-racer xfail is suppressed for these (frame_id, test) combinations.
_SCREEN_TYPE_XFAIL_SKIP = {"bort_finish_73m00s_f003_jpg"}
_HEARTS_XFAIL_SKIP = {"bort_mid_30m00s_f003_jpg"}


def _build_frame_params(skip_xfail_for: set[str] | None = None):
    params = []
    for gf in _VALIDATION["golden_frames"]:
        frame_id = gf["file"].replace("/", "_").replace(".", "_")
        racer = gf.get("racer", "")
        reason = _XFAIL_REASONS.get(racer)
        if skip_xfail_for and frame_id in skip_xfail_for:
            reason = None
        marks = [pytest.mark.xfail(reason=reason, strict=False)] if reason else []
        params.append(pytest.param(frame_id, gf, marks=marks))
    return params


_FRAME_PARAMS = _build_frame_params()
_SCREEN_TYPE_PARAMS = _build_frame_params(skip_xfail_for=_SCREEN_TYPE_XFAIL_SKIP)
_HEARTS_PARAMS = _build_frame_params(skip_xfail_for=_HEARTS_XFAIL_SKIP)


# ─── Canonical extraction helpers ────────────────────────────────────────────

def _extract_from_profile(stream_frame: np.ndarray, profile: dict):
    """Extract 256x240 canonical frame using a stored crop profile.

    Scales crop coordinates from stored stream resolution to the actual
    extracted frame resolution (which may differ, e.g. 1920x1080 vs 1280x720).
    Then runs find_grid_alignment() on the canonical to get the correct
    life_row (and grid offset) if the stream has standard red LIFE text.

    Returns (canonical, grid_offset, life_row, landmarks).
    """
    fh, fw = stream_frame.shape[:2]
    cx, cy, cw, ch = profile["crop"]
    sw, sh = profile["stream_width"], profile["stream_height"]

    # Scale from stored stream resolution to actual frame resolution
    sx, sy = fw / sw, fh / sh
    cx2 = int(round(cx * sx))
    cy2 = int(round(cy * sy))
    cw2 = int(round(cw * sx))
    ch2 = int(round(ch * sy))

    # Extract region with black padding for negative-y crops
    region = np.zeros((ch2, cw2, 3), dtype=np.uint8)
    sy1 = max(0, cy2)
    sy2 = min(fh, cy2 + ch2)
    sx1 = max(0, cx2)
    sx2 = min(fw, cx2 + cw2)
    if sy2 > sy1 and sx2 > sx1:
        region[(sy1 - cy2):(sy1 - cy2) + (sy2 - sy1),
               (sx1 - cx2):(sx1 - cx2) + (sx2 - sx1)] = stream_frame[sy1:sy2, sx1:sx2]

    canonical = cv2.resize(region, (256, 240), interpolation=cv2.INTER_AREA)
    landmarks = profile.get("landmarks")

    # Try to find the actual LIFE text row via red-pixel scan (standard sprites).
    # This handles streams where the HUD doesn't land at the default life_row=5.
    alignment = find_grid_alignment(canonical)
    if alignment is not None:
        dx, dy, life_row = alignment
        return canonical, (dx, dy), life_row, landmarks

    # Alignment failed — custom sprites or non-standard stream. Fall back to the
    # profile's stored grid offset + default life_row. Landmark-based readers
    # don't depend on life_row, so detection still works for racers with landmarks.
    grid_offset = tuple(profile.get("grid_offset", [0, 0]))
    return canonical, grid_offset, 5, landmarks


def _extract_from_calibration(stream_frame: np.ndarray, expected_screen_type: str):
    """Extract canonical frame via calibrate_from_life_text() (fallback).

    Returns (canonical, grid_offset, None) or (None, None, None) on failure.
    """
    if expected_screen_type not in GAMEPLAY_TYPES:
        return None, None, None

    result = calibrate_from_life_text(stream_frame)
    if result is None:
        return None, None, None

    cx, cy, cw, ch = result["crop"]
    grid_offset = result["grid_offset"]
    confidence = result.get("confidence", 0.0)
    if confidence < CALIBRATION_CONFIDENCE_MIN:
        return None, None, None

    fh, fw = stream_frame.shape[:2]
    sy1, sy2 = max(0, cy), min(fh, cy + ch)
    sx1, sx2 = max(0, cx), min(fw, cx + cw)
    region = np.zeros((ch, cw, 3), dtype=np.uint8)
    if sy2 > sy1 and sx2 > sx1:
        region[(sy1 - cy):(sy1 - cy) + (sy2 - sy1),
               (sx1 - cx):(sx1 - cx) + (sx2 - sx1)] = stream_frame[sy1:sy2, sx1:sx2]

    canonical = cv2.resize(region, (256, 240), interpolation=cv2.INTER_AREA)
    return canonical, grid_offset, None


# ─── Module-scope fixture: run detection once per frame ──────────────────────

@pytest.fixture(scope="module")
def frame_results():
    """Load every stream frame, extract canonical, run detect() — one pass per frame."""
    profiles = _VALIDATION.get("crop_profiles", {})
    results = {}

    for gf in _VALIDATION["golden_frames"]:
        key = gf["file"].replace("/", "_").replace(".", "_")
        img_path = FRAMES_DIR / gf["file"]

        assert img_path.exists(), f"Missing frame: {img_path}"
        stream_frame = cv2.imread(str(img_path))
        assert stream_frame is not None, f"cv2.imread failed: {img_path}"

        exp = gf["expected"]
        racer = gf.get("racer", "")

        # Prefer stored crop profile for gameplay frames; fall back to auto-calibration.
        # Non-gameplay frames (subscreen, title, etc.) use calibration to preserve
        # existing skip behavior when HUD text is absent.
        canonical = None
        grid_offset = (0, 0)
        life_row = 5
        landmarks = None
        confidence = 0.0

        if racer in profiles and exp["screen_type"] in GAMEPLAY_TYPES:
            canonical, grid_offset, life_row, landmarks = _extract_from_profile(
                stream_frame, profiles[racer]
            )
            confidence = 1.0
        elif exp["screen_type"] in GAMEPLAY_TYPES:
            canonical, grid_offset, _ = _extract_from_calibration(
                stream_frame, exp["screen_type"]
            )
            if canonical is not None:
                confidence = CALIBRATION_CONFIDENCE_MIN  # meets threshold

        state = None
        if canonical is not None:
            dx, dy = grid_offset
            detector = NesStateDetector(
                template_dir=str(TEMPLATE_DIR),
                life_row=life_row,
                landmarks=landmarks,
            )
            nf = NESFrame(canonical, 1.0, 1.0, grid_dx=dx, grid_dy=dy)
            state = detector.detect(nf)

        results[key] = {
            "state": state,
            "expected": exp,
            "canonical": canonical,
            "grid_offset": grid_offset,
            "confidence": confidence,
            "file": gf["file"],
        }
    return results


# ─── Test 1: Screen type ─────────────────────────────────────────────────────

@pytest.mark.parametrize("frame_id,gf", _SCREEN_TYPE_PARAMS)
def test_screen_type(frame_results, frame_id, gf):
    r = frame_results[frame_id]
    exp_screen = r["expected"]["screen_type"]

    if r["state"] is None:
        pytest.skip(
            f"{r['file']}: calibration failed (conf={r['confidence']:.2f}) "
            f"or non-gameplay frame ({exp_screen}) — cannot assert screen_type"
        )

    assert r["state"].screen_type == exp_screen, (
        f"{r['file']}: screen_type expected={exp_screen!r}, "
        f"got={r['state'].screen_type!r} (crop conf={r['confidence']:.2f})"
    )


# ─── Test 2: Hearts ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("frame_id,gf", _HEARTS_PARAMS)
def test_hearts(frame_results, frame_id, gf):
    r = frame_results[frame_id]
    exp = r["expected"]

    if r["state"] is None or exp.get("hearts_current") is None:
        pytest.skip(f"{r['file']}: no hearts to assert")

    state = r["state"]
    exp_cur = exp["hearts_current"]
    exp_max = exp.get("hearts_max")

    assert abs(state.hearts_current - exp_cur) <= 1, (
        f"{r['file']}: hearts_current expected {exp_cur}±1, got {state.hearts_current}"
    )
    if exp_max is not None:
        assert abs(state.hearts_max - exp_max) <= 1, (
            f"{r['file']}: hearts_max expected {exp_max}±1, got {state.hearts_max}"
        )


# ─── Test 3: Rupees, keys, bombs ─────────────────────────────────────────────

@pytest.mark.parametrize("frame_id,gf", _FRAME_PARAMS)
def test_counters(frame_results, frame_id, gf):
    r = frame_results[frame_id]
    exp = r["expected"]

    if r["state"] is None or exp.get("rupees") is None:
        pytest.skip(f"{r['file']}: no counters to assert")

    state = r["state"]
    assert state.rupees == exp["rupees"], (
        f"{r['file']}: rupees expected {exp['rupees']}, got {state.rupees}"
    )
    if exp.get("keys") is not None:
        assert state.keys == exp["keys"], (
            f"{r['file']}: keys expected {exp['keys']}, got {state.keys}"
        )
        exp_master = exp.get("has_master_key", False)
        assert state.has_master_key == exp_master, (
            f"{r['file']}: has_master_key expected {exp_master}, got {state.has_master_key}"
        )
    if exp.get("bombs") is not None:
        assert state.bombs == exp["bombs"], (
            f"{r['file']}: bombs expected {exp['bombs']}, got {state.bombs}"
        )


# ─── Test 4: Dungeon level ────────────────────────────────────────────────────

@pytest.mark.parametrize("frame_id,gf", _FRAME_PARAMS)
def test_dungeon_level(frame_results, frame_id, gf):
    r = frame_results[frame_id]
    exp_lvl = r["expected"].get("dungeon_level")

    if r["state"] is None or exp_lvl is None:
        pytest.skip(f"{r['file']}: dungeon_level not asserted")

    assert r["state"].dungeon_level == exp_lvl, (
        f"{r['file']}: dungeon_level expected {exp_lvl}, got {r['state'].dungeon_level}"
    )


# ─── Test 5: B-item ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("frame_id,gf", _FRAME_PARAMS)
def test_b_item(frame_results, frame_id, gf):
    r = frame_results[frame_id]
    exp = r["expected"]
    exp_b = exp.get("b_item")

    # Only assert if b_item is explicitly specified (not null)
    if r["state"] is None or "b_item" not in exp or exp_b is None:
        pytest.skip(f"{r['file']}: b_item not asserted")

    assert r["state"].b_item == exp_b, (
        f"{r['file']}: b_item expected {exp_b!r}, got {r['state'].b_item!r}"
    )
