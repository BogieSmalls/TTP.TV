# HUD Calibration & Detection Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fixed-coordinate HUD reading with a self-calibrating anchor system derived from detected reference points (LIFE text, B/A borders, HUD/gameplay boundary, LEVEL text, digit rows, minimap gray rect), redesign minimap reading with full room tracking, and replace the fragile subscreen-only inventory model with an event-driven tracker.

**Architecture:** Four new/refactored classes — `HudCalibrator` (anchor detection + locked affine mapping), `MinimapReader` (full grid derivation + dot detection + tile recognition), `PlayerItemTracker` (obtained items), `RaceItemTracker` (seen item log). `HudReader` delegates coordinate math to `HudCalibrator`. `NesStateDetector` wires them together.

**Tech Stack:** Python, NumPy, OpenCV, existing vision pipeline (`vision/detector/`)

---

## Vocabulary

| Layer | Verb | Meaning |
|---|---|---|
| Vision (`hud_reader`, detectors) | **detect / identify** | Raw pixel analysis result |
| Tracking (`game_logic.py`) | **see** | Item/room was observed by vision |
| Tracking (`game_logic.py`) | **obtain** | Player definitively acquired the item |

---

## Calibration Anchors

| Anchor | Provides | NES reference |
|---|---|---|
| LIFE text y position | `anchor_y`, scale_y (glyph height / 8) | Row 5, y=40 |
| LIFE-bottom → gameplay boundary | scale_y (independent) | Boundary at y=64 |
| B-item left border x | `anchor_x`, scale_x (with A-item) | Col ~16 |
| A-item left border x | scale_x (B→A gap) | Col ~20 |
| LEVEL-X text left edge | dungeon minimap col origin | Row 1, x=0 |
| Rupee digit row center y | minimap row 1–2 boundary | Row 2, y≈19 |
| Key digit row center y | minimap row 5–6 boundary | Row 4, y≈35 |
| Bomb digit row center y | minimap row 7–8 boundary | Row 5, y≈43 |
| Minimap gray rect bounds | scale cross-validation + minimap grid | x=16–79 |
| HUD/gameplay boundary | Up+A text pos + subscreen item grid pos (bonus) | y=64 |

---

## Section 1: HudCalibrator

**File:** `vision/detector/hud_calibrator.py`

### Data structures

```python
@dataclass
class CalibrationAnchors:
    life_y: int | None = None          # LIFE text top in canonical pixels
    life_h: int | None = None          # LIFE text height in canonical pixels
    gameplay_y: int | None = None      # HUD/gameplay boundary y
    b_item_x: int | None = None        # B-item left border x
    a_item_x: int | None = None        # A-item left border x
    level_text_x: int | None = None    # LEVEL-X left edge (dungeon frames)
    rupee_row_y: int | None = None     # rupee digit row center y
    key_row_y: int | None = None       # key digit row center y
    bomb_row_y: int | None = None      # bomb digit row center y
    minimap_gray_rect: tuple[int,int,int,int] | None = None  # (x,y,w,h)

@dataclass
class CalibrationResult:
    anchor_x: float = 0.0
    anchor_y: float = 0.0
    scale_x: float = 1.0
    scale_y: float = 1.0
    confidence: float = 0.0
    locked: bool = False
    source_frame: int = -1
```

### Lifecycle

- `calibrate(frame, frame_num)` — called every gameplay frame
  1. Run all anchor detections (each returns value or None)
  2. Compute scale_y from all available measurements, take weighted average:
     - From LIFE glyph: `life_h / 8.0`
     - From HUD/gameplay boundary: `(gameplay_y - life_y) / (64 - LIFE_NES_Y)`
     - From digit rows: `(bomb_row_y - rupee_row_y) / (BOMB_NES_Y - RUPEE_NES_Y)`
  3. Compute scale_x from B/A gap: `(a_item_x - b_item_x) / (A_NES_X - B_NES_X)`
  4. confidence = fraction of anchors successfully detected (0.0–1.0)
  5. If `confidence > 0.85` and `not locked`: lock, log with frame number
  6. If locked: spot-check every 300 gameplay frames; log warning if drift > 3px

- `nes_to_px(nes_x, nes_y) -> tuple[int, int]` — maps NES coordinates to canonical frame pixels using locked result (or best available if not yet locked)

### Anchor detection methods (private)

- `_detect_life_text(frame)` — scan x=176–230, y=0–60 for red pixel cluster (R>50, R>2G, R>2B); return bounding box top y and height
- `_detect_gameplay_boundary(frame, life_y)` — scan downward from `life_y + 20` until non-black row found; return y
- `_detect_b_a_borders(frame)` — find blue border left edges at known x range for B and A item slots
- `_detect_level_text(frame)` — scan row 1 (y=8–15) for non-black pixel cluster; return left edge x
- `_detect_digit_rows(frame)` — find rupee, key, bomb digit row centers using red/white pixel scan at known column ranges
- `_detect_minimap_gray_rect(frame)` — scan x=16–79, y=12–52 for mid-gray rectangle (BGR each 80–140); return bounding rect

---

## Section 2: HudReader changes

**File:** `vision/detector/hud_reader.py`

- Constructor gains `calibrator: HudCalibrator` parameter
- `_extract(frame, nes_x, nes_y, w, h)` — when calibrator is locked, uses `calibrator.nes_to_px()` instead of `crop_w/256` scaling. Falls back to existing landmark or grid math when not locked.
- `_tile(frame, col, row)` — unchanged interface; uses updated `_extract()`
- `read_hearts()` — landmark path: derive heart row y from `calibrator.life_y + 8` (row 1) and `calibrator.life_y + 16` (row 2) instead of using Hearts landmark y directly. Fallback to existing landmark y when calibrator not locked.
- `read_minimap_position()` — **removed**; replaced by `MinimapReader`
- All other read methods unchanged in interface, gain accuracy via `_extract()` fix

---

## Section 3: MinimapReader

**File:** `vision/detector/minimap_reader.py`

### Data structures

```python
@dataclass
class MinimapResult:
    col: int          # 1-based
    row: int          # 1-based
    mode: str         # 'overworld' | 'dungeon'
    dungeon_map_rooms: int | None   # bitmask of blue-background cells (map acquired)
    triforce_room: tuple[int,int] | None   # (col,row) of flashing red dot
    zelda_room: tuple[int,int] | None     # L9 only: (col,row) of flashing dot
    collected_triforce: tuple[int,int] | None  # (col,row) of faint gray dot
    tile_match_id: int | None      # matched overworld room index (0–127)
    tile_match_score: float        # 0.0–1.0
    map_position: int              # backward-compat integer encoding
```

### Minimap row-to-HUD alignment

The row ABOVE the minimap contains "LEVEL-X " text (tile row 1, y=8-15).

| MM rows | Left side (minimap area) | Right side |
|---------|--------------------------|------------|
| 1 & 2   | Rupee count row          | B & A item labels, -LIFE-/-ROAR- text |
| 3 & 4   | Blank row                | Blank row |
| 5 & 6   | Key count row            | Top hearts row |
| 7 & 8   | Bomb count row           | Bottom hearts row |

### Grid derivation (from calibrator)

```
cell_h = (bomb_row_y - rupee_row_y) / 6.0
# rupee_row_y is center of MM row-pair 1-2 (1.5 cells from top)
minimap_top_y = rupee_row_y - 1.5 * cell_h
minimap_left_x = calibrator.nes_to_px(16, 0).x
minimap_right_x = calibrator.nes_to_px(79, 0).x
cell_w_dungeon = (minimap_right_x - minimap_left_x) / 8
cell_w_overworld = cell_w_dungeon / 2
```

### OW vs dungeon mode — LEVEL text detection

- `_detect_level_text(frame)` — check calibrator's `level_text_x` anchor; if present → dungeon mode
- Dungeon mode overrides `screen_type` classification for all minimap decisions
- `dungeon_level` parsed from LEVEL-X text (re-uses existing `read_dungeon_level()`)

### Dot detection (dungeon mode)

Scan each 8×8 dungeon minimap cell. Classify any significant pixel cluster:

| Dot type | Detection criteria | Priority |
|---|---|---|
| Link | Brightest cluster, same hue as overworld indicator | Highest |
| Flashing triforce/Zelda | Bright red cluster, alternates between frames | Second |
| Collected triforce | Faint gray cluster, static | Lowest — informational only |

- Compare two recent frames to detect flicker (flashing = present in frame N, absent in frame N-1 or N+1)
- L9 special case: `dungeon_level == 9` → relabel flashing dot as `zelda_room`
- Dungeon map detected: scan all 64 cells for blue background (B>R, B>G, B>150); emit `dungeon_map_rooms` bitmask

### Dot detection (overworld mode)

- Scan gray rect area for brightest cluster in stark contrast to gray background
- Gray rect position cross-validates `calibrator` scale (feeds back as refinement hint)

### Overworld tile recognition

Reference library: `content/overworld_rooms/` (128 tiles on disk)

**Pass 1 — minimap prior:**
1. Convert minimap-derived (col, row) to room index
2. Load that room's tile from reference library
3. Compare full gameplay area (below HUD boundary, full width) against tile using histogram similarity (64-bin per channel, normalized dot product)
4. If score ≥ 0.80 → accept, emit `tile_match_id`, reinforce calibrator confidence

**Pass 2 — 3×3 neighborhood:**
1. If Pass 1 score < 0.80, query `zelda_map.py` for up to 8 adjacent rooms
2. Compare gameplay area against each neighbor
3. Take best match; if score ≥ 0.80 → accept (may correct a wrong minimap reading), log discrepancy
4. If still no match → tile unrecognized, `tile_match_score = best_score`, no position correction

---

## Section 4: Event-Driven Inventory

**File:** `vision/game_logic.py` — new `PlayerItemTracker` and `RaceItemTracker` classes

### PlayerItemTracker

Tracks items **obtained** by the player. Never decreases item state.

**State:**
```python
_inventory: dict[str, bool]    # all boolean items
sword_level: int               # 0–3
arrows_level: int              # 0=none, 1=wooden, 2=silver
```

**Update triggers (in priority order):**

| Vision identifies | Action |
|---|---|
| `b_item == 'arrows'` | `bow = True` (Bow implied by arrows in B-slot) |
| `b_item_change` to any item | `inventory[new_item] = True` |
| `sword_upgrade` event | `sword_level = max(old, new)` |
| `item_obtained` event (floor item confirmed pickup) | `inventory[item] = True` |
| Silver arrows obtained | `arrows_level = 2` |
| Wooden arrows obtained | `arrows_level = max(current, 1)` |
| Subscreen scan succeeds | Merge: True values override; False only overrides if no prior True |

**One-way upgrade cascades on detection:**

| Vision identifies | Sets | Clears |
|---|---|---|
| Red candle | `red_candle = True` | `blue_candle = False` |
| Red ring | `red_ring = True` | `blue_ring = False` |
| Magical boomerang | `magical_boomerang = True` | `boomerang = False` |

**Bow/Arrows rules:**
- `arrows_level` never decreases
- `b_item == 'arrows'` → `bow = True` (Bow never appears directly in B-slot)
- Arrow pickup without Bow detection → does NOT set `bow = True`
- Silver arrows obtained → `arrows_level = 2` only (does NOT set `bow = True`)

### RaceItemTracker

Tracks items **seen** at locations, regardless of whether obtained.

```python
@dataclass
class SeenItem:
    item: str
    map_position: int     # encoded room index
    frame: int
    obtained: bool        # updated to True if item_obtained event follows
```

**Update triggers:**
- `item_detected` (floor item visible) → append `SeenItem(obtained=False)`
- `item_obtained` → find matching SeenItem, set `obtained=True`
- `item_seen_missed` → item was seen but player left room; SeenItem stays `obtained=False`

### FloorItemTracker rename

- `item_pickup` event → renamed to `item_obtained` (same room, item gone)
- Add `item_seen_missed` event (room changed while item in "gone streak")

---

## Section 5: Integration (NesStateDetector)

**File:** `vision/detector/nes_state.py`

**Constructor additions:**
```python
self.calibrator = HudCalibrator()
self.minimap    = MinimapReader(calibrator=self.calibrator)
self.player_items = PlayerItemTracker()
self.race_items   = RaceItemTracker()
# existing: hud_reader updated to accept calibrator
```

**Per-frame flow:**
1. `calibrator.calibrate(frame, frame_num)` — first, every gameplay frame
2. Screen classification unchanged; but `minimap.read()` LEVEL-text detection overrides `screen_type` for minimap decisions
3. HUD reads (hearts, rupees, keys, etc.) — HudReader uses calibrated coordinates
4. `minimap.read(frame, screen_type, dungeon_level)` → `MinimapResult`; replaces `read_minimap_position()`
5. `player_items.update(state, events)` — produces updated `items` dict
6. `race_items.update(events, state.map_position, frame_num)` — logs seen/obtained

**GameState new fields:**
```python
dungeon_map_rooms: int | None       # bitmask; None until map acquired
triforce_room: tuple | None         # (col, row); None until compass acquired
zelda_room: tuple | None            # L9 only
tile_match_id: int | None           # overworld tile recognition result
tile_match_score: float
```

**Backward-compatible:** `map_position` integer encoding preserved. `items` dict schema preserved.

---

## Tests Required

| Test file | Covers |
|---|---|
| `tests/test_hud_calibrator.py` | Anchor detection, confidence scoring, lock/spot-check, nes_to_px mapping |
| `tests/test_minimap_reader.py` | Grid derivation, dot detection (all 4 types), tile recognition pass 1 & 2 |
| `tests/test_player_item_tracker.py` | All inference rules, upgrade cascades, merge-not-replace, arrows/bow rules |
| `tests/test_race_item_tracker.py` | seen/obtained event logging, item_seen_missed handling |
| `tests/test_nes_state_calibrated.py` | End-to-end: calibrated coordinates flow through to correct HUD readings |
| Existing 323 tests | Must remain green |

---

## Out of Scope (future plans)

- Subscreen detection improvements (subscreen reads now secondary to event-driven inventory; reliability improvement deferred)
- Dungeon tile recognition (overworld only in this plan; dungeon room matching is future work)
- Racer-vs-racer seen-item comparison (race tracker logs data; cross-racer analysis deferred)
