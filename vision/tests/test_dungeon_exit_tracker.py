"""Unit tests for DungeonExitTracker.

Tests the state machine: IDLE → EXITING → (triforce_inferred | game_complete | timeout).

Key nuances:
- EXITING only enters from dungeon with dungeon_level > 0 to a non-gameplay screen
  (not overworld, dungeon, cave, or subscreen)
- triforce_inferred fires only if: hearts increased, hearts at max, _exit_hearts_min > 0,
  no death menu seen, and dungeon 1-8
- game_complete fires for D9 exits that last > 30 frames
- Death menu guard: 3+ consecutive 'death' frames → _exit_saw_death_menu = True
- Timeout: exit_frames > 40 → reset to IDLE
"""
import sys
from pathlib import Path

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.dungeon_exit_tracker import DungeonExitTracker


def _make_tracker():
    tf = [False] * 8
    tracker = DungeonExitTracker(triforce_inferred=tf)
    return tracker, tf


def _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=10):
    """Feed a dungeon→death transition to put the tracker into EXITING phase."""
    return tracker.process_frame(
        screen_type='death', dungeon_level=0,
        hearts_current=hearts_current, hearts_max=hearts_max,
        prev_screen_type='dungeon', prev_dungeon_level=dungeon_level,
        frame_number=frame,
    )


# ── IDLE → EXITING transitions ────────────────────────────────────────────────

class TestExitPhaseTransition:

    def test_enters_exiting_on_dungeon_to_death_transition(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3)
        assert tracker._exit_phase.name == 'EXITING'
        assert tracker._exit_dungeon == 3

    def test_stays_idle_when_prev_was_overworld(self):
        tracker, _ = _make_tracker()
        tracker.process_frame(
            screen_type='death', dungeon_level=0,
            hearts_current=3, hearts_max=5,
            prev_screen_type='overworld', prev_dungeon_level=0,
            frame_number=10,
        )
        assert tracker._exit_phase.name == 'IDLE'

    def test_stays_idle_when_prev_dungeon_level_is_zero(self):
        """D0 (entrance rooms) exits don't trigger — only D1-D9."""
        tracker, _ = _make_tracker()
        tracker.process_frame(
            screen_type='death', dungeon_level=0,
            hearts_current=3, hearts_max=5,
            prev_screen_type='dungeon', prev_dungeon_level=0,
            frame_number=10,
        )
        assert tracker._exit_phase.name == 'IDLE'

    def test_stays_idle_when_transition_is_to_overworld(self):
        """Direct dungeon→overworld transition: not a death exit, don't enter EXITING."""
        tracker, _ = _make_tracker()
        tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=5, hearts_max=5,
            prev_screen_type='dungeon', prev_dungeon_level=3,
            frame_number=10,
        )
        # Went directly to overworld — EXITING was never set (resolved immediately)
        # This should either produce a triforce event or stay IDLE
        assert tracker._exit_phase.name == 'IDLE'

    def test_returns_to_idle_when_returning_to_dungeon(self):
        """EXITING + return to dungeon = transition flicker, reset."""
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, frame=10)
        tracker.process_frame(
            screen_type='dungeon', dungeon_level=3,
            hearts_current=3, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        assert tracker._exit_phase.name == 'IDLE'


# ── Triforce inference ────────────────────────────────────────────────────────

class TestTriforceInference:

    def test_triforce_inferred_when_hearts_increase_to_max(self):
        tracker, tf = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=10)
        events = tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=5, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        assert any(e['event'] == 'triforce_inferred' for e in events)
        assert tf[2] is True  # D3 → index 2

    def test_triforce_not_inferred_when_hearts_did_not_increase(self):
        """Already at max when exiting — hearts_current not > _exit_hearts_start."""
        tracker, tf = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, hearts_current=5, hearts_max=5, frame=10)
        events = tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=5, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        assert not any(e['event'] == 'triforce_inferred' for e in events)
        assert tf[2] is False

    def test_triforce_not_inferred_when_hearts_increased_but_below_max(self):
        tracker, tf = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=10)
        events = tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=4, hearts_max=5,  # increased but NOT at max
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        assert not any(e['event'] == 'triforce_inferred' for e in events)
        assert tf[2] is False

    def test_triforce_not_inferred_for_dungeon_9(self):
        """D9 is Ganon — not a triforce dungeon."""
        tracker, tf = _make_tracker()
        _enter_exiting(tracker, dungeon_level=9, hearts_current=3, hearts_max=5, frame=10)
        events = tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=5, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        assert not any(e['event'] == 'triforce_inferred' for e in events)

    def test_triforce_not_inferred_after_death_menu(self):
        """3+ consecutive death frames set _exit_saw_death_menu → no triforce."""
        tracker, tf = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=10)
        # Two more death frames (total 3) → saw_death_menu = True
        tracker.process_frame(
            screen_type='death', dungeon_level=0,
            hearts_current=3, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        tracker.process_frame(
            screen_type='death', dungeon_level=0,
            hearts_current=3, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=12,
        )
        assert tracker._exit_saw_death_menu is True
        events = tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=5, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=13,
        )
        assert not any(e['event'] == 'triforce_inferred' for e in events)
        assert tf[2] is False

    def test_two_death_frames_do_not_set_death_menu_flag(self):
        """Only 3+ consecutive death frames trigger saw_death_menu."""
        tracker, tf = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=10)
        tracker.process_frame(
            screen_type='death', dungeon_level=0,
            hearts_current=3, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        # Only 2 death frames total — not a death menu
        assert tracker._exit_saw_death_menu is False
        events = tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=5, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=12,
        )
        assert any(e['event'] == 'triforce_inferred' for e in events)

    def test_triforce_not_inferred_twice_for_same_dungeon(self):
        """Once tf[idx] is set, the event does not re-fire."""
        tracker, tf = _make_tracker()
        tf[2] = True  # pre-set D3
        _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=10)
        events = tracker.process_frame(
            screen_type='overworld', dungeon_level=0,
            hearts_current=5, hearts_max=5,
            prev_screen_type='death', prev_dungeon_level=0,
            frame_number=11,
        )
        assert not any(e['event'] == 'triforce_inferred' for e in events)

    def test_triforce_inferred_sets_correct_index_for_each_dungeon(self):
        """Dungeon N maps to triforce_inferred[N-1]."""
        for dungeon in range(1, 9):
            tracker, tf = _make_tracker()
            _enter_exiting(tracker, dungeon_level=dungeon, hearts_current=3, hearts_max=5, frame=10)
            tracker.process_frame(
                screen_type='overworld', dungeon_level=0,
                hearts_current=5, hearts_max=5,
                prev_screen_type='death', prev_dungeon_level=0,
                frame_number=11,
            )
            assert tf[dungeon - 1] is True, f'D{dungeon} should set tf[{dungeon - 1}]'


# ── Game completion ───────────────────────────────────────────────────────────

class TestGameComplete:

    def test_game_complete_fires_after_30_exit_frames_from_d9(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=9, hearts_current=3, hearts_max=5, frame=0)
        events_all = []
        for i in range(1, 32):  # frames 1-31, exit_frames = 31 > 30
            evts = tracker.process_frame(
                screen_type='transition', dungeon_level=0,
                hearts_current=3, hearts_max=5,
                prev_screen_type='transition', prev_dungeon_level=0,
                frame_number=i,
            )
            events_all.extend(evts)
        assert any(e['event'] == 'game_complete' for e in events_all)
        assert tracker.game_completed is True

    def test_game_complete_not_fired_before_30_frames(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=9, hearts_current=3, hearts_max=5, frame=0)
        events_all = []
        for i in range(1, 31):  # exit_frames = 30, not > 30
            evts = tracker.process_frame(
                screen_type='transition', dungeon_level=0,
                hearts_current=3, hearts_max=5,
                prev_screen_type='transition', prev_dungeon_level=0,
                frame_number=i,
            )
            events_all.extend(evts)
        assert not any(e['event'] == 'game_complete' for e in events_all)

    def test_game_complete_not_fired_if_player_died_during_exit(self):
        """_exit_hearts_min == 0 means player died — not game completion."""
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=9, hearts_current=3, hearts_max=5, frame=0)
        # Hearts drop to 0
        tracker.process_frame(
            screen_type='transition', dungeon_level=0,
            hearts_current=0, hearts_max=5,
            prev_screen_type='transition', prev_dungeon_level=0,
            frame_number=1,
        )
        events_all = []
        for i in range(2, 40):
            evts = tracker.process_frame(
                screen_type='transition', dungeon_level=0,
                hearts_current=0, hearts_max=5,
                prev_screen_type='transition', prev_dungeon_level=0,
                frame_number=i,
            )
            events_all.extend(evts)
        assert not any(e['event'] == 'game_complete' for e in events_all)

    def test_game_complete_not_fired_twice(self):
        tracker, _ = _make_tracker()
        tracker.game_completed = True
        _enter_exiting(tracker, dungeon_level=9, hearts_current=3, hearts_max=5, frame=0)
        events_all = []
        for i in range(1, 40):
            events_all.extend(tracker.process_frame(
                screen_type='transition', dungeon_level=0,
                hearts_current=3, hearts_max=5,
                prev_screen_type='transition', prev_dungeon_level=0,
                frame_number=i,
            ))
        assert not any(e['event'] == 'game_complete' for e in events_all)


# ── Timeout ───────────────────────────────────────────────────────────────────

class TestTimeout:

    def test_exiting_resets_after_40_frames(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=0)
        for i in range(1, 42):  # exit_frames = 41 > 40
            tracker.process_frame(
                screen_type='transition', dungeon_level=0,
                hearts_current=3, hearts_max=5,
                prev_screen_type='transition', prev_dungeon_level=0,
                frame_number=i,
            )
        assert tracker._exit_phase.name == 'IDLE'

    def test_not_timed_out_at_exactly_40_frames(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, hearts_current=3, hearts_max=5, frame=0)
        for i in range(1, 41):  # exit_frames = 40, not > 40
            tracker.process_frame(
                screen_type='transition', dungeon_level=0,
                hearts_current=3, hearts_max=5,
                prev_screen_type='transition', prev_dungeon_level=0,
                frame_number=i,
            )
        assert tracker._exit_phase.name == 'EXITING'


# ── is_exiting_d9 property ────────────────────────────────────────────────────

class TestIsExitingD9:

    def test_true_during_d9_exit(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=9, frame=0)
        assert tracker.is_exiting_d9 is True

    def test_false_during_d3_exit(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, frame=0)
        assert tracker.is_exiting_d9 is False

    def test_false_when_idle(self):
        tracker, _ = _make_tracker()
        assert tracker.is_exiting_d9 is False


# ── reset() ───────────────────────────────────────────────────────────────────

class TestReset:

    def test_reset_clears_triforce_list_in_place(self):
        tf = [False] * 8
        tracker = DungeonExitTracker(triforce_inferred=tf)
        tf[2] = True
        tracker.reset()
        assert tf[2] is False  # same list object, mutated in place

    def test_reset_clears_game_completed(self):
        tracker, _ = _make_tracker()
        tracker.game_completed = True
        tracker.reset()
        assert tracker.game_completed is False

    def test_reset_returns_to_idle(self):
        tracker, _ = _make_tracker()
        _enter_exiting(tracker, dungeon_level=3, frame=0)
        tracker.reset()
        assert tracker._exit_phase.name == 'IDLE'
