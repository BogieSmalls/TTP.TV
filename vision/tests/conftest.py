"""Pytest fixtures for vision detector tests."""
import json
import sys
from pathlib import Path

import cv2
import pytest

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.nes_state import NesStateDetector

GOLDEN_FRAMES_DIR = Path(__file__).parent / "golden_frames"
TEMPLATE_DIR = VISION_DIR / "templates"


@pytest.fixture(scope="session")
def detector():
    return NesStateDetector(template_dir=str(TEMPLATE_DIR))


@pytest.fixture(scope="session")
def golden_frames():
    frames = []
    for png_path in sorted(GOLDEN_FRAMES_DIR.glob("*.png")):
        json_path = png_path.with_suffix(".json")
        if not json_path.exists():
            continue
        frame = cv2.imread(str(png_path))
        with open(json_path) as f:
            expected = json.load(f)
        frames.append({"name": png_path.stem, "frame": frame, "expected": expected})
    return frames
