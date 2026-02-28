# Native-Resolution Vision Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace early 256×240 canonicalization with native-resolution tile extraction throughout all vision detectors, eliminating codec-artifact noise and dramatically improving detection reliability across all streamers.

**Architecture:** The current pipeline crops the stream frame then immediately resizes to 256×240 before any detection — this is where Twitch's H.264 8×8 DCT blocks directly smear NES 8×8 tiles together. The fix is to keep the native crop (typically 960×720 or 1280×720) and map all NES pixel coordinates to stream coordinates using `scale_x = crop_w/256`, `scale_y = crop_h/240`. `HudReader.set_stream_source()` already implements this correctly for HUD tiles; this plan extends the same pattern to `ScreenClassifier`, `TriforceReader`, and `InventoryReader`, and removes the guard that previously limited it to landmark-only streams. The 256×240 canonical frame is preserved *only* for `FloorItemDetector` (sliding window — would be too slow at native scale).

**Tech Stack:** Python, NumPy, OpenCV (`cv2`), existing test suite in `vision/tests/` (pytest)

---

## Context and Key Files

| File | Role |
|------|------|
| `vision/vision_engine.py` | Main loop — reads frames, crops, canonicalizes, calls detector |
| `vision/detector/nes_state.py` | `NesStateDetector` — orchestrates all sub-detectors |
| `vision/detector/screen_classifier.py` | `ScreenClassifier` — hardcoded 256×240 pixel coords |
| `vision/detector/hud_reader.py` | `HudReader` — already has `set_stream_source()` working correctly |
| `vision/detector/triforce_reader.py` | `TriforceReader` — hardcoded NES pixel coords (lines 24–43, 142–151) |
| `vision/detector/inventory_reader.py` | `InventoryReader` — SWAP detection at hardcoded y=0–40, x=24–72 |
| `vision/detector/floor_item_detector.py` | `FloorItemDetector` — stays on canonical (performance) |
| `vision/tests/` | All existing tests — must stay green throughout |

## What "scale_x / scale_y" Means

```
scale_x = crop_w / 256.0   # e.g. 960/256 = 3.75 for typical 4:3 1280×720 stream
scale_y = crop_h / 240.0   # e.g. 720/240 = 3.0

# NES pixel → nes_region pixel:
native_x = round(nes_x * scale_x)
native_y = round(nes_y * scale_y)
native_w = max(1, round(8 * scale_x))
native_h = max(1, round(8 * scale_y))
```

`nes_region` in the plan below means the already-cropped stream frame at native resolution (shape `crop_h × crop_w`). NOT the full 1920×1080 stream frame — that belongs to `HudReader.set_stream_source()` which handles sub-pixel landmark mapping separately.

---

## Task 1: Add `set_native_crop()` to ScreenClassifier

**Files:**
- Modify: `vision/detector/screen_classifier.py`
- Test: `vision/tests/test_screen_classifier_native.py` (create)

### Step 1: Write the failing test

```python
# vision/tests/test_screen_classifier_native.py
import numpy as np
import pytest
from detector.screen_classifier import ScreenClassifier


def _make_canonical_dungeon_frame(grid_dx=1, grid_dy=2, life_row=5):
    """Create a 256×240 frame with red LIFE text and dark game area."""
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    # Dark game area (dungeon brightness)
    frame[64:, :] = 20
    # Red LIFE text at (22*8+dx, life_row*8+dy) = (177, 42) for dx=1,dy=2,row=5
    x = 22 * 8 + grid_dx
    y = life_row * 8 + grid_dy
    frame[y:y+8, x:x+8] = [0, 0, 200]  # BGR red
    return frame


def _scale_frame(frame, scale_x, scale_y):
    """Upscale a canonical frame to simulate native stream resolution."""
    import cv2
    h, w = frame.shape[:2]
    return cv2.resize(frame, (round(w * scale_x), round(h * scale_y)),
                      interpolation=cv2.INTER_NEAREST)


def test_classify_dungeon_at_native_resolution():
    """ScreenClassifier correctly identifies dungeon at 3.75×3.0 scale."""
    clf = ScreenClassifier(grid_offset=(1, 2), life_row=5)
    canonical = _make_canonical_dungeon_frame()
    # Simulate a 960×720 native crop (typical 4:3 1280×720 stream)
    scale_x, scale_y = 960 / 256, 720 / 240
    native = _scale_frame(canonical, scale_x, scale_y)
    clf.set_native_crop(native, scale_x, scale_y)
    result = clf.classify(canonical)  # canonical still passed, native overrides reads
    clf.clear_native_crop()
    assert result == 'dungeon'


def test_classify_without_native_still_works():
    """When no native crop is set, classify() uses the canonical frame as before."""
    clf = ScreenClassifier(grid_offset=(1, 2), life_row=5)
    canonical = _make_canonical_dungeon_frame()
    assert clf.classify(canonical) == 'dungeon'


def test_native_crop_cleared_after_clear():
    """After clear_native_crop(), uses canonical frame."""
    clf = ScreenClassifier(grid_offset=(1, 2), life_row=5)
    canonical = _make_canonical_dungeon_frame()
    native = _scale_frame(canonical, 3.75, 3.0)
    clf.set_native_crop(native, 3.75, 3.0)
    clf.clear_native_crop()
    # Should still work with canonical (no crash, correct result)
    assert clf.classify(canonical) == 'dungeon'
```

### Step 2: Run test to verify it fails

```
cd vision && pytest tests/test_screen_classifier_native.py -v
```
Expected: `AttributeError: 'ScreenClassifier' object has no attribute 'set_native_crop'`

### Step 3: Implement `set_native_crop()` and helpers

In `screen_classifier.py`, add to `ScreenClassifier.__init__()`:

```python
def __init__(self, grid_offset: tuple[int, int] = (1, 2), life_row: int = 5):
    self.grid_dx, self.grid_dy = grid_offset
    self._life_row = life_row
    # Native crop support — set per-frame via set_native_crop()
    self._native_crop: np.ndarray | None = None
    self._scale_x: float = 1.0
    self._scale_y: float = 1.0
```

Add these methods to `ScreenClassifier`:

```python
def set_native_crop(self, crop_frame: np.ndarray,
                    scale_x: float, scale_y: float) -> None:
    """Provide the native-resolution crop for this frame.

    When set, all pixel reads use stream-space coordinates computed from
    scale_x = crop_w/256, scale_y = crop_h/240. Dramatically improves
    reliability by avoiding Twitch H.264 DCT artifacts that smear 8×8 tiles
    when the frame is downscaled to 256×240.

    Args:
        crop_frame: The NES game region at native stream resolution
                    (shape: crop_h × crop_w, BGR).
        scale_x:    crop_w / 256.0
        scale_y:    crop_h / 240.0
    """
    self._native_crop = crop_frame
    self._scale_x = scale_x
    self._scale_y = scale_y

def clear_native_crop(self) -> None:
    """Release the native crop reference (call after each frame)."""
    self._native_crop = None

def _af(self, canonical: np.ndarray) -> np.ndarray:
    """Return active frame: native crop if set, else canonical."""
    return self._native_crop if self._native_crop is not None else canonical

def _sc(self, nes_x: int, nes_y: int,
        nes_w: int = 8, nes_h: int = 8) -> tuple[int, int, int, int]:
    """Scale NES pixel coords to active-frame coords.

    Returns (x, y, w, h) in the active frame's coordinate space.
    When native crop is set, multiplies by scale factors.
    When no native crop, returns NES coords unchanged (1:1).
    """
    if self._native_crop is not None:
        return (round(nes_x * self._scale_x),
                round(nes_y * self._scale_y),
                max(1, round(nes_w * self._scale_x)),
                max(1, round(nes_h * self._scale_y)))
    return nes_x, nes_y, nes_w, nes_h
```

### Step 4: Refactor all pixel reads in ScreenClassifier to use `_af()` / `_sc()`

Replace each method body (do NOT change method signatures or the `classify()` logic):

**`_has_life_text`** — replace body:
```python
def _has_life_text(self, frame: np.ndarray) -> bool:
    src = self._af(frame)
    x, y, w, h = self._sc(22 * 8 + self.grid_dx, self._life_row * 8 + self.grid_dy)
    if y + h > src.shape[0] or x + w > src.shape[1]:
        return False
    tile = src[y:y + h, x:x + w]
    avg = np.mean(tile, axis=(0, 1))
    r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
    return r > RED_CHANNEL_MIN and r > g * RED_TO_GREEN_RATIO and r > b * RED_TO_BLUE_RATIO
```

**`_classify_gameplay`** — replace body:
```python
def _classify_gameplay(self, frame: np.ndarray) -> str:
    src = self._af(frame)
    hud_h = round(64 * self._scale_y) if self._native_crop is not None else 64
    game_area = src[hud_h:, :, :]
    avg_brightness = float(np.mean(game_area))
    if avg_brightness < DUNGEON_BRIGHTNESS_MAX:
        return 'dungeon'
    elif avg_brightness < CAVE_BRIGHTNESS_MAX:
        return 'cave'
    else:
        return 'overworld'
```

**`_is_death_flash`** — replace body:
```python
def _is_death_flash(self, game_area: np.ndarray) -> bool:
    # game_area is already the sliced region — no scaling needed here
    red_mean = float(np.mean(game_area[:, :, 2]))
    green_mean = float(np.mean(game_area[:, :, 1]))
    blue_mean = float(np.mean(game_area[:, :, 0]))
    return (red_mean > DEATH_FLASH_RED_MIN
            and red_mean > green_mean * RED_TO_GREEN_RATIO
            and red_mean > blue_mean * RED_TO_BLUE_RATIO)
```

Update `classify()` to pass the scaled game_area to `_is_death_flash`:
```python
def classify(self, frame: np.ndarray) -> str:
    if self._has_life_text(frame):
        return self._classify_gameplay(frame)

    src = self._af(frame)
    hud_h = round(64 * self._scale_y) if self._native_crop is not None else 64
    game_area = src[hud_h:, :, :]
    full_brightness = float(np.mean(src))

    if full_brightness < TRANSITION_BRIGHTNESS_MAX:
        return 'transition'
    if self._is_death_flash(game_area):
        return 'death'
    if self._has_shifted_hud(frame):
        return 'subscreen'
    if self._is_death_menu(frame):
        return 'death'
    if self._is_title(frame):
        return 'title'
    if full_brightness < LOW_BRIGHTNESS_MAX:
        return 'transition'
    game_brightness = float(np.mean(game_area))
    if game_brightness < SUBSCREEN_DARK_GAME_MAX:
        return 'subscreen'
    return 'unknown'
```

**`_has_shifted_hud`** — replace body (step by 1 native pixel, limit scan iterations):
```python
def _has_shifted_hud(self, frame: np.ndarray) -> bool:
    src = self._af(frame)
    x, _, tw, th = self._sc(22 * 8 + self.grid_dx, 0)
    if x + tw > src.shape[1]:
        return False

    y_start = round(SHIFTED_HUD_Y_START * self._scale_y) if self._native_crop is not None else SHIFTED_HUD_Y_START
    y_end   = round(SHIFTED_HUD_Y_END   * self._scale_y) if self._native_crop is not None else SHIFTED_HUD_Y_END
    y_end = min(y_end, src.shape[0] - th)
    # Step by 1 native pixel for sub-pixel accuracy; 4 consecutive = ~1 NES row
    step = max(1, round(self._scale_y)) if self._native_crop is not None else 1

    life_y = None
    consecutive_red = 0
    for y in range(y_start, y_end, step):
        tile = src[y:y + th, x:x + tw]
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        if r > RED_CHANNEL_MIN and r > g * RED_TO_GREEN_RATIO and r > b * RED_TO_BLUE_RATIO:
            consecutive_red += 1
            if consecutive_red >= CONSECUTIVE_RED_ROWS_MIN and life_y is None:
                life_y = y - (CONSECUTIVE_RED_ROWS_MIN - 1) * step
        else:
            consecutive_red = 0

    if life_y is None:
        return False

    # Minimap check — scale all minimap coords
    map_y_above = round(MINIMAP_Y_ABOVE_LIFE * self._scale_y) if self._native_crop is not None else MINIMAP_Y_ABOVE_LIFE
    map_y_below = round(MINIMAP_Y_BELOW_LIFE * self._scale_y) if self._native_crop is not None else MINIMAP_Y_BELOW_LIFE
    mx1 = round(MINIMAP_X_START * self._scale_x) if self._native_crop is not None else MINIMAP_X_START
    mx2 = round(MINIMAP_X_END   * self._scale_x) if self._native_crop is not None else MINIMAP_X_END
    map_y   = max(0, life_y - map_y_above)
    map_y2  = min(src.shape[0], life_y + map_y_below)
    if map_y2 - map_y < th or mx2 <= mx1:
        return False
    map_region = src[map_y:map_y2, mx1:mx2]
    avg_map = np.mean(map_region, axis=(0, 1))
    channel_spread = float(max(avg_map) - min(avg_map))
    brightness = float(np.mean(avg_map))
    return (channel_spread < MINIMAP_CHANNEL_SPREAD_MAX
            and MINIMAP_BRIGHTNESS_MIN < brightness < MINIMAP_BRIGHTNESS_MAX)
```

**`_is_death_menu`** — replace body:
```python
def _is_death_menu(self, frame: np.ndarray) -> bool:
    src = self._af(frame)
    full_brightness = float(np.mean(src))
    if full_brightness > DEATH_MENU_BRIGHTNESS_MAX or full_brightness < DEATH_MENU_BRIGHTNESS_MIN:
        return False
    cy1 = round(DEATH_MENU_CENTER_Y[0] * self._scale_y) if self._native_crop is not None else DEATH_MENU_CENTER_Y[0]
    cy2 = round(DEATH_MENU_CENTER_Y[1] * self._scale_y) if self._native_crop is not None else DEATH_MENU_CENTER_Y[1]
    cx1 = round(DEATH_MENU_CENTER_X[0] * self._scale_x) if self._native_crop is not None else DEATH_MENU_CENTER_X[0]
    cx2 = round(DEATH_MENU_CENTER_X[1] * self._scale_x) if self._native_crop is not None else DEATH_MENU_CENTER_X[1]
    center = src[cy1:cy2, cx1:cx2, :]
    if center.size == 0:
        return False
    center_brightness = float(np.mean(center))
    if center_brightness < DEATH_MENU_CENTER_BRIGHT_MIN or center_brightness > DEATH_MENU_CENTER_BRIGHT_MAX:
        return False
    white_mask = np.mean(center, axis=2) > WHITE_PIXEL_THRESHOLD
    white_ratio = float(np.sum(white_mask)) / (center.shape[0] * center.shape[1])
    return WHITE_RATIO_MIN < white_ratio < WHITE_RATIO_MAX
```

**`_is_title`** — replace body:
```python
def _is_title(self, frame: np.ndarray) -> bool:
    src = self._af(frame)
    top_rows = round(TITLE_TOP_ROWS * self._scale_y) if self._native_crop is not None else TITLE_TOP_ROWS
    top = src[0:top_rows, :, :]
    return float(np.mean(top)) < TITLE_TOP_BRIGHTNESS_MAX
```

### Step 5: Run tests

```
cd vision && pytest tests/test_screen_classifier_native.py tests/test_game_logic.py -v
```
Expected: All pass.

### Step 6: Commit

```bash
git add vision/detector/screen_classifier.py vision/tests/test_screen_classifier_native.py
git commit -m "feat(vision): add native-resolution support to ScreenClassifier"
```

---

## Task 2: Add `set_native_crop()` to TriforceReader

**Files:**
- Modify: `vision/detector/triforce_reader.py`
- Test: `vision/tests/test_triforce_native.py` (create)

### Step 1: Write the failing test

```python
# vision/tests/test_triforce_native.py
import numpy as np
import cv2
import pytest
from detector.triforce_reader import TriforceReader


def _make_triforce_subscreen(life_y_nes=180, num_pieces=3, scale_x=1.0, scale_y=1.0):
    """Create a frame with LIFE text + N gold triforce clusters at native scale."""
    w = round(256 * scale_x)
    h = round(240 * scale_y)
    frame = np.zeros((h, w, 3), dtype=np.uint8)

    # Red LIFE text at life_y_nes scaled
    lx = round((22 * 8 + 1) * scale_x)
    ly = round(life_y_nes * scale_y)
    tw, th = max(1, round(8 * scale_x)), max(1, round(8 * scale_y))
    frame[ly:ly + th, lx:lx + tw] = [0, 0, 200]

    # Gold triforce clusters above LIFE
    piece_x_positions = [92, 110, 128]
    for px in piece_x_positions[:num_pieces]:
        cx = round(px * scale_x)
        cy = round((life_y_nes - 60) * scale_y)
        pw, ph = max(4, round(10 * scale_x)), max(4, round(10 * scale_y))
        frame[cy:cy + ph, cx:cx + pw] = [0, 150, 200]  # BGR orange/gold

    return frame


def test_triforce_at_canonical_scale():
    reader = TriforceReader(grid_offset=(1, 2))
    frame = _make_triforce_subscreen(num_pieces=3)
    result = reader.read_triforce(frame)
    assert sum(result) == 3


def test_triforce_at_native_scale_3x():
    """TriforceReader finds triforce pieces at 3× native scale."""
    reader = TriforceReader(grid_offset=(1, 2))
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_triforce_subscreen(num_pieces=2, scale_x=scale_x, scale_y=scale_y)
    reader.set_native_crop(frame, scale_x, scale_y)
    result = reader.read_triforce(frame)
    reader.clear_native_crop()
    assert sum(result) == 2


def test_triforce_clear_native_crop():
    reader = TriforceReader(grid_offset=(1, 2))
    frame = _make_triforce_subscreen(num_pieces=1, scale_x=3.75, scale_y=3.0)
    reader.set_native_crop(frame, 3.75, 3.0)
    reader.clear_native_crop()
    # After clear, should not crash on canonical input
    canonical = _make_triforce_subscreen(num_pieces=1)
    assert isinstance(reader.read_triforce(canonical), list)
```

### Step 2: Run to verify failure

```
cd vision && pytest tests/test_triforce_native.py -v
```
Expected: `AttributeError: 'TriforceReader' object has no attribute 'set_native_crop'`

### Step 3: Implement

In `TriforceReader.__init__()`, add:
```python
def __init__(self, grid_offset: tuple[int, int] = (1, 2)):
    self.grid_dx, self.grid_dy = grid_offset
    self._native_crop: np.ndarray | None = None
    self._scale_x: float = 1.0
    self._scale_y: float = 1.0
```

Add methods:
```python
def set_native_crop(self, crop_frame: np.ndarray,
                    scale_x: float, scale_y: float) -> None:
    """Provide the native-resolution crop for this frame."""
    self._native_crop = crop_frame
    self._scale_x = scale_x
    self._scale_y = scale_y

def clear_native_crop(self) -> None:
    self._native_crop = None

def _af(self, canonical: np.ndarray) -> np.ndarray:
    return self._native_crop if self._native_crop is not None else canonical

def _s(self, v: float, axis: str) -> int:
    """Scale a NES pixel value along 'x' or 'y' axis."""
    if self._native_crop is None:
        return int(v)
    return round(v * (self._scale_x if axis == 'x' else self._scale_y))
```

Replace `_find_life_y()` body:
```python
def _find_life_y(self, frame: np.ndarray) -> int | None:
    src = self._af(frame)
    x  = self._s(22 * 8 + self.grid_dx, 'x')
    tw = max(1, self._s(8, 'x'))
    th = max(1, self._s(8, 'y'))
    y_start = self._s(100, 'y')
    y_end   = min(self._s(232, 'y'), src.shape[0] - th)
    if x + tw > src.shape[1]:
        return None
    for y in range(y_start, y_end):
        tile = src[y:y + th, x:x + tw]
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        if r > 50 and r > g * 2 and r > b * 2:
            return y
    return None
```

Replace `read_triforce()` body (scale all hardcoded coords):
```python
def read_triforce(self, frame: np.ndarray) -> list[bool]:
    src = self._af(frame)
    life_y = self._find_life_y(frame)
    if life_y is None:
        return [False] * 8

    y_start = max(0, life_y - self._s(TRIFORCE_Y_OFFSET_MAX, 'y'))
    y_end   = max(0, life_y - self._s(TRIFORCE_Y_OFFSET_MIN, 'y'))
    x_start = self._s(TRIFORCE_X_START, 'x')
    x_end   = self._s(TRIFORCE_X_END, 'x')

    if y_end <= y_start or x_end <= x_start:
        return [False] * 8

    region = src[y_start:y_end, x_start:x_end]
    if region.size == 0:
        return [False] * 8

    gold_mask = self._gold_mask(region)
    total_gold = int(np.sum(gold_mask))
    if total_gold < MIN_GOLD_PIXELS:
        return [False] * 8

    gold_ys, gold_xs = np.where(gold_mask)
    abs_xs = gold_xs + x_start   # absolute X in src frame

    sorted_xs = np.sort(abs_xs)
    gap_threshold = max(8, self._s(8, 'x'))   # scale cluster gap threshold
    min_cluster_pixels = max(3, self._s(3, 'x') * self._s(3, 'y') // 9)

    clusters = []
    cluster_start = int(sorted_xs[0])
    cluster_end   = int(sorted_xs[0])
    cluster_count = 1
    for x in sorted_xs[1:]:
        if x - cluster_end <= gap_threshold:
            cluster_end = int(x)
            cluster_count += 1
        else:
            if cluster_count >= min_cluster_pixels:
                clusters.append((cluster_start + cluster_end) // 2)
            cluster_start = int(x)
            cluster_end   = int(x)
            cluster_count = 1
    if cluster_count >= min_cluster_pixels:
        clusters.append((cluster_start + cluster_end) // 2)

    self._last_cluster_centers = clusters
    self._last_num_collected = len(clusters)

    result = [False] * 8
    for i in range(min(len(clusters), 8)):
        result[i] = True
    return result
```

### Step 4: Run tests

```
cd vision && pytest tests/test_triforce_native.py tests/vision/ -v
```
Expected: All pass.

### Step 5: Commit

```bash
git add vision/detector/triforce_reader.py vision/tests/test_triforce_native.py
git commit -m "feat(vision): add native-resolution support to TriforceReader"
```

---

## Task 3: Add `set_native_crop()` to InventoryReader (SWAP detection)

**Files:**
- Modify: `vision/detector/inventory_reader.py`
- Test: `vision/tests/test_inventory_native.py` (create)

**Context:** Z1R returns `{}` for item grid reads; the only active code path is Z1R SWAP detection — red "SWAP" text at y=0–40, x=24–72. The subscreen item slot positions (ACTIVE_ITEM_SLOTS, etc.) are not used in Z1R. Only scale the SWAP detection region.

### Step 1: Write the failing test

Find the `InventoryReader` class and its SWAP detection method first:

```
cd vision && grep -n "class InventoryReader\|def.*swap\|def.*read\|SWAP\|y=0\|x=24" detector/inventory_reader.py
```

Then write a test matching that method's signature.

```python
# vision/tests/test_inventory_native.py
import numpy as np
import pytest
from detector.inventory_reader import InventoryReader


def _make_swap_frame(has_swap=True, scale_x=1.0, scale_y=1.0):
    """Frame with red SWAP text in top-left (or blank if has_swap=False)."""
    w = round(256 * scale_x)
    h = round(240 * scale_y)
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    if has_swap:
        # Red pixels in SWAP region: y=5-35, x=30-70 in NES coords
        y1 = round(5 * scale_y)
        y2 = round(35 * scale_y)
        x1 = round(30 * scale_x)
        x2 = round(70 * scale_x)
        frame[y1:y2, x1:x2] = [0, 0, 180]  # BGR red
    return frame


def test_swap_detected_at_canonical():
    reader = InventoryReader()
    frame = _make_swap_frame(has_swap=True)
    assert reader.is_z1r_swap(frame) is True


def test_no_swap_at_canonical():
    reader = InventoryReader()
    frame = _make_swap_frame(has_swap=False)
    assert reader.is_z1r_swap(frame) is False


def test_swap_detected_at_native_scale():
    reader = InventoryReader()
    scale_x, scale_y = 960 / 256, 720 / 240
    frame = _make_swap_frame(has_swap=True, scale_x=scale_x, scale_y=scale_y)
    reader.set_native_crop(frame, scale_x, scale_y)
    result = reader.is_z1r_swap(frame)
    reader.clear_native_crop()
    assert result is True
```

*Note:* If the actual method name for SWAP detection differs from `is_z1r_swap`, adjust the test to match. Run `grep -n "def " detector/inventory_reader.py` to find the real method names.

### Step 2: Run to verify failure

```
cd vision && pytest tests/test_inventory_native.py -v
```

### Step 3: Implement

In `InventoryReader.__init__()` add:
```python
self._native_crop: np.ndarray | None = None
self._scale_x: float = 1.0
self._scale_y: float = 1.0
```

Add methods:
```python
def set_native_crop(self, crop_frame: np.ndarray,
                    scale_x: float, scale_y: float) -> None:
    self._native_crop = crop_frame
    self._scale_x = scale_x
    self._scale_y = scale_y

def clear_native_crop(self) -> None:
    self._native_crop = None
```

In the SWAP detection method, replace the frame slice at the top with:
```python
src = self._native_crop if self._native_crop is not None else frame
if self._native_crop is not None:
    y_max = round(40 * self._scale_y)
    x_min = round(24 * self._scale_x)
    x_max = round(72 * self._scale_x)
else:
    y_max, x_min, x_max = 40, 24, 72
swap_region = src[0:y_max, x_min:x_max]
```

Preserve the existing red-pixel-count logic unchanged — it operates on `swap_region` and threshold values that are ratios/counts, not coordinates.

### Step 4: Run tests

```
cd vision && pytest tests/test_inventory_native.py -v
```
Expected: All pass.

### Step 5: Commit

```bash
git add vision/detector/inventory_reader.py vision/tests/test_inventory_native.py
git commit -m "feat(vision): add native-resolution support to InventoryReader SWAP detection"
```

---

## Task 4: Add `set_native_frame()` / `clear_native_frame()` to NesStateDetector

**Files:**
- Modify: `vision/detector/nes_state.py`
- Test: `vision/tests/test_nes_state_native.py` (create)

**Context:** `NesStateDetector` orchestrates all sub-detectors. This task adds the single entry point that vision_engine.py calls, which fans out to each sub-detector. `HudReader.set_stream_source()` takes the *full stream frame* (to handle negative crop_y edge cases); the others take the *pre-cropped nes_region*.

### Step 1: Write the failing test

```python
# vision/tests/test_nes_state_native.py
import numpy as np
import pytest
from detector.nes_state import NesStateDetector


def _make_native_dungeon_frame(crop_w=960, crop_h=720):
    """Full stream frame + crop params simulating a 960×720 game region."""
    stream = np.zeros((720, 1280, 3), dtype=np.uint8)
    crop_x, crop_y = 160, 0  # centered in 1280×720
    # Put red LIFE text at NES (177, 42) → stream (160 + round(177*3.75), round(42*3.0))
    sx = crop_x + round(177 * (crop_w / 256))
    sy = crop_y + round(42  * (crop_h / 240))
    tw = max(1, round(8 * crop_w / 256))
    th = max(1, round(8 * crop_h / 240))
    stream[sy:sy + th, sx:sx + tw] = [0, 0, 200]
    # Dark game area
    game_y = crop_y + round(64 * crop_h / 240)
    stream[game_y:crop_y + crop_h, crop_x:crop_x + crop_w] = 20
    return stream, crop_x, crop_y, crop_w, crop_h


def test_set_native_frame_propagates_to_hud_reader():
    det = NesStateDetector('templates')
    stream, cx, cy, cw, ch = _make_native_dungeon_frame()
    det.set_native_frame(stream, cx, cy, cw, ch)
    assert det.hud_reader._stream_frame is not None
    assert det.hud_reader._scale_x == pytest.approx(cw / 256.0)
    det.clear_native_frame()
    assert det.hud_reader._stream_frame is None


def test_set_native_frame_propagates_to_screen_classifier():
    det = NesStateDetector('templates')
    stream, cx, cy, cw, ch = _make_native_dungeon_frame()
    det.set_native_frame(stream, cx, cy, cw, ch)
    assert det.screen_classifier._native_crop is not None
    assert det.screen_classifier._scale_x == pytest.approx(cw / 256.0)
    det.clear_native_frame()
    assert det.screen_classifier._native_crop is None
```

### Step 2: Run to verify failure

```
cd vision && pytest tests/test_nes_state_native.py -v
```
Expected: `AttributeError: 'NesStateDetector' object has no attribute 'set_native_frame'`

### Step 3: Implement

In `nes_state.py`, add these two methods to `NesStateDetector`:

```python
def set_native_frame(self, stream_frame: np.ndarray,
                     crop_x: int, crop_y: int,
                     crop_w: int, crop_h: int) -> None:
    """Provide native-resolution frame data to all sub-detectors.

    Call this before detect() on every frame. Enables pixel reads at stream
    resolution (e.g. 960×720) instead of the downscaled 256×240 canonical,
    dramatically improving accuracy by preserving more signal per tile.

    Args:
        stream_frame: Full raw stream frame (H×W×3 BGR).
        crop_x, crop_y: Top-left of the NES game region in stream pixels.
        crop_w, crop_h: Size of the NES game region in stream pixels.
    """
    scale_x = crop_w / 256.0
    scale_y = crop_h / 240.0

    # HudReader uses the full stream frame (handles negative crop_y padding)
    self.hud_reader.set_stream_source(stream_frame, crop_x, crop_y, crop_w, crop_h)

    # Other detectors use the pre-cropped region
    fh, fw = stream_frame.shape[:2]
    sy1, sy2 = max(0, crop_y), min(fh, crop_y + crop_h)
    sx1, sx2 = max(0, crop_x), min(fw, crop_x + crop_w)
    if sy2 > sy1 and sx2 > sx1:
        nes_region = stream_frame[sy1:sy2, sx1:sx2]
        # Pad if crop extends outside stream frame (e.g. negative crop_y)
        if nes_region.shape[:2] != (crop_h, crop_w):
            padded = np.zeros((crop_h, crop_w, 3), dtype=np.uint8)
            dy_off = sy1 - crop_y
            dx_off = sx1 - crop_x
            padded[dy_off:dy_off + nes_region.shape[0],
                   dx_off:dx_off + nes_region.shape[1]] = nes_region
            nes_region = padded
    else:
        nes_region = np.zeros((crop_h, crop_w, 3), dtype=np.uint8)

    self.screen_classifier.set_native_crop(nes_region, scale_x, scale_y)
    self.triforce_reader.set_native_crop(nes_region, scale_x, scale_y)
    self.inventory_reader.set_native_crop(nes_region, scale_x, scale_y)

def clear_native_frame(self) -> None:
    """Release all native frame references. Call after detect() on every frame."""
    self.hud_reader.clear_stream_source()
    self.screen_classifier.clear_native_crop()
    self.triforce_reader.clear_native_crop()
    self.inventory_reader.clear_native_crop()
```

### Step 4: Run tests

```
cd vision && pytest tests/test_nes_state_native.py -v
```
Expected: Both pass.

### Step 5: Run full test suite to confirm no regressions

```
cd vision && pytest tests/ -v
```
Expected: All 261+ tests pass.

### Step 6: Commit

```bash
git add vision/detector/nes_state.py vision/tests/test_nes_state_native.py
git commit -m "feat(vision): add set_native_frame() orchestration to NesStateDetector"
```

---

## Task 5: Update vision_engine.py to Always Use Native Resolution

**Files:**
- Modify: `vision/vision_engine.py` (lines 411–419)

This is the change that activates everything built in Tasks 1–4 for every frame, for every streamer, regardless of whether landmarks are configured.

### Step 1: Identify the existing conditional block

In `vision_engine.py`, the current code at the bottom of the main loop reads:

```python
# Enable stream-resolution tile extraction for HUD reading.
# Maps NES pixel coords → stream coords and extracts at native
# resolution, bypassing distortion from non-integer resize ratios.
if landmarks and sub_crop is None:
    detector.hud_reader.set_stream_source(
        frame, crop_x, crop_y, crop_w, crop_h)

process_frame(nes_canonical)
detector.hud_reader.clear_stream_source()
```

### Step 2: Replace it

Replace the entire block above with:

```python
# Always use native resolution for all detectors.
# Compute effective crop: if sub_crop was applied, the actual NES region
# in stream space is offset by (sx, sy) within the original crop.
if sub_crop is not None:
    sx, sy, sw, sh = sub_crop
    eff_crop_x = crop_x + sx
    eff_crop_y = crop_y + sy
    eff_crop_w = sw
    eff_crop_h = sh
else:
    eff_crop_x, eff_crop_y = crop_x, crop_y
    eff_crop_w, eff_crop_h = crop_w, crop_h

detector.set_native_frame(frame, eff_crop_x, eff_crop_y, eff_crop_w, eff_crop_h)
process_frame(nes_canonical)
detector.clear_native_frame()
```

### Step 3: Verify no syntax errors

```
cd vision && python -c "import vision_engine; print('OK')"
```

### Step 4: Run full test suite

```
cd vision && pytest tests/ -v
```
Expected: All tests pass.

### Step 5: Smoke-test against a real frame

Run the vision engine on 30 seconds of the training VOD and inspect the output:

```bash
streamlink --stream-url "https://www.twitch.tv/videos/2696354137" best \
  | ffmpeg -ss 440 -i pipe:0 -t 30 -vf "fps=2" \
    -pix_fmt bgr24 -vcodec rawvideo -f rawvideo pipe:1 \
  | python vision/vision_engine.py \
    --racer bogie_test \
    --crop 0,0,1280,720 \
    --width 1280 --height 720 \
    --templates vision/templates \
    --server http://localhost:3000 2>&1 | head -100
```

Look for:
- `[Vision] Auto-calibrated` or landmark-based calibration log
- `screen_type: dungeon` in the output (frame at t=451 should be dungeon)
- No Python errors

### Step 6: Commit

```bash
git add vision/vision_engine.py
git commit -m "feat(vision): unconditionally use native-resolution extraction for all detectors"
```

---

## Task 6: End-to-End Validation Against Known Ground Truth

**Files:**
- Create: `vision/tests/test_native_e2e.py` (integration test using saved frame)

### Step 1: Save a reference frame

Download a known-good frame from the training VOD at t=451 (known ground truth: dungeon LEVEL-8, red candle, 3 rupees, 0 keys, 3 bombs, 3/3 hearts):

```bash
streamlink --stream-url "https://www.twitch.tv/videos/2696354137" best \
  | ffmpeg -ss 451 -i pipe:0 -vframes 1 \
    -pix_fmt bgr24 -vcodec rawvideo -f rawvideo \
    vision/tests/fixtures/bogie_t451_raw.bin \
  && echo "width=1280 height=720" > vision/tests/fixtures/bogie_t451_raw.meta
```

*(Or save as PNG if preferred)*

### Step 2: Write the integration test

```python
# vision/tests/test_native_e2e.py
"""End-to-end test: native-resolution detection on a real VOD frame.

Ground truth at t=451 of https://www.twitch.tv/videos/2696354137:
  - screen_type: dungeon
  - dungeon_level: 8
  - b_item: red_candle
  - rupees: 3
  - keys: 0
  - bombs: 3
  - hearts_current: 3
  - hearts_max: 3
"""
import os
import numpy as np
import pytest
from detector.nes_state import NesStateDetector
from detector.game_logic import GameLogicValidator

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'bogie_t451_raw.bin')
TEMPLATES = os.path.join(os.path.dirname(__file__), '..', 'templates')
CROP = (0, 0, 1280, 720)  # full-frame crop (adjust if Bogie's crop differs)


@pytest.mark.skipif(not os.path.exists(FIXTURE), reason="VOD fixture not downloaded")
def test_bogie_t451_native_detection():
    """Canonical+native detection on bogie t=451 matches known ground truth."""
    frame = np.frombuffer(open(FIXTURE, 'rb').read(), dtype=np.uint8).reshape((720, 1280, 3))
    cx, cy, cw, ch = CROP
    nes_region = frame[cy:cy + ch, cx:cx + cw]
    import cv2
    nes_canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)

    det = NesStateDetector(TEMPLATES, grid_offset=(1, 2), life_row=5)
    det.set_native_frame(frame, cx, cy, cw, ch)
    state = det.detect(nes_canonical)
    det.clear_native_frame()

    assert state.screen_type == 'dungeon', f"Expected dungeon, got {state.screen_type}"
    assert state.dungeon_level == 8, f"Expected level 8, got {state.dungeon_level}"
    assert state.rupees == 3, f"Expected 3 rupees, got {state.rupees}"
    assert state.keys == 0, f"Expected 0 keys, got {state.keys}"
    assert state.bombs == 3, f"Expected 3 bombs, got {state.bombs}"
    assert state.hearts_current == 3
    assert state.hearts_max == 3
```

### Step 3: Run fixture download, then test

```
cd vision && pytest tests/test_native_e2e.py -v -s
```

If fixture doesn't exist, test is skipped. Download the frame manually if needed and re-run.

### Step 4: If any assertion fails, debug using diagnostics

The vision_engine writes `data/vision-diag-*.json` on the first gameplay frame. Inspect it:
```
cat data/vision-diag-bogie.json
```

Fix calibration if grid_offset is wrong for Bogie's stream. The Bogie crop profile in the DB should have the correct values — use the dashboard crop editor to verify.

### Step 5: Commit

```bash
git add vision/tests/test_native_e2e.py vision/tests/fixtures/.gitkeep
git commit -m "test(vision): add end-to-end native-resolution integration test"
```

---

## Rollback Plan

If native resolution degrades results for any existing stream:
1. In `vision_engine.py`, re-add the `if landmarks and sub_crop is None:` guard around the `set_native_frame()` call
2. This restores the old behavior (native only when landmarks configured)
3. Investigate which detector/stream combination regressed using the diagnostics JSON

---

## Test Runs Summary

After all tasks complete, run the full suite:

```
cd vision && pytest tests/ -v --tb=short 2>&1 | tail -20
```

Expected: All 265+ tests pass (261 existing + ~4 new per task).
