"""Dungeon exit tracker: infers triforce collection and game completion.

Monitors the sequence: dungeon → non-gameplay transition → overworld.
If hearts increase and reach max during the transition, a triforce was
collected. If D9 exit persists >30 frames, the game is complete.
"""

from enum import Enum, auto
from typing import Callable


class _ExitPhase(Enum):
    """Phases of the dungeon exit sequence detector."""
    IDLE = auto()
    EXITING = auto()


class DungeonExitTracker:
    """Tracks dungeon exits to infer triforce collection and game completion.

    The coordinator (GameLogicValidator) owns the canonical triforce_inferred
    list and passes it in via the constructor so both this tracker and
    ItemHoldTracker share a single reference.
    """

    def __init__(
        self,
        triforce_inferred: list[bool] | None = None,
        record_anomaly_fn: Callable | None = None,
    ):
        # Shared list — coordinator owns it; all writes are in-place
        self.triforce_inferred: list[bool] = (
            triforce_inferred if triforce_inferred is not None else [False] * 8
        )
        self.game_completed: bool = False

        self._exit_phase = _ExitPhase.IDLE
        self._exit_dungeon: int = 0
        self._exit_start_frame: int = 0
        self._exit_hearts_start: int = 0
        self._exit_hearts_min: int = 99
        self._exit_death_frames: int = 0
        self._exit_saw_death_menu: bool = False

        self._record_anomaly: Callable = record_anomaly_fn or (lambda *a, **kw: None)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    @property
    def is_exiting_d9(self) -> bool:
        """True while in the EXITING phase for dungeon 9 (credits suppressor)."""
        return (
            self._exit_phase == _ExitPhase.EXITING
            and self._exit_dungeon == 9
        )

    def process_frame(
        self,
        screen_type: str,
        dungeon_level: int,
        hearts_current: int,
        hearts_max: int,
        prev_screen_type: str,
        prev_dungeon_level: int,
        frame_number: int,
    ) -> list[dict]:
        """Process one frame.

        Returns list of game event dicts (triforce_inferred, game_complete).
        Also updates self.triforce_inferred and self.game_completed in place.
        """
        events: list[dict] = []
        screen = screen_type

        if self._exit_phase == _ExitPhase.IDLE:
            # Transition: dungeon → non-gameplay screen
            if (
                prev_screen_type == 'dungeon'
                and prev_dungeon_level > 0
                and screen not in ('dungeon', 'cave', 'overworld', 'subscreen')
            ):
                self._exit_phase = _ExitPhase.EXITING
                self._exit_dungeon = prev_dungeon_level
                self._exit_start_frame = frame_number
                # hearts_current has already been carry-forwarded by the coordinator
                self._exit_hearts_start = hearts_current
                self._exit_hearts_min = hearts_current
                self._exit_death_frames = 1 if screen == 'death' else 0
                self._exit_saw_death_menu = False

        elif self._exit_phase == _ExitPhase.EXITING:
            self._exit_hearts_min = min(self._exit_hearts_min, hearts_current)

            # Track consecutive 'death' screen frames — 3+ = death menu
            if screen == 'death':
                self._exit_death_frames += 1
                if self._exit_death_frames >= 3:
                    self._exit_saw_death_menu = True
            else:
                self._exit_death_frames = 0

            exit_frames = frame_number - self._exit_start_frame
            dungeon = self._exit_dungeon

            # Resolution: arrived at overworld
            if screen == 'overworld':
                hearts_increased = hearts_current > self._exit_hearts_start
                hearts_at_max = hearts_current >= hearts_max

                if (
                    hearts_increased
                    and hearts_at_max
                    and self._exit_hearts_min > 0
                    and not self._exit_saw_death_menu
                    and 1 <= dungeon <= 8
                ):
                    idx = dungeon - 1
                    if not self.triforce_inferred[idx]:
                        self.triforce_inferred[idx] = True
                        desc = (
                            f'Triforce piece {dungeon} inferred '
                            f'(hearts {self._exit_hearts_start}'
                            f'->{hearts_current}, '
                            f'exit took {exit_frames} frames)'
                        )
                        events.append({
                            'frame': frame_number,
                            'event': 'triforce_inferred',
                            'description': desc,
                            'dungeon_level': dungeon,
                        })
                        self._record_anomaly(
                            frame_number, 'triforce_inferred', desc,
                            severity='info')
                self._reset_exit()

            # Resolution: returned to dungeon (was just a transition/flicker)
            elif screen in ('dungeon', 'cave'):
                self._reset_exit()

            # Game completion: D9 exit persists for >30 frames
            elif (
                dungeon == 9
                and exit_frames > 30
                and self._exit_hearts_min > 0
                and not self.game_completed
            ):
                self.game_completed = True
                desc = (
                    f'Game completed! Exited D9 after '
                    f'{exit_frames} frames of credits'
                )
                events.append({
                    'frame': self._exit_start_frame,
                    'event': 'game_complete',
                    'description': desc,
                    'dungeon_level': 9,
                })
                self._record_anomaly(
                    self._exit_start_frame, 'game_complete',
                    f'Game completed (D9 exit, {exit_frames} frames of credits)',
                    severity='info')
                self._reset_exit()

            # Timeout: too long without resolution
            elif exit_frames > 40:
                self._reset_exit()

        return events

    def reset(self) -> None:
        """Clear all state (including triforce_inferred in place)."""
        for i in range(8):
            self.triforce_inferred[i] = False
        self.game_completed = False
        self._reset_exit()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _reset_exit(self) -> None:
        """Reset the exit-sequence tracking only (not triforce/game_completed)."""
        self._exit_phase = _ExitPhase.IDLE
        self._exit_dungeon = 0
        self._exit_start_frame = 0
        self._exit_hearts_start = 0
        self._exit_hearts_min = 99
        self._exit_death_frames = 0
        self._exit_saw_death_menu = False
