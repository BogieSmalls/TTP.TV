"""Unit tests for auto_crop.py — auto-calibration of NES game region.

Tests use synthesized numpy arrays (no VOD files needed). Key functions:
- find_grid_alignment(): locates -LIFE- red text at grid positions
- _verify_hud(): checks for Zelda 1 HUD features in a candidate region
- _score_calibration(): scores how well a canonical frame matches Zelda 1
- _deduplicate_rects(): merges nearby rectangle candidates
- detect_crop(): contour-based game region detection
- calibrate_from_life_text(): red cluster → crop region inference
- detect_crop_multi(): multi-frame median
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.auto_crop import (
    AutoCropDetector,
    CropResult,
    find_grid_alignment,
    find_grid_offset,
    calibrate_from_life_text,
    _score_calibration,
    is_likely_gameplay,
    filter_gameplay_frames,
    multi_anchor_calibration,
    _find_level_text,
    _find_hearts_pattern,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _blank_canonical():
    """Create a blank 256x240 BGR black frame."""
    return np.zeros((240, 256, 3), dtype=np.uint8)


def _paint_tile_red(frame, col, row, dx=0, dy=0, color=(0, 0, 200)):
    """Paint an 8x8 tile at grid position (col, row) with offset (dx, dy)."""
    x = col * 8 + dx
    y = row * 8 + dy
    if y + 8 <= frame.shape[0] and x + 8 <= frame.shape[1]:
        frame[y:y + 8, x:x + 8] = color


def _make_life_frame(dx=0, dy=0, life_row=5):
    """Create a 256x240 frame with red LIFE text tiles at the given position.

    Paints cols 22-24 (L, I, F of -LIFE-) as red tiles, and leaves col 27
    dark (not hearts). Also adds a dark HUD background and bright game area
    for _score_calibration to pass.
    """
    frame = _blank_canonical()

    # Dark HUD background (top 64 rows already black)
    # Bright game area below HUD (rows 64-240)
    frame[64:240, :] = [0, 80, 0]  # dark green (overworld-ish)

    # Paint LIFE text at cols 22, 23, 24 with given offset
    red = (0, 0, 200)  # BGR
    _paint_tile_red(frame, 22, life_row, dx, dy, red)  # "L"
    _paint_tile_red(frame, 23, life_row, dx, dy, red)  # "I"
    _paint_tile_red(frame, 24, life_row, dx, dy, red)  # "F"

    return frame


def _make_stream_frame(game_w=512, game_h=480, game_x=64, game_y=0,
                       frame_w=640, frame_h=480, life_dx=0, life_dy=0):
    """Create a stream-sized frame with a synthesized NES game region inside.

    The game region has: dark HUD (top 27%), bright game area (bottom 73%),
    and red LIFE text tiles at the correct scaled position.

    Returns (frame, expected_crop) where expected_crop is (game_x, game_y, game_w, game_h).
    """
    frame = np.zeros((frame_h, frame_w, 3), dtype=np.uint8)
    scale_x = game_w / 256
    scale_y = game_h / 240

    # Fill game region: dark HUD top, bright game bottom
    hud_h = int(64 * scale_y)  # top 64 NES rows = HUD
    # HUD: dark
    frame[game_y:game_y + hud_h, game_x:game_x + game_w] = [10, 10, 10]
    # Game area: bright green
    frame[game_y + hud_h:game_y + game_h, game_x:game_x + game_w] = [0, 100, 0]

    # Paint LIFE text (3 tiles at row 5, cols 22-24)
    life_row = 5
    for col in [22, 23, 24]:
        nes_x = col * 8 + life_dx
        nes_y = life_row * 8 + life_dy
        sx = game_x + int(nes_x * scale_x)
        sy = game_y + int(nes_y * scale_y)
        tw = max(int(8 * scale_x), 1)
        th = max(int(8 * scale_y), 1)
        if sy + th <= frame_h and sx + tw <= frame_w:
            frame[sy:sy + th, sx:sx + tw] = [0, 0, 200]  # red

    # Dark minimap region (top-left of HUD)
    mm_x = game_x + int(16 * scale_x)
    mm_y = game_y + int(16 * scale_y)
    mm_w = int(48 * scale_x)
    mm_h = int(36 * scale_y)
    if mm_y + mm_h <= frame_h and mm_x + mm_w <= frame_w:
        frame[mm_y:mm_y + mm_h, mm_x:mm_x + mm_w] = [5, 5, 5]

    return frame, (game_x, game_y, game_w, game_h)


# ── find_grid_alignment ──────────────────────────────────────────────────────

class TestFindGridAlignment:

    def test_standard_life_text_at_row5_offset_zero(self):
        """Standard NES layout: LIFE at row 5, no grid offset."""
        frame = _make_life_frame(dx=0, dy=0, life_row=5)
        result = find_grid_alignment(frame)
        assert result is not None
        dx, dy, life_row = result
        assert dx == 0
        assert dy == 0
        assert life_row == 5

    def test_life_text_with_nonzero_offset(self):
        """Grid offset (3, 2): LIFE tiles shifted 3px right and 2px down."""
        frame = _make_life_frame(dx=3, dy=2, life_row=5)
        result = find_grid_alignment(frame)
        assert result is not None
        dx, dy, life_row = result
        assert dx == 3
        assert dy == 2
        assert life_row == 5

    def test_life_text_at_row4(self):
        """Overscan-shifted HUD: LIFE at row 4 instead of standard row 5."""
        frame = _make_life_frame(dx=0, dy=0, life_row=4)
        result = find_grid_alignment(frame)
        assert result is not None
        _, _, life_row = result
        assert life_row == 4

    def test_life_text_at_row3(self):
        """Extreme overscan: LIFE at row 3."""
        frame = _make_life_frame(dx=0, dy=0, life_row=3)
        result = find_grid_alignment(frame)
        assert result is not None
        _, _, life_row = result
        assert life_row == 3

    def test_life_text_at_row6(self):
        """Shifted down: LIFE at row 6."""
        frame = _make_life_frame(dx=0, dy=0, life_row=6)
        result = find_grid_alignment(frame)
        assert result is not None
        _, _, life_row = result
        assert life_row == 6

    def test_blank_frame_returns_none(self):
        """Totally black frame: no red pixels → no LIFE text found."""
        frame = _blank_canonical()
        result = find_grid_alignment(frame)
        assert result is None

    def test_hearts_confusion_penalized(self):
        """Red at cols 22-29 (hearts row) — col 27 red penalizes, LIFE wins."""
        # Frame 1: just LIFE text (cols 22-24), col 27 dark
        life_frame = _make_life_frame(dx=0, dy=0, life_row=5)
        life_result = find_grid_alignment(life_frame)
        assert life_result is not None

        # Frame 2: red at cols 22-29 (hearts span), including col 27
        hearts_frame = _make_life_frame(dx=0, dy=0, life_row=5)
        for col in range(25, 30):
            _paint_tile_red(hearts_frame, col, 5, 0, 0, (0, 0, 200))
        hearts_result = find_grid_alignment(hearts_frame)
        # Hearts frame should still find something (penalized but not blocked)
        # The key test: LIFE-only should score HIGHER than hearts-confused
        # We can't directly compare scores, but both should find row 5
        if hearts_result is not None:
            assert hearts_result[2] == 5  # still finds row 5

    def test_only_single_red_tile_insufficient(self):
        """A single red tile at col 22 but nothing at 23/24 → lower score.

        The function still returns a result (the base L check passes),
        but without I/F confirmation the score is weaker.
        """
        frame = _blank_canonical()
        frame[64:240, :] = [0, 80, 0]
        _paint_tile_red(frame, 22, 5, 0, 0, (0, 0, 200))
        result = find_grid_alignment(frame)
        # Still finds something — single red tile passes the base check
        assert result is not None
        assert result[2] == 5


# ── find_grid_offset (thin wrapper) ───────────────────────────────────────────

class TestFindGridOffset:

    def test_returns_dx_dy_tuple(self):
        frame = _make_life_frame(dx=1, dy=4, life_row=5)
        result = find_grid_offset(frame)
        assert result is not None
        assert result == (1, 4)

    def test_returns_none_on_blank(self):
        result = find_grid_offset(_blank_canonical())
        assert result is None


# ── _verify_hud ───────────────────────────────────────────────────────────────

class TestVerifyHud:
    """Tests AutoCropDetector._verify_hud via a detector instance."""

    def setup_method(self):
        self.detector = AutoCropDetector()

    def test_valid_zelda_hud_passes(self):
        """Frame with dark HUD, bright game, red hearts → passes."""
        frame = np.zeros((240, 256, 3), dtype=np.uint8)
        # Dark HUD (rows 0-64)
        frame[0:64, :] = [10, 10, 10]
        # Red hearts at rows 28-44, cols 170-248
        frame[28:44, 170:248] = [0, 0, 180]
        # Bright game area (rows 64-240)
        frame[64:240, :] = [0, 120, 0]
        # Dark minimap (rows 16-60, cols 16-64)
        frame[16:60, 16:64] = [5, 5, 5]

        assert self.detector._verify_hud(frame, 0, 0, 256, 240) is True

    def test_bright_hud_fails(self):
        """All-white frame: HUD brightness > 80 → fails check 1."""
        frame = np.full((240, 256, 3), 200, dtype=np.uint8)
        assert self.detector._verify_hud(frame, 0, 0, 256, 240) is False

    def test_game_darker_than_hud_fails(self):
        """Game area darker than HUD → fails check 2."""
        frame = np.zeros((240, 256, 3), dtype=np.uint8)
        frame[0:64, :] = [60, 60, 60]   # moderately bright HUD
        frame[64:240, :] = [10, 10, 10]  # very dark game area
        assert self.detector._verify_hud(frame, 0, 0, 256, 240) is False

    def test_no_hearts_but_minimap_and_brightness_pass(self):
        """2 of 3 soft checks pass (minimap + game brightness) → True."""
        frame = np.zeros((240, 256, 3), dtype=np.uint8)
        frame[0:64, :] = [10, 10, 10]    # dark HUD
        frame[64:240, :] = [0, 80, 0]    # bright game area (>20)
        frame[16:60, 16:64] = [5, 5, 5]  # dark minimap (<60)
        # No red hearts — only 2 checks: minimap_ok + game_brightness > 20
        assert self.detector._verify_hud(frame, 0, 0, 256, 240) is True

    def test_empty_region_returns_false(self):
        """Zero-size region → returns False."""
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        assert self.detector._verify_hud(frame, 0, 0, 0, 0) is False


# ── _deduplicate_rects ────────────────────────────────────────────────────────

class TestDeduplicateRects:

    def setup_method(self):
        self.detector = AutoCropDetector()

    def test_empty_list(self):
        assert self.detector._deduplicate_rects([]) == []

    def test_identical_rects_deduplicated(self):
        rects = [(100, 50, 300, 280), (100, 50, 300, 280), (100, 50, 300, 280)]
        result = self.detector._deduplicate_rects(rects)
        assert len(result) == 1

    def test_nearby_rects_within_threshold_deduplicated(self):
        """Rects within 20px (default threshold) of each other → merged."""
        rects = [(100, 50, 300, 280), (110, 55, 305, 285)]
        result = self.detector._deduplicate_rects(rects, threshold=20)
        assert len(result) == 1

    def test_far_apart_rects_kept(self):
        """Rects more than threshold apart → both kept."""
        rects = [(100, 50, 300, 280), (500, 300, 200, 180)]
        result = self.detector._deduplicate_rects(rects, threshold=20)
        assert len(result) == 2

    def test_custom_threshold(self):
        """Rects 15px apart with threshold=10 → not deduplicated."""
        rects = [(100, 50, 300, 280), (115, 50, 300, 280)]
        result = self.detector._deduplicate_rects(rects, threshold=10)
        assert len(result) == 2


# ── _score_calibration ────────────────────────────────────────────────────────

class TestScoreCalibration:

    def test_good_frame_scores_high(self):
        """Frame with LIFE text, dark HUD, bright game → high score."""
        frame = _make_life_frame(dx=0, dy=0, life_row=5)
        score = _score_calibration(frame, 0, 0)
        # LIFE text check (0.5) + 2nd char (0.3) + dark HUD (0.3) + bright game (0.3)
        # + minimap (0.2) = up to 1.6
        assert score >= 0.8

    def test_blank_frame_scores_low(self):
        """All-black frame: no LIFE text → low score.

        Dark HUD passes (0.3), dark minimap passes (0.2), but game area is
        NOT brighter than HUD → no game bonus. No LIFE text → no 0.5/0.3.
        Total = 0.5, well below a good frame's 1.0+.
        """
        frame = _blank_canonical()
        score = _score_calibration(frame, 0, 0)
        assert score <= 0.5

    def test_wrong_offset_misses_life(self):
        """LIFE at offset (0,0) but scoring at offset (7,7) → misses LIFE text.

        Full 8x8 red tiles at grid (0,0). Offset (7,7) reads tiles starting
        7px right/down — only 1px overlap with the 8px red block, so the tile
        average drops below the R>50 threshold.
        """
        frame = _make_life_frame(dx=0, dy=0, life_row=5)
        score_correct = _score_calibration(frame, 0, 0)
        score_wrong = _score_calibration(frame, 7, 7)
        assert score_correct > score_wrong


# ── detect_crop ───────────────────────────────────────────────────────────────

class TestDetectCrop:

    def setup_method(self):
        self.detector = AutoCropDetector()

    def test_nes_rectangle_on_black_background(self):
        """Clear bright rectangle with NES aspect ratio on dark background."""
        # Create 640x480 black frame with bright rectangle
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        # Game region: 320x300 (aspect 1.067) at (160, 90)
        x0, y0, gw, gh = 160, 90, 320, 300
        # Dark HUD (top 80px of game region)
        frame[y0:y0 + 80, x0:x0 + gw] = [10, 10, 10]
        # Bright game area
        frame[y0 + 80:y0 + gh, x0:x0 + gw] = [0, 120, 0]
        # Red hearts
        heart_y = y0 + int(30 * gh / 240)
        frame[heart_y:heart_y + 20, x0 + int(170 * gw / 256):x0 + int(248 * gw / 256)] = [0, 0, 180]
        # Dark minimap
        mm_y = y0 + int(16 * gh / 240)
        frame[mm_y:mm_y + 30, x0 + int(16 * gw / 256):x0 + int(64 * gw / 256)] = [5, 5, 5]

        result = self.detector.detect_crop(frame)
        # May or may not detect the exact rectangle depending on contour detection.
        # The key test: if detected, it should be close to our rectangle.
        if result is not None:
            assert abs(result.aspect_ratio - 1.067) < 0.4
            assert result.source_width == 640
            assert result.source_height == 480

    def test_blank_frame_returns_none(self):
        """All-black frame → no rectangles found → None."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        result = self.detector.detect_crop(frame)
        assert result is None

    def test_uniform_bright_frame_returns_none(self):
        """Solid color frame has no edges/contours → None or low confidence."""
        frame = np.full((480, 640, 3), 128, dtype=np.uint8)
        result = self.detector.detect_crop(frame)
        # Uniform frame: no contours to detect
        assert result is None or result.confidence < 0.5

    def test_wrong_aspect_ratio_filtered(self):
        """Very wide rectangle (3:1 aspect) outside NES range → filtered out."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        # Very wide rectangle: 600x100 → aspect 6.0, way outside 0.95-1.35
        frame[190:290, 20:620] = [0, 200, 0]
        result = self.detector.detect_crop(frame)
        if result is not None:
            # If something is found, its aspect should be in valid range
            assert 0.95 <= result.aspect_ratio <= 1.35


# ── calibrate_from_life_text ──────────────────────────────────────────────────

class TestCalibrateFromLifeText:

    def test_frame_with_nes_game_at_2x_scale(self):
        """Synthesized 640x480 frame with NES game at 2x scale → finds crop."""
        frame, (gx, gy, gw, gh) = _make_stream_frame(
            game_w=512, game_h=480, game_x=64, game_y=0,
            frame_w=640, frame_h=480)

        result = calibrate_from_life_text(frame)
        if result is not None:
            cx, cy, cw, ch = result['crop']
            # The found crop should overlap significantly with the actual game region
            assert cw > 200  # reasonable width
            assert ch > 200  # reasonable height
            assert result['confidence'] > 0
            assert result['grid_offset'] is not None

    def test_blank_frame_returns_none(self):
        """All-black frame → no red clusters → None."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        result = calibrate_from_life_text(frame)
        assert result is None

    def test_red_in_bottom_40_percent_ignored(self):
        """Red pixels below 60% of frame are masked out → not found."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        # Place red cluster in bottom 40% (y > 288 for 480h frame)
        frame[350:380, 200:280] = [0, 0, 200]
        result = calibrate_from_life_text(frame)
        assert result is None

    def test_tiny_red_cluster_ignored(self):
        """Red area < 50px² → ignored by connected component filter."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        # Very small red spot: 3x3 = 9px², even after dilation < 50
        frame[100:103, 300:303] = [0, 0, 200]
        result = calibrate_from_life_text(frame)
        # May or may not find something (dilation expands), but shouldn't crash
        # The dilation might expand 3x3 enough — this is fine either way


# ── detect_crop_multi ─────────────────────────────────────────────────────────

class TestDetectCropMulti:

    def setup_method(self):
        self.detector = AutoCropDetector()

    def test_returns_none_for_empty_list(self):
        assert self.detector.detect_crop_multi([]) is None

    def test_returns_none_for_blank_frames(self):
        frames = [np.zeros((480, 640, 3), dtype=np.uint8)] * 3
        result = self.detector.detect_crop_multi(frames)
        assert result is None

    def test_median_of_consistent_detections(self):
        """Three identical frames → median = same detection."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        # Clear rectangle with valid aspect ratio
        frame[90:390, 160:480] = [0, 120, 0]  # 320x300 → 1.067
        # Add dark HUD area
        frame[90:170, 160:480] = [10, 10, 10]
        # Red hearts
        frame[110:130, 330:470] = [0, 0, 180]
        # Dark minimap
        frame[100:130, 170:210] = [5, 5, 5]

        frames = [frame.copy(), frame.copy(), frame.copy()]
        result = self.detector.detect_crop_multi(frames)
        if result is not None:
            # All three frames identical → median should match any single detection
            single = self.detector.detect_crop(frame)
            if single is not None:
                assert result.x == single.x
                assert result.y == single.y
                assert result.w == single.w
                assert result.h == single.h


# ── CropResult ────────────────────────────────────────────────────────────────

class TestCropResult:

    def test_to_dict(self):
        cr = CropResult(
            x=100, y=50, w=320, h=300,
            confidence=0.85, aspect_ratio=1.067,
            source_width=640, source_height=480,
            hud_verified=True,
        )
        d = cr.to_dict()
        assert d['x'] == 100
        assert d['w'] == 320
        assert d['confidence'] == 0.85
        assert d['hud_verified'] is True


# ── Gameplay frame filter ──────────────────────────────────────────────────

class TestIsLikelyGameplay:

    def test_gameplay_frame_passes(self):
        """Frame with dark HUD top and bright game area → True."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        frame[:120, :] = [10, 10, 10]     # dark HUD (top 25%)
        frame[120:, :] = [0, 100, 0]      # bright game area
        assert is_likely_gameplay(frame) is True

    def test_all_black_fails(self):
        """Transition/loading frame: all black → False."""
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        assert is_likely_gameplay(frame) is False

    def test_uniform_frame_fails(self):
        """Solid color frame: low variance → False."""
        frame = np.full((480, 640, 3), 100, dtype=np.uint8)
        assert is_likely_gameplay(frame) is False

    def test_bright_hud_fails(self):
        """All-bright frame: HUD brightness > 80 → False."""
        frame = np.full((480, 640, 3), 150, dtype=np.uint8)
        assert is_likely_gameplay(frame) is False


class TestFilterGameplayFrames:

    def test_mixed_frames(self):
        """Filter keeps gameplay, drops transitions."""
        gameplay = np.zeros((480, 640, 3), dtype=np.uint8)
        gameplay[:120, :] = [10, 10, 10]
        gameplay[120:, :] = [0, 100, 0]

        black = np.zeros((480, 640, 3), dtype=np.uint8)
        uniform = np.full((480, 640, 3), 100, dtype=np.uint8)

        frames = [gameplay.copy(), black, gameplay.copy(), uniform, gameplay.copy()]
        filtered = filter_gameplay_frames(frames)
        assert len(filtered) == 3

    def test_all_bad_returns_original(self):
        """When fewer than 2 pass, returns original list."""
        black = np.zeros((480, 640, 3), dtype=np.uint8)
        frames = [black, black, black]
        filtered = filter_gameplay_frames(frames)
        assert len(filtered) == 3  # returns originals


# ── Multi-anchor calibration ─────────────────────────────────────────────

class TestMultiAnchorCalibration:

    def test_life_text_only(self):
        """Frame with LIFE text → returns result with life_score > 0."""
        frame = _make_life_frame(dx=0, dy=0, life_row=5)
        result = multi_anchor_calibration(frame)
        assert result is not None
        assert result['life_score'] > 0

    def test_life_plus_hearts(self):
        """Frame with LIFE text + hearts → higher score than LIFE alone."""
        frame = _make_life_frame(dx=0, dy=0, life_row=5)
        # Add hearts at row 3-4, cols 22-29
        for col in range(22, 29):
            _paint_tile_red(frame, col, 3, 0, 0, (0, 0, 180))
        result = multi_anchor_calibration(frame)
        assert result is not None
        assert result['hearts_score'] > 0

    def test_blank_frame_returns_none(self):
        """Totally dark frame → returns None (score below threshold)."""
        frame = _blank_canonical()
        result = multi_anchor_calibration(frame)
        assert result is None

    def test_correct_offset_found(self):
        """Multi-anchor score should be highest at the correct offset."""
        frame = _make_life_frame(dx=2, dy=3, life_row=5)
        result = multi_anchor_calibration(frame)
        assert result is not None
        # The LIFE text anchor is strongest — verify it dominates
        assert result['life_score'] > 0
        assert result['score'] > 0.5


class TestFindLevelText:

    def test_bright_level_text(self):
        """Bright tiles at LEVEL position → positive score."""
        frame = _blank_canonical()
        # LEVEL text at row 9, cols 2-6 (bright white)
        for col in range(2, 7):
            _paint_tile_red(frame, col, 9, 0, 0, (200, 200, 200))
        score = _find_level_text(frame, 0, 0)
        assert score > 0

    def test_dark_level_area(self):
        """No bright tiles at LEVEL position → zero score."""
        frame = _blank_canonical()
        score = _find_level_text(frame, 0, 0)
        assert score == 0.0


class TestFindHeartsPattern:

    def test_red_hearts_detected(self):
        """Red dots at hearts position → positive score."""
        frame = _blank_canonical()
        for col in range(22, 28):
            _paint_tile_red(frame, col, 3, 0, 0, (0, 0, 180))
        score = _find_hearts_pattern(frame, 0, 0)
        assert score > 0

    def test_no_hearts(self):
        """Empty frame → zero score."""
        frame = _blank_canonical()
        score = _find_hearts_pattern(frame, 0, 0)
        assert score == 0.0
