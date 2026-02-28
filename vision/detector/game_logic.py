"""Game-logic validation for Zelda 1 state transitions.

Validates detected state changes against Zelda 1 game rules to filter
impossible transitions. For example:
- Triforce pieces cannot be uncollected
- Sword level can only increase
- Certain items cannot be lost once acquired
- Max hearts can only increase (via heart containers)

This reduces false detections by rejecting state changes that violate
known game mechanics.
"""

from dataclasses import asdict

from .dungeon_exit_tracker import DungeonExitTracker
from .inventory_accumulator import InventoryAccumulator
from .item_hold_tracker import ItemHoldTracker
from .nes_state import GameState
from .warp_death_tracker import WarpDeathTracker
from .zelda_map import is_adjacent, OVERWORLD_COLS, DUNGEON_COLS


# Items that cannot be lost once acquired (one-time pickups)
NON_LOSABLE_ITEMS = frozenset({
    'raft', 'ladder', 'book', 'power_bracelet', 'magic_key',
})

# Items that upgrade in-place (the base item can be "lost" when upgraded)
UPGRADE_CHAINS = {
    'boomerang': 'magic_boomerang',
    'blue_candle': 'red_candle',
    'letter': 'blue_potion',
    'blue_potion': 'red_potion',
    'blue_ring': 'red_ring',
}

# Known bomb capacity tiers in Zelda 1
BOMB_TIERS = [8, 12, 16]

# Any Roads — cave-based warp points in Z1R.
DEFAULT_ANY_ROADS: set[int] = set()

# Fields readable only during gameplay (overworld/dungeon/cave) via HUD.
_HUD_FIELDS = frozenset({
    'hearts_current', 'hearts_max', 'has_half_heart', 'rupees', 'keys',
    'bombs', 'has_master_key', 'gannon_nearby', 'map_position',
    'dungeon_level', 'bomb_max', 'sword_level',
})

# Fields readable only on the subscreen (inventory/triforce)
_SUBSCREEN_FIELDS = frozenset({'items', 'triforce'})

# Fields readable on both gameplay and subscreen, but not title/death
_DUAL_FIELDS = frozenset({'b_item'})

# Streak-validated HUD fields — require N consecutive gameplay frames showing
# the same new value before accepting a change.
_STREAK_THRESHOLDS: dict[str, int] = {
    'gannon_nearby': 2,
}


class StaircaseItemTracker:
    """Tracks items on dungeon staircase pedestals across frames.

    State machine:
        idle -> item_visible: item detected for 2+ consecutive frames
        item_visible -> acquired: item gone for 3+ consecutive frames (emits event)
        acquired -> idle: after emitting event
    """

    _VISIBLE_THRESHOLD = 2    # consecutive frames to confirm item presence
    _ACQUIRED_THRESHOLD = 3   # consecutive frames gone to confirm pickup

    def __init__(self):
        self._state: str = 'idle'
        self._item_name: str | None = None
        self._seen_count: int = 0
        self._gone_count: int = 0

    def process(self, detected_item: str | None, screen_type: str,
                dungeon_level: int) -> list[dict]:
        """Process one frame. Returns list of events (may be empty)."""
        events: list[dict] = []

        # Reset if not in dungeon
        if screen_type != 'dungeon':
            self._reset()
            return events

        # Triforce is handled by a separate tracker
        is_staircase_item = (detected_item is not None
                             and detected_item != 'triforce')

        if self._state == 'idle':
            if is_staircase_item:
                self._seen_count += 1
                self._item_name = detected_item
                if self._seen_count >= self._VISIBLE_THRESHOLD:
                    self._state = 'item_visible'
            else:
                self._seen_count = 0
                self._item_name = None

        elif self._state == 'item_visible':
            if is_staircase_item:
                self._gone_count = 0
                self._item_name = detected_item
            else:
                self._gone_count += 1
                if self._gone_count >= self._ACQUIRED_THRESHOLD:
                    events.append({
                        'type': 'staircase_item_acquired',
                        'item': self._item_name,
                        'dungeon_level': dungeon_level,
                    })
                    self._reset()

        return events

    def _reset(self) -> None:
        self._state = 'idle'
        self._item_name = None
        self._seen_count = 0
        self._gone_count = 0


class FloorItemTracker:
    """Tracks items on dungeon/overworld floors across frames.

    Emits item_drop events when new items appear and item_pickup events
    when tracked items disappear.

    Handles room transitions gracefully: items visible on the first few
    frames after entering a room are treated as pre-existing (no item_drop
    event).  A grace period of _ROOM_ENTRY_GRACE frames absorbs initial
    detections as the baseline.

    Items must be confirmed present for _CONFIRM_FRAMES consecutive frames
    before being added to the tracked set (prevents transient false positives).
    Items must be absent for _GONE_FRAMES consecutive frames before being
    considered picked up (prevents flicker from detection noise).
    """

    _ROOM_ENTRY_GRACE = 3   # frames after room change to absorb baseline
    _CONFIRM_FRAMES = 2     # consecutive frames to confirm a new item
    _GONE_FRAMES = 3        # consecutive absent frames to confirm pickup
    _MATCH_DIST = 12        # max pixel distance to consider same item

    def __init__(self):
        self._tracked: list[dict] = []       # confirmed items: {name, x, y}
        self._pending: list[dict] = []       # candidates: {name, x, y, count}
        self._gone_counts: dict[int, int] = {}  # tracked_idx -> absent streak
        self._grace_remaining: int = 0
        self._prev_screen_key: tuple = ()    # (screen_type, dungeon_level, map_position)

    def process(self, floor_items: list[dict], screen_type: str,
                dungeon_level: int, map_position: int,
                frame_number: int) -> list[dict]:
        """Process one frame of floor item detections.

        Args:
            floor_items: List of {'name', 'x', 'y', 'score'} dicts from
                         FloorItemDetector (may be empty).
            screen_type: Current screen classification.
            dungeon_level: Current dungeon level (0=overworld).
            map_position: Current minimap room position.
            frame_number: Current frame number for event timestamps.

        Returns:
            List of event dicts (item_drop / item_pickup).
        """
        events: list[dict] = []

        # Not on a gameplay screen — clear state
        if screen_type not in ('dungeon', 'overworld'):
            self._reset()
            return events

        # Detect room change — reset tracking and start grace period
        screen_key = (screen_type, dungeon_level, map_position)
        if screen_key != self._prev_screen_key:
            self._reset()
            self._prev_screen_key = screen_key
            self._grace_remaining = self._ROOM_ENTRY_GRACE

        # During grace period: absorb detections as baseline
        if self._grace_remaining > 0:
            self._grace_remaining -= 1
            if self._grace_remaining == 0:
                # After grace period ends, adopt current items as baseline
                for fi in floor_items:
                    self._tracked.append({
                        'name': fi['name'], 'x': fi['x'], 'y': fi['y'],
                    })
            return events

        current_set = [(fi['name'], fi['x'], fi['y']) for fi in floor_items]

        # --- Check for disappeared items (pickup) ---
        new_tracked = []
        for idx, item in enumerate(self._tracked):
            still_present = any(
                self._match(item, cn, cx, cy) for cn, cx, cy in current_set
            )
            if still_present:
                self._gone_counts.pop(idx, None)
                new_tracked.append(item)
            else:
                gone = self._gone_counts.get(idx, 0) + 1
                self._gone_counts[idx] = gone
                if gone >= self._GONE_FRAMES:
                    events.append({
                        'frame': frame_number,
                        'event': 'item_pickup',
                        'description': f'Picked up floor item: {item["name"]}',
                        'item': item['name'],
                        'x': item['x'], 'y': item['y'],
                        'dungeon_level': dungeon_level,
                    })
                    self._gone_counts.pop(idx, None)
                    # Don't add to new_tracked — item is gone
                else:
                    new_tracked.append(item)
        self._tracked = new_tracked

        # Rebuild gone_counts with new indices
        old_gone = dict(self._gone_counts)
        self._gone_counts = {}
        for new_idx, item in enumerate(self._tracked):
            for old_idx, count in old_gone.items():
                if old_idx < len(self._tracked) and self._tracked[new_idx] is item:
                    self._gone_counts[new_idx] = count

        # --- Check for new items (drop) ---
        for cn, cx, cy in current_set:
            # Already tracked?
            if any(self._match(t, cn, cx, cy) for t in self._tracked):
                continue

            # Already pending?
            matched_pending = False
            for p in self._pending:
                if self._match(p, cn, cx, cy):
                    p['count'] += 1
                    matched_pending = True
                    if p['count'] >= self._CONFIRM_FRAMES:
                        self._tracked.append({
                            'name': cn, 'x': cx, 'y': cy,
                        })
                        events.append({
                            'frame': frame_number,
                            'event': 'item_drop',
                            'description': f'Floor item appeared: {cn}',
                            'item': cn,
                            'x': cx, 'y': cy,
                            'dungeon_level': dungeon_level,
                        })
                        self._pending.remove(p)
                    break

            if not matched_pending:
                self._pending.append({
                    'name': cn, 'x': cx, 'y': cy, 'count': 1,
                })

        # Age out pending items not seen this frame
        self._pending = [
            p for p in self._pending
            if any(self._match(p, cn, cx, cy) for cn, cx, cy in current_set)
        ]

        return events

    def _match(self, item: dict, name: str, x: int, y: int) -> bool:
        """Check if a detection matches a tracked/pending item by position."""
        return (abs(item['x'] - x) < self._MATCH_DIST
                and abs(item['y'] - y) < self._MATCH_DIST)

    def _reset(self) -> None:
        self._tracked.clear()
        self._pending.clear()
        self._gone_counts.clear()
        self._grace_remaining = 0


class PlayerItemTracker:
    """Tracks items the player has obtained. State only ever increases.

    Vocabulary: Vision *identifies* items; this tracker records that the player
    has *obtained* them.
    """

    # One-way upgrade pairs: obtaining the right item clears the left
    _UPGRADES: list[tuple[str, str]] = [
        ('blue_candle', 'red_candle'),
        ('blue_ring', 'red_ring'),
        ('boomerang', 'magical_boomerang'),
    ]

    def __init__(self) -> None:
        self._items: dict[str, bool] = {}
        self.sword_level: int = 0    # 0–3, never decreases
        self.arrows_level: int = 0   # 0=none, 1=wooden, 2=silver, never decreases

    def update_from_b_item(self, b_item: str | None) -> None:
        """Process a newly identified B-item slot value."""
        if b_item is None:
            return
        self._set(b_item, True)
        if b_item == 'arrows':
            # Arrows in B-slot definitively means Bow is in inventory
            self._set('bow', True)
            # At minimum wooden arrows (level 1)
            self.arrows_level = max(self.arrows_level, 1)

    def update_item_obtained(self, item: str) -> None:
        """Record that the player obtained a specific item."""
        self._set(item, True)

    def update_sword_level(self, level: int) -> None:
        """Sword level never decreases."""
        self.sword_level = max(self.sword_level, level)

    def update_arrows_level(self, level: int) -> None:
        """Arrows level never decreases. Does NOT set bow."""
        self.arrows_level = max(self.arrows_level, level)

    def merge_subscreen(self, subscreen_items: dict[str, bool]) -> None:
        """Merge a subscreen scan: True values override; False values ignored if we already know True."""
        for item, value in subscreen_items.items():
            if value:
                self._set(item, True)
            # False: only accept if we have no prior True
            elif not self._items.get(item, False):
                self._items[item] = False

    def get_items(self) -> dict[str, bool]:
        return dict(self._items)

    def _set(self, item: str, value: bool) -> None:
        self._items[item] = value
        if not value:
            return
        # Apply one-way upgrades: obtaining the superior item clears the inferior
        for inferior, superior in self._UPGRADES:
            if item == superior:
                self._items[inferior] = False


class GameLogicValidator:
    """Validates state transitions against Zelda 1 game rules.

    Maintains the last validated state and filters impossible changes
    from new detections.
    """

    ANOMALY_DEBOUNCE_FRAMES = 20

    def __init__(self, any_roads: set[int] | None = None):
        self.prev: GameState | None = None
        self.anomalies: list[dict] = []
        self.any_roads: set[int] = any_roads or DEFAULT_ANY_ROADS

        # Cave traversal tracking (for Rule 10 Any Roads detection)
        self._pre_cave_position: int = 0

        # Debounce: non-losable items only fire once per session
        self._item_anomaly_logged: set[str] = set()
        # Debounce: general anomaly cooldown (detector -> last frame logged)
        self._last_anomaly_frame: dict[str, int] = {}

        # Heart container tracking per dungeon
        self._dungeon_heart_frame: dict[int, int] = {}

        # Canonical triforce_inferred list — owned here, shared with both trackers
        self._triforce_inferred: list[bool] = [False] * 8

        # Sub-trackers
        self._dungeon_exit_tracker = DungeonExitTracker(
            triforce_inferred=self._triforce_inferred,
            record_anomaly_fn=self._record_anomaly,
        )
        self._item_hold_tracker = ItemHoldTracker(
            triforce_inferred=self._triforce_inferred,
            record_anomaly_fn=self._record_anomaly,
        )
        self._warp_death_tracker = WarpDeathTracker(
            any_roads=any_roads,
        )
        self._staircase_tracker = StaircaseItemTracker()
        self._floor_item_tracker = FloorItemTracker()
        self._inventory_accumulator = InventoryAccumulator()

        # Game events list
        self.game_events: list[dict] = []

        # Gameplay started flag — suppresses attract-mode false deaths.
        self._gameplay_started: bool = False
        self._gameplay_streak: int = 0
        self._last_title_frame: int = 0

        # Ganon fight tracking
        self._ganon_seen: bool = False

        # Generalized streak validation for HUD fields
        self._field_streaks: dict[str, tuple] = {}

        # Dungeon first visit tracking
        self._dungeons_visited: set[int] = set()

        # B-item change tracking
        self._last_b_item: str | None = None

    def validate(self, current: GameState, frame_number: int = 0) -> GameState:
        """Apply game logic constraints to filter impossible transitions.

        Args:
            current: Newly detected game state.
            frame_number: Current frame number (for anomaly tracking).

        Returns:
            Validated GameState with impossible changes reverted.
        """
        events_start = len(self.game_events)

        if self.prev is None:
            self.prev = current
            # Initialise warp tracker's start/entrance on first frame
            if current.map_position > 0:
                if current.screen_type == 'overworld':
                    self._warp_death_tracker.overworld_start = current.map_position
                if current.screen_type == 'dungeon' and current.dungeon_level > 0:
                    self._warp_death_tracker.dungeon_entrances[current.dungeon_level] = (
                        current.map_position
                    )
            return current

        prev = self.prev
        d = asdict(current)

        # ─── Carry forward non-readable fields ───
        if current.screen_type not in ('overworld', 'dungeon', 'cave'):
            for fld in _HUD_FIELDS:
                d[fld] = getattr(prev, fld)
        if current.screen_type != 'subscreen':
            d['items'] = dict(prev.items)
            d['triforce'] = list(prev.triforce)
        if current.screen_type not in ('overworld', 'dungeon', 'cave', 'subscreen'):
            for fld in _DUAL_FIELDS:
                d[fld] = getattr(prev, fld)

        # ─── Streak validation for HUD fields ───
        if current.screen_type in ('overworld', 'dungeon', 'cave'):
            for fld, threshold in _STREAK_THRESHOLDS.items():
                raw_value = d[fld]
                prev_value = getattr(prev, fld)
                if raw_value != prev_value:
                    pending = self._field_streaks.get(fld)
                    if pending and pending[0] == raw_value:
                        if pending[1] + 1 >= threshold:
                            self._field_streaks.pop(fld, None)
                        else:
                            self._field_streaks[fld] = (raw_value, pending[1] + 1)
                            d[fld] = prev_value
                    else:
                        self._field_streaks[fld] = (raw_value, 1)
                        d[fld] = prev_value
                else:
                    self._field_streaks.pop(fld, None)

        # ─── Track gameplay started (suppress attract-mode events) ───
        if d['screen_type'] == 'title':
            self._last_title_frame = frame_number
            self._gameplay_streak = 0
        elif d['screen_type'] in ('overworld', 'dungeon', 'cave'):
            self._gameplay_streak += 1
            if self._gameplay_streak >= 120 and not self._gameplay_started:
                self._gameplay_started = True

        # ─── Dungeon first visit ───
        if (
            d['screen_type'] == 'dungeon'
            and d['dungeon_level'] > 0
            and self._gameplay_started
            and d['dungeon_level'] not in self._dungeons_visited
        ):
            self._dungeons_visited.add(d['dungeon_level'])
            self.game_events.append({
                'frame': frame_number, 'event': 'dungeon_first_visit',
                'description': f'Entered dungeon {d["dungeon_level"]} for the first time',
                'dungeon_level': d['dungeon_level'],
            })

        # ─── Subscreen open ───
        if (
            d['screen_type'] == 'subscreen'
            and prev.screen_type != 'subscreen'
            and self._gameplay_started
        ):
            self.game_events.append({
                'frame': frame_number, 'event': 'subscreen_open',
                'description': 'Opened inventory',
                'dungeon_level': d['dungeon_level'],
            })

        # ─── B-item change ───
        if (
            d['b_item'] is not None
            and d['b_item'] != self._last_b_item
            and d['screen_type'] in ('overworld', 'dungeon', 'cave', 'subscreen')
            and self._gameplay_started
        ):
            self.game_events.append({
                'frame': frame_number, 'event': 'b_item_change',
                'description': f'B-item: {d["b_item"]}'
                               + (f' (was {self._last_b_item})' if self._last_b_item else ''),
                'dungeon_level': d['dungeon_level'],
            })
            self._last_b_item = d['b_item']

        # ─── Item-hold detection (Link holding item overhead) ───
        self.game_events.extend(self._item_hold_tracker.process_frame(
            detected_item=current.detected_item,
            detected_item_y=current.detected_item_y,
            screen_type=d['screen_type'],
            dungeon_level=d['dungeon_level'],
            hearts_current=d['hearts_current'],
            hearts_max=d['hearts_max'],
            frame_number=frame_number,
        ))

        # ─── Dungeon exit / triforce inference state machine ───
        # Run BEFORE warp/death detection so game_complete can suppress
        # credits-related death events on the same frame.
        self.game_events.extend(self._dungeon_exit_tracker.process_frame(
            screen_type=d['screen_type'],
            dungeon_level=d['dungeon_level'],
            hearts_current=d['hearts_current'],
            hearts_max=d['hearts_max'],
            prev_screen_type=prev.screen_type,
            prev_dungeon_level=prev.dungeon_level,
            frame_number=frame_number,
        ))

        # ─── Warp/death detection ───
        self.game_events.extend(self._warp_death_tracker.process_frame(
            screen_type=d['screen_type'],
            dungeon_level=d['dungeon_level'],
            hearts_current=d['hearts_current'],
            hearts_max=d['hearts_max'],
            map_position=d['map_position'],
            prev_screen_type=prev.screen_type,
            prev_hearts_max=prev.hearts_max,
            gameplay_started=self._gameplay_started,
            game_completed=self._dungeon_exit_tracker.game_completed,
            game_events=self.game_events,
            frame_number=frame_number,
            dungeon_exit_exiting_d9=self._dungeon_exit_tracker.is_exiting_d9,
        ))

        # ─── Staircase item tracking ───
        staircase_events = self._staircase_tracker.process(
            detected_item=current.detected_item,
            screen_type=d['screen_type'],
            dungeon_level=d['dungeon_level'],
        )
        for evt in staircase_events:
            self.game_events.append({
                'frame': frame_number,
                'event': 'staircase_item_acquired',
                'type': 'staircase_item_acquired',
                'item': evt['item'],
                'description': f'Staircase item: {evt["item"]}',
                'dungeon_level': evt['dungeon_level'],
            })

        # ─── Floor item tracking ───
        floor_items = getattr(current, 'floor_items', [])
        self.game_events.extend(self._floor_item_tracker.process(
            floor_items=floor_items,
            screen_type=d['screen_type'],
            dungeon_level=d['dungeon_level'],
            map_position=d['map_position'],
            frame_number=frame_number,
        ))

        # ─── Ganon fight tracking (D9 only) ───
        if (
            d['screen_type'] == 'dungeon'
            and d['dungeon_level'] == 9
            and not self._dungeon_exit_tracker.game_completed
        ):
            if d['gannon_nearby'] and not self._ganon_seen:
                self._ganon_seen = True
                self.game_events.append({
                    'frame': frame_number, 'event': 'ganon_fight',
                    'description': 'Entered Ganon fight (ROAR detected)',
                    'dungeon_level': 9,
                })
            elif not d['gannon_nearby'] and self._ganon_seen:
                self._ganon_seen = False
                self.game_events.append({
                    'frame': frame_number, 'event': 'ganon_kill',
                    'description': 'Ganon defeated (ROAR ended)',
                    'dungeon_level': 9,
                })

        # ─── Validation rules ───

        # Rule 1: Max hearts can only increase
        if d['hearts_max'] < prev.hearts_max and prev.hearts_max > 0:
            self._record_anomaly(frame_number, 'hearts_max',
                                 f'Max hearts decreased from {prev.hearts_max} to {d["hearts_max"]}')
            d['hearts_max'] = prev.hearts_max

        # Rule 2: Hearts cannot exceed max
        if d['hearts_current'] > d['hearts_max']:
            d['hearts_current'] = d['hearts_max']

        # Rule 3: Triforce pieces cannot be uncollected
        for i in range(min(len(prev.triforce), len(d['triforce']))):
            if prev.triforce[i] and not d['triforce'][i]:
                self._record_anomaly(frame_number, 'triforce',
                                     f'Triforce piece {i + 1} disappeared')
                d['triforce'][i] = True

        # Rule 3b: Merge inferred triforce into state
        for i in range(8):
            if self._triforce_inferred[i]:
                d['triforce'][i] = True

        # Sword upgrade event (before Rule 4 validation)
        if (d['sword_level'] > prev.sword_level and prev.sword_level >= 0
                and self._gameplay_started):
            SWORD_NAMES = {1: 'Wooden Sword', 2: 'White Sword', 3: 'Magical Sword'}
            name = SWORD_NAMES.get(d['sword_level'], f'Sword level {d["sword_level"]}')
            self.game_events.append({
                'frame': frame_number, 'event': 'sword_upgrade',
                'description': f'Picked up {name}',
                'dungeon_level': d['dungeon_level'],
            })

        # Rule 4: Sword level can only increase
        if d['sword_level'] < prev.sword_level and prev.sword_level > 0:
            self._record_anomaly(frame_number, 'sword_level',
                                 f'Sword level decreased from {prev.sword_level} to {d["sword_level"]}')
            d['sword_level'] = prev.sword_level

        # Rule 5: Non-losable items cannot disappear
        for item in NON_LOSABLE_ITEMS:
            if prev.items.get(item) and not d['items'].get(item):
                if item not in self._item_anomaly_logged:
                    self._record_anomaly(frame_number, f'item:{item}',
                                         f'Non-losable item {item} disappeared')
                    self._item_anomaly_logged.add(item)
                d['items'][item] = True

        # Rule 6: Upgraded items
        for base, upgrade in UPGRADE_CHAINS.items():
            if prev.items.get(base) and not d['items'].get(base):
                if not d['items'].get(upgrade):
                    if base not in self._item_anomaly_logged:
                        self._record_anomaly(frame_number, f'item:{base}',
                                             f'Item {base} disappeared without upgrade to {upgrade}')
                        self._item_anomaly_logged.add(base)
                    d['items'][base] = True

        # Rule 7: Rupees bounded 0-255
        if d['rupees'] < 0:
            d['rupees'] = 0
        if d['rupees'] > 255:
            d['rupees'] = 255

        # Rule 8: Master key is permanent once acquired
        if prev.has_master_key and not d['has_master_key']:
            self._record_anomaly(frame_number, 'has_master_key', 'Master key disappeared')
            d['has_master_key'] = True

        # Rule 9: Bomb max can only increase
        observed = max(d['bombs'], prev.bomb_max)
        for tier in BOMB_TIERS:
            if observed <= tier:
                d['bomb_max'] = tier
                break
        else:
            d['bomb_max'] = 16

        # Track cave traversals (for Rule 10 cave warp detection)
        if prev.screen_type == 'overworld' and d['screen_type'] == 'cave':
            self._pre_cave_position = prev.map_position
        elif prev.screen_type != 'cave' and d['screen_type'] != 'cave':
            self._pre_cave_position = 0

        # Rule 10: Map position adjacency
        ow_start = self._warp_death_tracker.overworld_start
        dg_entrances = self._warp_death_tracker.dungeon_entrances
        if (
            prev.map_position > 0
            and d['map_position'] > 0
            and prev.screen_type == d['screen_type']
        ):
            if d['screen_type'] == 'overworld':
                if not is_adjacent(prev.map_position, d['map_position'], OVERWORLD_COLS):
                    if d['map_position'] == ow_start:
                        self._record_anomaly(
                            frame_number, 'map_position',
                            f'Up+A/Reset to start screen: {prev.map_position}'
                            f' -> {d["map_position"]}',
                            severity='info')
                    elif (self.any_roads
                          and prev.map_position in self.any_roads
                          and d['map_position'] in self.any_roads):
                        self._record_anomaly(
                            frame_number, 'map_position',
                            f'Any Roads warp: {prev.map_position}'
                            f' -> {d["map_position"]}',
                            severity='info')
                    elif self._pre_cave_position > 0:
                        self._record_anomaly(
                            frame_number, 'map_position',
                            f'Cave warp: {prev.map_position}'
                            f' -> {d["map_position"]}',
                            severity='info')
                    else:
                        self._record_anomaly(
                            frame_number, 'map_position',
                            f'Non-adjacent overworld jump: {prev.map_position}'
                            f' -> {d["map_position"]}')

            elif d['screen_type'] == 'dungeon':
                if not is_adjacent(prev.map_position, d['map_position'], DUNGEON_COLS):
                    dg_level = d.get('dungeon_level', 0)
                    entrance = dg_entrances.get(dg_level, 0)
                    if entrance > 0 and d['map_position'] == entrance:
                        self._record_anomaly(
                            frame_number, 'map_position',
                            f'Up+A to dungeon {dg_level} entrance: '
                            f'{prev.map_position} -> {d["map_position"]}',
                            severity='info')
                    else:
                        self._record_anomaly(
                            frame_number, 'map_position',
                            f'Non-adjacent dungeon jump (staircase?): '
                            f'{prev.map_position} -> {d["map_position"]}',
                            severity='info')

        # Rule 11: Dungeon level stickiness
        if (
            prev.dungeon_level > 0
            and d['dungeon_level'] == 0
            and d['screen_type'] in ('dungeon', 'cave')
            and prev.screen_type in ('dungeon', 'cave')
        ):
            self._record_anomaly(
                frame_number, 'dungeon_level',
                f'Dungeon level dropped to 0 while in {d["screen_type"]}')
            d['dungeon_level'] = prev.dungeon_level

        # Rule 12: Screen type reinforcement from dungeon context
        if (
            prev.screen_type == 'dungeon'
            and prev.dungeon_level > 0
            and d['screen_type'] == 'overworld'
            and d['dungeon_level'] > 0
        ):
            self._record_anomaly(
                frame_number, 'screen_type',
                f'Classifier said overworld but dungeon level'
                f' {d["dungeon_level"]} still present')
            d['screen_type'] = 'dungeon'

        # ─── Heart container tracking ───
        if (
            d['screen_type'] in ('overworld', 'dungeon', 'cave')
            and d['hearts_max'] > prev.hearts_max
            and prev.hearts_max > 0
        ):
            location = d['screen_type']
            dg = d['dungeon_level']
            if location == 'dungeon' and dg > 0:
                desc = f'Heart container in D{dg} ({prev.hearts_max}->{d["hearts_max"]})'
                if dg not in self._dungeon_heart_frame:
                    self._dungeon_heart_frame[dg] = frame_number
            elif location == 'cave':
                desc = f'Heart container in cave ({prev.hearts_max}->{d["hearts_max"]})'
            else:
                desc = f'Heart container on overworld ({prev.hearts_max}->{d["hearts_max"]})'
            self.game_events.append({
                'frame': frame_number, 'event': 'heart_container',
                'description': desc,
                'dungeon_level': dg,
            })
            self._record_anomaly(frame_number, 'heart_container', desc, severity='info')

        # ─── Feed events to inventory accumulator ───
        for evt in self.game_events[events_start:]:
            self._inventory_accumulator.process_event(evt)

        # Build validated GameState
        result = GameState(**d)
        result.events = self.game_events[events_start:]
        self.prev = result
        return result

    def get_anomalies(self) -> list[dict]:
        """Return all recorded anomalies."""
        return list(self.anomalies)

    def get_accumulated_inventory(self) -> dict[str, bool]:
        """Return event-based accumulated inventory (for Z1R)."""
        return self._inventory_accumulator.get_inventory()

    def get_triforce_inferred(self) -> list[bool]:
        """Return the inferred triforce state (8 booleans)."""
        return list(self._triforce_inferred)

    def reset(self) -> None:
        """Clear validation state."""
        self.prev = None
        self.anomalies.clear()
        self._pre_cave_position = 0
        self._item_anomaly_logged.clear()
        self._last_anomaly_frame.clear()
        self._dungeon_heart_frame.clear()
        # Reset triforce list in-place (shared with both sub-trackers)
        for i in range(8):
            self._triforce_inferred[i] = False
        self._dungeon_exit_tracker.reset()
        self._item_hold_tracker.reset()
        self._warp_death_tracker.reset()
        self._staircase_tracker._reset()
        self._floor_item_tracker._reset()
        self._inventory_accumulator.reset()
        self._gameplay_started = False
        self._gameplay_streak = 0
        self._last_title_frame = 0
        self._ganon_seen = False
        self._field_streaks.clear()
        self._dungeons_visited = set()
        self._last_b_item = None
        self.game_events.clear()

    def _record_anomaly(self, frame_number: int, detector: str, description: str,
                        severity: str = 'warning') -> None:
        """Record a detected anomaly with temporal debouncing."""
        if severity != 'info':
            last_frame = self._last_anomaly_frame.get(detector, -999)
            if frame_number - last_frame < self.ANOMALY_DEBOUNCE_FRAMES:
                return
        self._last_anomaly_frame[detector] = frame_number
        self.anomalies.append({
            'frame': frame_number,
            'detector': detector,
            'description': description,
            'severity': severity,
        })


class RaceItemTracker:
    """Tracks where each item lives on the seed — a seed knowledge map.

    Records "for each item in the game, where is it?" as detected by vision.
    Combined with PlayerItemTracker this answers "did Bogie get the silver
    arrows from Level 5?"

    Vocabulary: Vision *detects* floor items. This tracker records that an
    item was *seen* at a location; separately records if it was *obtained*.
    """

    def __init__(self) -> None:
        # item_name -> {'map_position': int, 'first_seen_frame': int, 'obtained': bool}
        self._locations: dict[str, dict] = {}

    def item_seen(self, item: str, map_position: int, frame: int) -> None:
        """Record that vision detected this item at a map position."""
        if item not in self._locations:
            self._locations[item] = {
                'map_position': map_position,
                'first_seen_frame': frame,
                'obtained': False,
            }
        # Update location if seen at same position (idempotent)
        # Don't overwrite if already marked obtained from a previous sighting

    def item_obtained(self, item: str, frame: int) -> None:
        """Mark an item as obtained by the player (confirmed pickup)."""
        if item in self._locations:
            self._locations[item]['obtained'] = True
        # If we see an obtained event without a prior sighting, still record it
        # (handles edge cases where floor detection missed the initial appearance)
        else:
            self._locations[item] = {
                'map_position': 0,  # unknown location
                'first_seen_frame': frame,
                'obtained': True,
            }

    def get_locations(self) -> dict[str, dict]:
        """Return the full seed knowledge map."""
        return dict(self._locations)
