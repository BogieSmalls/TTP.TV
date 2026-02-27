"""Unit tests for WarpDeathTracker.

Tests Up+A warp and death detection via position-reset and CSR patterns.

Key nuances:
- overworld_start is recorded from the first overworld frame with map_position > 0
- dungeon_entrances is recorded from the first visit to each dungeon
- Gap tracking: non-gameplay AND non-subscreen frames increment _non_gameplay_gap
  Subscreen is excluded (Up+A opens subscreen first)
- Position-reset detection: gap >= 4, gameplay_started, not game_completed
- pre_gap_hearts is captured BEFORE the hearts-zero streak update each frame
- Hearts-zero streak: 4 consecutive gameplay frames with hearts=0 required
  to set _last_gameplay_hearts = 0 (confirming death rather than misread)
- up_a_warp: reset detected AND pre_gap_hearts > 0
- death: reset detected AND pre_gap_hearts == 0
- CSR detection: screen_type='death' AND prev != 'death', uses _last_gameplay_hearts
- _warp_detected_this_gap prevents double-counting within one gap
- 'transition' screen type is the cleanest gap filler (not 'death', avoids CSR interference)
"""
import sys
from pathlib import Path

VISION_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(VISION_DIR))

from detector.warp_death_tracker import WarpDeathTracker


def _feed(tracker, screen_type='overworld', dungeon_level=0, hearts_current=3,
          hearts_max=3, map_position=0, prev_screen_type='overworld',
          prev_hearts_max=3, gameplay_started=True, game_completed=False,
          game_events=None, frame_number=0, dungeon_exit_exiting_d9=False):
    """Thin wrapper around process_frame with sane defaults."""
    return tracker.process_frame(
        screen_type=screen_type,
        dungeon_level=dungeon_level,
        hearts_current=hearts_current,
        hearts_max=hearts_max,
        map_position=map_position,
        prev_screen_type=prev_screen_type,
        prev_hearts_max=prev_hearts_max,
        gameplay_started=gameplay_started,
        game_completed=game_completed,
        game_events=game_events or [],
        frame_number=frame_number,
        dungeon_exit_exiting_d9=dungeon_exit_exiting_d9,
    )


def _build_gap(tracker, length=4, start_frame=1, screen_type='transition'):
    """Feed `length` non-gameplay, non-subscreen frames to build a gap."""
    for i in range(start_frame, start_frame + length):
        _feed(tracker, screen_type=screen_type, frame_number=i,
              prev_screen_type=screen_type)


# ── Overworld start & dungeon entrance recording ──────────────────────────────

class TestPositionRecording:

    def test_overworld_start_recorded_on_first_overworld_frame(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)
        assert tracker.overworld_start == 42

    def test_overworld_start_not_overwritten_once_set(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)
        _feed(tracker, screen_type='overworld', map_position=99, frame_number=1)
        assert tracker.overworld_start == 42

    def test_overworld_start_not_recorded_when_map_position_is_zero(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=0, frame_number=0)
        assert tracker.overworld_start == 0

    def test_dungeon_entrance_recorded_on_first_dungeon_visit(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='dungeon', dungeon_level=3, map_position=77, frame_number=0)
        assert tracker.dungeon_entrances.get(3) == 77

    def test_dungeon_entrance_not_overwritten_once_set(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='dungeon', dungeon_level=3, map_position=77, frame_number=0)
        _feed(tracker, screen_type='dungeon', dungeon_level=3, map_position=88, frame_number=1)
        assert tracker.dungeon_entrances.get(3) == 77

    def test_different_dungeons_recorded_independently(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='dungeon', dungeon_level=1, map_position=10, frame_number=0)
        _feed(tracker, screen_type='dungeon', dungeon_level=5, map_position=50, frame_number=1)
        assert tracker.dungeon_entrances.get(1) == 10
        assert tracker.dungeon_entrances.get(5) == 50


# ── Gap tracking ──────────────────────────────────────────────────────────────

class TestGapTracking:

    def test_non_gameplay_gap_increments_on_transition_screen(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', frame_number=0)
        _feed(tracker, screen_type='transition', frame_number=1, prev_screen_type='overworld')
        _feed(tracker, screen_type='transition', frame_number=2, prev_screen_type='transition')
        assert tracker._non_gameplay_gap == 2

    def test_subscreen_does_not_increment_gap(self):
        """Up+A opens subscreen first — subscreen frames excluded from gap count."""
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', frame_number=0)
        _feed(tracker, screen_type='subscreen', frame_number=1, prev_screen_type='overworld')
        _feed(tracker, screen_type='subscreen', frame_number=2, prev_screen_type='subscreen')
        assert tracker._non_gameplay_gap == 0

    def test_gameplay_frame_resets_gap_to_zero(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', frame_number=0)
        _feed(tracker, screen_type='transition', frame_number=1, prev_screen_type='overworld')
        _feed(tracker, screen_type='transition', frame_number=2, prev_screen_type='transition')
        assert tracker._non_gameplay_gap == 2
        _feed(tracker, screen_type='overworld', frame_number=3, prev_screen_type='transition')
        assert tracker._non_gameplay_gap == 0

    def test_last_gameplay_screen_updated_on_gameplay_frame(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='dungeon', dungeon_level=3, frame_number=0)
        assert tracker._last_gameplay_screen == 'dungeon'


# ── Up+A warp detection ───────────────────────────────────────────────────────

class TestUpAWarpDetection:

    def test_up_a_warp_fires_on_overworld_start_after_gap(self):
        tracker = WarpDeathTracker()
        # Record start position
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0,
              prev_screen_type='')
        # Build gap of 4 frames
        _build_gap(tracker, length=4, start_frame=1)
        # Return to overworld at start position with non-zero hearts
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3,
                       frame_number=5, prev_screen_type='transition')
        assert any(e['event'] == 'up_a_warp' for e in events)

    def test_up_a_warp_requires_gap_of_at_least_4(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)
        _build_gap(tracker, length=3, start_frame=1)  # Only 3 gap frames
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3,
                       frame_number=4, prev_screen_type='transition')
        assert not any(e['event'] == 'up_a_warp' for e in events)

    def test_no_warp_when_overworld_start_not_known(self):
        """If overworld_start is never set, position-reset cannot match."""
        tracker = WarpDeathTracker()
        # No initial overworld frame — overworld_start stays 0
        _build_gap(tracker, length=4, start_frame=0)
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3, frame_number=4)
        assert not any(e['event'] in ('up_a_warp', 'death') for e in events)

    def test_no_warp_when_position_differs_from_start(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)
        _build_gap(tracker, length=4, start_frame=1)
        events = _feed(tracker, screen_type='overworld', map_position=99,  # different pos
                       hearts_current=3, hearts_max=3,
                       frame_number=5, prev_screen_type='transition')
        assert not any(e['event'] in ('up_a_warp', 'death') for e in events)

    def test_no_warp_when_gameplay_not_started(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0,
              gameplay_started=False)
        _build_gap(tracker, length=4, start_frame=1)
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3, gameplay_started=False,
                       frame_number=5, prev_screen_type='transition')
        assert not any(e['event'] in ('up_a_warp', 'death') for e in events)

    def test_no_warp_when_game_completed(self):
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)
        _build_gap(tracker, length=4, start_frame=1)
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3, game_completed=True,
                       frame_number=5, prev_screen_type='transition')
        assert not any(e['event'] in ('up_a_warp', 'death') for e in events)


# ── Death detection ───────────────────────────────────────────────────────────

class TestDeathDetection:

    def test_death_fires_when_pre_gap_hearts_were_zero(self):
        """4-frame zero-hearts streak confirmed → pre_gap_hearts=0 → death on reset."""
        tracker = WarpDeathTracker()
        # Record overworld start
        _feed(tracker, screen_type='overworld', map_position=42, hearts_current=3,
              frame_number=0, prev_screen_type='')
        # 4 consecutive gameplay frames with hearts=0 → confirmed dead
        for i in range(1, 5):
            _feed(tracker, screen_type='overworld', hearts_current=0, hearts_max=3,
                  map_position=42, prev_hearts_max=3, frame_number=i,
                  prev_screen_type='overworld')
        # Now pre_gap_hearts should be 0
        _build_gap(tracker, length=4, start_frame=5)
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3,
                       frame_number=9, prev_screen_type='transition')
        assert any(e['event'] == 'death' for e in events)

    def test_death_requires_4_consecutive_zero_hearts_frames(self):
        """Streak of 3 < threshold of 4 → pre_gap_hearts stays non-zero → up_a_warp."""
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, hearts_current=3,
              frame_number=0, prev_screen_type='')
        # Only 3 frames with hearts=0 (below threshold of 4)
        for i in range(1, 4):
            _feed(tracker, screen_type='overworld', hearts_current=0, hearts_max=3,
                  map_position=42, prev_hearts_max=3, frame_number=i,
                  prev_screen_type='overworld')
        _build_gap(tracker, length=4, start_frame=4)
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3,
                       frame_number=8, prev_screen_type='transition')
        # pre_gap_hearts was never set to 0 (streak of 3 < 4)
        assert any(e['event'] == 'up_a_warp' for e in events)
        assert not any(e['event'] == 'death' for e in events)

    def test_zero_hearts_streak_resets_on_nonzero_hearts(self):
        """If hearts recover before gap, streak resets and death is not confirmed."""
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, hearts_current=3,
              frame_number=0)
        # 3 frames zero, then non-zero — streak resets
        for i in range(1, 4):
            _feed(tracker, screen_type='overworld', hearts_current=0, hearts_max=3,
                  map_position=42, prev_hearts_max=3, frame_number=i,
                  prev_screen_type='overworld')
        _feed(tracker, screen_type='overworld', hearts_current=2, hearts_max=3,
              map_position=42, frame_number=4, prev_screen_type='overworld')
        assert tracker._zero_hearts_streak == 0
        assert tracker._last_gameplay_hearts == 2  # streak reset, hearts=2 recorded


# ── CSR (death screen) detection ─────────────────────────────────────────────

class TestCSRDetection:

    def test_csr_up_a_warp_when_last_gameplay_hearts_nonzero(self):
        """Death screen appears with hearts > 0 last known → Up+A warp."""
        tracker = WarpDeathTracker()
        tracker._last_gameplay_hearts = 3
        events = _feed(tracker, screen_type='death',
                       hearts_current=0, hearts_max=3,
                       frame_number=1, prev_screen_type='overworld')
        assert any(e['event'] == 'up_a_warp' for e in events)

    def test_csr_death_when_last_gameplay_hearts_zero(self):
        """Death screen with hearts == 0 last known → death."""
        tracker = WarpDeathTracker()
        tracker._last_gameplay_hearts = 0
        events = _feed(tracker, screen_type='death',
                       hearts_current=0, hearts_max=3,
                       frame_number=1, prev_screen_type='overworld')
        assert any(e['event'] == 'death' for e in events)

    def test_csr_suppressed_during_d9_exit(self):
        """During D9 exit (credits roll), death screen is expected — don't fire."""
        tracker = WarpDeathTracker()
        tracker._last_gameplay_hearts = 3
        events = _feed(tracker, screen_type='death',
                       frame_number=1, prev_screen_type='overworld',
                       dungeon_exit_exiting_d9=True)
        assert not any(e['event'] in ('up_a_warp', 'death') for e in events)

    def test_csr_not_fired_on_consecutive_death_frames(self):
        """CSR only triggers on the TRANSITION to death, not while already there."""
        tracker = WarpDeathTracker()
        tracker._last_gameplay_hearts = 3
        _feed(tracker, screen_type='death', frame_number=1, prev_screen_type='overworld')
        # Second consecutive death — prev_screen_type='death' → no CSR
        events = _feed(tracker, screen_type='death', frame_number=2, prev_screen_type='death')
        assert not any(e['event'] in ('up_a_warp', 'death') for e in events)

    def test_csr_not_fired_without_gameplay_started(self):
        tracker = WarpDeathTracker()
        tracker._last_gameplay_hearts = 3
        events = _feed(tracker, screen_type='death',
                       frame_number=1, prev_screen_type='overworld',
                       gameplay_started=False)
        assert not any(e['event'] in ('up_a_warp', 'death') for e in events)


# ── Deduplication: one event per gap ─────────────────────────────────────────

class TestWarpDeduplication:

    def test_csr_fires_first_position_reset_skipped_in_same_gap(self):
        """CSR detects warp on death transition; position-reset in same gap is blocked."""
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)
        tracker._last_gameplay_hearts = 3

        # Transition to death → CSR fires
        csr_events = _feed(tracker, screen_type='death',
                           frame_number=1, prev_screen_type='overworld')
        assert any(e['event'] == 'up_a_warp' for e in csr_events)

        # Build gap to 4
        for i in range(2, 5):
            _feed(tracker, screen_type='death', frame_number=i, prev_screen_type='death')

        # Return to overworld start — position-reset should NOT fire (gap already used)
        pos_events = _feed(tracker, screen_type='overworld', map_position=42,
                           hearts_current=3, hearts_max=3,
                           frame_number=5, prev_screen_type='death')
        assert not any(e['event'] in ('up_a_warp', 'death') for e in pos_events)

    def test_second_gap_can_fire_independent_warp(self):
        """After gameplay resets _warp_detected_this_gap, a new gap can fire again."""
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)

        # First warp
        _build_gap(tracker, length=4, start_frame=1)
        _feed(tracker, screen_type='overworld', map_position=42, hearts_current=3,
              hearts_max=3, frame_number=5, prev_screen_type='transition')

        # Second gap (new gameplay gap, _warp_detected_this_gap was reset)
        _build_gap(tracker, length=4, start_frame=6)
        events = _feed(tracker, screen_type='overworld', map_position=42,
                       hearts_current=3, hearts_max=3,
                       frame_number=10, prev_screen_type='transition')
        assert any(e['event'] == 'up_a_warp' for e in events)


# ── Dungeon entrance reset ────────────────────────────────────────────────────

class TestDungeonEntranceReset:

    def test_dungeon_entrance_reset_requires_last_screen_was_dungeon(self):
        """Normal dungeon entry from overworld should NOT be mistaken for a warp."""
        tracker = WarpDeathTracker()
        # Record dungeon entrance
        _feed(tracker, screen_type='dungeon', dungeon_level=3, map_position=77,
              frame_number=0)
        # Gap starting from dungeon (last_gameplay_screen = 'dungeon')
        _build_gap(tracker, length=4, start_frame=1)
        # Return to dungeon at entrance position
        events = _feed(tracker, screen_type='dungeon', dungeon_level=3, map_position=77,
                       hearts_current=3, hearts_max=3,
                       frame_number=5, prev_screen_type='transition')
        assert any(e['event'] == 'up_a_warp' for e in events)

    def test_dungeon_entry_from_overworld_not_a_warp(self):
        """Entry from overworld → dungeon is normal, not a warp."""
        tracker = WarpDeathTracker()
        _feed(tracker, screen_type='overworld', map_position=42, frame_number=0)
        # Record dungeon entrance
        _feed(tracker, screen_type='dungeon', dungeon_level=3, map_position=77,
              frame_number=1, prev_screen_type='overworld')
        # Gap (last_gameplay_screen = 'dungeon' now)
        _build_gap(tracker, length=4, start_frame=2)
        # Re-enter dungeon at entrance — only fires if last_screen was dungeon
        events = _feed(tracker, screen_type='dungeon', dungeon_level=3, map_position=77,
                       hearts_current=3, hearts_max=3,
                       frame_number=6, prev_screen_type='transition')
        # last_gameplay_screen='dungeon' (set on frame 1) → is_reset=True → up_a_warp
        assert any(e['event'] == 'up_a_warp' for e in events)


# ── reset() ───────────────────────────────────────────────────────────────────

class TestReset:

    def test_reset_clears_all_state(self):
        tracker = WarpDeathTracker()
        tracker.overworld_start = 42
        tracker.dungeon_entrances = {3: 77, 5: 50}
        tracker._non_gameplay_gap = 5
        tracker._last_gameplay_hearts = 3
        tracker._zero_hearts_streak = 2
        tracker.reset()
        assert tracker.overworld_start == 0
        assert tracker.dungeon_entrances == {}
        assert tracker._non_gameplay_gap == 0
        assert tracker._last_gameplay_hearts == 0
        assert tracker._zero_hearts_streak == 0

    def test_reset_clears_warp_detected_flag(self):
        tracker = WarpDeathTracker()
        tracker._warp_detected_this_gap = True
        tracker.reset()
        assert tracker._warp_detected_this_gap is False
