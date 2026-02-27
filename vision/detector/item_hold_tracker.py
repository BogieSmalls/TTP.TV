"""Item-hold tracker: detects triforce collection via item-hold animation.

The triforce animation color-cycles (orange <-> blue), creating an
intermittent detection pattern. Ground triforces are consistently orange.
We require both detections AND gaps (non-detected frames) to confirm the
color-cycling flash pattern unique to the held item animation. Triforce
confirmation requires hearts reaching max (triforce refills hearts to full).
"""

from typing import Callable


class ItemHoldTracker:
    """Tracks item-hold animation (Link holding item overhead) to detect triforce.

    The coordinator (GameLogicValidator) owns the canonical triforce_inferred
    list and passes it in via the constructor so both this tracker and
    DungeonExitTracker share a single reference.
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
        self._record_anomaly: Callable = record_anomaly_fn or (lambda *a, **kw: None)

        # Item-hold detection state (13 variables)
        self._item_hold_type: str | None = None
        self._item_hold_y: int = 0
        self._item_hold_y_min: int = 999
        self._item_hold_y_max: int = 0
        self._item_hold_detected: int = 0
        self._item_hold_total: int = 0
        self._item_hold_gaps: int = 0
        self._item_hold_start_frame: int = 0
        self._item_hold_last_frame: int = 0
        self._item_hold_dungeon: int = 0
        self._item_hold_fired: bool = False
        self._item_hold_hearts_start: int = 0
        self._item_hold_pending: bool = False

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def process_frame(
        self,
        detected_item: str | None,
        detected_item_y: int,
        screen_type: str,
        dungeon_level: int,
        hearts_current: int,
        hearts_max: int,
        frame_number: int,
    ) -> list[dict]:
        """Process one frame. Returns list of game event dicts (triforce_inferred)."""
        events: list[dict] = []
        item = detected_item
        item_y = detected_item_y
        screen = screen_type

        # If NOT currently tracking, only start in dungeon/cave
        if self._item_hold_detected == 0 and not self._item_hold_pending:
            if screen not in ('dungeon', 'cave') or dungeon_level == 0:
                return events

        # If pending (threshold met, waiting for hearts confirmation)
        if self._item_hold_pending:
            frames_since = frame_number - self._item_hold_last_frame
            if (
                hearts_current > self._item_hold_hearts_start
                and hearts_current >= hearts_max
                and hearts_max > 0
            ):
                events.extend(
                    self._fire_triforce_event(hearts_current, hearts_max, frame_number)
                )
                self._reset_item_hold()
                return events
            if frames_since > 20:
                self._reset_item_hold()
                return events
            return events

        if item is not None:
            if self._item_hold_type == item and self._item_hold_detected > 0:
                # Same item already being tracked — check y stability
                new_y_min = min(self._item_hold_y_min, item_y)
                new_y_max = max(self._item_hold_y_max, item_y)
                if new_y_max - new_y_min <= 6:
                    # Stable position — accumulate
                    self._item_hold_detected += 1
                    self._item_hold_total += 1
                    self._item_hold_last_frame = frame_number
                    self._item_hold_y_min = new_y_min
                    self._item_hold_y_max = new_y_max
                else:
                    # y drifted too far — not a stable hold; reset and
                    # re-evaluate as a potential new start
                    if screen in ('dungeon', 'cave') and dungeon_level > 0:
                        self._start_item_hold(
                            item, item_y, frame_number, dungeon_level, hearts_current)
                    else:
                        self._reset_item_hold()
                    return events
            elif screen in ('dungeon', 'cave') and dungeon_level > 0:
                # Different item or first detection — start new tracking
                self._start_item_hold(
                    item, item_y, frame_number, dungeon_level, hearts_current)
            else:
                return events
        else:
            # No item detected this frame
            if self._item_hold_detected > 0:
                if frame_number - self._item_hold_last_frame > 12:
                    # Too long without detection — animation is over
                    if self._item_hold_met_threshold():
                        self._item_hold_pending = True
                        # Check hearts immediately in case they already increased
                        if (
                            hearts_current > self._item_hold_hearts_start
                            and hearts_current >= hearts_max
                            and hearts_max > 0
                        ):
                            events.extend(
                                self._fire_triforce_event(
                                    hearts_current, hearts_max, frame_number)
                            )
                            self._reset_item_hold()
                    else:
                        self._reset_item_hold()
                else:
                    # Gap frame — evidence of color cycling
                    self._item_hold_total += 1
                    self._item_hold_gaps += 1
            return events

        # item is not None and tracking state was just updated above.
        # Check if threshold is met and hearts have already reached max.
        if self._item_hold_met_threshold() and not self._item_hold_fired:
            if (
                hearts_current > self._item_hold_hearts_start
                and hearts_current >= hearts_max
                and hearts_max > 0
            ):
                events.extend(
                    self._fire_triforce_event(hearts_current, hearts_max, frame_number)
                )
                self._reset_item_hold()

        return events

    def reset(self) -> None:
        """Clear all state (including triforce_inferred in place)."""
        for i in range(8):
            self.triforce_inferred[i] = False
        self._reset_item_hold()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _item_hold_met_threshold(self) -> bool:
        """Check if item-hold detection meets minimum thresholds."""
        return (
            not self._item_hold_fired
            and self._item_hold_detected >= 4
            and self._item_hold_gaps >= 1
            and self._item_hold_total >= 8
        )

    def _start_item_hold(
        self,
        item: str,
        item_y: int,
        frame_number: int,
        dungeon_level: int,
        hearts: int,
    ) -> None:
        """Start tracking a new item-hold animation."""
        self._item_hold_type = item
        self._item_hold_y = item_y
        self._item_hold_y_min = item_y
        self._item_hold_y_max = item_y
        self._item_hold_detected = 1
        self._item_hold_total = 1
        self._item_hold_gaps = 0
        self._item_hold_start_frame = frame_number
        self._item_hold_last_frame = frame_number
        self._item_hold_dungeon = dungeon_level
        self._item_hold_fired = False
        self._item_hold_hearts_start = hearts
        self._item_hold_pending = False

    def _fire_triforce_event(
        self,
        hearts_current: int,
        hearts_max: int,
        frame_number: int,
    ) -> list[dict]:
        """Confirm and record a triforce detection from item-hold animation.

        Returns a list with one event dict, or empty list if not applicable.
        """
        dungeon = self._item_hold_dungeon
        if self._item_hold_type != 'triforce' or not (1 <= dungeon <= 8):
            return []
        idx = dungeon - 1
        if self.triforce_inferred[idx] or self._item_hold_fired:
            return []

        self._item_hold_fired = True
        self.triforce_inferred[idx] = True

        y_spread = self._item_hold_y_max - self._item_hold_y_min
        desc = (
            f'Triforce piece {dungeon} detected '
            f'(item-hold + hearts refill, '
            f'{self._item_hold_detected} det, '
            f'{self._item_hold_gaps} gaps, '
            f'hearts {self._item_hold_hearts_start}'
            f'->{hearts_current}/{hearts_max})'
        )
        self._record_anomaly(
            self._item_hold_start_frame, 'triforce_item_hold',
            f'Triforce piece {dungeon} via item-hold '
            f'(hearts {self._item_hold_hearts_start}'
            f'->{hearts_current}/{hearts_max}, '
            f'{self._item_hold_detected} det, '
            f'{self._item_hold_gaps} gaps, y\u00b1{y_spread}px)',
            severity='info')

        return [{
            'frame': self._item_hold_start_frame,
            'event': 'triforce_inferred',
            'description': desc,
            'dungeon_level': dungeon,
        }]

    def _reset_item_hold(self) -> None:
        """Reset item-hold tracking state."""
        self._item_hold_type = None
        self._item_hold_y = 0
        self._item_hold_y_min = 999
        self._item_hold_y_max = 0
        self._item_hold_detected = 0
        self._item_hold_total = 0
        self._item_hold_gaps = 0
        self._item_hold_start_frame = 0
        self._item_hold_last_frame = 0
        self._item_hold_dungeon = 0
        self._item_hold_fired = False
        self._item_hold_hearts_start = 0
        self._item_hold_pending = False
