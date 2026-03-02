# Retire Python Vision Pipeline — Design

**Goal:** Migrate all vision detection to the WebGPU pipeline, close remaining feature gaps, build a VOD regression harness, then remove all Python vision code.

**Context:** The WebGPU pipeline (headless Chromium + GPU compute shaders + server-side TypeScript) already handles HUD reading, screen classification, heart reading, minimap position, floor item detection, state stabilization, and 7 of 14 game events. It runs in production for live race tracking. The Python pipeline (`vision/detector/`, `vision_engine.py`) is the legacy system being retired.

**Architecture:** Four-phase migration. Phase 1 closes feature gaps in TypeScript (no shader changes — raw data already extracted). Phase 2 rebuilds Learn Mode as a WebGPU VOD regression harness with reference-file comparison. Phase 3 removes all Python integration code. Phase 4 declutters the repository.

---

## Phase 1: Close Feature Gaps (Server-Side TypeScript)

All 5 missing features are interpretation/tracking logic applied to data the GPU shaders already produce. No WGSL shader changes needed.

### 1. Triforce Detection

**New class:** `TriforceTracker` in `server/src/vision/`

The `gold_pass` aggregate shader already counts gold pixels per frame. The tracker watches for the triforce collection animation pattern:

- **Flash pattern:** 4+ frames with elevated gold pixel count, with 1+ gaps (triforce color-cycles orange/blue during collection)
- **Y-position stability:** Gold pixel distribution stays within a 6px vertical band across all detections (rejects random overworld orange)
- **Hearts refill:** `heartsMax` must increase to maximum during or after the animation (rejects map/compass/key pickups that don't refill hearts)

Tracking starts when the player is in a dungeon/cave but continues through screen-type changes (the flash causes the screen classifier to briefly read "overworld").

Called from `VisionPipelineController` after `EventInferencer.update()`.

### 2. Item Drop/Pickup Events

**Modify:** `FloorItemTracker.ts` (already exists, tracks item presence)

Add temporal event logic matching the Python `FloorItemTracker`:
- Room-entry grace period: 3 frames after `mapPosition` changes (ignore pre-existing items)
- Confirm streak: 2 consecutive frames of detection before emitting `item_drop`
- Gone streak: 3 consecutive frames of absence before emitting `item_pickup`
- Score threshold already applied by GPU shader

The `floorItems[]` array from `RawPixelState` provides per-frame detection data.

### 3. Warp/Death Tracking

**New class:** `WarpDeathTracker` in `server/src/vision/`

When `screenType` transitions to `transition`:
- If `heartsCurrent === 0` → death (900-frame cooldown before next death event)
- If player was on a doorway/staircase tile → warp (up+A or staircase entry)
- Otherwise → screen scroll (no event)

Emits `up_a_warp` event. Uses existing `screenType` transitions and heart state from `StableGameState`.

### 4. SWAP Detection

**Modify:** `PixelInterpreter._classifyScreen()`

When `screenType === 'subscreen'`, check the `redRatioAtLife` aggregate. In the subscreen, the LIFE text shifts down — if red pixels appear in the SWAP text region (top ~40px of the NES frame), classify as `subscreen_swap`.

If the existing `red_pass` aggregate doesn't cover the SWAP region (it samples at the LIFE position), add a dedicated check. The simplest approach: when screen is classified as `subscreen`, check if any of the HUD digit tiles show unusually high red content (SWAP text overlaps the HUD area).

### 5. Inventory Grid (Non-Z1R)

**Modify:** `PixelInterpreter.interpret()`

For non-Z1R ROMs, the subscreen displays a 4x2 item grid. When `screenType === 'subscreen'`, attempt to read item presence from fixed grid positions using the existing NCC item template matching (the `b_item` and `sword` template groups already include all inventory items).

For Z1R: return empty inventory (current behavior, unchanged).

---

## Phase 2: VOD Regression Harness

Replace Python Learn Mode with a WebGPU-based VOD analysis tool.

### How It Works

1. **Input:** Twitch VOD URL (or local file URL)
2. **Processing:** `VisionWorkerManager.addRacer()` already accepts any stream URL. Point it at a VOD. The headless Chromium tab plays the VOD through HLS, runs all GPU shaders, and feeds `RawPixelState` to the server pipeline.
3. **Collection:** Record all `StableGameState` transitions and `GameEvent[]` emissions with timestamps into a session result file.
4. **Comparison:** Compare the collected events against a **reference file** — a JSON recording of expected events for that VOD, manually verified once and checked into the repo (e.g., `data/vod-references/bogie-training-vod.json`).
5. **Output:** Pass/fail with detailed diff showing discrepancies (missing events, extra events, wrong timestamps, wrong state values).

### Server Changes

- **Rewrite `LearnSessionManager.ts`** to use `VisionWorkerManager` instead of spawning Python. Same lifecycle (start/stop/cancel) but backed by WebGPU.
- **Same REST endpoints:** `POST /api/learn/sessions`, `GET /api/learn/sessions/:id`, etc.
- **New:** Reference file loading + comparison logic. Reference files stored in `data/vod-references/`.
- **Socket.IO:** Same `learn:progress`, `learn:complete` events to dashboard.

### Dashboard

- Update `LearnMode.tsx` to show pass/fail results and event diffs.
- Remove Python-specific UI (crop recommendations — handled by auto-calibration).

### Reference File Format

```json
{
  "vodUrl": "https://www.twitch.tv/videos/2696354137",
  "racer": "Bogie",
  "expectedEvents": [
    { "type": "dungeon_first_visit", "approxTimestamp": 120, "data": { "dungeonLevel": 1 } },
    { "type": "triforce_inferred", "approxTimestamp": 300 },
    { "type": "death", "approxTimestamp": 450 }
  ],
  "stateCheckpoints": [
    { "approxTimestamp": 60, "screenType": "overworld", "rupees": 0, "keys": 0 },
    { "approxTimestamp": 180, "screenType": "dungeon", "dungeonLevel": 1 }
  ]
}
```

Timestamps are approximate (within a 5-second window) to handle frame-rate and buffering variance.

---

## Phase 3: Remove Python Integration

Once VOD regression passes on the training VOD, remove:

### Delete Server TypeScript Files
- `server/src/vision/VisionBridge.ts` — Python subprocess spawning
- `server/src/vision/VisionManager.ts` — Python pipeline orchestration
- `server/src/vision/FrameExtractor.ts` — ffmpeg frame piping to Python stdin
- `server/src/vision/inBrowserCalibrationMath.ts` — dead code (zero imports)

### Config Cleanup
- Remove `vision.pythonPath` from `server/src/config.ts`
- Remove `vision.confidence` thresholds (WebGPU uses PixelInterpreter's own thresholds)
- Keep `tools.ffmpegPath` and `tools.streamlinkPath` (still used by HLS resolution)

### Route Cleanup
- Remove `POST /api/vision/:racerId` (Python state push endpoint)
- Remove `GET /vision-py/:racerId/frame` (Python debug frame endpoint)
- Remove `POST /api/vision-vod/start` and `POST /api/vision-vod/stop` (Python VOD endpoints)
- Consolidate learn routes to WebGPU backend
- Keep all WebGPU vision endpoints in `visionEndpoints.ts`

### Dashboard Cleanup
- Remove or repurpose `VisionLab.tsx` (Python vision debug page)
- `WebGPUVision.tsx` becomes the sole vision debug page
- Remove Python-specific sidebar links

### Index.ts Cleanup
- Remove `VisionManager` import and initialization
- Remove old `LearnSessionManager` import (replaced by new WebGPU version)
- Remove Python vision Socket.IO event forwarding

---

## Phase 4: Declutter Repository

### vision/ Directory

**Keep:**
| Path | Reason |
|------|--------|
| `vision/templates/digits/*.png` (10 files) | Served by templateServer.ts |
| `vision/templates/items/*.png` (27 files) | Served by templateServer.ts |
| `vision/templates/drops/*.png` (5 files) | Served by templateServer.ts |
| `vision/templates/enemies/*.png` (4 files) | Served by templateServer.ts |

**Delete:**
| Path | Reason |
|------|--------|
| `vision/detector/` (25 .py files) | Replaced by WebGPU TypeScript pipeline |
| `vision/tests/` (22 test files) | Test scenarios ported to TypeScript in Phase 1-2 |
| `vision/vision_engine.py` | Replaced by VisionWorkerManager |
| `vision/learn_mode.py` | Replaced by WebGPU Learn Mode |
| `vision/*.py` (26 debug scripts) | One-off development scripts |
| `vision/debug_*/` (11 dirs, ~20 MB) | Ephemeral debug artifacts |
| `vision/.venv/` (208 MB) | Python virtual environment |
| `vision/__pycache__/`, `.pytest_cache/` | Auto-generated |
| `vision/requirements.txt` | No longer needed |
| `vision/templates/new_sprites/` | Unused experimental assets |
| `vision/templates/enemies/raw/*.gif` | Source GIFs, .png versions preserved |
| `vision/templates/hearts/`, `triforce/` | Empty placeholder directories |
| `vision/templates/digits/*.bak*` | Old template backups |
| `vision/FLOOR_DETECTION_PLAN.md`, `STAIRCASE_DETECTION_PLAN.md` | Historical docs |

**Relocate:**
| From | To | Reason |
|------|-----|--------|
| `vision/validation_*.json` (6 files) | `data/calibration-profiles/` | Streamer calibration data, useful for regression testing |
| `vision/tests/fixtures/*.png` (4 files) | `data/test-fixtures/` or delete | Only needed if porting pixel-level tests |

### Other Stale Files (Project Root)

These accumulated files can be cleaned up:
- `claude_bad_commit.patch`, `patch.diff`, `patch2.diff` — temporary patches
- `diff.txt`, `diff3.txt`, `diff4.txt`, `diff5.txt` — temporary diffs
- `gitlog.txt`, `port_3000.txt` — temporary notes

### Test Migration

The Python `test_game_logic.py` (141 tests) contains valuable game-event test scenarios. Port the test *data* (input state sequences → expected events) to TypeScript vitest tests for `EventInferencer`. This preserves the validation coverage without keeping Python infrastructure.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Triforce detection regression | Flash-pattern logic is well-documented in MEMORY.md. Port exact thresholds from Python. Validate on training VOD. |
| VOD playback timing differs from live | Use approximate timestamp windows (±5s) in reference files. |
| Missing edge cases in TypeScript port | Run VOD regression harness on multiple known VODs before deleting Python. |
| Template assets accidentally deleted | `vision/templates/` is the only directory shared between Python and WebGPU. Preserve it explicitly. |
| Learn Mode UX regression | Keep same REST endpoints and Socket.IO events. Dashboard changes are minimal. |

---

## Success Criteria

- [ ] All 5 feature gaps closed and covered by TypeScript tests
- [ ] VOD regression harness passes on training VOD (Bogie, racetime daring-fairyfountain-1032)
- [ ] No Python subprocess spawning anywhere in the server
- [ ] `pythonPath` removed from config
- [ ] `vision/` directory contains only `templates/` with active PNG assets
- [ ] `VisionLab.tsx` removed, `WebGPUVision.tsx` is sole vision debug page
- [ ] All existing vitest tests pass
- [ ] TypeScript compiles clean (`npx tsc --noEmit`)
