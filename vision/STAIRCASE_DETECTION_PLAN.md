# Staircase Item Detection Plan

## Exploration Findings

### What We Tested
Used two BogieSmalls stream screenshots of a dungeon staircase room (LEVEL-1):
1. Red ring resting on the central pedestal
2. Link holding the red ring overhead (acquire animation)

### Results

| Scenario | Best Region | Item Match | Score | Reliable? |
|----------|------------|------------|-------|-----------|
| Pedestal (resting) | 24x32 at NES (124,136) | red_ring | 0.727 | Yes |
| Pedestal (resting) | 32x40 at NES (120,132) | red_ring | 0.727 | Yes |
| Pedestal (resting) | 48x48 at NES (112,128) | blue_ring* | 0.727 | Shape yes, color no |
| Hoisted (above Link) | 32x40 at NES (88,110) | magical_shield** | 0.681 | No |
| Hoisted (above Link) | 32x40 ring score | red_ring | 0.660 | Marginal |

\* Larger regions include wall pixels that confuse color disambiguation.
\** Link's body creates false shape matches that outscore the item.

### False Positive Analysis

| Region Content | Top Match | Score | Passes 0.55 threshold? |
|---------------|-----------|-------|----------------------|
| Red ring on pedestal | red_ring | 0.727 | Yes |
| Empty pedestal (bricks only) | potion_blue | 0.527 | No |
| Link holding item (hoisted) | magical_shield | 0.681 | Yes (but wrong item) |

The 0.55 threshold cleanly separates real items (0.727+) from empty pedestal noise (0.527).
The isolation brightness check (mean < 40) also helps: pedestal with item = 14.6, empty = 10.3,
Link present in region = 80+.

### Key Takeaways

1. **Pedestal detection is reliable** — ItemReader binary shape matching consistently finds the item at 0.727 (well above the 0.3 threshold). Color disambiguation works when the region is small enough to exclude wall pixels.

2. **Hoisted detection is noisy** — Link's body, enemies, and wall textures create false positives that outscore the actual held item. Not suitable for direct template matching.

3. **No new screen type needed** — Staircase rooms classify as `dungeon`. The side-scrolling layout doesn't affect screen classification.

4. **Existing ItemHoldTracker can cover the hoisted case** — It already monitors for item-hold animations (currently used for triforce). The pedestal scan tells us WHAT item was picked up; the hold animation confirms WHEN.

5. **Item position is fixed** — All Zelda 1 staircase rooms use the same layout. The pedestal item position is consistent at approximately NES (136, 148) in the full 256x240 frame.

---

## Proposed Architecture

### Overview

Add a `detect_staircase_item()` method to `ItemDetector` that scans a fixed hot zone in the game area for item sprites on the staircase pedestal. Wire it into `NesStateDetector.detect()` and `GameLogicValidator` for event tracking.

### Detection Flow

```
NesStateDetector.detect()
  └── ItemDetector.detect_items(frame, screen_type)
        ├── _detect_triforce(game_area)        [existing]
        └── _detect_staircase_item(game_area)  [NEW]
              ├── Extract 32x40 region at pedestal hot zone
              ├── ItemReader.read_item(region) → item name
              └── Return DetectedItem if score > threshold
```

### Changes by File

#### 1. `vision/detector/item_detector.py`

**Add `ItemReader` dependency and pedestal scan method.**

- Constructor takes optional `ItemReader` instance
- New `_detect_staircase_item(game_area)` method:
  - Extracts a **32x40** region centered on the pedestal position
    - NES game-area coords: x=120, y=68 (=132 full-frame minus 64 HUD), w=32, h=40
    - This gives 8x16 templates 25x25 sliding positions — handles ±12px crop error
  - Calls `item_reader.read_item(region)` for the match
  - Also calls `item_reader.read_item_scored(region)` to get confidence
  - **Isolation check**: verify the region is mostly dark (mean brightness < 40) to reject false positives when Link/enemies are present but no item sits on the pedestal
  - Returns `DetectedItem(item_type=matched_name, x=cx, y=cy, confidence=score)` or None
- Only runs when `screen_type == 'dungeon'`

**Constants:**
```python
# Staircase pedestal hot zone (game area coordinates, relative to y=64)
_PEDESTAL_X = 120     # left edge of extraction region
_PEDESTAL_Y = 68      # top edge (game-area coords = full-frame 132)
_PEDESTAL_W = 32      # extraction width
_PEDESTAL_H = 40      # extraction height
_PEDESTAL_BRIGHTNESS_MAX = 40  # reject regions with too much non-item content
_STAIRCASE_ITEM_THRESHOLD = 0.55  # higher than default 0.3 to reduce false positives
```

#### 2. `vision/detector/nes_state.py`

**Wire ItemReader into ItemDetector.**

- Pass `self.item_reader` to `ItemDetector.__init__()` (ItemReader is already available in NesStateDetector)
- The existing `self.item_detector.detect_items()` call already runs on every gameplay frame — no new call needed
- The `DetectedItem` from staircase detection flows through the same `detected_item` / `detected_item_y` fields in GameState

#### 3. `vision/detector/game_logic.py`

**Add staircase item tracking.**

New tracker: `StaircaseItemTracker` (similar to existing `ItemHoldTracker`):

- **State machine:**
  1. `idle` — no staircase item detected
  2. `item_visible` — item detected on pedestal for N consecutive frames
  3. `item_acquired` — item disappeared from pedestal (Link picked it up)

- **Transition logic:**
  - `idle → item_visible`: detected_item is not None AND detected_item is NOT 'triforce' AND screen_type == 'dungeon', for 2+ consecutive frames
  - `item_visible → item_acquired`: detected_item becomes None (item disappeared from pedestal), for 3+ consecutive frames
  - `item_acquired → idle`: after emitting the game event

- **Game event:** `staircase_item_acquired` with payload `{item: "red_ring", dungeon_level: 3}`

- **Implications on GameState:** When a staircase item is acquired:
  - `blue_ring` / `red_ring` → potential ring upgrade (not directly trackable from HUD, but informative for commentary)
  - `heart_container` → expect max_hearts to increase (already tracked by Rule 1)
  - Other items → informative event for commentary/tracker

#### 4. No changes needed

- `screen_classifier.py` — staircase rooms are already 'dungeon', no new type
- `item_reader.py` / `shape_matcher.py` — existing binary shape matching works as-is
- `templates/items/` — existing templates cover all staircase items

### Verification Plan

1. **Unit test with golden frames**: Save the two exploration screenshots as properly-cropped 256x240 golden frames. Write tests asserting `detect_staircase_item()` returns `red_ring` for the pedestal frame and `None` for the hoisted frame.

2. **Integration test with VOD**: Run against the BogieSmalls training VOD (2705396017). Look for staircase room events at known timestamps. Verify no false positives on normal dungeon rooms.

3. **Edge cases to test:**
   - Empty pedestal (after item pickup) → should return None
   - Link standing on/near the pedestal → isolation check should reject
   - Different items (heart container, boomerang, etc.) → verify template matching works
   - Different dungeon levels (palette changes) → verify binary shape matching is palette-agnostic

### Cost Analysis

- **Per-frame cost**: One 32x40 region extraction + 27 template matches (8x16 sliding within 32x40 = 625 positions per template). ~0.5ms per frame on modern hardware.
- **Only active during dungeon frames**: No cost on overworld/cave/subscreen.
- **Memory**: No new templates needed. One new tracker state (~100 bytes).

### Future Extensions

1. **Staircase room detection**: Could add visual fingerprinting of the side-scrolling room layout to activate the scan only in actual staircase rooms (rather than every dungeon frame). Low priority — the isolation check and dungeon-only gate already prevent most false positives.

2. **Hoisted item confirmation**: Extend ItemHoldTracker to confirm what item was picked up by correlating the staircase detection with the subsequent hold animation. Currently ItemHoldTracker only tracks triforce; could generalize.

3. **Cave item detection**: Similar approach for cave shops/old men who give items. Same pedestal-style presentation. Different room coordinates.
