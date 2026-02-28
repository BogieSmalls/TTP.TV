"""Unit tests for floor item detection pipeline.

Tests FloorItemDetector (detection accuracy, NMS, frame-diff guard,
shape twin disambiguation) and FloorItemTracker (item_drop, item_obtained,
item_seen_missed, room entry grace period).

Uses synthetic compositing on dungeon golden frames for controlled
ground truth — same approach validated in explore_floor_items.py.
"""

import os
import sys
import random
from pathlib import Path

import cv2
import numpy as np
import pytest

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.floor_item_detector import FloorItemDetector, FloorItem, _nms
from detector.item_reader import ItemReader
from detector.game_logic import FloorItemTracker, GameLogicValidator
from detector.nes_state import GameState

# --- Paths ---
TEMPLATE_DIR = str(VISION_DIR / 'templates' / 'items')
DROPS_DIR = str(VISION_DIR / 'templates' / 'drops')
GOLDEN_FRAME_DIR = str(VISION_DIR / 'tests' / 'golden_frames')


# --- Fixtures ---

@pytest.fixture
def item_reader():
    return ItemReader(TEMPLATE_DIR)


@pytest.fixture
def detector(item_reader):
    return FloorItemDetector(item_reader, score_threshold=0.85, drops_dir=DROPS_DIR)


@pytest.fixture
def dungeon_frame():
    """Load the first dungeon golden frame (256x240 BGR)."""
    path = os.path.join(GOLDEN_FRAME_DIR, 'dungeon_01.png')
    frame = cv2.imread(path, cv2.IMREAD_COLOR)
    assert frame is not None, f"Missing golden frame: {path}"
    assert frame.shape == (240, 256, 3)
    return frame


@pytest.fixture
def dungeon_frames():
    """Load all dungeon golden frames."""
    frames = []
    for fname in sorted(os.listdir(GOLDEN_FRAME_DIR)):
        if fname.startswith('dungeon') and fname.endswith('.png'):
            path = os.path.join(GOLDEN_FRAME_DIR, fname)
            img = cv2.imread(path, cv2.IMREAD_COLOR)
            if img is not None:
                frames.append((fname, img))
    assert len(frames) >= 1
    return frames


def composite_item(frame, template, x, y):
    """Place item template on frame at game_area position (x, y).

    Translates y from game_area coords to full frame coords (adds 64).
    """
    result = frame.copy()
    th, tw = template.shape[:2]
    fy = y + 64  # game area starts at row 64
    gray = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
    mask = gray > 10
    roi = result[fy:fy + th, fy + tw:]  # intentional bug guard
    # Correct: place in the actual ROI
    result[fy:fy + th, x:x + tw][mask] = template[mask]
    return result


def make_state(**kwargs) -> GameState:
    """Build a GameState with sane defaults."""
    defaults = dict(
        screen_type='dungeon',
        dungeon_level=1,
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
        map_position=34,
        detected_item=None,
        detected_item_y=0,
        floor_items=[],
    )
    defaults.update(kwargs)
    return GameState(**defaults)


# =============================================================================
# FloorItemDetector — Detection Accuracy
# =============================================================================

class TestFloorItemDetection:
    """Test that composited items are detected with high scores."""

    def test_single_item_detected(self, detector, dungeon_frame, item_reader):
        """A single composited item should be found at the correct position."""
        tmpl = item_reader.templates['heart_container']
        frame = composite_item(dungeon_frame, tmpl, 120, 80)
        items = detector.detect(frame, 'dungeon')
        matched = [i for i in items if abs(i.x - 120) <= 4 and abs(i.y - 80) <= 4]
        assert len(matched) >= 1
        assert matched[0].score >= 0.85

    def test_multiple_items_detected(self, detector, dungeon_frame, item_reader):
        """Multiple items at different positions should all be found."""
        positions = [(40, 50), (120, 80), (200, 100)]
        names = ['key', 'bomb', 'bow']
        frame = dungeon_frame.copy()
        for name, (x, y) in zip(names, positions):
            tmpl = item_reader.templates[name]
            frame = composite_item(frame, tmpl, x, y)

        items = detector.detect(frame, 'dungeon')
        for x, y in positions:
            matched = [i for i in items if abs(i.x - x) <= 6 and abs(i.y - y) <= 6]
            assert len(matched) >= 1, f"Item at ({x},{y}) not detected"

    def test_recall_across_all_templates(self, detector, dungeon_frame, item_reader):
        """Test that each template can be individually detected."""
        detected_count = 0
        total = 0
        for name, tmpl in item_reader.templates.items():
            frame = composite_item(dungeon_frame, tmpl, 100, 80)
            items = detector.detect(frame, 'dungeon')
            # Reset frame diff state
            detector._prev_game_area = None
            matched = [i for i in items if abs(i.x - 100) <= 6 and abs(i.y - 80) <= 6]
            if matched:
                detected_count += 1
            total += 1

        recall = detected_count / total
        assert recall >= 0.90, f"Recall {recall:.0%} < 90% ({detected_count}/{total})"

    def test_high_scores_for_synthetic_items(self, detector, dungeon_frame, item_reader):
        """Synthetic items should score very high (near 1.0)."""
        tmpl = item_reader.templates['blue_candle']
        frame = composite_item(dungeon_frame, tmpl, 100, 80)
        items = detector.detect(frame, 'dungeon')
        matched = [i for i in items if abs(i.x - 100) <= 4 and abs(i.y - 80) <= 4]
        assert len(matched) >= 1
        assert matched[0].score >= 0.95, f"Score {matched[0].score:.3f} < 0.95"


# =============================================================================
# FloorItemDetector — Enemy Drop Templates
# =============================================================================

class TestEnemyDropDetection:
    """Test that enemy drop templates (clock, fairy, heart, rupees) detect correctly."""

    DROP_NAMES = ['clock', 'fairy', 'heart_drop', 'rupee_blue', 'rupee_orange']

    def test_each_drop_template_detected(self, detector, dungeon_frame):
        """Each enemy drop template composited on a dungeon floor should be detected."""
        for name in self.DROP_NAMES:
            tmpl = detector._tmpl_f32[name].astype(np.uint8)
            frame = composite_item(dungeon_frame, tmpl, 100, 80)
            detector._prev_game_area = None  # reset frame diff
            items = detector.detect(frame, 'dungeon')
            matched = [i for i in items if i.name == name
                       and abs(i.x - 100) <= 6 and abs(i.y - 80) <= 6]
            assert len(matched) >= 1, f"Drop template '{name}' not detected"
            assert matched[0].score >= 0.85, (
                f"Drop '{name}' score {matched[0].score:.3f} < 0.85")

    def test_drop_templates_high_scores(self, detector, dungeon_frame):
        """Synthetic drop composites should score near 1.0 on dark background.

        Uses position (100,80) which has a dark floor in dungeon_01 golden
        frame — NCC scores reach 1.0.  Real-world scores are lower due to
        Twitch compression and non-uniform backgrounds.
        """
        for name in self.DROP_NAMES:
            tmpl = detector._tmpl_f32[name].astype(np.uint8)
            frame = composite_item(dungeon_frame, tmpl, 100, 80)
            detector._prev_game_area = None
            items = detector.detect(frame, 'dungeon')
            matched = [i for i in items if i.name == name
                       and abs(i.x - 100) <= 6 and abs(i.y - 80) <= 6]
            assert len(matched) >= 1, f"Drop '{name}' not detected at (100,80)"
            assert matched[0].score >= 0.90, (
                f"Drop '{name}' score {matched[0].score:.3f} < 0.90")

    def test_drops_not_in_item_reader(self, item_reader):
        """Enemy drop templates should NOT be in ItemReader (prevents HUD/staircase FP)."""
        for name in self.DROP_NAMES:
            assert name not in item_reader.templates, (
                f"Drop '{name}' found in ItemReader — should be in drops/ dir only")


# =============================================================================
# FloorItemDetector — False Positives
# =============================================================================

class TestFloorItemFalsePositives:
    """Test that empty frames produce few false detections."""

    def test_empty_frame_few_fps(self, detector, dungeon_frames):
        """Empty dungeon frames should produce few false positives."""
        total_fp = 0
        for fname, frame in dungeon_frames:
            detector._prev_game_area = None  # reset diff guard
            items = detector.detect(frame, 'dungeon')
            total_fp += len(items)
        avg_fp = total_fp / len(dungeon_frames)
        assert avg_fp <= 5.0, f"Average FP {avg_fp:.1f} > 5 per frame"

    def test_no_detection_on_non_gameplay(self, detector, dungeon_frame):
        """Non-gameplay screen types should return empty list."""
        for st in ('subscreen', 'title', 'death', 'cave', 'transition'):
            items = detector.detect(dungeon_frame, st)
            assert items == [], f"Detected items on screen_type={st}"


# =============================================================================
# FloorItemDetector — NMS
# =============================================================================

class TestNMS:
    """Test non-maximum suppression logic."""

    def test_suppresses_nearby_duplicates(self):
        detections = [
            ('key', 100, 80, 0.95),
            ('key', 102, 81, 0.90),
            ('bomb', 200, 60, 0.88),
        ]
        kept = _nms(detections, 8, 16)
        assert len(kept) == 2
        assert kept[0][0] == 'key' and kept[0][3] == 0.95
        assert kept[1][0] == 'bomb'

    def test_keeps_distant_detections(self):
        detections = [
            ('key', 40, 40, 0.90),
            ('bomb', 200, 120, 0.85),
        ]
        kept = _nms(detections, 8, 16)
        assert len(kept) == 2

    def test_empty_input(self):
        assert _nms([], 8, 16) == []

    def test_single_detection(self):
        kept = _nms([('key', 100, 80, 0.9)], 8, 16)
        assert len(kept) == 1

    def test_highest_score_wins(self):
        """When two detections overlap, the higher score survives."""
        detections = [
            ('key', 100, 80, 0.80),
            ('bomb', 101, 81, 0.95),
        ]
        kept = _nms(detections, 8, 16)
        assert len(kept) == 1
        assert kept[0][0] == 'bomb'


# =============================================================================
# FloorItemDetector — Frame Diff Guard
# =============================================================================

class TestFrameDiffGuard:
    """Test that the frame-diff guard skips unchanged frames."""

    def test_identical_frames_return_cached(self, detector, dungeon_frame, item_reader):
        """Second call with identical frame returns cached result."""
        tmpl = item_reader.templates['key']
        frame = composite_item(dungeon_frame, tmpl, 100, 80)
        result1 = detector.detect(frame, 'dungeon')
        result2 = detector.detect(frame, 'dungeon')
        assert result1 == result2

    def test_changed_frame_rescans(self, detector, dungeon_frame, item_reader):
        """A significantly changed frame triggers a new scan."""
        tmpl_key = item_reader.templates['key']

        frame1 = composite_item(dungeon_frame, tmpl_key, 100, 80)
        result1 = detector.detect(frame1, 'dungeon')

        # Create a significantly different frame (flood a region with white)
        frame2 = dungeon_frame.copy()
        frame2[64:180, 30:220] = 200  # large bright region
        result2 = detector.detect(frame2, 'dungeon')

        # frame2 has no items composited — high-scoring detections from
        # frame1 (key at 100,80) should NOT be in result2
        key_in_r1 = any(abs(i.x - 100) <= 4 and abs(i.y - 80) <= 4
                        and i.score > 0.9 for i in result1)
        key_in_r2 = any(abs(i.x - 100) <= 4 and abs(i.y - 80) <= 4
                        and i.score > 0.9 for i in result2)
        assert key_in_r1, "Key should be detected in frame1"
        assert not key_in_r2, "Key should NOT be detected in frame2 (no item)"

    def test_screen_type_change_resets_diff(self, detector, dungeon_frame):
        """Changing to non-gameplay resets the diff guard."""
        detector.detect(dungeon_frame, 'dungeon')
        detector.detect(dungeon_frame, 'subscreen')  # resets
        # After reset, next dungeon frame should trigger full scan
        assert detector._prev_game_area is None


# =============================================================================
# FloorItemDetector — Shape Twin Disambiguation
# =============================================================================

class TestShapeTwinDisambiguation:
    """Test that shape-identical items are disambiguated by color."""

    def test_blue_candle_vs_red_candle(self, detector, dungeon_frame, item_reader):
        """Blue candle should be identified as blue, not red."""
        tmpl = item_reader.templates['blue_candle']
        frame = composite_item(dungeon_frame, tmpl, 100, 80)
        items = detector.detect(frame, 'dungeon')
        matched = [i for i in items if abs(i.x - 100) <= 4 and abs(i.y - 80) <= 4]
        assert len(matched) >= 1
        assert matched[0].name == 'blue_candle'

    def test_red_candle_vs_blue_candle(self, detector, dungeon_frame, item_reader):
        """Red candle should be identified as red, not blue."""
        tmpl = item_reader.templates['red_candle']
        frame = composite_item(dungeon_frame, tmpl, 100, 80)
        detector._prev_game_area = None
        items = detector.detect(frame, 'dungeon')
        matched = [i for i in items if abs(i.x - 100) <= 4 and abs(i.y - 80) <= 4]
        assert len(matched) >= 1
        assert matched[0].name == 'red_candle'


# =============================================================================
# FloorItemDetector — Wall Margin
# =============================================================================

class TestWallMargin:
    """Test that detections in the wall border are excluded."""

    def test_item_near_wall_excluded(self, detector, dungeon_frame, item_reader):
        """Items placed in the wall margin zone should be excluded."""
        tmpl = item_reader.templates['key']
        # Place at x=4 (within 16px margin)
        frame = composite_item(dungeon_frame, tmpl, 4, 80)
        items = detector.detect(frame, 'dungeon')
        near_wall = [i for i in items if i.x < 16]
        assert len(near_wall) == 0

    def test_item_inside_margin_detected(self, detector, dungeon_frame, item_reader):
        """Items placed inside the margin zone should be detected."""
        tmpl = item_reader.templates['key']
        frame = composite_item(dungeon_frame, tmpl, 100, 80)
        items = detector.detect(frame, 'dungeon')
        matched = [i for i in items if abs(i.x - 100) <= 4 and abs(i.y - 80) <= 4]
        assert len(matched) >= 1


# =============================================================================
# FloorItemDetector — detect_game_area (direct API)
# =============================================================================

class TestDetectGameArea:
    """Test the direct game_area API (no screen_type filter, no diff guard)."""

    def test_direct_scan(self, detector, dungeon_frame, item_reader):
        tmpl = item_reader.templates['bomb']
        game_area = dungeon_frame[64:].copy()
        # Composite directly on game_area
        th, tw = tmpl.shape[:2]
        gray = cv2.cvtColor(tmpl, cv2.COLOR_BGR2GRAY)
        mask = gray > 10
        game_area[80:80 + th, 120:120 + tw][mask] = tmpl[mask]

        items = detector.detect_game_area(game_area)
        matched = [i for i in items if abs(i.x - 120) <= 4 and abs(i.y - 80) <= 4]
        assert len(matched) >= 1


# =============================================================================
# FloorItemTracker — Event Generation
# =============================================================================

class TestFloorItemTracker:
    """Test the game_logic FloorItemTracker state machine."""

    def make_floor_items(self, *items):
        """Shorthand: make_floor_items(('key', 100, 80), ('bomb', 200, 60))"""
        return [{'name': n, 'x': x, 'y': y, 'score': 0.9} for n, x, y in items]

    def test_item_drop_after_confirmation(self):
        """A new item must appear for 2+ frames before emitting item_drop."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('key', 100, 80))

        # Grace period: 3 frames
        for i in range(3):
            events = tracker.process([], 'dungeon', 1, 34, i)
            assert events == []

        # Frame 3: grace ends, empty baseline adopted
        # Frame 4: item appears — pending (count=1)
        events = tracker.process(fi, 'dungeon', 1, 34, 4)
        assert not any(e['event'] == 'item_drop' for e in events)

        # Frame 5: item still there — confirmed (count=2), drop emitted
        events = tracker.process(fi, 'dungeon', 1, 34, 5)
        drops = [e for e in events if e['event'] == 'item_drop']
        assert len(drops) == 1
        assert drops[0]['item'] == 'key'

    def test_item_obtained_after_gone(self):
        """Tracked item must be absent for 3+ frames before item_obtained."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('key', 100, 80))

        # Set up: grace period with item present
        for i in range(3):
            tracker.process(fi, 'dungeon', 1, 34, i)

        # Item is now tracked (adopted during grace)
        # Remove item — gone streak
        events_all = []
        for i in range(3, 10):
            events = tracker.process([], 'dungeon', 1, 34, i)
            events_all.extend(events)

        obtained = [e for e in events_all if e['event'] == 'item_obtained']
        assert len(obtained) == 1
        assert obtained[0]['item'] == 'key'

    def test_room_entry_grace_suppresses_drop(self):
        """Items present when entering a room should not fire item_drop."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('heart_container', 120, 80))

        # Enter room with item already there — grace period
        all_events = []
        for i in range(10):
            events = tracker.process(fi, 'dungeon', 1, 34, i)
            all_events.extend(events)

        drops = [e for e in all_events if e['event'] == 'item_drop']
        assert drops == [], "Items present at room entry should not trigger drop"

    def test_room_change_resets_tracking(self):
        """Changing rooms emits item_seen_missed for tracked items."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('key', 100, 80))

        # Room 1: establish item
        for i in range(5):
            tracker.process(fi, 'dungeon', 1, 34, i)

        # Room 2 (map_position changes): new grace period
        events = tracker.process([], 'dungeon', 1, 50, 6)
        assert any(e['event'] == 'item_seen_missed' for e in events), \
            "Room change should emit item_seen_missed for tracked items"
        assert not any(e['event'] == 'item_obtained' for e in events), \
            "Room change should not emit item_obtained"

    def test_non_gameplay_clears_state(self):
        """Switching to subscreen/title clears tracking."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('key', 100, 80))

        for i in range(5):
            tracker.process(fi, 'dungeon', 1, 34, i)

        # Switch to subscreen
        events = tracker.process(fi, 'subscreen', 1, 34, 6)
        assert events == []
        assert tracker._tracked == []

    def test_transient_detection_no_drop(self):
        """A single-frame flash should not trigger item_drop."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('bomb', 150, 60))

        # Grace period (no items)
        for i in range(3):
            tracker.process([], 'dungeon', 1, 34, i)

        # Item appears for just 1 frame
        events = tracker.process(fi, 'dungeon', 1, 34, 4)
        assert not any(e['event'] == 'item_drop' for e in events)

        # Item gone next frame
        events = tracker.process([], 'dungeon', 1, 34, 5)
        assert not any(e['event'] == 'item_drop' for e in events)

    def test_overworld_screen_type(self):
        """Floor items should be tracked on overworld too."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('heart_container', 100, 80))

        # Grace period with item
        for i in range(3):
            tracker.process(fi, 'overworld', 0, 119, i)

        # Item adopted — verify it's tracked
        assert len(tracker._tracked) == 1

    def test_multiple_items_tracked(self):
        """Multiple floor items can be tracked simultaneously."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('key', 100, 80), ('bomb', 200, 60))

        for i in range(3):
            tracker.process(fi, 'dungeon', 1, 34, i)

        assert len(tracker._tracked) == 2

    def test_pickup_only_fires_once(self):
        """After pickup event, the same item should not trigger again."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('key', 100, 80))

        # Grace: establish item
        for i in range(3):
            tracker.process(fi, 'dungeon', 1, 34, i)

        # Remove for enough frames to trigger pickup
        all_events = []
        for i in range(3, 15):
            events = tracker.process([], 'dungeon', 1, 34, i)
            all_events.extend(events)

        pickups = [e for e in all_events if e['event'] == 'item_obtained']
        assert len(pickups) == 1, f"Expected 1 item_obtained, got {len(pickups)}"

    def test_item_obtained_event_when_same_room(self):
        """Item disappearing while room unchanged -> item_obtained."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('bow', 100, 80))
        # Confirm item over CONFIRM_FRAMES
        for i in range(tracker._CONFIRM_FRAMES + tracker._ROOM_ENTRY_GRACE + 1):
            tracker.process(fi, 'dungeon', 1, 42, frame_number=i)
        # Now remove item (gone streak) — same room
        events_all = []
        for i in range(tracker._GONE_FRAMES + 1):
            evts = tracker.process([], 'dungeon', 1, 42, frame_number=100 + i)
            events_all.extend(evts)
        names = [e['event'] for e in events_all]
        assert 'item_obtained' in names
        assert 'item_seen_missed' not in names

    def test_item_seen_missed_when_room_changes(self):
        """Item disappearing due to room change -> item_seen_missed."""
        tracker = FloorItemTracker()
        fi = self.make_floor_items(('bow', 100, 80))
        for i in range(tracker._CONFIRM_FRAMES + tracker._ROOM_ENTRY_GRACE + 1):
            tracker.process(fi, 'dungeon', 1, 42, frame_number=i)
        # Room changes — item no longer visible (player left)
        events = tracker.process([], 'dungeon', 1, 99, frame_number=100)
        names = [e['event'] for e in events]
        assert 'item_seen_missed' in names
        assert 'item_obtained' not in names


# =============================================================================
# FloorItemTracker — Integration with GameLogicValidator
# =============================================================================

class TestFloorItemGameLogicIntegration:
    """Test floor item events flowing through GameLogicValidator."""

    def test_drop_event_in_validator(self):
        """item_drop should appear in game_events from validate()."""
        v = GameLogicValidator()
        fi = [{'name': 'key', 'x': 100, 'y': 80, 'score': 0.9}]

        # Prime with enough gameplay frames to start + establish grace
        for i in range(130):
            v.validate(make_state(floor_items=[]), frame_number=i)

        # New item appears
        for i in range(130, 135):
            v.validate(make_state(floor_items=fi), frame_number=i)

        drops = [e for e in v.game_events if e['event'] == 'item_drop']
        assert len(drops) >= 1
        assert drops[0]['item'] == 'key'

    def test_pickup_event_in_validator(self):
        """item_obtained should appear in game_events from validate()."""
        v = GameLogicValidator()
        fi = [{'name': 'bomb', 'x': 150, 'y': 60, 'score': 0.9}]

        # Establish gameplay + item during grace
        for i in range(130):
            v.validate(make_state(floor_items=fi), frame_number=i)

        # Remove item for 5+ frames
        for i in range(130, 140):
            v.validate(make_state(floor_items=[]), frame_number=i)

        pickups = [e for e in v.game_events if e['event'] == 'item_obtained']
        assert len(pickups) >= 1
        assert pickups[0]['item'] == 'bomb'

    def test_floor_items_carried_forward(self):
        """floor_items on non-gameplay frames shouldn't cause crashes."""
        v = GameLogicValidator()
        v.validate(make_state(floor_items=[]), frame_number=0)
        # Transition to subscreen (floor_items not readable)
        result = v.validate(make_state(
            screen_type='subscreen', floor_items=[]), frame_number=1)
        # Should not crash
        assert result is not None
