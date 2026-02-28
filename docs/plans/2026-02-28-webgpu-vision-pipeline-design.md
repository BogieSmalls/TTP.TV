# WebGPU Vision Pipeline Design

**Date:** 2026-02-28
**Status:** Approved — ready for implementation planning

## Goal

Replace the ffmpeg/Python vision pipeline with a browser-based WebGPU pipeline. One headless
Chromium tab per racer reads an HLS stream via a `<video>` element, uses `importExternalTexture`
for zero-copy GPU frame access, and runs all NES Zelda detection (HUD reads, room matching, floor
items, event inference) via WGSL compute shaders. Game event inference runs server-side in
TypeScript. Python is fully retired from the real-time path.

## Motivation

The Python pipeline has two fundamental problems:

1. **Pixel quality**: Downsizing to a 256×240 canonical frame smears Twitch's 8×8 H.264 DCT
   blocks. NES pixels align perfectly with DCT block boundaries at stream resolution — so
   canonical resize throws away the best-quality signal before detection begins.

2. **Accumulated complexity**: Seventeen revisions of patches on `game_logic.py` have produced
   unreliable event detection. A clean TypeScript implementation, knowing all the failure modes
   in advance, will be more accurate.

**Additional drivers:**
- 30fps detection replaces 1-4fps. Streak thresholds tighten from seconds to milliseconds.
- N-racer scalability: monitoring 16 racers simultaneously is feasible (the 5090 handles all
  16 at ~3% GPU utilization at 30fps). Python pipeline was O(N) CPU-heavy.
- The broadcast director layer (auto-switching cameras based on game state across all racers)
  becomes possible only when all racer states are processed together server-side.

## Architecture

```
RTMP / VOD sources
      ↓
HLS relay
  Live RTMP:  node-media-server HLS output (port 8888, config change only)
  VOD:        streamlink --stream-url → .m3u8 URL resolved by VisionWorkerManager
  Live Twitch: streamlink --stream-url per racer, URL refreshed every ~10 min on stall
      ↓
Playwright browser (single instance, one page per racer)
  Each page:
    <video> element + requestVideoFrameCallback (30fps, exact per-decoded-frame)
    importExternalTexture({ source: video }) → zero-copy GPUExternalTexture
    WGSL compute passes (single command encoder per frame):
      Pass 1: HUD tile NCC       — 50 tile positions × ~10 templates = ~500 comparisons
      Pass 2: Room matching      — resize gameplay→64×44, Pearson vs 128 room templates
      Pass 3: Floor item scan    — 37 templates sliding over ~480×744 native pixels
      Pass 4: Aggregate passes   — brightness, red ratio (LIFE text), gold pixel count
    mapAsync result readback     — ~3KB buffer, ~1-2ms, only async point
    WebSocket → server: RawPixelState JSON (30fps)
      ↓
Server (TypeScript, existing Express/Socket.IO process)
  VisionWorkerManager            — replaces LearnSessionManager + Python spawning
  PixelInterpreter               — RawPixelState → RawGameState (pure, stateless)
  StateStabilizer                — RawGameState → StableGameState (streak filtering, 30fps)
  EventInferencer                — StableGameState history → GameEvent[] (per racer)
  Cross-racer director layer     — all N racer states → featured racer selection
  Commentary engine              — unchanged
  Overlay / Dashboard            — unchanged
```

## Section 1: Video Input (HLS Infrastructure)

The browser `<video>` element needs an HLS URL. Three cases:

**VOD races:** `streamlink --stream-url <vod_url> best` returns a stable `.m3u8` URL.
`VisionWorkerManager` resolves this before tab launch and passes it via the initial WebSocket
handshake. The tab loads it as `<video src="...">` with no further involvement.

**Live RTMP (incoming streams):** The existing `node-media-server` on port 8888 supports HLS
output — enable `hls: true` in its config. This adds `/live/<stream_key>/index.m3u8` with no
new infrastructure. If `node-media-server` is not in use, a two-line `nginx-rtmp` config
produces the same result.

**Live Twitch (16-person races):** `streamlink --stream-url <channel> best` per racer.
Twitch HLS URLs rotate every ~10 minutes. `VisionWorkerManager` monitors for `<video>` stall
events (>5s without a new `requestVideoFrameCallback`) and re-fetches the URL. CORS in headless
Playwright is bypassed with `--disable-web-security` (local tool, acceptable).

**The tab is URL-agnostic.** It receives an HLS URL, loads it, and streams it. Whether that
URL is a VOD, a local RTMP relay, or a Twitch stream is invisible to the tab's detection logic.

## Section 2: WebGPU Detection Pipeline

### Frame acquisition

```typescript
video.requestVideoFrameCallback((now, metadata) => {
  const externalTexture = device.importExternalTexture({ source: video });
  // externalTexture is valid only in this JS task — all GPU work submitted here
  dispatchDetectionPasses(externalTexture, calibrationUniform);
  video.requestVideoFrameCallback(...); // re-register for next frame
});
```

`importExternalTexture` hands the GPU a live reference to the H.264 decoder's output buffer.
The video frame never touches CPU memory. On the 5090 (discrete GPU), the frame lives in VRAM
after decode; on iGPU setups it would be in unified memory. Either way: zero copy.

### Compute passes (single command encoder per frame)

**Pass 1 — HUD tile NCC**
- Input: `GPUExternalTexture` (video frame), `texture_2d_array<f32>` (all templates)
- Tile position list (computed from calibration + grid offset at startup, updated on recalibration)
- Workgroup [8, 8, 1]: one thread per pixel in an 8×8 tile. Shared memory reduction for NCC sum.
- Output: float score per (tile, template) pair → ~2KB

**Pass 2 — Room template matching**
- Input: video frame
- First sub-pass: resize gameplay area (NES rows 64–240) to 64×44 in-shader via bilinear sampling
- Second sub-pass: Pearson correlation of resized area against 128 room templates in parallel
- Output: 128 float scores + 1 argmax index + position → 516 bytes

**Pass 3 — Floor item sliding window**
- Input: video frame, 37 drop/item templates (8×16 NES → 24×48 at 3× native scale)
- Slide each template over gameplay area: 480×744 valid positions
- One thread per (template, position). Atomic max reduction: best (score, x, y) per template.
- Output: 37 × {score f32, x u16, y u16} → 444 bytes

**Pass 4 — Aggregate pixel passes**
- Input: video frame
- Three parallel reductions over the gameplay area:
  - Mean brightness (overworld/dungeon/cave classification)
  - Red ratio at LIFE text position (screen type anchor)
  - Gold pixel count in triforce region (R>150, G>80, B<70, R>G)
- Output: ~40 bytes

**Result readback**
```typescript
commandEncoder.copyBufferToBuffer(storageBuffer, 0, stagingBuffer, 0, RESULT_SIZE);
device.queue.submit([commandEncoder.finish()]);
await stagingBuffer.mapAsync(GPUMapMode.READ); // ~1-2ms
const results = new Float32Array(stagingBuffer.getMappedRange());
// parse → RawPixelState → WebSocket
```
Total per frame (30fps, 4 racers, batched): ~4-6ms GPU time. 5090 at ~3% utilization.

### Template storage

All templates loaded once at tab startup from the existing `templates/` directory. Grouped by
pixel size into `texture_2d_array<f32>` objects in GPU memory — one array per tile size (8×8,
8×16, 64×44). Pre-normalized (mean=0, std=1) for NCC. Never change during a session.

### Calibration in WGSL

The `CalibrationResult` from the existing Python calibrator (crop bounds + grid offset) becomes
a 4-float GPU uniform:

```wgsl
struct Calibration { scale_x: f32, scale_y: f32, offset_x: f32, offset_y: f32 }

fn nes_to_uv(nes_x: f32, nes_y: f32) -> vec2<f32> {
    return vec2<f32>(
        (nes_x * calib.scale_x + calib.offset_x) / f32(videoWidth),
        (nes_y * calib.scale_y + calib.offset_y) / f32(videoHeight)
    );
}
```

This is `CalibrationResult.nes_to_px()` in WGSL. Grid offset (dx, dy) is baked into tile
position definitions before upload. On recalibration, `VisionWorkerManager` sends new uniform
values to the tab via WebSocket; the tab uploads them before the next frame dispatch.

### Per-frame budget (single racer, 30fps, 5090)

| Pass | GPU time |
|---|---|
| Pass 1: HUD tile NCC (500 comparisons on 8×8 tiles) | ~0.1ms |
| Pass 2: Room matching (128 templates on 64×44) | ~0.2ms |
| Pass 3: Floor item scan (37 templates × 357K positions) | ~0.5ms |
| Pass 4: Aggregates | ~0.1ms |
| mapAsync readback (~3KB) | ~1.0ms |
| **Total per racer per frame** | **~2ms** |
| **16 racers batched, one command encoder** | **~4-6ms** |

## Section 3: TypeScript Game Logic

Replaces `game_logic.py`. Runs server-side so all N racers' states are visible together.

### Three-layer pipeline

**`PixelInterpreter` — pure, stateless**
Takes `RawPixelState` (GPU readback floats). Returns `RawGameState`. Pure math: argmax of
digit scores, threshold checks on aggregates, floor item position extraction. No temporal
logic. Fully testable with synthetic inputs, no browser or GPU required.

**`StateStabilizer` — all temporal logic in one place**

```typescript
class StreakTracker<T> {
  // threshold: N consecutive identical frames before accepting a change
  // bidirectional: both rising and falling edges require confirmation
  // threshold in frames (30fps: 3 frames = 100ms, 15 frames = 500ms)
}
```

Per-field thresholds at 30fps:

| Field | Frames | Latency | Notes |
|---|---|---|---|
| screen_type | 6 | 200ms | |
| hearts_current | 3 | 100ms | |
| hearts_max | 15 | 500ms | increase only — never decreases |
| rupees / keys / bombs | 3 | 100ms | |
| dungeon_level | 6 | 200ms | |
| floor_item confirm | 3 | 100ms | |
| floor_item gone | 6 | 200ms | |
| b_item | 6 | 200ms | |

**`EventInferencer` — redesigned for 30fps**

All known failure modes from the Python implementation addressed at design time:

| Event | Python approach | 30fps redesign |
|---|---|---|
| `death` | 4-consecutive hearts=0 | Detect Link's white blink pattern (characteristic, not just hearts=0) |
| `triforce_inferred` | Flash: 4+ orange + gaps + Y-stability + hearts refill | Count 2 full orange↔blue cycles (3-4Hz = 7-10 frames/cycle). Hearts refill confirmation unchanged. |
| `up_a_warp` | Position reset after ≥4 non-gameplay frames | Gap threshold ≥2 frames (67ms). `_last_gameplay_hearts == 0` → death, `> 0` → warp. |
| `heart_container` | hearts_max increases in dungeon | Unchanged logic, faster confirmation |
| `game_complete` | D9 exit + 30+ non-gameplay frames | Unchanged |
| `sword_upgrade` | sword_level increases | StreakTracker(threshold=6) |
| `b_item_change` | None→first item always fires | Explicit initial state (no null edge case) |
| `dungeon_first_visit` | Set of visited dungeon levels | Unchanged, first-time detection |
| `ganon_fight` | gannon_nearby in D9 | Sprite detection at 30fps — much more samples per room |

**Cross-racer logic** (available because all racers process in the same Node.js instance):
- Race standings updated in real-time as `game_complete` fires per racer
- Director layer reads all N `StableGameState` objects to select featured racers
- Commentary engine receives full race context (all standings, all states) for prompts
- Future: auto-highlight "N racers are in the same dungeon right now" type of logic

### Data flow

```typescript
// Per racer, 30fps
rawPixelState   = parseGpuReadback(stagingBuffer);           // ~0.1ms
rawGameState    = pixelInterpreter.interpret(rawPixelState); // pure fn
stableGameState = stateStabilizer.update(rawGameState);      // streak logic
events          = eventInferencer.infer(stableGameState);    // state machine

// Server-wide, 30fps
allStates = visionManager.getAllStableStates();               // Map<racerId, StableGameState>
director.evaluate(allStates, events);                         // cross-racer logic
```

## Section 4: Calibration Integration

Python calibration tooling is unchanged — offline tool, same Python `HudCalibrator`, same
`CropProfileService` DB storage. What changes is the consumer.

**Flow:**
```
Python HudCalibrator (offline) → CropProfileService (DB)
                                        ↓
                         VisionWorkerManager reads at tab launch
                                        ↓
                    Passed to tab in initial WebSocket handshake
                                        ↓
             Uploaded as GPU uniform buffer: {scale_x, scale_y, offset_x, offset_y}
```

The `CalibrationResult` from the in-progress calibration redesign (`nes_to_px()` affine
transform) is exactly the data the GPU uniform requires. No changes to that work needed.

On runtime recalibration: `VisionWorkerManager` sends updated uniform values via WebSocket.
Tab uploads new buffer before the next `requestVideoFrameCallback` fires. No tab restart.

## Section 5: Preview & Debug

**On-demand snapshot:**
Tab keeps a secondary `<canvas>` mirroring the `<video>`. On `requestPreview` WebSocket
message, calls `canvas.toBlob('image/jpeg', 0.85)` and returns the bytes. No continuous
capture overhead.

**Debug annotated frame:**
A third canvas renders tile bounding boxes, best-match template names, NCC scores, room match
winner, floor item detections — all drawn using the same calibration data that the GPU uses.
Invaluable for verifying new crop profiles.

**Server endpoints:**
- `GET /api/vision/:racerId/frame` — latest JPEG snapshot (~100KB)
- `GET /api/vision/:racerId/debug` — annotated JPEG with detection overlays
- `GET /api/vision/:racerId/state` — current `StableGameState` JSON

**VisionLab integration:**
`vision:frame` Socket.IO event carries a JPEG at 2fps per racer (background priority).
Debug overlay mode sends annotated frames instead. Same data contract as current VisionLab.

**16-racer monitoring view (`/vision/race`):**
4×4 grid of racer panels. Each panel: latest frame thumbnail (2fps) + `StableGameState`
badges (screen type, dungeon level, hearts, triforce progress, current floor items). The
operator's mission control for a full 16-person race.

## N-Racer Scalability

The pipeline is designed for N racers from day one:

- `VisionWorkerManager` manages a pool of tabs: `monitoredRacers` (up to 16+, full game state)
  vs `featuredRacers` (2-4, on-stream)
- All N tabs share one Playwright browser instance → shared GPU process → batched compute
- Commentary, overlay, and dashboard operate on `featuredRacers`
- The director layer reads all `monitoredRacers` states and decides who to feature
- Future: full 16-person race dataset (every racer, every frame, game state history) stored
  automatically — post-race analytics, highlight reels, routing comparisons

At 16 racers, 30fps, batched into one command encoder: ~4-6ms GPU time on the 5090 (~3%
utilization). RAM: ~3.2GB for 16 Chromium tabs (96GB available — trivial).

## What Gets Retired

| Component | Replacement |
|---|---|
| `FrameExtractor` (ffmpeg per racer) | `<video>` element in headless tab |
| `vision_engine.py` | WebGPU compute passes + `PixelInterpreter` |
| `game_logic.py` | `StateStabilizer` + `EventInferencer` (TypeScript) |
| `LearnSessionManager` (Python spawning) | `VisionWorkerManager` (Playwright) |
| All Python sub-detectors (real-time) | WGSL shaders + `PixelInterpreter` |

## What Stays

| Component | Status |
|---|---|
| Python `HudCalibrator` | Unchanged — offline tool |
| `CropProfileService` + DB schema | Unchanged |
| `templates/` directory | Unchanged — same files uploaded to GPU |
| Commentary engine | Unchanged |
| Race logic (VOD/live race orchestration) | Unchanged |
| Overlay + Dashboard | Unchanged (new `/vision/race` page added) |
| Python vision unit tests | Retired with Python pipeline |
| Server-side TypeScript tests | New — for `PixelInterpreter`, `StateStabilizer`, `EventInferencer` |

## Dependencies

- **Playwright** (already in project or standard npm install)
- **WebGPU** (built into Chromium 113+, no install)
- **HLS relay** (node-media-server config change, or nginx-rtmp)
- **`streamlink`** (already installed)
- **No new Python packages**
- **No WASM bundles** (WebGPU is native browser API)

## Open Questions for Implementation Planning

1. Does `node-media-server` support HLS output in the current config, or does nginx-rtmp need
   to be added?
2. For the 16-racer batched compute design, do all tabs share a single `GPUDevice`, or do they
   each hold their own device and submit work independently? (Shared device is more efficient
   for batching; separate devices are simpler and more crash-isolated.)
3. What is the priority order for implementation? Suggested: HLS relay → single-racer tab
   skeleton → HUD tile NCC → game logic TypeScript → floor item scan → room matching →
   multi-racer batching → director layer.
