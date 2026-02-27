"""Warp/death tracker: detects Up+A warps and deaths from gameplay gaps.

Tracks non-gameplay gaps (consecutive non-subscreen, non-gameplay frames)
and detects when gameplay resumes at a known reset position (overworld start
or dungeon entrance). Also handles the CSR screen-based fallback detection
and the hearts-zero streak guard against false deaths.
"""

from typing import Callable


class WarpDeathTracker:
    """Detects Up+A warps and deaths via position-reset and CSR patterns.

    Public attributes overworld_start and dungeon_entrances are read by
    the coordinator for Rule 10 (map adjacency checks).
    """

    def __init__(
        self,
        any_roads: set[int] | None = None,
    ):
        self.overworld_start: int = 0
        self.dungeon_entrances: dict[int, int] = {}

        # any_roads is kept for future use (Rule 10 in coordinator uses it)
        self.any_roads: set[int] = any_roads or set()

        # Hearts-zero streak tracking
        self._last_gameplay_hearts: int = 0
        self._zero_hearts_streak: int = 0

        # Non-gameplay gap tracking
        self._non_gameplay_gap: int = 0
        self._last_gameplay_position: int = 0
        self._last_gameplay_screen: str = ''
        self._warp_detected_this_gap: bool = False

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def process_frame(
        self,
        screen_type: str,
        dungeon_level: int,
        hearts_current: int,
        hearts_max: int,
        map_position: int,
        prev_screen_type: str,
        prev_hearts_max: int,
        gameplay_started: bool,
        game_completed: bool,
        game_events: list[dict],
        frame_number: int,
        dungeon_exit_exiting_d9: bool = False,
    ) -> list[dict]:
        """Process one frame. Returns list of game event dicts (death, up_a_warp).

        Also updates overworld_start, dungeon_entrances, and internal gap/
        streak state in place.
        """
        events: list[dict] = []

        # ─── Save pre-update hearts for death vs Up+A determination ───
        # Must capture BEFORE the hearts-zero streak update below.
        pre_gap_hearts = self._last_gameplay_hearts

        # ─── Hearts-zero streak tracking ───
        # Require 4 consecutive gameplay frames with hearts=0 AND consistent
        # hearts_max to confirm Link actually died (not a misclassified frame).
        if screen_type in ('overworld', 'dungeon', 'cave'):
            if hearts_current > 0:
                self._last_gameplay_hearts = hearts_current
                self._zero_hearts_streak = 0
            elif prev_hearts_max > 0 and hearts_max >= prev_hearts_max:
                # hearts_max is consistent — HUD was present, 0 is real
                self._zero_hearts_streak += 1
                if self._zero_hearts_streak >= 4:
                    self._last_gameplay_hearts = 0
            # else: hearts_max dropped (transition frame with default values) — ignore

        # ─── Position-reset warp/death detection ───
        if screen_type in ('overworld', 'dungeon', 'cave'):
            if (
                self._non_gameplay_gap >= 4
                and gameplay_started
                and not game_completed
                and not self._warp_detected_this_gap
            ):
                new_pos = map_position
                is_reset = False

                if (
                    screen_type == 'overworld'
                    and self.overworld_start > 0
                    and new_pos == self.overworld_start
                ):
                    is_reset = True
                elif screen_type == 'dungeon' and dungeon_level > 0:
                    entrance = self.dungeon_entrances.get(dungeon_level, 0)
                    if (
                        entrance > 0
                        and new_pos == entrance
                        and self._last_gameplay_screen == 'dungeon'
                    ):
                        is_reset = True

                # Don't fire if triforce was just inferred this frame
                triforce_just_inferred = (
                    game_events
                    and game_events[-1].get('event') == 'triforce_inferred'
                    and game_events[-1].get('frame') == frame_number
                )

                if is_reset and not triforce_just_inferred:
                    self._warp_detected_this_gap = True
                    if pre_gap_hearts == 0:
                        events.append({
                            'frame': frame_number,
                            'event': 'death',
                            'description': (
                                f'Link died (respawned at reset position '
                                f'after {self._non_gameplay_gap} frame gap)'
                            ),
                            'dungeon_level': dungeon_level,
                        })
                    else:
                        events.append({
                            'frame': frame_number,
                            'event': 'up_a_warp',
                            'description': (
                                f'Up+A warp (hearts {pre_gap_hearts}, '
                                f'reset after {self._non_gameplay_gap} frame gap)'
                            ),
                            'dungeon_level': dungeon_level,
                        })

        # ─── CSR-based death/warp detection ───
        if (
            screen_type == 'death'
            and prev_screen_type != 'death'
            and not game_completed
            and gameplay_started
            and not self._warp_detected_this_gap
            and not dungeon_exit_exiting_d9
        ):
            self._warp_detected_this_gap = True
            if self._last_gameplay_hearts == 0:
                events.append({
                    'frame': frame_number,
                    'event': 'death',
                    'description': (
                        'Link died (hearts reached 0, CSR screen detected)'
                    ),
                    'dungeon_level': dungeon_level,
                })
            else:
                events.append({
                    'frame': frame_number,
                    'event': 'up_a_warp',
                    'description': (
                        f'Up+A warp (hearts were {self._last_gameplay_hearts}, '
                        f'CSR screen detected)'
                    ),
                    'dungeon_level': dungeon_level,
                })

        # ─── Update start/entrance positions ───
        # Must happen AFTER position-reset detection (uses old values)
        # and BEFORE the coordinator's Rule 10 adjacency check (reads new values).
        if map_position > 0:
            if screen_type == 'overworld' and self.overworld_start == 0:
                self.overworld_start = map_position
            if (
                screen_type == 'dungeon'
                and dungeon_level > 0
                and dungeon_level not in self.dungeon_entrances
            ):
                self.dungeon_entrances[dungeon_level] = map_position

        # ─── Update non-gameplay gap and last gameplay state ───
        if screen_type in ('overworld', 'dungeon', 'cave'):
            self._non_gameplay_gap = 0
            self._warp_detected_this_gap = False
            self._last_gameplay_position = map_position
            self._last_gameplay_screen = screen_type
        elif screen_type != 'subscreen':
            self._non_gameplay_gap += 1

        return events

    def reset(self) -> None:
        """Clear all state."""
        self.overworld_start = 0
        self.dungeon_entrances.clear()
        self._last_gameplay_hearts = 0
        self._zero_hearts_streak = 0
        self._non_gameplay_gap = 0
        self._last_gameplay_position = 0
        self._last_gameplay_screen = ''
        self._warp_detected_this_gap = False
