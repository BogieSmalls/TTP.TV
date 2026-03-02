# Race Analyzer & Vision Lab Retirement — Design

**Goal:** Replace Learn Mode and Vision Lab with two focused tools: WebGPU Vision (live debug) and Race Analyzer (VOD analysis). Add item tracker to WebGPU Vision, then build a new Race Analyzer page for faster-than-realtime VOD analysis with exploratory timeline output.

**Context:** The WebGPU vision pipeline is the sole vision system after Phase 1. Vision Lab (`VisionLab.tsx`) is a Python-era debug page that can be retired once its remaining features (item tracker, triforce pieces) are added to WebGPU Vision. Learn Mode was a Python-based VOD analysis tool — the Race Analyzer replaces it with WebGPU-backed faster-than-realtime processing.

---

## Part A: Close WebGPU Vision Gaps

### Item Tracker Display

**Problem:** WebGPU Vision shows HUD values but not the inferred item inventory. Vision Lab shows a 20-item grid.

**Solution:** Emit `PlayerItemTracker.getItems()` in the `vision:webgpu:state` Socket.IO event. Add an item grid component to `WebGPUVision.tsx`.

- **Server:** Add `items: Record<string, boolean>` and `swordLevel: number` and `arrowsLevel: number` to `WebGPUStateUpdate`.
- **Dashboard:** New `ItemGrid` component in `WebGPUVision.tsx` showing obtained items as colored badges (same style as Vision Lab's item list).

### Per-Piece Triforce Display

**Problem:** WebGPU Vision shows triforce as a count (0-8). Vision Lab shows per-piece booleans.

**Solution:** The `TriforceTracker` already emits `triforce_inferred` events with dungeon level data. Track which dungeons have had triforce collected. Emit as an 8-element boolean array alongside the count.

- **Server:** Add `triforcePieces: boolean[]` to `WebGPUStateUpdate`, derived from `TriforceTracker` state.
- **Dashboard:** Replace the `■□` text display with an 8-slot visual (numbered 1-8, colored when collected).

---

## Part B: Retire Vision Lab

Once Part A is complete:

- **Delete** `dashboard/src/pages/VisionLab.tsx`
- **Remove** the `/vision` sidebar link (keep `/vision/webgpu` as the sole vision page, possibly rename route to `/vision`)
- **Remove** Python-specific API routes:
  - `POST /api/vision/:racerId` (Python state push)
  - `GET /vision-py/:racerId/frame` (Python debug frame)
  - `POST /api/vision-vod/start` and `POST /api/vision-vod/stop` (Python VOD)
- **Remove** `vision:raw` and `vision:events` Socket.IO handlers (Python-era events)
- **Move** WebGPU Vision from `/vision/webgpu` to `/vision` (sole vision page)

---

## Part C: Race Analyzer

### Purpose

A dashboard page that crunches an entire VOD through the WebGPU pipeline at faster-than-realtime speed, then presents a race timeline with all detected events and state transitions for exploratory inspection.

### Faster-Than-Realtime Processing

**Mechanism:** Set `video.playbackRate` on the headless Chromium tab's video element.

- **New WebSocket message:** `{ type: 'setPlaybackRate', rate: number }` from server to tab
- **worker.js change:** Handle the message with `video.playbackRate = msg.rate`
- **Constraint:** HLS streams may not support arbitrary speeds. Twitch VODs typically work at 2x-4x. Beyond 4x, the GPU pipeline may not keep up (depends on GPU). Start with 2x as default, let user adjust.
- **Frame skipping:** At higher playback rates, `requestVideoFrameCallback` may not fire for every frame. This is acceptable — the pipeline processes whatever frames it gets, and the stabilizer handles gaps.

### Server Architecture

**New class:** `RaceAnalyzerSession` in `server/src/vision/`

Lifecycle:
1. **Start:** Create a `VisionWorkerManager` racer with VOD URL + `startOffset`. Set playback rate via `sendToTab`.
2. **Collect:** Listen to `VisionPipelineController.onStateUpdate()` and `onGameEvents()`. Record all events and periodic state snapshots (every ~1 second of VOD time) into an in-memory session.
3. **Progress:** Emit `analyzer:progress` Socket.IO events with current VOD time, frame count, events found so far.
4. **Complete:** When the video ends (detect via `video.ended` or no frames for N seconds), emit `analyzer:complete` with the full session result.
5. **Cancel:** User can stop early.

**Session result structure:**
```typescript
interface AnalyzerResult {
  racerId: string;
  vodUrl: string;
  duration: number;           // total VOD seconds processed
  playbackRate: number;
  events: GameEvent[];        // all events in chronological order
  stateSnapshots: Array<{     // periodic snapshots (~1/second)
    vodTime: number;          // seconds into VOD
    state: StableGameState;
    items: Record<string, boolean>;
  }>;
  summary: {
    deaths: number;
    triforceCount: number;
    dungeonsVisited: number[];
    gameComplete: boolean;
    totalFrames: number;
  };
}
```

**REST endpoints:**
- `POST /api/analyzer/start` — Start a session (vodUrl, racerId, startOffset, playbackRate)
- `POST /api/analyzer/stop` — Cancel running session
- `GET /api/analyzer/result` — Get completed session result

**Socket.IO events:**
- `analyzer:progress` — `{ racerId, vodTime, frameCount, eventsFound }`
- `analyzer:complete` — `{ racerId, result: AnalyzerResult }`

### VOD End Detection

When the video reaches the end:
- `video.ended` event fires → worker sends `{ type: 'vodEnded' }` to server
- Fallback: if no frames received for 10 seconds, assume ended
- Server emits `analyzer:complete`

### Dashboard Page

**Route:** `/analyzer` (sidebar link under TRAIN section, replacing Learn Mode)

**Layout:**
1. **Header bar:** VOD URL input, racer selector, start offset, playback rate selector (1x/2x/4x), Start/Stop buttons, progress indicator
2. **Race Summary panel:** Deaths, triforce count, dungeons visited, game complete status
3. **Event Timeline:** Vertical list of all detected events, color-coded by priority (high=red, medium=yellow, low=gray). Each event shows VOD timestamp, type, description.
4. **State Scrubber:** Horizontal timeline bar. Clicking/dragging seeks through the state snapshots. Shows the game state at that point in time (hearts, rupees, items, screen type, map position).
5. **Optional:** Minimap showing visited rooms at the scrubber position.

The scrubber is NOT a video player — it scrubs through the recorded state snapshots. No video frames are stored (too large). The timeline is purely data-driven.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| HLS playback rate > 1x drops frames | Acceptable — stabilizer handles gaps. Events use frame timestamps, not wall clock. |
| GPU can't keep up at high rate | Start with 2x default. User can reduce if needed. Pipeline is already optimized for 30fps. |
| VOD end detection unreliable | Dual detection: `video.ended` event + no-frame timeout (10s). |
| Large session results (long VODs) | State snapshots at 1/sec = ~7,200 for 2-hour VOD. Each is <1KB. Fits in memory. |
| Vision Lab features missed | Part A closes all gaps before Part B deletes the page. |

---

## Success Criteria

- [ ] WebGPU Vision shows item inventory grid and per-piece triforce
- [ ] Vision Lab page removed, `/vision` route points to WebGPU Vision
- [ ] Python vision routes removed from server
- [ ] Race Analyzer page processes VOD at 2x+ speed
- [ ] Race Analyzer shows event timeline and state scrubber
- [ ] All existing vitest tests pass
- [ ] TypeScript compiles clean
