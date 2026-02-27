# Floor Item Detection — Architecture Plan

## Exploration Results

Tested 4 approaches on 5 dungeon golden frames with 27 item templates (8x16 NES sprites).

### Approach Comparison

| Approach | Recall | FP/frame | Speed | Viable? |
|----------|--------|----------|-------|---------|
| A. Connected components + ItemReader | 33% | 25 | 208ms | NO |
| B. Binary shape sliding window | 53% | 8 | 12ms | NO |
| **C. Full-color sliding window** | **99%** | **2.2** | **64ms** | **YES** |
| D. Two-pass (binary -> color verify) | 57% | 1 | 18ms | NO |

### Key Findings

1. **Full-color template matching wins decisively.** `cv2.matchTemplate` with
   `TM_CCOEFF_NORMED` on BGR images achieves 99% recall at threshold 0.70,
   with only 2.2 false positives per frame on empty dungeon backgrounds.

2. **Score separation is clean.** TP scores range 0.87-1.00 (mean 0.95).
   FP scores range 0.60-0.78 (mean 0.66). A threshold of 0.80 provides a
   clean 0.09 gap between the lowest TP and highest FP — zero overlap.

3. **Binary shape matching fails on dungeons.** Wall edges and door frames
   produce binary patterns that match thin item templates (wand at 0.91,
   sword_white at 0.90, magical_shield at 0.83). Full-color matching
   discriminates because walls are brown while items are distinctly colored.

4. **BG-color masking is counterproductive.** Zeroing floor/wall pixels
   (via `_zero_bg()`) creates new bright-on-black patterns that INCREASE
   false matches. The existing `bg_colors` mechanism works for HUD items
   (black background) but not for floor detection.

5. **Connected components candidate detection has poor recall** (~33%)
   because many item pixels are too dim at useful thresholds. Items like
   bomb (only 13 bright pixels at threshold 30) and boomerang (24 pixels
   total) fragment or disappear entirely.

6. **Performance is viable at 4fps.** 64ms = 26% of the 250ms per-frame
   budget. Frame-diff guard (0.05ms) skips static frames, and running every
   2nd frame halves the average cost to ~32ms.

### False Positive Sources

The remaining FP at threshold 0.70 are:
- `wand` / `recorder` on vertical wall edges (score 0.73-0.78)
- `boomerang` on wall corners (score 0.72)
- `magical_shield` on door frames (score 0.65-0.67)

All are in the wall/border margin zone (outer 16px of game area).
Wall margin exclusion eliminates most of these.

## Proposed Architecture

### Detection Pipeline

```
detect_floor_items(game_area: ndarray, screen_type: str) -> list[FloorItem]
    1. Frame-diff guard: skip if game_area unchanged from last call
    2. Convert game_area to float32 (one-time per frame)
    3. For each template in ITEM_TEMPLATES:
         cv2.matchTemplate(game_area_f32, template_f32, TM_CCOEFF_NORMED)
         Collect all positions with score >= 0.80
         Apply margin filter (skip detections in outer 16px)
    4. Non-maximum suppression (8px x, 16px y distance)
    5. Color disambiguation for shape twins (reuse ItemReader._pick_by_color)
    6. Return list of FloorItem(name, x, y, score)
```

### Data Types

```python
@dataclass
class FloorItem:
    name: str       # e.g., 'blue_candle', 'heart_container'
    x: int          # NES pixel x position in game_area
    y: int          # NES pixel y position in game_area
    score: float    # matchTemplate NCC score (0.80-1.00)
```

### Integration with NES State

```
nes_state.py:
    if screen_type in ('dungeon', 'overworld'):
        state.floor_items = floor_detector.detect(game_area, screen_type)
```

Floor items are added to `GameState` alongside existing fields (screen_type,
hearts, keys, etc.). The game_logic layer can then infer events:
- `item_pickup`: item disappears between frames
- `item_drop`: new item appears after enemy death

### Performance Optimizations

| Optimization | Savings | Notes |
|-------------|---------|-------|
| Frame-diff guard | Skip 80%+ frames | Items are static; most frames unchanged |
| Precomputed float32 templates | ~2ms | One-time cost at init |
| Margin check before NMS | Reduce NMS input | Most FP are at walls |
| Run every 2nd frame | 50% avg cost | Items persist for many frames |
| Temporal confirmation | Eliminate transient FP | Require 2+ consecutive detections |

Expected real-world cost: **~5-15ms average** (most frames skipped by diff guard).

### Threshold Selection

| Threshold | Recall | FP/frame | Notes |
|-----------|--------|----------|-------|
| 0.65 | 99% | 2.8 | Aggressive — more false positives |
| 0.70 | 99% | 2.2 | Balanced — good for initial detection |
| 0.75 | 99% | 0.8 | Conservative — few false positives |
| 0.80 | ~95%* | ~0 | Safest — score gap ensures zero FP |

*0.80 may miss items with palette variations in real captures (synthetic items
score 1.0 due to exact template match; real captures will score lower due to
capture artifacts). Start with 0.75, tune down to 0.70 if recall drops.

**Recommended starting threshold: 0.75**

### What This Does NOT Cover

- **Overworld floor items**: Different floor colors (green, brown, sand).
  Need to test on overworld golden frames. The full-color approach should
  still work — just different FP patterns.
- **Link/enemy discrimination**: Link (16x16, flesh tones) and enemies
  will produce false matches. Temporal tracking (Link moves, items don't)
  and size filtering (Link is 16x16, items are 8x16) can help.
- **Capture artifact robustness**: Real stream captures have compression
  artifacts, color shifts, and sub-pixel alignment issues that will lower
  TP scores. Need to validate on real VOD frames.
- **Item disambiguation in practice**: Shape twins need real color data to
  verify the `_pick_by_color` approach works on captured video.

## File Plan

| File | Action | Description |
|------|--------|-------------|
| `detector/floor_item_detector.py` | Create | `FloorItemDetector` class with detection pipeline |
| `detector/color_utils.py` | Extend | Add overworld floor colors if needed |
| `nes_state.py` | Extend | Add `floor_items` field to GameState |
| `game_logic.py` | Extend | Infer item_pickup / item_drop events |
| `tests/test_floor_items.py` | Create | Unit tests with golden frame composites |

## Validation Steps

1. **Synthetic**: Run `explore_floor_items.py` — already passing (99% recall, 2.2 FP)
2. **Real dungeon frames**: User provides screenshots with visible floor items
3. **Full VOD test**: Run on training VOD, check for false item detections
4. **Performance**: Profile in learn_mode.py pipeline, verify < 30ms average
