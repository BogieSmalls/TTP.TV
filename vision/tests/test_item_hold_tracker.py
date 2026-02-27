"""Unit tests for ItemHoldTracker.

Tests the item-hold animation detection state machine.

Key nuances:
- Tracking only starts inside dungeon/cave with dungeon_level > 0
- Threshold: detected >= 4 AND gaps >= 1 AND total >= 8
- y-spread guard: new_y_max - new_y_min <= 6 required for stable tracking
- Hearts must increase to > hearts_start and reach hearts_max to fire
- Pending state: when animation ends (gap > 12 frames), waits up to 20 frames
  for hearts to refill
- Only fires for item_type='triforce' and dungeon 1-8
"""
import sys
from pathlib import Path

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.item_hold_tracker import ItemHoldTracker


def _make_tracker():
    tf = [False] * 8
    tracker = ItemHoldTracker(triforce_inferred=tf)
    return tracker, tf


def _feed_threshold_sequence(tracker, dungeon=3, y=100, start_frame=0,
                              hearts_start=3, hearts_max=5):
    """Feed 4 detections interleaved with 4 gap frames (total=8, det=4, gaps=4).

    Pattern: det, gap, det, gap, det, gap, det, gap
    Returns (all_events, next_frame_number).
    """
    all_events = []
    frame = start_frame
    for _ in range(4):
        evts = tracker.process_frame(
            detected_item='triforce', detected_item_y=y,
            screen_type='dungeon', dungeon_level=dungeon,
            hearts_current=hearts_start, hearts_max=hearts_max,
            frame_number=frame,
        )
        all_events.extend(evts)
        frame += 1
        evts = tracker.process_frame(
            detected_item=None, detected_item_y=0,
            screen_type='dungeon', dungeon_level=dungeon,
            hearts_current=hearts_start, hearts_max=hearts_max,
            frame_number=frame,
        )
        all_events.extend(evts)
        frame += 1
    return all_events, frame


# ── Tracking start guards ────────────────────────────────────────────────────

class TestTrackingStartGuards:

    def test_overworld_detection_is_ignored(self):
        tracker, tf = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='overworld', dungeon_level=0,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        assert tracker._item_hold_detected == 0

    def test_dungeon_level_zero_is_ignored(self):
        """Entrance rooms (D0) don't have triforces."""
        tracker, tf = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=0,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        assert tracker._item_hold_detected == 0

    def test_cave_with_dungeon_level_starts_tracking(self):
        """Cave can carry over dungeon context — tracking should start."""
        tracker, _ = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='cave', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        assert tracker._item_hold_detected == 1

    def test_dungeon_tracking_starts_and_records_state(self):
        tracker, _ = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=10,
        )
        assert tracker._item_hold_detected == 1
        assert tracker._item_hold_type == 'triforce'
        assert tracker._item_hold_dungeon == 3
        assert tracker._item_hold_hearts_start == 3


# ── Threshold logic ───────────────────────────────────────────────────────────

class TestThresholdLogic:

    def test_below_threshold_no_event_fires(self):
        """Only 3 detections + 2 gaps = total 5 — below threshold."""
        tracker, tf = _make_tracker()
        for i in range(3):
            tracker.process_frame(
                detected_item='triforce', detected_item_y=100,
                screen_type='dungeon', dungeon_level=3,
                hearts_current=3, hearts_max=5, frame_number=i * 2,
            )
            if i < 2:
                tracker.process_frame(
                    detected_item=None, detected_item_y=0,
                    screen_type='dungeon', dungeon_level=3,
                    hearts_current=3, hearts_max=5, frame_number=i * 2 + 1,
                )
        # Feed one more detection with hearts at max — still below threshold
        events = tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=5, hearts_max=5, frame_number=100,
        )
        # detected=4 but total < 8 (not enough gaps for total to reach 8)
        # Actually at this point: det=4, gaps=2, total=6 — still below total threshold
        assert tf[2] is False

    def test_meets_threshold_and_fires_on_detection_with_hearts_at_max(self):
        tracker, tf = _make_tracker()
        all_events, next_frame = _feed_threshold_sequence(tracker, dungeon=3)
        # Feed one more detection with hearts increased to max
        events = tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=5, hearts_max=5,
            frame_number=next_frame,
        )
        all_events.extend(events)
        assert any(e['event'] == 'triforce_inferred' for e in all_events)
        assert tf[2] is True

    def test_threshold_requires_at_least_one_gap(self):
        """Gaps must be >= 1 — solid detections without cycling don't count."""
        tracker, tf = _make_tracker()
        # Feed 8 consecutive detections, no gaps
        for i in range(8):
            tracker.process_frame(
                detected_item='triforce', detected_item_y=100,
                screen_type='dungeon', dungeon_level=3,
                hearts_current=3 if i < 7 else 5, hearts_max=5,
                frame_number=i,
            )
        # gaps == 0 → threshold not met
        assert tf[2] is False


# ── Hearts refill confirmation ────────────────────────────────────────────────

class TestHeartsRefillConfirmation:

    def test_triforce_not_fired_if_hearts_never_increase(self):
        """Hearts already at max before animation — can't increase further."""
        tracker, tf = _make_tracker()
        # hearts_start = 5 = hearts_max — no increase possible
        all_events, next_frame = _feed_threshold_sequence(
            tracker, dungeon=3, hearts_start=5, hearts_max=5)
        # Feed more detection frames — hearts stay at max, never increase
        for i in range(next_frame, next_frame + 5):
            tracker.process_frame(
                detected_item='triforce', detected_item_y=100,
                screen_type='dungeon', dungeon_level=3,
                hearts_current=5, hearts_max=5, frame_number=i,
            )
        assert tf[2] is False

    def test_pending_state_fires_when_hearts_reach_max_after_animation(self):
        """Animation ends (gap > 12), enters pending, fires when hearts refill."""
        tracker, tf = _make_tracker()
        # Feed threshold sequence: last detection at frame 6, last_frame=6
        all_events, _ = _feed_threshold_sequence(
            tracker, dungeon=3, start_frame=0, hearts_start=3, hearts_max=5)

        # Gap > 12 frames after last detection (frame 6) → pending activated
        tracker.process_frame(
            detected_item=None, detected_item_y=0,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=19,  # 19-6=13 > 12
        )
        assert tracker._item_hold_pending is True

        # Hearts reach max → fires
        events = tracker.process_frame(
            detected_item=None, detected_item_y=0,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=5, hearts_max=5, frame_number=20,
        )
        assert any(e['event'] == 'triforce_inferred' for e in events)
        assert tf[2] is True

    def test_pending_state_times_out_after_20_frames(self):
        """If hearts don't refill within 20 frames of last detection, reset."""
        tracker, tf = _make_tracker()
        all_events, _ = _feed_threshold_sequence(
            tracker, dungeon=3, start_frame=0, hearts_start=3, hearts_max=5)

        # Activate pending (last detection at frame 6)
        tracker.process_frame(
            detected_item=None, detected_item_y=0,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=19,
        )
        assert tracker._item_hold_pending is True

        # 21 frames after last detection → frames_since > 20 → reset
        tracker.process_frame(
            detected_item=None, detected_item_y=0,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=27,  # 27-6=21 > 20
        )
        assert tracker._item_hold_pending is False
        assert tracker._item_hold_detected == 0
        assert tf[2] is False


# ── Non-triforce items ────────────────────────────────────────────────────────

class TestNonTriforceItems:

    def test_heart_container_does_not_fire_triforce_event(self):
        tracker, tf = _make_tracker()
        for i in range(8):
            tracker.process_frame(
                detected_item='heart_container', detected_item_y=100,
                screen_type='dungeon', dungeon_level=3,
                hearts_current=3 if i < 7 else 5, hearts_max=5,
                frame_number=i,
            )
        assert all(not t for t in tf)

    def test_triforce_item_type_required_for_event(self):
        """_fire_triforce_event returns [] for non-triforce item_hold_type."""
        tracker, tf = _make_tracker()
        all_events, next_frame = _feed_threshold_sequence.__wrapped__(
            tracker) if hasattr(_feed_threshold_sequence, '__wrapped__') else ([], 8)
        # Directly test via custom sequence
        tracker2, tf2 = _make_tracker()
        for i in range(4):
            tracker2.process_frame(
                detected_item='compass', detected_item_y=100,
                screen_type='dungeon', dungeon_level=3,
                hearts_current=3, hearts_max=5, frame_number=i * 2,
            )
            tracker2.process_frame(
                detected_item=None, detected_item_y=0,
                screen_type='dungeon', dungeon_level=3,
                hearts_current=3, hearts_max=5, frame_number=i * 2 + 1,
            )
        events = tracker2.process_frame(
            detected_item='compass', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=5, hearts_max=5, frame_number=9,
        )
        assert not any(e['event'] == 'triforce_inferred' for e in events)
        assert all(not t for t in tf2)


# ── Y-drift reset ─────────────────────────────────────────────────────────────

class TestYDriftReset:

    def test_y_drift_above_6px_resets_tracking(self):
        """Item jumping > 6px vertically = not a stable hold; restart."""
        tracker, _ = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        assert tracker._item_hold_detected == 1
        # y jumps to 107 (7px from 100 → drift > 6)
        tracker.process_frame(
            detected_item='triforce', detected_item_y=107,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=1,
        )
        # Tracking restarted: detected=1, y_min=y_max=107
        assert tracker._item_hold_detected == 1
        assert tracker._item_hold_y_min == 107

    def test_y_within_6px_is_stable(self):
        """Small y variation (≤6px) is accumulated, not reset."""
        tracker, _ = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        tracker.process_frame(
            detected_item='triforce', detected_item_y=106,  # 6px drift, exactly at limit
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=1,
        )
        assert tracker._item_hold_detected == 2  # accumulated, not reset


# ── Gap counting ──────────────────────────────────────────────────────────────

class TestGapCounting:

    def test_gap_frames_increment_gap_counter(self):
        tracker, _ = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        assert tracker._item_hold_gaps == 0
        tracker.process_frame(
            detected_item=None, detected_item_y=0,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=1,
        )
        assert tracker._item_hold_gaps == 1

    def test_long_gap_without_meeting_threshold_resets_tracking(self):
        """Gap > 12 frames but threshold not yet met → reset (not pending)."""
        tracker, _ = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        # 13 frames without detection — well past the 12-frame gap limit
        tracker.process_frame(
            detected_item=None, detected_item_y=0,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=13,
        )
        # Only 1 detection and 1 gap — threshold not met → reset
        assert tracker._item_hold_detected == 0
        assert tracker._item_hold_pending is False


# ── reset() ───────────────────────────────────────────────────────────────────

class TestReset:

    def test_reset_clears_triforce_list_in_place(self):
        tf = [False] * 8
        tracker = ItemHoldTracker(triforce_inferred=tf)
        tf[4] = True
        tracker.reset()
        assert tf[4] is False  # same list object, mutated in place

    def test_reset_clears_all_tracking_state(self):
        tracker, _ = _make_tracker()
        tracker.process_frame(
            detected_item='triforce', detected_item_y=100,
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5, frame_number=0,
        )
        tracker.reset()
        assert tracker._item_hold_detected == 0
        assert tracker._item_hold_type is None
        assert tracker._item_hold_gaps == 0
        assert tracker._item_hold_pending is False
        assert tracker._item_hold_fired is False
