"""Tests for GanonDetector — sprite-based Ganon detection in D9."""

import os

import cv2
import numpy as np
import pytest

from detector.ganon_detector import GanonDetector
from detector.nes_frame import NESFrame

TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), '..', 'templates', 'enemies')


@pytest.fixture(scope='module')
def ganon_detector():
    return GanonDetector(TEMPLATE_DIR)


def _nf(frame):
    """Wrap a 256x240 canonical frame as NESFrame at 1:1 scale."""
    return NESFrame(frame, 1.0, 1.0)


def _make_frame(screen_type='dungeon'):
    """Create a blank 256x240 NES frame.

    Dungeon frames have a dark game area (below HUD row 64).
    Overworld frames are brighter.
    """
    if screen_type == 'dungeon':
        frame = np.zeros((240, 256, 3), dtype=np.uint8)
        # Dim dungeon floor
        frame[64:] = 20
    else:
        frame = np.full((240, 256, 3), 80, dtype=np.uint8)
    return frame


def _place_ganon(frame, template_dir, template_name='ganon_blue1', x=100, y=80):
    """Composite a Ganon template onto a frame at game-area position (x, y)."""
    path = os.path.join(template_dir, f'{template_name}.png')
    tmpl = cv2.imread(path, cv2.IMREAD_COLOR)
    assert tmpl is not None, f'Failed to load {path}'

    result = frame.copy()
    th, tw = tmpl.shape[:2]
    fy = y + 64  # game area offset
    gray = cv2.cvtColor(tmpl, cv2.COLOR_BGR2GRAY)
    mask = gray > 10  # non-black pixels
    result[fy:fy + th, x:x + tw][mask] = tmpl[mask]
    return result


class TestGanonDetection:
    """Core detection tests."""

    def test_detects_ganon_in_d9(self, ganon_detector):
        """Blue Ganon sprite in D9 should be detected."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue1', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'dungeon', 9) is True

    def test_detects_ganon_blue2(self, ganon_detector):
        """Second animation frame should also match."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue2', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'dungeon', 9) is True

    def test_detects_ganon_blue3(self, ganon_detector):
        """Third animation frame should also match."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue3', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'dungeon', 9) is True

    def test_detects_ganon_red(self, ganon_detector):
        """Red (hit-flash) Ganon should be detected."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_red1', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'dungeon', 9) is True


class TestGanonGuards:
    """Guard conditions that should prevent detection."""

    def test_skips_non_d9_dungeon(self, ganon_detector):
        """Ganon should not be detected in dungeons other than D9."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue1', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'dungeon', 5) is False

    def test_skips_overworld(self, ganon_detector):
        """Ganon should not be detected on overworld."""
        frame = _make_frame('overworld')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue1', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'overworld', 0) is False

    def test_skips_cave(self, ganon_detector):
        """Ganon should not be detected in caves."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue1', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'cave', 9) is False

    def test_empty_d9_no_ganon(self, ganon_detector):
        """Empty D9 room should not detect Ganon."""
        frame = _make_frame('dungeon')
        assert ganon_detector.detect(_nf(frame), 'dungeon', 9) is False

    def test_subscreen_skipped(self, ganon_detector):
        """Subscreen should not trigger detection."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue1', x=112, y=80)
        assert ganon_detector.detect(_nf(frame), 'subscreen', 9) is False


class TestGanonEdgeCases:
    """Edge cases and robustness."""

    def test_missing_template_dir(self):
        """Detector with missing template dir should return False gracefully."""
        det = GanonDetector('/nonexistent/path')
        frame = _make_frame('dungeon')
        assert det.detect(_nf(frame), 'dungeon', 9) is False

    def test_ganon_at_different_positions(self, ganon_detector):
        """Ganon at various game-area positions should be detected."""
        for x, y in [(50, 40), (150, 100), (200, 60)]:
            frame = _make_frame('dungeon')
            frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue1', x=x, y=y)
            assert ganon_detector.detect(_nf(frame), 'dungeon', 9) is True, \
                f'Failed to detect Ganon at ({x}, {y})'

    def test_noisy_frame(self, ganon_detector):
        """Ganon should be detected even with mild noise (Twitch compression)."""
        frame = _make_frame('dungeon')
        frame = _place_ganon(frame, TEMPLATE_DIR, 'ganon_blue1', x=112, y=80)
        # Add mild noise (simulates compression artifacts)
        noise = np.random.randint(-10, 11, frame.shape, dtype=np.int16)
        noisy = np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        assert ganon_detector.detect(_nf(noisy), 'dungeon', 9) is True
