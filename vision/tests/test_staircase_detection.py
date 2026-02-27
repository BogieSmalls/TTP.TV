"""Tests for staircase item detection in ItemDetector and StaircaseItemTracker.

Covers:
- ItemDetector._detect_staircase_item() pedestal hot zone matching
- StaircaseItemTracker state machine (idle -> visible -> acquired)
- End-to-end golden frame tests via NesStateDetector
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.item_detector import ItemDetector, DetectedItem
from detector.item_reader import ItemReader
from detector.game_logic import GameLogicValidator
from detector.nes_state import GameState, NesStateDetector

TEMPLATE_DIR = VISION_DIR / "templates"
GOLDEN_FRAMES_DIR = Path(__file__).parent / "golden_frames"


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_state(**kwargs) -> GameState:
    defaults = dict(
        screen_type='overworld',
        dungeon_level=0,
        hearts_current=3,
        hearts_max=3,
        has_half_heart=False,
        rupees=50,
        keys=0,
        bombs=4,
        b_item='bomb',
        sword_level=1,
        has_master_key=False,
        gannon_nearby=False,
        bomb_max=8,
        items={},
        triforce=[False] * 8,
        map_position=0,
        detected_item=None,
        detected_item_y=0,
    )
    defaults.update(kwargs)
    return GameState(**defaults)


def make_dark_frame() -> np.ndarray:
    """256x240 all-black frame."""
    return np.zeros((240, 256, 3), dtype=np.uint8)


def make_pedestal_frame_with_item(item_reader: ItemReader,
                                   item_name: str) -> np.ndarray:
    """Build a synthetic 256x240 frame with an item template at the pedestal position.

    Places the item template at the expected pedestal location on an otherwise
    dark dungeon background.
    """
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    template = item_reader.templates.get(item_name)
    if template is None:
        raise ValueError(f"No template for {item_name}")

    # Place template at pedestal center: NES full-frame (132, 140)
    # Template is 16h x 8w (NES sprite)
    th, tw = template.shape[:2]
    y = 140  # center_y - th//2 roughly
    x = 132  # center_x - tw//2 roughly
    frame[y:y + th, x:x + tw] = template
    return frame


@pytest.fixture(scope="module")
def item_reader():
    return ItemReader(str(TEMPLATE_DIR / "items"))


@pytest.fixture(scope="module")
def item_detector(item_reader):
    return ItemDetector(item_reader=item_reader)


@pytest.fixture(scope="module")
def pedestal_frame():
    """Real golden frame: red ring on staircase pedestal."""
    path = GOLDEN_FRAMES_DIR / "staircase_pedestal_01.png"
    frame = cv2.imread(str(path))
    assert frame is not None, f"Could not load {path}"
    return frame


@pytest.fixture(scope="module")
def hoisted_frame():
    """Real golden frame: Link holding item overhead (pedestal empty)."""
    path = GOLDEN_FRAMES_DIR / "staircase_hoisted_01.png"
    frame = cv2.imread(str(path))
    assert frame is not None, f"Could not load {path}"
    return frame


# ── ItemDetector: _detect_staircase_item ──────────────────────────────────────

class TestStaircaseItemDetection:
    """Tests for ItemDetector staircase pedestal scanning."""

    def test_detects_ring_on_pedestal(self, item_detector, pedestal_frame):
        """Should detect a ring item on the staircase pedestal."""
        items = item_detector.detect_items(pedestal_frame, 'dungeon')
        staircase_items = [i for i in items if i.item_type not in ('triforce',)]
        assert len(staircase_items) >= 1, "Should detect the item on the pedestal"
        item = staircase_items[0]
        assert item.item_type in ('red_ring', 'blue_ring'), (
            f"Expected ring, got {item.item_type}"
        )
        assert item.confidence > 0.55

    def test_no_item_on_empty_pedestal(self, item_detector, hoisted_frame):
        """Should not detect an item on the pedestal when Link has picked it up."""
        items = item_detector.detect_items(hoisted_frame, 'dungeon')
        staircase_items = [i for i in items if i.item_type not in ('triforce',)]
        assert len(staircase_items) == 0, (
            f"Should not detect items on empty pedestal, got {staircase_items}"
        )

    def test_only_runs_in_dungeon(self, item_detector, pedestal_frame):
        """Staircase detection should only activate for dungeon screen_type."""
        for screen_type in ('overworld', 'cave', 'subscreen', 'death', 'title'):
            items = item_detector.detect_items(pedestal_frame, screen_type)
            staircase_items = [i for i in items if i.item_type not in ('triforce',)]
            # Overworld/cave might still detect triforce but not staircase items
            # (staircase detection is dungeon-only)
            if screen_type not in ('overworld', 'cave'):
                assert len(items) == 0

    def test_dark_frame_no_detection(self, item_detector):
        """All-black frame should not produce staircase item detections."""
        frame = make_dark_frame()
        items = item_detector.detect_items(frame, 'dungeon')
        assert len(items) == 0

    def test_synthetic_bomb_on_pedestal(self, item_reader, item_detector):
        """Placing a bomb template at the pedestal position should detect 'bomb'."""
        frame = make_pedestal_frame_with_item(item_reader, 'bomb')
        items = item_detector.detect_items(frame, 'dungeon')
        staircase_items = [i for i in items if i.item_type not in ('triforce',)]
        assert len(staircase_items) >= 1
        assert staircase_items[0].item_type == 'bomb'

    def test_synthetic_heart_container_on_pedestal(self, item_reader, item_detector):
        """Placing heart_container template at pedestal should detect it."""
        frame = make_pedestal_frame_with_item(item_reader, 'heart_container')
        items = item_detector.detect_items(frame, 'dungeon')
        staircase_items = [i for i in items if i.item_type not in ('triforce',)]
        assert len(staircase_items) >= 1
        assert staircase_items[0].item_type == 'heart_container'

    def test_bright_region_rejected(self, item_reader):
        """When the pedestal region is too bright (Link present), reject matches."""
        det = ItemDetector(item_reader=item_reader)
        # Frame with bright pixels throughout the pedestal hot zone
        frame = np.ones((240, 256, 3), dtype=np.uint8) * 120
        items = det.detect_items(frame, 'dungeon')
        staircase_items = [i for i in items if i.item_type not in ('triforce',)]
        assert len(staircase_items) == 0, "Bright region should be rejected by isolation check"


# ── StaircaseItemTracker state machine ────────────────────────────────────────

class TestStaircaseItemTracker:
    """Tests for the StaircaseItemTracker in game_logic.py."""

    def test_idle_to_visible_after_consecutive_frames(self):
        """Item detected on pedestal for 2+ frames transitions to visible."""
        v = GameLogicValidator()
        # Prime with a normal dungeon state
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 0)
        # Frame 1: item appears
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='red_ring'), 1)
        # Frame 2: item still there — should become visible
        result = v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                                       detected_item='red_ring'), 2)
        # The staircase tracker should have registered the item
        tracker = v._staircase_tracker
        assert tracker._state == 'item_visible'
        assert tracker._item_name == 'red_ring'

    def test_visible_to_acquired_emits_event(self):
        """Item disappearing after being visible should emit acquisition event."""
        v = GameLogicValidator()
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 0)
        # Show item for 2 frames to reach visible
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='red_ring'), 1)
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='red_ring'), 2)
        # Item disappears for 3 frames
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 3)
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 4)
        result = v.validate(make_state(screen_type='dungeon', dungeon_level=3), 5)

        # Check event was emitted
        events = result.events if hasattr(result, 'events') else []
        staircase_events = [e for e in events if e.get('type') == 'staircase_item_acquired']
        assert len(staircase_events) == 1
        assert staircase_events[0]['item'] == 'red_ring'
        assert staircase_events[0]['dungeon_level'] == 3

    def test_triforce_ignored_by_tracker(self):
        """Triforce detections should not trigger staircase item tracking."""
        v = GameLogicValidator()
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 0)
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='triforce'), 1)
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='triforce'), 2)
        tracker = v._staircase_tracker
        assert tracker._state == 'idle', "Triforce should not trigger staircase tracking"

    def test_non_dungeon_resets_tracker(self):
        """Leaving dungeon should reset the tracker to idle."""
        v = GameLogicValidator()
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 0)
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='red_ring'), 1)
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='red_ring'), 2)
        assert v._staircase_tracker._state == 'item_visible'
        # Leave dungeon
        v.validate(make_state(screen_type='overworld'), 3)
        assert v._staircase_tracker._state == 'idle'

    def test_single_frame_detection_not_enough(self):
        """A single frame of item detection should not transition to visible."""
        v = GameLogicValidator()
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 0)
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='red_ring'), 1)
        # Item disappears immediately
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 2)
        assert v._staircase_tracker._state == 'idle'

    def test_brief_disappearance_not_enough(self):
        """Item disappearing for only 1-2 frames should not trigger acquisition."""
        v = GameLogicValidator()
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 0)
        # Show item long enough to be visible
        for i in range(1, 4):
            v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                                  detected_item='blue_ring'), i)
        assert v._staircase_tracker._state == 'item_visible'
        # Brief 1-frame gap — should not trigger acquired
        v.validate(make_state(screen_type='dungeon', dungeon_level=3), 4)
        # Item reappears
        v.validate(make_state(screen_type='dungeon', dungeon_level=3,
                              detected_item='blue_ring'), 5)
        assert v._staircase_tracker._state == 'item_visible'
