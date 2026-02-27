# Vision Engine Refactor — Claude Code Handoff

This document was produced by an Antigravity (Google DeepMind) audit session. It contains a complete implementation plan for refactoring the vision engine. Execute phases in order — each phase must pass tests before proceeding.

## Context

The vision engine works but has structural problems in 2 files:
- `hud_reader.py` (698 lines) — dual landmark/grid code paths that fight each other
- `game_logic.py` (1008 lines) — three entangled state machines in a single 465-line `validate()` method

There is also a **blocking bug**: key/bomb digit column mapping is wrong (col 14 reads black for MFmerks; data is at col 13). The landmark-derived grid offset (`dx=0, dy=6`) doesn't match actual best (`dx=1, dy=7`).

The 10 other detector files are clean and should not be modified.

---

## Phase 1: Golden-Frame Test Harness

**Goal**: Create a pytest safety net before refactoring anything.

### Steps

1. Add `pytest>=8.0` to `vision/requirements.txt`
2. Install: `cd vision && .venv/Scripts/pip install pytest`
3. Create `vision/tests/conftest.py` with fixtures:
   - `detector` → `NesStateDetector` with templates from `vision/templates/`
   - `golden_frames` → loads all PNG + JSON pairs from `vision/tests/golden_frames/`
4. Create `vision/tests/golden_frames/` directory
5. Extract 12-15 golden frames by writing a script that:
   - Takes existing learn-snapshot JPGs from `data/learn-snapshots/ebfc366d/`
   - Downscales 512×480 → 256×240 with `INTER_NEAREST`
   - Saves as PNG (lossless)
   - Pairs each with a `.json` file containing expected `GameState` fields
   - Cover: title, overworld (×3), dungeon (×2), cave, subscreen (×2), death, transition
   - Use the report JSON at `data/report_ebfc366d.json` → `snapshots` array for ground-truth state values
6. Create `vision/tests/test_detector.py`:
   - `test_screen_classification` — parameterized over golden frames, asserts `screen_type`
   - `test_hud_present` — gameplay frames return True, non-gameplay frames return False
   - `test_hearts_reading` — asserts `hearts_current` and `hearts_max` on gameplay frames
   - Accept ±1 tolerance on digit-read fields (rupees, keys, bombs) due to JPEG artifacts
7. Verify all tests pass: `.venv/Scripts/python -m pytest tests/ -v`

### Critical Notes
- JPEG artifacts hurt template matching. Use `INTER_NEAREST` downscale for best results.
- Screen classification and heart reading use color/brightness, not template matching — these are reliable on JPEG frames.
- Digit-matching tests should have relaxed thresholds or be marked with known tolerances.

---

## Phase 2: Decompose `game_logic.py`

**Goal**: Extract 3 state machines from `GameLogicValidator` into separate classes. No behavior changes — the coordinator calls each tracker and collects events.

### New Files

#### `vision/detector/dungeon_exit_tracker.py`
Extract from `GameLogicValidator`:
- `_check_dungeon_exit()` (lines 681-787)
- `_reset_dungeon_exit()` (lines 978-986)
- State variables: `_exit_phase`, `_exit_dungeon`, `_exit_start_frame`, `_exit_hearts_start`, `_exit_hearts_min`, `_exit_death_frames`, `_exit_saw_death_menu`
- Also moves: `_triforce_inferred` list, `_game_completed` flag, game completion detection

Interface:
```python
class DungeonExitTracker:
    def __init__(self):
        self.triforce_inferred = [False] * 8
        self.game_completed = False
        # ... exit state vars ...

    def process_frame(self, screen_type: str, dungeon_level: int,
                      hearts_current: int, hearts_max: int,
                      prev_screen_type: str, prev_dungeon_level: int,
                      frame_number: int) -> list[dict]:
        """Returns list of game event dicts (triforce_inferred, game_complete)."""

    def reset(self):
        """Clear all state."""
```

#### `vision/detector/item_hold_tracker.py`
Extract from `GameLogicValidator`:
- `_check_item_hold()` (lines 789-904)
- `_item_hold_met_threshold()` (lines 906-911)
- `_start_item_hold()` (lines 913-928)
- `_fire_triforce_event()` (lines 930-960) — returns event dict instead of mutating `d`
- `_reset_item_hold()` (lines 962-976)
- All 13 `_item_hold_*` state variables

Interface:
```python
class ItemHoldTracker:
    def __init__(self):
        self.triforce_inferred = [False] * 8  # shared ref with DungeonExitTracker
        # ... item hold state vars ...

    def process_frame(self, detected_item: str | None, detected_item_y: int,
                      screen_type: str, dungeon_level: int,
                      hearts_current: int, hearts_max: int,
                      frame_number: int) -> list[dict]:
        """Returns list of game event dicts (triforce_inferred)."""

    def reset(self):
        """Clear all state."""
```

**Important**: Both `DungeonExitTracker` and `ItemHoldTracker` write to `triforce_inferred`. The coordinator (`GameLogicValidator`) should own the canonical list and pass it to both trackers or share a reference.

#### `vision/detector/warp_death_tracker.py`
Extract from `GameLogicValidator.validate()`:
- Position-reset warp detection (lines 319-368)
- CSR-based death/warp detection (lines 390-414)
- Hearts-zero streak tracking (lines 284-305)
- Non-gameplay gap tracking (lines 623-630)
- State: `_non_gameplay_gap`, `_last_gameplay_position`, `_last_gameplay_screen`, `_warp_detected_this_gap`, `_last_gameplay_hearts`, `_zero_hearts_streak`, `overworld_start`, `dungeon_entrances`

Interface:
```python
class WarpDeathTracker:
    def __init__(self, any_roads: set[int] | None = None):
        self.overworld_start = 0
        self.dungeon_entrances: dict[int, int] = {}
        # ... gap/streak state vars ...

    def process_frame(self, screen_type: str, dungeon_level: int,
                      hearts_current: int, hearts_max: int,
                      map_position: int, prev_screen_type: str,
                      prev_hearts_max: int,
                      gameplay_started: bool, game_completed: bool,
                      game_events: list[dict],
                      frame_number: int) -> list[dict]:
        """Returns list of game event dicts (death, up_a_warp)."""

    def reset(self):
        """Clear all state."""
```

### Modify `game_logic.py`
- Import and instantiate the 3 sub-trackers in `__init__`
- `validate()` calls each tracker's `process_frame()`, appends returned events to `self.game_events`
- Shared `_triforce_inferred` list: owned by validator, passed to/synced with both trackers
- Remove extracted state variables and methods from `GameLogicValidator`
- Keep in `validate()`: carry-forward logic, streak validation, all 12 validation rules, anomaly recording, ganon tracking, sword/b-item/heart-container events, dungeon first visit, subscreen open

**Target**: `validate()` shrinks from ~465 to ~200 lines, `__init__` from 81 to ~40 variables.

### Verify
Run `pytest tests/ -v` — all tests must still pass.

---

## Phase 3: Refactor `hud_reader.py`

**Goal**: Clean separation of landmark vs grid code paths. Stop deriving grid offset from landmarks.

### Key Changes to `hud_reader.py`

1. **`_apply_landmarks()`**: Remove ALL grid offset derivation (lines 107-125). Do NOT set `self.grid_dx` or `self.grid_dy` from landmarks. Instead, just store the landmark dicts:
   ```python
   def _apply_landmarks(self, landmarks):
       lm_map = {lm['label']: lm for lm in landmarks}
       self._landmarks = lm_map
       # Store landmark regions for pixel-based extraction
       if '-LIFE-' in lm_map:
           lm = lm_map['-LIFE-']
           self._life_region = (lm['x'], lm['y'], lm.get('w', 40), lm.get('h', 8))
       # ... store other landmark regions similarly ...
   ```

2. **Reader methods**: Each method should have a clean structure:
   ```python
   def read_foo(self, frame, ...):
       if self._has_landmark('Foo'):
           region = self._extract_landmark(frame, 'Foo')
           return self._read_foo_from_region(region, ...)
       else:
           return self._read_foo_from_grid(frame, ...)
   ```

3. **Remove `_row_shift`**: It's a confusing indirection. Store the actual tile row positions once during `__init__` based on `life_row` parameter. Don't adjust at read time.

4. **Grid offset stays from `__init__` parameter**: The grid offset should come from `find_grid_alignment()` in the calling code (`vision_engine.py` / `learn_mode.py`), never derived from landmark pixels.

### Verify
Run `pytest tests/ -v` — all tests must still pass.

---

## Phase 4: Fix HUD Column Mapping Bug ✓ COMPLETE

**Goal**: Fix keys/bombs reading for all stream layouts.

### Investigation
The NES Zelda HUD places single-digit counters at the **leftmost** digit column, not rightmost. For keys and bombs (which display "X#" where X is an icon):
- The icon is at col 12
- A single-digit value goes to col **13** (the tens position)  
- Col 14 (ones position) is black/empty when value < 10

### Fix in `hud_reader.py`
1. Change `KEY_DIGIT_COLS` from `[13, 14]` to `[13]` (single digit only; Z1R never has 10+ keys)
2. Change `BOMB_DIGIT_COLS` similarly — or keep `[13, 14]` but handle the case where col 14 is empty (don't treat it as "0", treat it as absent)
3. The `_read_counter_tiles()` method already skips dark tiles (`np.mean(gray) < 10`), so if col 14 is black it will be skipped — the issue may be in how landmarks derive the column positions

### Verify
1. Add MFmerks golden frames (`data/learn-snapshots/` from a session using that VOD) with expected key/bomb values
2. Run `pytest tests/ -v` — new frames must pass
3. Optionally: run a full learn-mode session on the MFmerks VOD to verify keys/bombs throughout

---

---

## Phase 5: Decompose `item_reader.py`

**Goal**: Separate reusable binary shape matching from item-domain knowledge. The current class mixes template I/O, mask math, color analysis, and item-twin logic into one 252-line unit. Decomposing enables reuse of the matching engine elsewhere (digit-like contexts, enemy sprites) and makes each piece independently testable.

### New File: `vision/detector/shape_matcher.py`

Extract the domain-agnostic binary matching engine:

```python
class BinaryShapeMatcher:
    """Load PNG templates, convert to binary masks, match via sliding window."""

    def __init__(self, template_dir: str, threshold: int = 10):
        self.templates: dict[str, np.ndarray] = {}   # raw BGR (kept for callers)
        self._masks:    dict[str, np.ndarray] = {}   # binary masks
        self._threshold = threshold

    def match(self, region: np.ndarray,
              bg_colors: list[np.ndarray] | None = None
              ) -> tuple[str, float] | None:
        """Return (name, score) of best match above 0.3, or None."""

    def match_scored(self, region: np.ndarray,
                     bg_colors: list[np.ndarray] | None = None
                     ) -> list[tuple[str, float]]:
        """Return all (name, score) pairs, sorted best-first."""

    def has_templates(self) -> bool:

    # Private: _to_binary, _score, _zero_bg (renamed from _prepare_mask,
    #          _match_score, _mask_background — no semantic change)
```

Move from `ItemReader` to `BinaryShapeMatcher`:
- `_prepare_mask` → `_to_binary`
- `_match_score` → `_score`
- `_mask_background` → `_zero_bg`
- The `templates` dict (raw BGR, used by callers for color inspection)
- The `_template_masks` dict → `_masks`
- `_tmpl_h` / `_tmpl_w` (only ever used for tracking; remove or keep internal)

### Modify `vision/detector/item_reader.py`

Slim `ItemReader` down to item-domain logic only:

```python
_SHAPE_TWINS = { ... }   # fix comment indentation (currently 4-space indented, should be 0)

class ItemReader:
    def __init__(self, template_dir: str, threshold: int = 10):
        self._matcher = BinaryShapeMatcher(template_dir, threshold)
        self._threshold = threshold   # needed by _pick_by_color

    def read_item(self, tile, bg_colors=None) -> str | None:
        scored = self._matcher.match_scored(tile, bg_colors)
        if not scored or scored[0][1] <= 0.3:
            return None
        best_item, best_score = scored[0]
        if best_item in _SHAPE_TWINS:
            partner, _ = _SHAPE_TWINS[best_item]
            partner_score = next((s for n, s in scored if n == partner), 0.0)
            if abs(best_score - partner_score) < 0.05:
                best_item = self._pick_by_color(tile, best_item, partner)
        return best_item

    def read_item_scored(self, tile, bg_colors=None) -> list[tuple[str, float]]:
        return self._matcher.match_scored(tile, bg_colors)

    def has_templates(self) -> bool:
        return self._matcher.has_templates()

    def _pick_by_color(self, tile, item_a, item_b) -> str:
        # unchanged — color analysis stays in ItemReader (item-domain knowledge)
```

Note: `_pick_by_color` doesn't move — it knows about `_SHAPE_TWINS` color indicators
('blue', 'red', 'bright', 'warm'), which are item-domain concepts, not matching-engine concerns.

### Files Changed

| File | Change |
|------|--------|
| `vision/detector/shape_matcher.py` | **Create** — `BinaryShapeMatcher` |
| `vision/detector/item_reader.py` | **Modify** — delegate to `BinaryShapeMatcher`; fix `_SHAPE_TWINS` comment indent |

No callers change — `ItemReader`'s public API (`read_item`, `read_item_scored`, `has_templates`) is identical.

### Verify

```
pytest tests/test_silly_rock_race.py -v
```
Expected: 12 passed, 11 skipped, 16 xfailed, 6 xpassed (no change from Phase 4 baseline).

---

## File Reference

### Don't Touch (clean, working)
- `nes_state.py` (146 lines) — orchestrator
- `screen_classifier.py` (197 lines) — screen type detection
- `temporal_buffer.py` (110 lines) — frame smoothing
- `digit_reader.py` (84 lines) — template matching
- `item_reader.py` (250 lines) — binary shape matching
- `item_detector.py` (121 lines) — game area item detection
- `triforce_reader.py` (168 lines) — subscreen triforce
- `inventory_reader.py` (250 lines) — Z1R SWAP detection
- `color_utils.py` (62 lines) — utilities
- `zelda_map.py` (32 lines) — grid helpers

### Refactor
- `game_logic.py` (1008 lines) → decompose into 3 sub-trackers + slim coordinator
- `hud_reader.py` (698 lines) → clean landmark/grid separation

### Leave Alone (complex but working)
- `auto_crop.py` (741 lines) — crop detection
- `room_matcher.py` (570 lines) — minimap calibration
- `learn_mode.py` (733 lines) — VOD processing loop
- `vision_engine.py` (383 lines) — live mode entry point
