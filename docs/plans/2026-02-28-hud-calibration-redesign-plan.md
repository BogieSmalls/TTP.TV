# HUD Calibration & Detection Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a self-calibrating HUD anchor system, full minimap redesign with room/dot/tile recognition, and event-driven player + race item trackers — replacing every fixed-coordinate assumption in the vision pipeline.

**Architecture:** `HudCalibrator` detects LIFE text + B/A borders + digit rows + gameplay boundary to compute a locked affine map (NES→canonical pixel). `HudReader._extract()` uses it. `MinimapReader` derives its grid from calibrated anchors + LEVEL text. `PlayerItemTracker` tracks what the player has obtained. `RaceItemTracker` tracks where each item lives on the seed. `NesStateDetector` wires all four in.

**Tech Stack:** Python 3.11, NumPy, OpenCV, pytest. All code lives under `vision/detector/`. Tests live under `vision/tests/`. Run tests with: `cd vision && .venv/Scripts/python.exe -m pytest tests/ -v`

**Key NES coordinate facts (canonical 256×240 frame):**
- LIFE text: x=176–199 (cols 22–24), y=40–47 (row 5)
- HUD/gameplay boundary: y=64
- B-item sprite: x=128 (col 16), y=16–31 (rows 2–3)
- A-item/sword: x=152 (col 19), y=24–39 (row 3)
- B→A horizontal gap in NES pixels: 24px (3 tiles)
- Rupee digit row: row 2, center y≈19
- Key digit row: row 4, center y≈35
- Bomb/LIFE digit row: row 5, center y≈43
- Minimap region: x=16–79, y=12–52 (8 rows × either 16 or 8 cols)
- LEVEL-X text: row 1 (y=8–15), x=0–63 (8 chars × 8px)
- Overworld rooms reference: `content/overworld_rooms/C{col}_R{row}.jpg` (col 1–16, row 1–8)

**Vocabulary reminder:**
- Vision layer: **detect / identify** (raw pixels)
- Tracking layer: **see** (observed), **obtain** (player acquired)

---

### Task 1: HudCalibrator — dataclasses + `nes_to_px()` math

**Files:**
- Create: `vision/detector/hud_calibrator.py`
- Create: `vision/tests/test_hud_calibrator.py`

**Step 1: Write the failing test**

```python
# vision/tests/test_hud_calibrator.py
import pytest
from detector.hud_calibrator import CalibrationResult

def test_nes_to_px_identity():
    """With anchor_x=0, anchor_y=0, scale=1.0, NES coords = pixel coords."""
    result = CalibrationResult(anchor_x=0.0, anchor_y=0.0, scale_x=1.0, scale_y=1.0)
    assert result.nes_to_px(0, 0) == (0, 0)
    assert result.nes_to_px(128, 120) == (128, 120)

def test_nes_to_px_with_scale():
    """scale_x=2.0, scale_y=3.0 doubles/triples coordinates."""
    result = CalibrationResult(anchor_x=0.0, anchor_y=0.0, scale_x=2.0, scale_y=3.0)
    assert result.nes_to_px(10, 10) == (20, 30)

def test_nes_to_px_with_offset():
    """anchor_y=5 shifts all y results by 5."""
    result = CalibrationResult(anchor_x=0.0, anchor_y=5.0, scale_x=1.0, scale_y=1.0)
    assert result.nes_to_px(0, 0) == (0, 5)
    assert result.nes_to_px(10, 40) == (10, 45)

def test_calibration_result_defaults_unlocked():
    result = CalibrationResult()
    assert result.locked is False
    assert result.confidence == 0.0
    assert result.source_frame == -1
```

**Step 2: Run test to verify it fails**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'detector.hud_calibrator'`

**Step 3: Write minimal implementation**

```python
# vision/detector/hud_calibrator.py
"""HUD anchor-based calibration for NES Zelda 1 streams.

Detects reference points (LIFE text, B/A item borders, HUD/gameplay boundary,
digit rows, minimap gray rect) to compute a locked affine mapping from NES
pixel coordinates to canonical frame pixel coordinates.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np


# ─── NES reference constants ──────────────────────────────────────────────────
# All y values are top-of-region in canonical NES 256x240 space.
LIFE_NES_Y = 40          # LIFE text row 5 top
LIFE_NES_X = 176         # LIFE text col 22 left edge
GAMEPLAY_NES_Y = 64      # first row of game area (below HUD)
RUPEE_ROW_NES_Y = 19     # center of rupee digit row 2
KEY_ROW_NES_Y = 35       # center of key digit row 4
BOMB_ROW_NES_Y = 43      # center of bomb digit row 5
B_ITEM_NES_X = 128       # B-item sprite left edge (col 16)
A_ITEM_NES_X = 152       # A-item/sword left edge (col 19)
B_TO_A_NES_PX = 24       # A_ITEM_NES_X - B_ITEM_NES_X
HIGH_CONFIDENCE = 0.85   # lock threshold
SPOT_CHECK_INTERVAL = 300  # gameplay frames between spot-checks
DRIFT_WARNING_PX = 3     # warn if locked values drift > this many pixels


@dataclass
class CalibrationAnchors:
    """Raw detected pixel positions of each HUD reference point."""
    life_y: int | None = None
    life_h: int | None = None
    gameplay_y: int | None = None
    b_item_x: int | None = None
    a_item_x: int | None = None
    level_text_x: int | None = None
    rupee_row_y: int | None = None
    key_row_y: int | None = None
    bomb_row_y: int | None = None
    minimap_gray_rect: tuple[int, int, int, int] | None = None  # (x,y,w,h)


@dataclass
class CalibrationResult:
    """Locked affine mapping: NES pixel → canonical frame pixel."""
    anchor_x: float = 0.0
    anchor_y: float = 0.0
    scale_x: float = 1.0
    scale_y: float = 1.0
    confidence: float = 0.0
    locked: bool = False
    source_frame: int = -1

    def nes_to_px(self, nes_x: int, nes_y: int) -> tuple[int, int]:
        """Map a NES pixel coordinate to canonical frame pixel coordinate."""
        px_x = int(round(self.anchor_x + nes_x * self.scale_x))
        px_y = int(round(self.anchor_y + nes_y * self.scale_y))
        return px_x, px_y
```

**Step 4: Run test to verify it passes**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v
```
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add vision/detector/hud_calibrator.py vision/tests/test_hud_calibrator.py
git commit -m "feat: add HudCalibrator dataclasses and nes_to_px mapping"
```

---

### Task 2: HudCalibrator — `_detect_life_text()`

**Files:**
- Modify: `vision/detector/hud_calibrator.py`
- Modify: `vision/tests/test_hud_calibrator.py`

**Step 1: Write the failing test**

```python
# Add to vision/tests/test_hud_calibrator.py
import numpy as np
from detector.hud_calibrator import HudCalibrator

def _make_frame() -> np.ndarray:
    """Return a black 240x256x3 frame."""
    return np.zeros((240, 256, 3), dtype=np.uint8)

def test_detect_life_text_finds_red_cluster():
    """Red pixel cluster at LIFE position should be found."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint red pixels at LIFE position: x=176-199, y=40-47
    frame[40:48, 176:200, 2] = 220  # R channel
    frame[40:48, 176:200, 1] = 20   # G channel (low)
    frame[40:48, 176:200, 0] = 20   # B channel (low)
    life_y, life_h = cal._detect_life_text(frame)
    assert life_y is not None
    assert 38 <= life_y <= 42  # within 2px of actual
    assert 6 <= life_h <= 10   # within 2px of 8

def test_detect_life_text_returns_none_on_dark_frame():
    cal = HudCalibrator()
    frame = _make_frame()
    life_y, life_h = cal._detect_life_text(frame)
    assert life_y is None
    assert life_h is None
```

**Step 2: Run test to verify it fails**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py::test_detect_life_text_finds_red_cluster -v
```
Expected: FAIL with `AttributeError: 'HudCalibrator' object has no attribute '_detect_life_text'`

**Step 3: Write minimal implementation**

Add `HudCalibrator` class and `_detect_life_text()` to `vision/detector/hud_calibrator.py`:

```python
class HudCalibrator:
    """Detects HUD reference anchors and maintains a locked calibration result."""

    # Scan bounds for LIFE text (generous to handle stream offsets)
    _LIFE_SCAN_X1, _LIFE_SCAN_X2 = 160, 230
    _LIFE_SCAN_Y1, _LIFE_SCAN_Y2 = 0, 64

    def __init__(self) -> None:
        self.result = CalibrationResult()
        self._anchors = CalibrationAnchors()
        self._gameplay_frames_seen = 0
        self._last_spot_check = 0

    def _detect_life_text(self, frame: np.ndarray) -> tuple[int | None, int | None]:
        """Scan for the -LIFE- red text cluster; return (top_y, height) or (None, None)."""
        region = frame[self._LIFE_SCAN_Y1:self._LIFE_SCAN_Y2,
                       self._LIFE_SCAN_X1:self._LIFE_SCAN_X2]
        r = region[:, :, 2].astype(np.int16)
        g = region[:, :, 1].astype(np.int16)
        b = region[:, :, 0].astype(np.int16)
        red_mask = (r > 50) & (r > g * 2) & (r > b * 2)
        if red_mask.sum() < 6:
            return None, None
        rows = np.any(red_mask, axis=1)
        row_indices = np.where(rows)[0]
        if len(row_indices) == 0:
            return None, None
        top_y = int(row_indices[0]) + self._LIFE_SCAN_Y1
        bot_y = int(row_indices[-1]) + self._LIFE_SCAN_Y1
        return top_y, max(1, bot_y - top_y + 1)
```

**Step 4: Run test to verify it passes**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add vision/detector/hud_calibrator.py vision/tests/test_hud_calibrator.py
git commit -m "feat: HudCalibrator _detect_life_text scans for red LIFE cluster"
```

---

### Task 3: HudCalibrator — boundary, B/A borders, digit rows, minimap gray rect

**Files:**
- Modify: `vision/detector/hud_calibrator.py`
- Modify: `vision/tests/test_hud_calibrator.py`

**Step 1: Write the failing tests**

```python
def test_detect_gameplay_boundary():
    """First non-black row below HUD should be detected."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint colored game area starting at y=68 (slightly offset)
    frame[68:, :, 1] = 80  # green tint in game area
    boundary_y = cal._detect_gameplay_boundary(frame, life_y=40)
    assert boundary_y is not None
    assert 66 <= boundary_y <= 72

def test_detect_b_a_borders():
    """Blue border pixels at B and A item positions should be found."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint blue at B-item left border (x≈128, y=16-31)
    frame[16:32, 128:130, 0] = 200  # B channel (blue)
    frame[16:32, 128:130, 1] = 20
    frame[16:32, 128:130, 2] = 20
    # Paint blue at A-item left border (x≈152, y=24-39)
    frame[24:40, 152:154, 0] = 200
    frame[24:40, 152:154, 1] = 20
    frame[24:40, 152:154, 2] = 20
    b_x, a_x = cal._detect_b_a_borders(frame)
    assert b_x is not None and 126 <= b_x <= 130
    assert a_x is not None and 150 <= a_x <= 154

def test_detect_digit_rows():
    """Bright pixel rows at rupee/key/bomb positions should be found."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint bright white at digit row positions
    frame[16:24, 96:130, :] = 200   # rupee digits
    frame[32:40, 100:134, :] = 200  # key digits
    frame[40:48, 100:134, :] = 200  # bomb digits
    rupee_y, key_y, bomb_y = cal._detect_digit_rows(frame)
    assert rupee_y is not None and 16 <= rupee_y <= 24
    assert key_y is not None and 32 <= key_y <= 40
    assert bomb_y is not None and 40 <= bomb_y <= 48

def test_detect_minimap_gray_rect():
    """Mid-gray rectangle in minimap region should be detected."""
    cal = HudCalibrator()
    frame = _make_frame()
    # Paint gray at minimap position (x=16-79, y=12-52)
    frame[12:52, 16:80, :] = 110
    rect = cal._detect_minimap_gray_rect(frame)
    assert rect is not None
    x, y, w, h = rect
    assert abs(x - 16) <= 4
    assert abs(y - 12) <= 4
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v -k "boundary or borders or digit_rows or gray_rect"
```
Expected: FAIL with `AttributeError`

**Step 3: Write minimal implementation**

Add these methods to `HudCalibrator` in `vision/detector/hud_calibrator.py`:

```python
    def _detect_gameplay_boundary(self, frame: np.ndarray,
                                  life_y: int) -> int | None:
        """Scan downward from life_y+20 until first non-black row. Returns y."""
        start_y = min(life_y + 20, 239)
        for y in range(start_y, min(start_y + 60, 240)):
            row = frame[y, :, :]
            if float(np.mean(row)) > 15:
                return y
        return None

    def _detect_b_a_borders(self, frame: np.ndarray
                             ) -> tuple[int | None, int | None]:
        """Detect left edges of B-item and A-item blue borders."""
        # B-item is at NES x≈128, y≈16-31; A-item at x≈152, y≈24-39
        b_x = a_x = None
        region_y1, region_y2 = 8, 48
        for x in range(115, 170):
            col = frame[region_y1:region_y2, x, :]
            b_ch = col[:, 0].astype(int)
            r_ch = col[:, 2].astype(int)
            g_ch = col[:, 1].astype(int)
            blue_pixels = int(np.sum((b_ch > 150) & (b_ch > r_ch * 2) & (b_ch > g_ch * 2)))
            if blue_pixels >= 4:
                if b_x is None and x < 142:
                    b_x = x
                elif b_x is not None and a_x is None and x > b_x + 10:
                    a_x = x
        return b_x, a_x

    def _detect_digit_rows(self, frame: np.ndarray
                           ) -> tuple[int | None, int | None, int | None]:
        """Find rupee, key, bomb digit row centers from bright pixel scan."""
        # Digit columns are in x range 80-140; scan that strip for bright rows
        strip = frame[8:56, 80:140, :]
        brightness = np.mean(strip, axis=(1, 2))
        rupee_y = key_y = bomb_y = None
        # Rupee row ≈ y=16-23 → strip rows 8-15
        for y_off in range(7, 17):
            if brightness[y_off] > 30:
                rupee_y = y_off + 8
                break
        # Key row ≈ y=32-39 → strip rows 24-31
        for y_off in range(23, 33):
            if brightness[y_off] > 30:
                key_y = y_off + 8
                break
        # Bomb row ≈ y=40-47 → strip rows 32-39
        for y_off in range(31, 41):
            if brightness[y_off] > 30:
                bomb_y = y_off + 8
                break
        return rupee_y, key_y, bomb_y

    def _detect_minimap_gray_rect(self, frame: np.ndarray
                                   ) -> tuple[int, int, int, int] | None:
        """Find mid-gray rectangle in minimap region (x=16-79, y=12-52)."""
        region = frame[12:52, 16:80, :]
        r = region[:, :, 2].astype(int)
        g = region[:, :, 1].astype(int)
        b = region[:, :, 0].astype(int)
        gray_mask = ((r >= 80) & (r <= 140) & (g >= 80) & (g <= 140)
                     & (b >= 80) & (b <= 140)).astype(np.uint8)
        if gray_mask.sum() < 20:
            return None
        coords = np.argwhere(gray_mask)
        y0, x0 = int(coords[:, 0].min()), int(coords[:, 1].min())
        y1, x1 = int(coords[:, 0].max()), int(coords[:, 1].max())
        return x0 + 16, y0 + 12, x1 - x0 + 1, y1 - y0 + 1
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add vision/detector/hud_calibrator.py vision/tests/test_hud_calibrator.py
git commit -m "feat: HudCalibrator anchor detection methods (boundary/borders/digits/minimap)"
```

---

### Task 4: HudCalibrator — `calibrate()` lifecycle (confidence, lock, spot-check)

**Files:**
- Modify: `vision/detector/hud_calibrator.py`
- Modify: `vision/tests/test_hud_calibrator.py`

**Step 1: Write the failing tests**

```python
def _make_gameplay_frame() -> np.ndarray:
    """Frame with all HUD anchors present at standard NES positions."""
    frame = _make_frame()
    # LIFE text (red, x=176-199, y=40-47)
    frame[40:48, 176:200, 2] = 220
    frame[40:48, 176:200, 1] = 20
    frame[40:48, 176:200, 0] = 20
    # Gameplay area (bright below y=64)
    frame[64:, :, 1] = 80
    # B-item blue border (x=128, y=16-31)
    frame[16:32, 128:130, 0] = 200
    # A-item blue border (x=152, y=24-39)
    frame[24:40, 152:154, 0] = 200
    # Digit rows bright (rupee y=16-23, key y=32-39, bomb y=40-47)
    frame[16:24, 96:130, :] = 200
    frame[32:40, 100:134, :] = 200
    frame[40:48, 100:134, :] = 200
    return frame

def test_calibrate_single_high_confidence_frame_locks():
    """A frame with all anchors should produce confidence > 0.85 and lock."""
    cal = HudCalibrator()
    frame = _make_gameplay_frame()
    cal.calibrate(frame, frame_num=1)
    assert cal.result.locked is True
    assert cal.result.confidence >= 0.85
    assert cal.result.source_frame == 1

def test_calibrate_dark_frame_does_not_lock():
    """A black frame has no anchors; confidence stays low, no lock."""
    cal = HudCalibrator()
    cal.calibrate(_make_frame(), frame_num=1)
    assert cal.result.locked is False
    assert cal.result.confidence < 0.85

def test_calibrate_once_locked_stays_locked():
    """Once locked, subsequent calls do not change the locked result."""
    cal = HudCalibrator()
    frame = _make_gameplay_frame()
    cal.calibrate(frame, frame_num=1)
    assert cal.result.locked
    scale_x_before = cal.result.scale_x
    cal.calibrate(frame, frame_num=2)
    assert cal.result.scale_x == scale_x_before  # unchanged

def test_calibrate_scale_y_from_life_glyph():
    """With life_h=8, scale_y should be exactly 1.0."""
    cal = HudCalibrator()
    frame = _make_gameplay_frame()
    cal.calibrate(frame, frame_num=1)
    assert 0.9 <= cal.result.scale_y <= 1.1
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v -k "calibrate"
```
Expected: FAIL with `AttributeError: 'HudCalibrator' has no attribute 'calibrate'`

**Step 3: Write minimal implementation**

Add `calibrate()` to `HudCalibrator`:

```python
    def calibrate(self, frame: np.ndarray, frame_num: int) -> None:
        """Detect all anchors, compute scales, lock on first high-confidence result."""
        # 1. Detect anchors
        life_y, life_h = self._detect_life_text(frame)
        self._anchors.life_y = life_y
        self._anchors.life_h = life_h

        gameplay_y = None
        if life_y is not None:
            gameplay_y = self._detect_gameplay_boundary(frame, life_y)
        self._anchors.gameplay_y = gameplay_y

        b_x, a_x = self._detect_b_a_borders(frame)
        self._anchors.b_item_x = b_x
        self._anchors.a_item_x = a_x

        rupee_y, key_y, bomb_y = self._detect_digit_rows(frame)
        self._anchors.rupee_row_y = rupee_y
        self._anchors.key_row_y = key_y
        self._anchors.bomb_row_y = bomb_y

        self._anchors.minimap_gray_rect = self._detect_minimap_gray_rect(frame)

        # 2. Compute scales from available measurements
        scale_y_measures: list[float] = []
        if life_h is not None:
            scale_y_measures.append(life_h / 8.0)
        if life_y is not None and gameplay_y is not None:
            scale_y_measures.append((gameplay_y - life_y) / (GAMEPLAY_NES_Y - LIFE_NES_Y))
        if rupee_y is not None and bomb_y is not None:
            scale_y_measures.append(
                (bomb_y - rupee_y) / (BOMB_ROW_NES_Y - RUPEE_ROW_NES_Y))

        scale_x_measures: list[float] = []
        if b_x is not None and a_x is not None:
            scale_x_measures.append((a_x - b_x) / B_TO_A_NES_PX)

        # 3. Confidence = fraction of anchor groups detected
        n_detected = sum([
            life_y is not None,
            gameplay_y is not None,
            b_x is not None and a_x is not None,
            rupee_y is not None,
            key_y is not None,
            bomb_y is not None,
            self._anchors.minimap_gray_rect is not None,
        ])
        confidence = n_detected / 7.0

        # 4. Build candidate result
        scale_y = float(np.mean(scale_y_measures)) if scale_y_measures else 1.0
        scale_x = float(np.mean(scale_x_measures)) if scale_x_measures else scale_y
        anchor_y = (life_y - LIFE_NES_Y * scale_y) if life_y is not None else 0.0
        anchor_x = (b_x - B_ITEM_NES_X * scale_x) if b_x is not None else 0.0

        # 5. Lock on first high-confidence result; spot-check thereafter
        if not self.result.locked:
            if confidence >= HIGH_CONFIDENCE:
                self.result = CalibrationResult(
                    anchor_x=anchor_x, anchor_y=anchor_y,
                    scale_x=scale_x, scale_y=scale_y,
                    confidence=confidence, locked=True, source_frame=frame_num)
            else:
                # Update best-effort (not locked)
                self.result = CalibrationResult(
                    anchor_x=anchor_x, anchor_y=anchor_y,
                    scale_x=scale_x, scale_y=scale_y,
                    confidence=confidence, locked=False, source_frame=frame_num)
        else:
            self._gameplay_frames_seen += 1
            if self._gameplay_frames_seen - self._last_spot_check >= SPOT_CHECK_INTERVAL:
                self._last_spot_check = self._gameplay_frames_seen
                if life_y is not None:
                    drift = abs(life_y - self.result.nes_to_px(LIFE_NES_X, LIFE_NES_Y)[1])
                    if drift > DRIFT_WARNING_PX:
                        import logging
                        logging.getLogger(__name__).warning(
                            f'HudCalibrator: LIFE text drifted {drift}px from locked position '
                            f'(frame {frame_num}). Calibration may be stale.')
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add vision/detector/hud_calibrator.py vision/tests/test_hud_calibrator.py
git commit -m "feat: HudCalibrator calibrate() lifecycle with confidence lock and spot-check"
```

---

### Task 5: HudReader — accept calibrator + fix `read_hearts()`

**Files:**
- Modify: `vision/detector/hud_reader.py:59-103` (constructor)
- Modify: `vision/detector/hud_reader.py:218-300` (`read_hearts`)
- Modify: `vision/tests/test_hud_calibrator.py`

**Step 1: Write the failing test**

```python
# Add to vision/tests/test_hud_calibrator.py
import numpy as np
from detector.hud_reader import HudReader
from detector.hud_calibrator import HudCalibrator, CalibrationResult

def test_hud_reader_accepts_calibrator():
    """HudReader can be constructed with a calibrator param."""
    cal = HudCalibrator()
    reader = HudReader(calibrator=cal)
    assert reader is not None

def test_read_hearts_uses_calibrated_life_y():
    """With a locked calibrator, heart rows derive from life_y, not landmark."""
    cal = HudCalibrator()
    # Manually lock with life_y=40 (standard NES position)
    cal.result = CalibrationResult(
        anchor_x=0.0, anchor_y=0.0, scale_x=1.0, scale_y=1.0,
        confidence=1.0, locked=True, source_frame=0)
    cal._anchors.life_y = 40

    reader = HudReader(calibrator=cal)
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    # Paint 3 full hearts at heart row 1 (y=48-55, x=176-199)
    frame[48:56, 176:199, 2] = 200  # red
    frame[48:56, 176:199, 1] = 30
    frame[48:56, 176:199, 0] = 30
    cur, max_h, half = reader.read_hearts(frame)
    # Should detect at least some hearts (not 0)
    assert cur >= 1
```

**Step 2: Run test to verify it fails**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py::test_hud_reader_accepts_calibrator -v
```
Expected: FAIL with `TypeError: HudReader.__init__() got unexpected keyword argument 'calibrator'`

**Step 3: Write minimal implementation**

In `vision/detector/hud_reader.py`:

Add import at top:
```python
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from .hud_calibrator import HudCalibrator
```

Modify `__init__` signature (line 59):
```python
def __init__(self, grid_offset: tuple[int, int] = (1, 2), life_row: int = 5,
             landmarks: list[dict] | None = None,
             calibrator: 'HudCalibrator | None' = None):
```

Add at end of `__init__` body (before `if landmarks:`):
```python
        self._calibrator = calibrator
```

Modify `read_hearts()` landmark path — replace the two `row_start` scan lines with calibrator-derived y when available. Inside the `if self._has_landmark('Hearts'):` block, before `norm = cv2.resize(...)`, add:

```python
            # If calibrator is locked, override lm['y'] with LIFE-anchored position.
            # LIFE text is at life_y; heart row 1 is 8px below, row 2 is 16px below.
            if (self._calibrator is not None
                    and self._calibrator.result.locked
                    and self._calibrator._anchors.life_y is not None):
                life_y = self._calibrator._anchors.life_y
                lm = dict(lm)          # don't mutate the stored landmark
                lm['y'] = life_y + 8  # heart row 1 top
                lm['h'] = 16          # covers both heart rows
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_hud_calibrator.py -v && .venv/Scripts/python.exe -m pytest tests/ -v --tb=short 2>&1 | tail -20
```
Expected: New tests PASS, existing 323 tests still PASS

**Step 5: Commit**

```bash
git add vision/detector/hud_reader.py vision/tests/test_hud_calibrator.py
git commit -m "feat: HudReader accepts calibrator, read_hearts uses LIFE-anchored row y"
```

---

### Task 6: MinimapReader — dataclass + grid derivation

**Files:**
- Create: `vision/detector/minimap_reader.py`
- Create: `vision/tests/test_minimap_reader.py`

**Step 1: Write the failing test**

```python
# vision/tests/test_minimap_reader.py
import numpy as np
import pytest
from detector.minimap_reader import MinimapReader, MinimapResult
from detector.hud_calibrator import HudCalibrator, CalibrationResult

def _make_locked_calibrator(life_y=40, rupee_y=19, key_y=35, bomb_y=43,
                             b_x=128, a_x=152) -> HudCalibrator:
    cal = HudCalibrator()
    cal.result = CalibrationResult(
        anchor_x=0.0, anchor_y=0.0, scale_x=1.0, scale_y=1.0,
        confidence=1.0, locked=True, source_frame=0)
    cal._anchors.life_y = life_y
    cal._anchors.rupee_row_y = rupee_y
    cal._anchors.key_row_y = key_y
    cal._anchors.bomb_row_y = bomb_y
    cal._anchors.b_item_x = b_x
    cal._anchors.a_item_x = a_x
    return cal

def test_minimap_reader_constructs():
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    assert mm is not None

def test_minimap_grid_cell_height():
    """cell_h = (bomb_y - rupee_y) / 6.0 = (43 - 19) / 6 = 4.0"""
    cal = _make_locked_calibrator(rupee_y=19, bomb_y=43)
    mm = MinimapReader(calibrator=cal)
    grid = mm._derive_grid()
    assert abs(grid['cell_h'] - 4.0) < 0.5

def test_minimap_grid_dungeon_cell_width():
    """Dungeon: 8 cols in 64px → cell_w = 8.0"""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    grid = mm._derive_grid()
    assert abs(grid['cell_w_dungeon'] - 8.0) < 1.0

def test_minimap_grid_overworld_cell_width():
    """Overworld: 16 cols in 64px → cell_w = 4.0"""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    grid = mm._derive_grid()
    assert abs(grid['cell_w_overworld'] - 4.0) < 1.0
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v
```
Expected: FAIL with `ModuleNotFoundError`

**Step 3: Write minimal implementation**

```python
# vision/detector/minimap_reader.py
"""Full minimap reading: grid derivation, dot detection, tile recognition."""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np
import cv2
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .hud_calibrator import HudCalibrator

# NES reference constants
MINIMAP_NES_X1 = 16
MINIMAP_NES_X2 = 80   # 64px wide
MINIMAP_NES_ROWS = 8
MINIMAP_DG_COLS = 8
MINIMAP_OW_COLS = 16
RUPEE_NES_Y = 19      # center of rupee digit row
BOMB_NES_Y = 43       # center of bomb digit row
TILE_MATCH_THRESHOLD = 0.80


@dataclass
class MinimapResult:
    col: int = 0               # 1-based
    row: int = 0               # 1-based
    mode: str = 'unknown'      # 'overworld' | 'dungeon'
    dungeon_map_rooms: int | None = None   # bitmask of blue cells (map)
    triforce_room: tuple[int, int] | None = None
    zelda_room: tuple[int, int] | None = None
    collected_triforce: tuple[int, int] | None = None
    tile_match_id: int | None = None
    tile_match_score: float = 0.0
    map_position: int = 0      # backward-compat integer


class MinimapReader:
    """Reads player minimap position and room metadata."""

    def __init__(self, calibrator: 'HudCalibrator',
                 overworld_rooms_dir: str = 'content/overworld_rooms') -> None:
        self._calibrator = calibrator
        self._rooms_dir = Path(overworld_rooms_dir)
        self._prev_frame: np.ndarray | None = None
        self._ow_templates: dict[int, np.ndarray] = {}  # lazy-loaded

    def _derive_grid(self) -> dict:
        """Compute minimap grid dimensions from calibrated anchor positions."""
        cal = self._calibrator
        rupee_y = cal._anchors.rupee_row_y or RUPEE_NES_Y
        bomb_y = cal._anchors.bomb_row_y or BOMB_NES_Y
        cell_h = (bomb_y - rupee_y) / 6.0
        # rupee_y is center of MM row-pair 1-2, which is 1.5 cells from top
        minimap_top_y = rupee_y - 1.5 * cell_h

        left_px, _ = cal.result.nes_to_px(MINIMAP_NES_X1, 0)
        right_px, _ = cal.result.nes_to_px(MINIMAP_NES_X2, 0)
        minimap_w = max(right_px - left_px, 1)
        cell_w_dungeon = minimap_w / MINIMAP_DG_COLS
        cell_w_overworld = minimap_w / MINIMAP_OW_COLS

        return {
            'cell_h': cell_h,
            'minimap_top_y': minimap_top_y,
            'minimap_left_x': left_px,
            'minimap_right_x': right_px,
            'cell_w_dungeon': cell_w_dungeon,
            'cell_w_overworld': cell_w_overworld,
            'minimap_h': cell_h * MINIMAP_NES_ROWS,
        }
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add vision/detector/minimap_reader.py vision/tests/test_minimap_reader.py
git commit -m "feat: MinimapReader dataclass + calibrator-derived grid"
```

---

### Task 7: MinimapReader — LEVEL text mode detection + Link dot

**Files:**
- Modify: `vision/detector/minimap_reader.py`
- Modify: `vision/tests/test_minimap_reader.py`

**Step 1: Write the failing tests**

```python
def _make_frame() -> np.ndarray:
    return np.zeros((240, 256, 3), dtype=np.uint8)

def test_detect_level_text_dungeon():
    """Non-black pixels in row 1 (y=8-15) indicate dungeon mode."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    frame = _make_frame()
    frame[8:16, 0:64, :] = 150  # LEVEL text
    assert mm._detect_level_text(frame) is not None

def test_detect_level_text_overworld():
    """No pixels in row 1 → overworld mode."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    assert mm._detect_level_text(_make_frame()) is None

def test_link_dot_detected_in_dungeon_minimap():
    """Bright dot in minimap → correct col/row returned."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    frame = _make_frame()
    # Paint bright dot at dungeon minimap col 2 row 1:
    # cell_w=8, cell_h=4, minimap_left=16, minimap_top=13
    # col2 center x = 16 + 8*1 + 4 = 28
    # row1 center y = 13 + 4*0 + 2 = 15
    frame[15:17, 28:30, :] = 255
    result = mm.read(frame, screen_type='dungeon', dungeon_level=2)
    assert result.mode == 'dungeon'
    assert result.col >= 1
    assert result.row >= 1
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v -k "level_text or link_dot"
```
Expected: FAIL

**Step 3: Write minimal implementation**

Add to `MinimapReader` in `vision/detector/minimap_reader.py`:

```python
    def _detect_level_text(self, frame: np.ndarray) -> int | None:
        """Return left edge x of LEVEL text if present in row 1, else None."""
        row1 = frame[8:16, 0:64, :]
        brightness = np.mean(row1, axis=2)
        bright_cols = np.where(np.any(brightness > 20, axis=0))[0]
        if len(bright_cols) == 0:
            return None
        return int(bright_cols[0])

    def _find_link_dot(self, minimap_region: np.ndarray,
                       grid: dict, is_dungeon: bool
                       ) -> tuple[int, int] | None:
        """Find the brightest pixel cluster; return (col, row) 1-based or None."""
        gray = np.mean(minimap_region, axis=2)
        threshold = float(np.max(gray)) * 0.8
        if threshold < 80:
            return None
        bright_mask = (gray > threshold).astype(np.uint8)
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(bright_mask)
        if num_labels <= 1:
            return None
        best_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        cy, cx = centroids[best_label][1], centroids[best_label][0]
        cell_w = grid['cell_w_dungeon'] if is_dungeon else grid['cell_w_overworld']
        cell_h = grid['cell_h']
        map_h = grid['minimap_h']
        map_w = minimap_region.shape[1]
        cols = MINIMAP_DG_COLS if is_dungeon else MINIMAP_OW_COLS
        col = max(1, min(cols, int(cx / map_w * cols) + 1))
        row = max(1, min(MINIMAP_NES_ROWS, int(cy / map_h * MINIMAP_NES_ROWS) + 1))
        return col, row

    def read(self, frame: np.ndarray, screen_type: str,
             dungeon_level: int = 0) -> MinimapResult:
        """Read minimap position and metadata from frame."""
        result = MinimapResult()
        grid = self._derive_grid()

        # Determine mode from LEVEL text (overrides screen classifier)
        level_x = self._detect_level_text(frame)
        is_dungeon = level_x is not None or screen_type == 'dungeon'
        result.mode = 'dungeon' if is_dungeon else 'overworld'

        # Extract minimap pixel region
        x1 = int(grid['minimap_left_x'])
        y1 = int(grid['minimap_top_y'])
        x2 = int(grid['minimap_right_x'])
        y2 = int(y1 + grid['minimap_h'])
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(255, x2), min(239, y2)
        if x2 <= x1 or y2 <= y1:
            return result

        minimap = frame[y1:y2, x1:x2]

        # Find Link dot
        dot = self._find_link_dot(minimap, grid, is_dungeon)
        if dot is not None:
            result.col, result.row = dot
            cols = MINIMAP_DG_COLS if is_dungeon else MINIMAP_OW_COLS
            result.map_position = (result.row - 1) * cols + (result.col - 1)

        self._prev_frame = frame.copy()
        return result
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add vision/detector/minimap_reader.py vision/tests/test_minimap_reader.py
git commit -m "feat: MinimapReader LEVEL text mode detection and Link dot finder"
```

---

### Task 8: MinimapReader — dungeon map + multi-dot detection (triforce/Zelda/collected)

**Files:**
- Modify: `vision/detector/minimap_reader.py`
- Modify: `vision/tests/test_minimap_reader.py`

**Step 1: Write the failing tests**

```python
def test_dungeon_map_bitmask_detected():
    """Blue cell backgrounds → dungeon_map_rooms bitmask set."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    frame = _make_frame()
    # Paint blue at dungeon minimap cell col=1,row=1 (x≈16-23, y≈15-19)
    frame[15:20, 16:24, 0] = 200  # B channel
    frame[15:20, 16:24, 1] = 30
    frame[15:20, 16:24, 2] = 30
    result = mm.read(frame, screen_type='dungeon', dungeon_level=3)
    assert result.dungeon_map_rooms is not None
    assert result.dungeon_map_rooms > 0

def test_flashing_dot_detected_as_triforce_room():
    """Red dot present in one frame but not the previous = triforce room."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)

    # prev frame: bright Link dot at col1,row1; no red at col2,row2
    prev = _make_frame()
    prev[17:19, 20:22, :] = 255   # Link dot at col1,row1

    # current frame: same Link dot + red dot at col2,row2
    curr = _make_frame()
    curr[17:19, 20:22, :] = 255   # Link dot
    curr[21:23, 28:30, 2] = 220   # Red dot (triforce) at col2,row2
    curr[21:23, 28:30, 1] = 20
    curr[21:23, 28:30, 0] = 20

    mm._prev_frame = prev
    result = mm.read(curr, screen_type='dungeon', dungeon_level=3)
    assert result.triforce_room is not None

def test_l9_flashing_dot_is_zelda_room():
    """In dungeon_level=9, flashing dot is zelda_room not triforce_room."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    prev = _make_frame()
    prev[17:19, 20:22, :] = 255
    curr = _make_frame()
    curr[17:19, 20:22, :] = 255
    curr[21:23, 28:30, 2] = 220
    curr[21:23, 28:30, 1] = 20
    curr[21:23, 28:30, 0] = 20
    mm._prev_frame = prev
    result = mm.read(curr, screen_type='dungeon', dungeon_level=9)
    assert result.zelda_room is not None
    assert result.triforce_room is None
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v -k "map_bitmask or flashing or l9"
```
Expected: FAIL

**Step 3: Write minimal implementation**

Add to `MinimapReader.read()` (after the Link dot section):

```python
        # Dungeon map bitmask (blue cell backgrounds)
        if is_dungeon:
            result.dungeon_map_rooms = self._detect_dungeon_map(minimap, grid)

        # Multi-dot detection: flashing red (triforce/Zelda) and faint gray
        if is_dungeon and self._prev_frame is not None:
            prev_minimap = self._prev_frame[y1:y2, x1:x2]
            flashing = self._detect_flashing_dot(minimap, prev_minimap, grid)
            if flashing is not None:
                if dungeon_level == 9:
                    result.zelda_room = flashing
                else:
                    result.triforce_room = flashing
            result.collected_triforce = self._detect_faint_gray_dot(
                minimap, grid, exclude=dot)
```

Add new methods to `MinimapReader`:

```python
    def _detect_dungeon_map(self, minimap: np.ndarray, grid: dict) -> int:
        """Scan 64 dungeon cells for royal blue backgrounds; return bitmask."""
        bitmask = 0
        cell_h = grid['cell_h']
        cell_w = grid['cell_w_dungeon']
        for row in range(MINIMAP_NES_ROWS):
            for col in range(MINIMAP_DG_COLS):
                y0 = int(row * cell_h)
                x0 = int(col * cell_w)
                y1 = min(int(y0 + cell_h), minimap.shape[0])
                x1 = min(int(x0 + cell_w), minimap.shape[1])
                cell = minimap[y0:y1, x0:x1]
                if cell.size == 0:
                    continue
                b = cell[:, :, 0].astype(int)
                r = cell[:, :, 2].astype(int)
                g = cell[:, :, 1].astype(int)
                blue_px = int(np.sum((b > 150) & (b > r * 2) & (b > g * 2)))
                if blue_px >= 2:
                    bitmask |= 1 << (row * MINIMAP_DG_COLS + col)
        return bitmask

    def _detect_flashing_dot(self, curr: np.ndarray, prev: np.ndarray,
                              grid: dict) -> tuple[int, int] | None:
        """Find red dot present now but not in prev frame (flashing)."""
        r_curr = curr[:, :, 2].astype(int)
        g_curr = curr[:, :, 1].astype(int)
        b_curr = curr[:, :, 0].astype(int)
        r_prev = prev[:, :, 2].astype(int)
        red_now = (r_curr > 150) & (r_curr > g_curr * 2) & (r_curr > b_curr * 2)
        red_before = r_prev > 100
        flashing = red_now & ~red_before
        if flashing.sum() < 2:
            return None
        coords = np.argwhere(flashing)
        cy, cx = float(np.mean(coords[:, 0])), float(np.mean(coords[:, 1]))
        cell_w = grid['cell_w_dungeon']
        cell_h = grid['cell_h']
        col = max(1, min(MINIMAP_DG_COLS, int(cx / cell_w) + 1))
        row = max(1, min(MINIMAP_NES_ROWS, int(cy / cell_h) + 1))
        return col, row

    def _detect_faint_gray_dot(self, minimap: np.ndarray, grid: dict,
                                exclude: tuple[int, int] | None
                                ) -> tuple[int, int] | None:
        """Find faint static gray dot (collected triforce marker)."""
        gray = np.mean(minimap, axis=2)
        faint_mask = ((gray > 40) & (gray < 90)).astype(np.uint8)
        if faint_mask.sum() < 2:
            return None
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(faint_mask)
        if num_labels <= 1:
            return None
        best_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        cy, cx = centroids[best_label][1], centroids[best_label][0]
        cell_w = grid['cell_w_dungeon']
        cell_h = grid['cell_h']
        col = max(1, min(MINIMAP_DG_COLS, int(cx / cell_w) + 1))
        row = max(1, min(MINIMAP_NES_ROWS, int(cy / cell_h) + 1))
        if exclude and (col, row) == exclude:
            return None  # same cell as Link — not a separate dot
        return col, row
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add vision/detector/minimap_reader.py vision/tests/test_minimap_reader.py
git commit -m "feat: MinimapReader dungeon map bitmask, flashing triforce/Zelda dot, faint gray dot"
```

---

### Task 9: MinimapReader — overworld tile recognition

**Files:**
- Modify: `vision/detector/minimap_reader.py`
- Modify: `vision/tests/test_minimap_reader.py`

**Context:** Reference tiles are in `content/overworld_rooms/C{col}_R{row}.jpg` (1-based, col 1–16, row 1–8). Comparison is histogram similarity (64-bin per BGR channel, normalized dot product) between the full gameplay area (frame[64:240, :, :]) and the reference tile resized to match.

**Step 1: Write the failing tests**

```python
import os
def test_load_ow_template_returns_array():
    """Loading C1_R1.jpg should return a numpy array if file exists."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal, overworld_rooms_dir='content/overworld_rooms')
    if not os.path.exists('content/overworld_rooms/C1_R1.jpg'):
        pytest.skip('overworld_rooms not present in test cwd')
    tmpl = mm._load_ow_template(col=1, row=1)
    assert tmpl is not None
    assert tmpl.shape[2] == 3  # BGR

def test_histogram_similarity_identical_images():
    """Same image compared to itself should score 1.0."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    img = np.random.randint(0, 255, (176, 256, 3), dtype=np.uint8)
    score = mm._histogram_similarity(img, img)
    assert score > 0.99

def test_histogram_similarity_different_images():
    """All-red vs all-blue should score near 0."""
    cal = _make_locked_calibrator()
    mm = MinimapReader(calibrator=cal)
    red = np.zeros((176, 256, 3), dtype=np.uint8)
    red[:, :, 2] = 255
    blue = np.zeros((176, 256, 3), dtype=np.uint8)
    blue[:, :, 0] = 255
    score = mm._histogram_similarity(red, blue)
    assert score < 0.1
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v -k "template or histogram"
```
Expected: FAIL

**Step 3: Write minimal implementation**

Add to `MinimapReader`:

```python
    def _load_ow_template(self, col: int, row: int) -> np.ndarray | None:
        """Load overworld room reference tile; cache in memory."""
        key = (col - 1) * MINIMAP_NES_ROWS + (row - 1)  # 0-based room index
        if key in self._ow_templates:
            return self._ow_templates[key]
        path = self._rooms_dir / f'C{col}_R{row}.jpg'
        if not path.exists():
            return None
        img = cv2.imread(str(path))
        self._ow_templates[key] = img
        return img

    def _histogram_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        """Normalized histogram dot product similarity (0–1) between two BGR images."""
        b_resized = cv2.resize(b, (a.shape[1], a.shape[0]),
                               interpolation=cv2.INTER_AREA)
        score = 0.0
        for ch in range(3):
            h_a = cv2.calcHist([a], [ch], None, [64], [0, 256]).flatten()
            h_b = cv2.calcHist([b_resized], [ch], None, [64], [0, 256]).flatten()
            norm_a = np.linalg.norm(h_a)
            norm_b = np.linalg.norm(h_b)
            if norm_a > 0 and norm_b > 0:
                score += float(np.dot(h_a / norm_a, h_b / norm_b))
        return score / 3.0

    def _identify_overworld_tile(self, frame: np.ndarray,
                                  minimap_col: int, minimap_row: int
                                  ) -> tuple[int | None, float]:
        """Compare gameplay area against reference tiles; return (room_id, score)."""
        gameplay = frame[64:240, :, :]  # below HUD
        # Pass 1: minimap prior
        tmpl = self._load_ow_template(minimap_col, minimap_row)
        if tmpl is not None:
            score = self._histogram_similarity(gameplay, tmpl)
            if score >= TILE_MATCH_THRESHOLD:
                room_id = (minimap_row - 1) * MINIMAP_OW_COLS + (minimap_col - 1)
                return room_id, score

        # Pass 2: 3×3 neighborhood
        best_id, best_score = None, 0.0
        for dc in (-1, 0, 1):
            for dr in (-1, 0, 1):
                if dc == 0 and dr == 0:
                    continue
                nc, nr = minimap_col + dc, minimap_row + dr
                if not (1 <= nc <= MINIMAP_OW_COLS and 1 <= nr <= MINIMAP_NES_ROWS):
                    continue
                tmpl = self._load_ow_template(nc, nr)
                if tmpl is None:
                    continue
                score = self._histogram_similarity(gameplay, tmpl)
                if score > best_score:
                    best_score = score
                    if score >= TILE_MATCH_THRESHOLD:
                        best_id = (nr - 1) * MINIMAP_OW_COLS + (nc - 1)
        return best_id, best_score
```

Also add tile recognition call in `read()` for overworld mode:
```python
        # Overworld tile recognition
        if not is_dungeon and result.col > 0 and result.row > 0:
            tile_id, tile_score = self._identify_overworld_tile(
                frame, result.col, result.row)
            result.tile_match_id = tile_id
            result.tile_match_score = tile_score
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_minimap_reader.py -v
```
Expected: All tests PASS (file-dependent test skipped if content dir not present in cwd)

**Step 5: Commit**

```bash
git add vision/detector/minimap_reader.py vision/tests/test_minimap_reader.py
git commit -m "feat: MinimapReader overworld tile recognition via histogram similarity"
```

---

### Task 10: PlayerItemTracker — obtained-item state machine

**Files:**
- Modify: `vision/detector/game_logic.py`
- Create: `vision/tests/test_player_item_tracker.py`

**Context:** Lives alongside `FloorItemTracker` in `game_logic.py`. Tracks what the player has **obtained**. Never decreases boolean item flags or integer progression levels.

**Step 1: Write the failing tests**

```python
# vision/tests/test_player_item_tracker.py
import pytest
from detector.game_logic import PlayerItemTracker

def test_b_item_arrows_implies_bow():
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('arrows')
    assert tracker.get_items()['bow'] is True
    assert tracker.arrows_level >= 1

def test_b_item_change_sets_item():
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('blue_candle')
    assert tracker.get_items()['blue_candle'] is True

def test_red_candle_clears_blue():
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('blue_candle')
    tracker.update_from_b_item('red_candle')
    items = tracker.get_items()
    assert items['red_candle'] is True
    assert items['blue_candle'] is False

def test_red_ring_clears_blue_ring():
    tracker = PlayerItemTracker()
    tracker.update_item_obtained('blue_ring')
    tracker.update_item_obtained('red_ring')
    items = tracker.get_items()
    assert items['red_ring'] is True
    assert items['blue_ring'] is False

def test_magical_boomerang_clears_boomerang():
    tracker = PlayerItemTracker()
    tracker.update_item_obtained('boomerang')
    tracker.update_item_obtained('magical_boomerang')
    items = tracker.get_items()
    assert items['magical_boomerang'] is True
    assert items['boomerang'] is False

def test_sword_level_never_decreases():
    tracker = PlayerItemTracker()
    tracker.update_sword_level(3)
    tracker.update_sword_level(1)
    assert tracker.sword_level == 3

def test_arrows_level_never_decreases():
    tracker = PlayerItemTracker()
    tracker.update_arrows_level(2)
    tracker.update_arrows_level(1)
    assert tracker.arrows_level == 2

def test_silver_arrows_does_not_imply_bow():
    tracker = PlayerItemTracker()
    tracker.update_arrows_level(2)
    assert tracker.get_items().get('bow', False) is False

def test_arrows_in_b_slot_implies_bow():
    """If arrows appear in B-slot, bow must be in inventory."""
    tracker = PlayerItemTracker()
    tracker.update_from_b_item('arrows')
    assert tracker.get_items()['bow'] is True

def test_subscreen_merge_true_overrides():
    """True from subscreen sets item True."""
    tracker = PlayerItemTracker()
    merged = tracker.merge_subscreen({'bow': True, 'blue_candle': False})
    assert tracker.get_items()['bow'] is True

def test_subscreen_merge_false_does_not_clear_known_true():
    """False from subscreen does NOT clear an already-True item."""
    tracker = PlayerItemTracker()
    tracker.update_item_obtained('blue_candle')
    tracker.merge_subscreen({'blue_candle': False})
    assert tracker.get_items()['blue_candle'] is True
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_player_item_tracker.py -v
```
Expected: FAIL with `ImportError: cannot import name 'PlayerItemTracker'`

**Step 3: Write minimal implementation**

Add `PlayerItemTracker` class to `vision/detector/game_logic.py` (after `FloorItemTracker`):

```python
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
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_player_item_tracker.py -v
```
Expected: All 11 tests PASS

**Step 5: Commit**

```bash
git add vision/detector/game_logic.py vision/tests/test_player_item_tracker.py
git commit -m "feat: PlayerItemTracker with upgrade cascades, bow/arrows rules, subscreen merge"
```

---

### Task 11: RaceItemTracker — seed knowledge table

**Files:**
- Modify: `vision/detector/game_logic.py`
- Create: `vision/tests/test_race_item_tracker.py`

**Context:** Answers "for each item in the game, where is it?" — a seed knowledge map. When vision detects a floor item at a location, record it. RaceItemTracker does not track who has what — that is `PlayerItemTracker`.

**Step 1: Write the failing tests**

```python
# vision/tests/test_race_item_tracker.py
from detector.game_logic import RaceItemTracker

def test_item_seen_recorded():
    """Detecting a floor item records its location."""
    tracker = RaceItemTracker()
    tracker.item_seen('magical_boomerang', map_position=45, frame=100)
    locs = tracker.get_locations()
    assert 'magical_boomerang' in locs
    assert locs['magical_boomerang']['map_position'] == 45

def test_item_seen_overwrites_with_same_location():
    """Seeing the same item twice at the same location doesn't duplicate."""
    tracker = RaceItemTracker()
    tracker.item_seen('bow', map_position=10, frame=1)
    tracker.item_seen('bow', map_position=10, frame=2)
    locs = tracker.get_locations()
    assert len([k for k in locs if k == 'bow']) == 1

def test_item_obtained_marks_obtained():
    """After item_obtained, get_locations shows obtained=True."""
    tracker = RaceItemTracker()
    tracker.item_seen('silver_arrows', map_position=22, frame=50)
    tracker.item_obtained('silver_arrows', frame=60)
    locs = tracker.get_locations()
    assert locs['silver_arrows']['obtained'] is True

def test_item_not_obtained_stays_false():
    """Seen but not obtained item has obtained=False."""
    tracker = RaceItemTracker()
    tracker.item_seen('red_candle', map_position=7, frame=30)
    locs = tracker.get_locations()
    assert locs['red_candle']['obtained'] is False

def test_multiple_items_tracked_independently():
    tracker = RaceItemTracker()
    tracker.item_seen('bow', map_position=5, frame=1)
    tracker.item_seen('arrows', map_position=12, frame=2)
    locs = tracker.get_locations()
    assert locs['bow']['map_position'] == 5
    assert locs['arrows']['map_position'] == 12
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_race_item_tracker.py -v
```
Expected: FAIL with `ImportError`

**Step 3: Write minimal implementation**

Add `RaceItemTracker` to `vision/detector/game_logic.py` (after `PlayerItemTracker`):

```python
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
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_race_item_tracker.py -v
```
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add vision/detector/game_logic.py vision/tests/test_race_item_tracker.py
git commit -m "feat: RaceItemTracker seed knowledge map (seen/obtained item locations)"
```

---

### Task 12: FloorItemTracker — split `item_pickup` → `item_obtained` / `item_seen_missed`

**Files:**
- Modify: `vision/detector/game_logic.py:129-290` (FloorItemTracker)
- Modify: `vision/tests/test_floor_items.py`

**Context:** When an item's "gone streak" is confirmed, the current code emits `item_pickup`. We need to split this: if the screen_key (room) changed while the item was disappearing → `item_seen_missed` (player left without picking it up). If room stayed the same → `item_obtained`.

**Step 1: Write the failing tests**

```python
# Add to vision/tests/test_floor_items.py
from detector.game_logic import FloorItemTracker

def test_item_obtained_event_when_same_room():
    """Item disappearing while room unchanged → item_obtained."""
    tracker = FloorItemTracker()
    item = {'name': 'bow', 'x': 100, 'y': 150, 'score': 0.9}
    # Confirm item over CONFIRM_FRAMES
    for _ in range(tracker._CONFIRM_FRAMES + 1):
        tracker.process([item], 'dungeon', 1, 42, frame_number=1)
    # Now remove item (gone streak) — same room
    events = []
    for i in range(tracker._GONE_FRAMES + 1):
        evts = tracker.process([], 'dungeon', 1, 42, frame_number=10 + i)
        events.extend(evts)
    names = [e['event'] for e in events]
    assert 'item_obtained' in names
    assert 'item_seen_missed' not in names

def test_item_seen_missed_when_room_changes():
    """Item disappearing due to room change → item_seen_missed."""
    tracker = FloorItemTracker()
    item = {'name': 'bow', 'x': 100, 'y': 150, 'score': 0.9}
    for _ in range(tracker._CONFIRM_FRAMES + 1):
        tracker.process([item], 'dungeon', 1, 42, frame_number=1)
    # Room changes — item no longer visible (player left)
    events = tracker.process([], 'dungeon', 1, 99, frame_number=10)
    names = [e['event'] for e in events]
    assert 'item_seen_missed' in names
    assert 'item_obtained' not in names
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_floor_items.py -v -k "obtained or seen_missed"
```
Expected: FAIL

**Step 3: Write minimal implementation**

In `vision/detector/game_logic.py`, find the `FloorItemTracker.process()` method (around line 213) where `item_pickup` event is emitted. Replace:

```python
                        'event': 'item_pickup',
```

with the room-change check:

```python
                        'event': ('item_seen_missed'
                                  if screen_key != self._prev_screen_key
                                  else 'item_obtained'),
```

Also update any existing tests in `test_floor_items.py` that assert `event == 'item_pickup'` to assert `event == 'item_obtained'` (these tests involve same-room disappearance).

**Step 4: Run full test suite**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/ -v --tb=short 2>&1 | tail -30
```
Expected: All tests PASS (updated `item_pickup` → `item_obtained` in existing tests)

**Step 5: Commit**

```bash
git add vision/detector/game_logic.py vision/tests/test_floor_items.py
git commit -m "feat: FloorItemTracker splits item_pickup into item_obtained/item_seen_missed based on room change"
```

---

### Task 13: NesStateDetector — new GameState fields + full wiring

**Files:**
- Modify: `vision/detector/nes_state.py:1-55` (imports + GameState)
- Modify: `vision/detector/nes_state.py:56-244` (NesStateDetector)
- Create: `vision/tests/test_nes_state_calibrated.py`

**Step 1: Write the failing test**

```python
# vision/tests/test_nes_state_calibrated.py
import numpy as np
from detector.nes_state import NesStateDetector, GameState

def test_gamestate_has_new_fields():
    gs = GameState()
    assert hasattr(gs, 'dungeon_map_rooms')
    assert hasattr(gs, 'triforce_room')
    assert hasattr(gs, 'zelda_room')
    assert hasattr(gs, 'tile_match_id')
    assert hasattr(gs, 'tile_match_score')

def test_nes_state_detector_constructs_with_calibrator():
    det = NesStateDetector()
    assert hasattr(det, 'calibrator')
    assert hasattr(det, 'minimap')
    assert hasattr(det, 'player_items')
    assert hasattr(det, 'race_items')

def test_detect_returns_gamestate_with_new_fields():
    det = NesStateDetector()
    frame = np.zeros((240, 256, 3), dtype=np.uint8)
    state = det.detect(frame)
    assert isinstance(state, GameState)
    assert state.dungeon_map_rooms is None or isinstance(state.dungeon_map_rooms, int)
```

**Step 2: Run tests to verify they fail**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_nes_state_calibrated.py -v
```
Expected: FAIL with `AttributeError`

**Step 3: Write minimal implementation**

**3a.** Add new fields to `GameState` dataclass in `nes_state.py` (after `floor_items`):

```python
    dungeon_map_rooms: int | None = None        # bitmask; None until map acquired
    triforce_room: tuple | None = None           # (col,row); None until compass
    zelda_room: tuple | None = None             # L9 only: Zelda's room
    tile_match_id: int | None = None            # OW tile recognition result
    tile_match_score: float = 0.0
```

**3b.** Add imports to `nes_state.py`:

```python
from .hud_calibrator import HudCalibrator
from .minimap_reader import MinimapReader
from .game_logic import PlayerItemTracker, RaceItemTracker
```

**3c.** Add to `NesStateDetector.__init__()` after existing initializations:

```python
        self.calibrator = HudCalibrator()
        # Pass calibrator to HudReader (update existing hud_reader instantiation)
        self.hud_reader = HudReader(grid_offset=grid_offset, life_row=life_row,
                                     landmarks=landmarks, calibrator=self.calibrator)
        self.minimap = MinimapReader(calibrator=self.calibrator)
        self.player_items = PlayerItemTracker()
        self.race_items = RaceItemTracker()
```

Note: The existing `self.hud_reader = HudReader(...)` line must be updated to pass `calibrator=self.calibrator`. Remove the duplicate instantiation.

**3d.** In `NesStateDetector.detect()`, update the frame loop:

After screen classification (line ~168), add:
```python
        # Run HUD calibration on every gameplay frame
        if state.screen_type in ('overworld', 'dungeon', 'cave'):
            self.calibrator.calibrate(frame, frame_num=getattr(self, '_frame_count', 0))
            self._frame_count = getattr(self, '_frame_count', 0) + 1
```

Replace the existing minimap line (line ~218):
```python
        # OLD: state.map_position = self.hud_reader.read_minimap_position(frame, is_dungeon)
        # NEW:
        minimap_result = self.minimap.read(frame, state.screen_type, state.dungeon_level)
        state.map_position = minimap_result.map_position
        state.dungeon_map_rooms = minimap_result.dungeon_map_rooms
        state.triforce_room = minimap_result.triforce_room
        state.zelda_room = minimap_result.zelda_room
        state.tile_match_id = minimap_result.tile_match_id
        state.tile_match_score = minimap_result.tile_match_score
```

After reading `b_item`, add PlayerItemTracker update:
```python
            state.b_item = self.hud_reader.read_b_item(frame, self.item_reader)
            self.player_items.update_from_b_item(state.b_item)
            self.player_items.update_sword_level(state.sword_level)
```

**Step 4: Run tests to verify they pass**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/test_nes_state_calibrated.py -v
```
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add vision/detector/nes_state.py vision/tests/test_nes_state_calibrated.py
git commit -m "feat: NesStateDetector wires HudCalibrator, MinimapReader, PlayerItemTracker, RaceItemTracker"
```

---

### Task 14: Full regression — verify all existing tests pass

**Files:** No changes — verification only.

**Step 1: Run the full test suite**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/ -v --tb=short 2>&1 | tail -40
```

**Step 2: Fix any failures**

If existing tests fail due to the `item_pickup` → `item_obtained` rename, update the test assertions. If they fail due to GameState field changes, update any `GameState()` comparisons.

**Step 3: Verify count**

```
cd vision && .venv/Scripts/python.exe -m pytest tests/ --tb=short -q
```
Expected output ends with: `N passed` where N ≥ 323 + (tests added in this plan)

**Step 4: Commit if any fixes were needed**

```bash
git add vision/tests/
git commit -m "fix: update existing tests for item_obtained rename and new GameState fields"
```

---

## Summary of new files

| File | Purpose |
|---|---|
| `vision/detector/hud_calibrator.py` | HudCalibrator: anchor detection + locked affine mapping |
| `vision/detector/minimap_reader.py` | MinimapReader: grid derivation, dot detection, tile recognition |
| `vision/tests/test_hud_calibrator.py` | HudCalibrator tests |
| `vision/tests/test_minimap_reader.py` | MinimapReader tests |
| `vision/tests/test_player_item_tracker.py` | PlayerItemTracker tests |
| `vision/tests/test_race_item_tracker.py` | RaceItemTracker tests |
| `vision/tests/test_nes_state_calibrated.py` | Integration tests for wired-up NesStateDetector |

## Modified files

| File | What changes |
|---|---|
| `vision/detector/hud_reader.py` | Accepts `calibrator` param; `read_hearts()` uses LIFE-anchored y |
| `vision/detector/game_logic.py` | Adds `PlayerItemTracker`, `RaceItemTracker`; splits `item_pickup` |
| `vision/detector/nes_state.py` | New `GameState` fields; wires all four new classes |
