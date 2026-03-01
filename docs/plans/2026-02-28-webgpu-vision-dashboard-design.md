# WebGPU Vision Dashboard Design

**Date:** 2026-02-28
**Status:** Approved — ready for implementation planning

## Goal

Add a `/vision/webgpu` dashboard page that gives deep, real-time visibility into the WebGPU
vision pipeline for a single racer at a time. The page is the permanent replacement for the
existing VisionLab (`/vision`) once the WebGPU pipeline proves more accurate. The Python page
stays untouched during the evaluation period.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  racer: [dropdown]   ● 30fps  ⬡ 1234 frames  ⚡ 2ms   [Start]  [Stop]  │
├─────────────────────────┬────────────────────────────────────────────────┤
│ screen   overworld      │ sword     white       dungeon  0               │
│ hearts   ❤❤❤❤❤❤ /16   │ b-item    candle                               │
│ rupees   128            │ triforce  ■■□□□□□□                             │
│ keys  2    bombs  8     │ PENDING:  hearts 5→3 (1/3)  screen (4/6)      │
├───────────┬─────────────┴──────────────────────────┬─────────────────────┤
│ EVENT LOG │              MINIMAP                   │  DEBUG FRAME (30fps)│
│           │                                        │                     │
│ 12:04     │  [Overworld — 16×8 room tile grid]     │  [annotated JPEG    │
│ triforce  │  current room: gold ring overlay        │   with NCC scores,  │
│           │  visited: full brightness               │   room match winner,│
│ 12:03     │  unvisited: 50% opacity                 │   floor item boxes] │
│ dungeon   │                                        │                     │
│           │  [Dungeon N — 8×8 traversal grid]      │                     │
│ 12:02     │  visited: dim blue cell                │                     │
│ death     │  current: gold cell                    │                     │
│           │  clears on dungeon level change         │                     │
└───────────┴────────────────────────────────────────┴─────────────────────┘
```

**Column widths (approximate):** event log 15%, minimap 50%, debug frame 35%.
**Row split:** top state section ~30% height, bottom panels ~70% height.

## Sections

### Header Strip

- **Racer dropdown**: lists racer IDs that have a registered WebGPU tab (from
  `GET /api/vision/racers`) plus any racers known to the system. Switching racers updates all
  panels.
- **Pipeline status**: fps (frames received per second from `vision:webgpu:state`), frame count
  (cumulative), latency (ms between frame timestamp and `Date.now()` on receipt). Shown as
  dim grey when pipeline is stopped, green when live.
- **Start / Stop buttons**: call `POST /api/vision/:racerId/start` (with `streamUrl` from
  racer config) and `DELETE /api/vision/:racerId`. Start is disabled if tab is already running.

### Top-Left: Primary Game State

| Field | Notes |
|---|---|
| screen | overworld / dungeon / cave / subscreen / death / title / unknown |
| hearts | current filled hearts as ❤ symbols + `/max` |
| rupees | numeric |
| keys | numeric |
| bombs | numeric |

### Top-Right: Secondary Game State + Pending

| Field | Notes |
|---|---|
| sword | none / wood / white / magical |
| b-item | item name or — |
| dungeon | 0 = overworld, 1–9 = dungeon level |
| triforce | 8 dot indicators ■ = collected, □ = missing |
| **PENDING row** | Any `StreakTracker` field currently accumulating frames, shown as `fieldName oldValue→newValue (N/threshold)`. Hidden when nothing is pending. |

The PENDING row is the key differentiator from VisionLab — it shows exactly why a field has not
yet confirmed its change, with progress toward the streak threshold.

### Bottom-Left: Event Log

Scrollable list, newest at top, keeps last 100 entries. Each row:
- Timestamp (HH:MM:SS)
- Color-coded event badge: high=red (triforce_inferred, death, game_complete, ganon_fight,
  ganon_kill), medium=yellow (heart_container, dungeon_first_visit, sword_upgrade,
  staircase_item_acquired), low=dim (all others)
- Description string from the event payload

Sourced from the existing `vision:events` Socket.IO event (already room-scoped to `vision`).

### Bottom-Center: Minimap

The minimap panel is the primary room position indicator. There is no text "room: C4,R3"
anywhere on the page — the map IS the position display.

**Overworld (screen_type = 'overworld' or when dungeonLevel = 0):**

- 16 columns × 8 rows grid of room tile thumbnails
- Tiles fetched once at page load from `GET /api/vision/room-templates` (returns 128 entries
  with `{id, col, row, pixels[]}` — already implemented in `templateServer.ts`). Dashboard
  renders each as a small `<canvas>` or `<img>` element.
- Current room: gold border ring overlay (derived from `mapPosition` NES byte:
  `col = (byte & 0x0F) + 1`, `row = (byte >> 4) + 1`)
- Previously visited rooms: full brightness
- Unvisited rooms: 50% opacity

**Dungeon (screen_type = 'dungeon'):**

- 8 × 8 grid of colored cells, constructed client-side as the player traverses
- Visited rooms: dim blue filled cell
- Current room: gold filled cell
- Grid header shows dungeon level (e.g. "Dungeon 3")
- Grid state clears when `dungeonLevel` changes (new dungeon entered)
- Room position derived from `mapPosition` NES byte same as overworld

Both states are maintained simultaneously client-side. The panel switches between them based on
`screenType` / `dungeonLevel` from the incoming state.

### Bottom-Right: Debug Frame

- `<img>` element updated at 30fps via `vision:webgpu:frame` Socket.IO event
- Annotated by the browser tab before sending: tile bounding boxes, NCC scores, room match
  winner label, floor item detection boxes
- Continuous streaming: server sends `{ type: 'startDebugStream' }` to the tab when the
  `/vision/webgpu` page is open and a racer is selected; tab sends annotated JPEG frames via
  WebSocket; server forwards as `vision:webgpu:frame` to the `vision` Socket.IO room
- Stream stops when the page navigates away or racer is deselected (`{ type: 'stopDebugStream' }`)

## Data Flow

```
Browser tab (Playwright)
  requestVideoFrameCallback → GPU passes → annotated JPEG
  WS → server: { type: 'debugFrame', racerId, jpeg: base64 }   (30fps, ~15KB/frame)
  WS → server: { type: 'rawState', racerId, ... }               (30fps, parsed by PixelInterpreter)
       ↓
VisionWorkerManager
  caches debugFrame → emits vision:webgpu:frame to Socket.IO 'vision' room
       ↓
VisionPipelineController
  PixelInterpreter → RawGameState
  StateStabilizer  → StableGameState + pending map (fields still accumulating)
  EventInferencer  → GameEvent[]
  emits vision:webgpu:state { racerId, raw: RawGameState, stable: StableGameState, pending: PendingMap }
  emits vision:events { racerId, events }  (existing, room-scoped)
       ↓
Dashboard /vision/webgpu
  useSocketEvent('vision:webgpu:state') → game state panels + minimap position
  useSocketEvent('vision:webgpu:frame') → debug frame img src
  useSocketEvent('vision:events')       → event log
```

**State push rate**: `vision:webgpu:state` is emitted on every stable-state update
(~30fps from the pipeline) but the dashboard throttles rendering to ~10fps for the state
panels — no need to re-render text fields 30 times/second. The debug frame renders every
received frame (true 30fps).

## New Server-Side Work

| Change | File | Notes |
|---|---|---|
| Emit `vision:webgpu:state` with raw+stable+pending | `VisionPipelineController.ts` | Add `pending` map: fields where `StreakTracker.pending !== current` |
| Forward debug frames as `vision:webgpu:frame` Socket.IO event | `VisionWorkerManager.ts` | On `debugFrame` message, emit to `io.to('vision')` |
| `startDebugStream` / `stopDebugStream` tab messages | `worker.js` | Enable/disable continuous annotated frame send loop |
| `GET /api/vision/racers` endpoint | `visionEndpoints.ts` | Returns list of active racerId strings |
| Pass `io` to `VisionWorkerManager` or emit via callback | `index.ts` / `VisionWorkerManager.ts` | So manager can forward frames to Socket.IO |
| `POST /api/vision/:racerId/start` | already done | Start button uses this |
| `DELETE /api/vision/:racerId` | already done | Stop button uses this |

## New Dashboard Work

| Component | File | Notes |
|---|---|---|
| Page | `dashboard/src/pages/WebGPUVision.tsx` | Main page, layout, Socket.IO subscriptions |
| Route | `dashboard/src/App.tsx` | Add `/vision/webgpu` route |
| Nav link | sidebar component | Add "WebGPU Vision" link under Vision section |
| Minimap | `dashboard/src/components/vision/WebGPUMinimap.tsx` | OW tile grid + dungeon traversal grid |
| Debug frame | `dashboard/src/components/vision/DebugFrame.tsx` | img element, 30fps socket updates |
| Event log | `dashboard/src/components/vision/WebGPUEventLog.tsx` | Color-coded scrollable list |
| Pipeline header | inline in WebGPUVision.tsx | Dropdown + stats + start/stop |

## What Stays Unchanged

- `/vision` (VisionLab) — Python pipeline page, untouched during evaluation
- `vision:events` Socket.IO event contract — same payload, same room scope
- `templateServer.ts` `/room-templates` endpoint — already serves the 128 OW tile images
- All existing Python pipeline code

## Transition Plan

When the WebGPU pipeline is confirmed as superior:

1. Point `/vision` nav link to `/vision/webgpu`
2. Archive or remove `VisionLab.tsx`
3. Remove Python pipeline components (`VisionBridge`, `LearnSessionManager` vision path,
   `FrameExtractor`)

No schema changes, no data migrations, no overlay changes required.
