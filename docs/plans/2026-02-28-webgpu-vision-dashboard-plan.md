# WebGPU Vision Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/vision/webgpu` dashboard page showing real-time WebGPU pipeline state, a
30fps annotated debug frame, an OW/dungeon minimap, and streak-pending field indicators.

**Architecture:** Server-side changes expose two new Socket.IO events (`vision:webgpu:state`
with raw+stable+pending, `vision:webgpu:frame` with debug JPEGs) and a `GET /api/vision/racers`
endpoint. The React dashboard page composes four focused components (minimap, event log, debug
frame, state grid) into layout B from the design doc.

**Tech Stack:** TypeScript (server), React + Vite (dashboard), Socket.IO, Tailwind v4,
existing `useSocketEvent` hook at `dashboard/src/hooks/useSocket.ts`

**Design doc:** `docs/plans/2026-02-28-webgpu-vision-dashboard-design.md`

---

## Task 1: StreakTracker pending accessors + StateStabilizer.getPendingFields()

The dashboard needs to display fields that are currently accumulating streak frames but haven't
confirmed yet (e.g. `hearts 5→3 (1/3 frames)`). StreakTracker's `pending` and `count` fields
are private — expose them, then add `getPendingFields()` to StateStabilizer.

**Files:**
- Modify: `server/src/vision/StateStabilizer.ts`
- Modify: `server/src/vision/types.ts`
- Test: `server/tests/StateStabilizer.test.ts`

**Step 1: Add PendingFieldInfo to types.ts**

Open `server/src/vision/types.ts`. Add this interface after the existing type definitions:

```typescript
export interface PendingFieldInfo {
  field: string;
  stableValue: unknown;
  pendingValue: unknown;
  count: number;
  threshold: number;
}
```

**Step 2: Write the failing test**

In `server/tests/StateStabilizer.test.ts`, add a new `describe` block:

```typescript
describe('StateStabilizer.getPendingFields()', () => {
  it('returns empty array when nothing is accumulating', () => {
    const s = new StateStabilizer();
    s.update({ screenType: 'overworld', heartsCurrent: 3, heartsMax: 3,
                rupees: 0, keys: 0, bombs: 0, dungeonLevel: 0,
                bItem: null, swordLevel: 0, hasMasterKey: false,
                mapPosition: 0, triforce: 0 });
    // After second identical update, nothing is pending
    s.update({ screenType: 'overworld', heartsCurrent: 3, heartsMax: 3,
                rupees: 0, keys: 0, bombs: 0, dungeonLevel: 0,
                bItem: null, swordLevel: 0, hasMasterKey: false,
                mapPosition: 0, triforce: 0 });
    expect(s.getPendingFields()).toEqual([]);
  });

  it('reports a field accumulating toward its threshold', () => {
    const s = new StateStabilizer();
    const base = { screenType: 'overworld', heartsCurrent: 3, heartsMax: 3,
                   rupees: 0, keys: 0, bombs: 0, dungeonLevel: 0,
                   bItem: null, swordLevel: 0, hasMasterKey: false,
                   mapPosition: 0, triforce: 0 };
    s.update(base);                              // establishes stable heartsCurrent=3
    s.update({ ...base, heartsCurrent: 2 });     // 1/3 frames toward 2
    const pending = s.getPendingFields();
    const hc = pending.find(p => p.field === 'heartsCurrent');
    expect(hc).toBeDefined();
    expect(hc!.stableValue).toBe(3);
    expect(hc!.pendingValue).toBe(2);
    expect(hc!.count).toBe(1);
    expect(hc!.threshold).toBe(3);
  });

  it('does not report a field once it has confirmed', () => {
    const s = new StateStabilizer();
    const base = { screenType: 'overworld', heartsCurrent: 3, heartsMax: 3,
                   rupees: 0, keys: 0, bombs: 0, dungeonLevel: 0,
                   bItem: null, swordLevel: 0, hasMasterKey: false,
                   mapPosition: 0, triforce: 0 };
    s.update(base);
    s.update({ ...base, heartsCurrent: 2 });
    s.update({ ...base, heartsCurrent: 2 });
    s.update({ ...base, heartsCurrent: 2 }); // threshold=3 reached
    expect(s.getPendingFields().find(p => p.field === 'heartsCurrent')).toBeUndefined();
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd server && npx vitest run tests/StateStabilizer.test.ts
```
Expected: FAIL — `getPendingFields is not a function`

**Step 4: Add public accessors to StreakTracker**

In `server/src/vision/StateStabilizer.ts`, add these getters to the `StreakTracker<T>` class
after the existing `get value()` getter:

```typescript
get pendingValue(): T { return this.pending; }
get pendingCount(): number { return this.count; }
get streakThreshold(): number { return this.threshold; }
```

**Step 5: Add getPendingFields() to StateStabilizer**

In `StateStabilizer`, add this method after the `update()` method:

```typescript
getPendingFields(): PendingFieldInfo[] {
  return (Object.entries(this.trackers) as [string, StreakTracker<unknown>][])
    .filter(([, t]) => t.pendingValue !== t.value)
    .map(([field, t]) => ({
      field,
      stableValue: t.value,
      pendingValue: t.pendingValue,
      count: t.pendingCount,
      threshold: t.streakThreshold,
    }));
}
```

Add the import for `PendingFieldInfo` at the top of `StateStabilizer.ts`:
```typescript
import type { PendingFieldInfo } from './types.js';
```

**Step 6: Run test to verify it passes**

```bash
cd server && npx vitest run tests/StateStabilizer.test.ts
```
Expected: all existing + 3 new pass

**Step 7: Commit**

```bash
git add server/src/vision/StateStabilizer.ts server/src/vision/types.ts server/tests/StateStabilizer.test.ts
git commit -m "feat: expose StreakTracker pending state, add StateStabilizer.getPendingFields()"
```

---

## Task 2: VisionPipelineController — onStateUpdate callback

The dashboard needs `vision:webgpu:state` events carrying `{ racerId, raw, stable, pending }`.
Add an `onStateUpdate` callback to `VisionPipelineController` that fires on every processed
frame, similar to the existing `onGameEvents` pattern.

**Files:**
- Modify: `server/src/vision/VisionPipelineController.ts`
- Modify: `server/src/vision/types.ts`
- Test: `server/tests/VisionPipelineController.test.ts` (new file)

**Step 1: Add WebGPUStateUpdate type to types.ts**

```typescript
export interface WebGPUStateUpdate {
  racerId: string;
  raw: RawGameState;
  stable: StableGameState;
  pending: PendingFieldInfo[];
}
```

**Step 2: Write the failing test**

Create `server/tests/VisionPipelineController.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { VisionPipelineController } from '../src/vision/VisionPipelineController.js';
import type { VisionWorkerManager } from '../src/vision/VisionWorkerManager.js';

function mockManager() {
  let cb: ((state: any) => void) | null = null;
  return {
    onRawState: vi.fn((c) => { cb = c; }),
    cacheState: vi.fn(),
    fireRaw: (s: any) => cb?.(s),
  } as unknown as VisionWorkerManager & { fireRaw: (s: any) => void };
}

const minRaw = {
  racerId: 'r1', frameNumber: 1, timestamp: 0,
  hudScores: [], roomScores: [], floorItems: [],
  gameBrightness: 30, redRatioAtLife: 0.8, goldPixelCount: 0,
};

describe('VisionPipelineController.onStateUpdate()', () => {
  it('fires with racerId, raw, stable, pending on each processed frame', () => {
    const mgr = mockManager();
    const ctrl = new VisionPipelineController(mgr as any);
    ctrl.addRacer('r1');
    const updates: any[] = [];
    ctrl.onStateUpdate((u) => updates.push(u));
    mgr.fireRaw(minRaw);
    expect(updates).toHaveLength(1);
    expect(updates[0].racerId).toBe('r1');
    expect(updates[0].stable).toBeDefined();
    expect(updates[0].pending).toBeInstanceOf(Array);
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd server && npx vitest run tests/VisionPipelineController.test.ts
```
Expected: FAIL — `onStateUpdate is not a function`

**Step 4: Add onStateUpdate to VisionPipelineController**

In `server/src/vision/VisionPipelineController.ts`:

Add import:
```typescript
import type { WebGPUStateUpdate } from './types.js';
```

Add field after `onEventsCallback`:
```typescript
private onStateUpdateCallback: ((update: WebGPUStateUpdate) => void) | null = null;
```

Add method after `onGameEvents()`:
```typescript
onStateUpdate(cb: (update: WebGPUStateUpdate) => void): void {
  this.onStateUpdateCallback = cb;
}
```

In `_processRaw()`, add after `this.manager.cacheState(raw.racerId, stableState)`:
```typescript
this.onStateUpdateCallback?.({
  racerId: raw.racerId,
  raw: rawState,
  stable: stableState,
  pending: pipeline.stabilizer.getPendingFields(),
});
```

**Step 5: Run test to verify it passes**

```bash
cd server && npx vitest run tests/VisionPipelineController.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add server/src/vision/VisionPipelineController.ts server/src/vision/types.ts server/tests/VisionPipelineController.test.ts
git commit -m "feat: VisionPipelineController.onStateUpdate() emits raw+stable+pending per frame"
```

---

## Task 3: VisionWorkerManager debug frame callback + debug stream control

The dashboard subscribes to `vision:webgpu:frame` Socket.IO events. The manager needs to
forward `debugFrame` WebSocket messages via a callback (same pattern as `onRawState`). The
tab also needs to respond to `startDebugStream` / `stopDebugStream` messages.

**Files:**
- Modify: `server/src/vision/VisionWorkerManager.ts`
- Test: `server/tests/VisionWorkerManager.pool.test.ts`

**Step 1: Write the failing test**

In `server/tests/VisionWorkerManager.pool.test.ts`, add:

```typescript
describe('VisionWorkerManager debug frame callback', () => {
  it('fires onDebugFrame when a debugFrame WS message arrives', () => {
    const mgr = new VisionWorkerManager();
    const frames: Array<{ racerId: string; jpeg: string }> = [];
    mgr.onDebugFrame((racerId, jpeg) => frames.push({ racerId, jpeg }));

    // Simulate a tab WebSocket registering and sending a debugFrame message
    const fakeWs = {
      readyState: WebSocket.OPEN,
      addEventListener: (event: string, handler: (e: any) => void) => {
        if (event === 'message') {
          handler({ data: JSON.stringify({ type: 'debugFrame', racerId: 'r1', jpeg: 'abc123' }) });
        }
      },
    };
    // Must have a tab entry for registerTabWebSocket to process
    (mgr as any).tabs.set('r1', { page: null, ws: null });
    mgr.registerTabWebSocket('r1', fakeWs as any);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ racerId: 'r1', jpeg: 'abc123' });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/VisionWorkerManager.pool.test.ts
```
Expected: FAIL — `onDebugFrame is not a function`

**Step 3: Add onDebugFrame to VisionWorkerManager**

In `server/src/vision/VisionWorkerManager.ts`:

Add field after `onStateCallback`:
```typescript
private onDebugFrameCallback: ((racerId: string, jpeg: string) => void) | null = null;
```

Add method after `onRawState()`:
```typescript
onDebugFrame(cb: (racerId: string, jpeg: string) => void): void {
  this.onDebugFrameCallback = cb;
}
```

In `registerTabWebSocket`, update the `debugFrame` branch (currently just caches):
```typescript
} else if (msg.type === 'debugFrame' && typeof msg.jpeg === 'string') {
  this.cacheDebugFrame(racerId, msg.jpeg);
  this.onDebugFrameCallback?.(racerId, msg.jpeg);
}
```

**Step 4: Add startDebugStream / stopDebugStream forwarding**

Add a public method for controlling the tab's debug stream:
```typescript
startDebugStream(racerId: string): void {
  this.sendToTab(racerId, { type: 'startDebugStream' });
}

stopDebugStream(racerId: string): void {
  this.sendToTab(racerId, { type: 'stopDebugStream' });
}
```

**Step 5: Run test to verify it passes**

```bash
cd server && npx vitest run tests/VisionWorkerManager.pool.test.ts
```
Expected: all pass

**Step 6: Commit**

```bash
git add server/src/vision/VisionWorkerManager.ts server/tests/VisionWorkerManager.pool.test.ts
git commit -m "feat: VisionWorkerManager.onDebugFrame() callback + startDebugStream/stopDebugStream"
```

---

## Task 4: worker.js — continuous debug frame streaming mode

The browser tab needs to respond to `startDebugStream` / `stopDebugStream` messages and push
annotated JPEG frames continuously when streaming is active. For now the "debug frame" is the
plain video frame on the preview canvas — annotations are added later when GPU results are
wired through.

**Files:**
- Modify: `server/src/public/vision-tab/worker.js`

This is browser JS — no unit tests. Verify by checking the server receives frames (Task 5).

**Step 1: Add debug stream state and continuous send in worker.js**

At the top of the file, after `let frameCount = 0;`, add:
```javascript
let debugStreamActive = false;
```

In `handleServerMessage()`, add two new message types:
```javascript
function handleServerMessage(msg) {
  if (msg.type === 'requestPreview') sendPreview();
  if (msg.type === 'recalibrate') Object.assign(calib, msg.calib);
  if (msg.type === 'startDebugStream') { debugStreamActive = true; }
  if (msg.type === 'stopDebugStream') { debugStreamActive = false; }
}
```

In `onVideoFrame()`, after the existing rawState send block, add:
```javascript
  if (debugStreamActive) {
    sendDebugFrame();
  }
```

Add the `sendDebugFrame()` function after `sendPreview()`:
```javascript
function sendDebugFrame() {
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 320, 240);
  canvas.toBlob(blob => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'debugFrame', racerId, jpeg: base64 }));
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.75);
}
```

Note: using 0.75 quality (vs 0.85 for preview) since this streams at 30fps.

**Step 2: Commit**

```bash
git add server/src/public/vision-tab/worker.js
git commit -m "feat: worker.js continuous debug frame streaming on startDebugStream message"
```

---

## Task 5: Wire up new events in index.ts + add GET /api/vision/racers

Connect the new callbacks to Socket.IO and add the racers list endpoint.

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/api/visionEndpoints.ts`
- Modify: `server/src/vision/VisionWorkerManager.ts`

**Step 1: Add getActiveRacerIds() to VisionWorkerManager**

In `server/src/vision/VisionWorkerManager.ts`, add after `getMonitoredCount()`:
```typescript
getActiveRacerIds(): string[] {
  return Array.from(this.tabs.keys());
}
```

**Step 2: Add GET /api/vision/racers endpoint**

In `server/src/api/visionEndpoints.ts`, add before the `return router` line:

```typescript
// List all racers with active WebGPU tabs
router.get('/racers', (_req, res) => {
  res.json({ racerIds: mgr.getActiveRacerIds() });
});
```

**Step 3: Add Socket.IO handlers in index.ts for debug stream start/stop**

In `server/src/index.ts`, find the `io.on('connection', ...)` block. Inside the connection
handler, add (after the existing channel-join logic):

```typescript
socket.on('vision:startDebugStream', (racerId: string) => {
  visionWorkerManager.startDebugStream(racerId);
});

socket.on('vision:stopDebugStream', (racerId: string) => {
  visionWorkerManager.stopDebugStream(racerId);
});
```

**Step 4: Wire onStateUpdate and onDebugFrame in index.ts**

After the existing `visionController.onGameEvents(...)` block (around line 110), add:

```typescript
visionController.onStateUpdate((update) => {
  io.to('vision').emit('vision:webgpu:state', update);
});

visionWorkerManager.onDebugFrame((racerId, jpeg) => {
  io.to('vision').emit('vision:webgpu:frame', { racerId, jpeg });
});
```

**Step 5: Build and verify**

```bash
cd server && npm run build
```
Expected: clean, no TypeScript errors.

**Step 6: Commit**

```bash
git add server/src/index.ts server/src/api/visionEndpoints.ts server/src/vision/VisionWorkerManager.ts
git commit -m "feat: wire vision:webgpu:state + vision:webgpu:frame Socket.IO, add GET /api/vision/racers"
```

---

## Task 6: WebGPUMinimap component

The minimap displays the player's position on either the 16×8 overworld tile grid or an 8×8
dungeon traversal grid built client-side. Room tiles are fetched from the template server.

**Files:**
- Create: `dashboard/src/components/vision/WebGPUMinimap.tsx`

**Step 1: Understand the room template data format**

`GET /api/vision/room-templates` returns:
```json
[{ "id": 0, "col": 1, "row": 1, "pixels": [r,g,b,r,g,b,...] }]
```
128 entries (cols 1-16, rows 1-8), each with 64×44×3 = 8448 pixel values (0-1 floats).

Room position from `mapPosition` NES byte:
```typescript
const col = (mapPosition & 0x0F) + 1;   // 1–16
const row = (mapPosition >> 4) + 1;      // 1–8
```

For dungeon rooms (8×8), position uses the same formula but col and row are 1–8.

**Step 2: Create the component**

Create `dashboard/src/components/vision/WebGPUMinimap.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';

interface RoomTemplate {
  id: number;
  col: number;
  row: number;
  pixels: number[];  // 64×44×3 floats 0-1
}

interface Props {
  mapPosition: number;
  screenType: string;
  dungeonLevel: number;
}

function decodePosition(mapPosition: number): { col: number; row: number } {
  return {
    col: (mapPosition & 0x0F) + 1,
    row: (mapPosition >> 4) + 1,
  };
}

export function WebGPUMinimap({ mapPosition, screenType, dungeonLevel }: Props) {
  const [templates, setTemplates] = useState<RoomTemplate[]>([]);
  // visited rooms: Map<dungeonLevel, Set<mapPosition>>
  const visitedRef = useRef<Map<number, Set<number>>>(new Map());
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // Fetch room templates once on mount
  useEffect(() => {
    fetch('/api/vision/room-templates')
      .then(r => r.json())
      .then((data: RoomTemplate[]) => setTemplates(data))
      .catch(() => {/* silently ignore — map still functional without tiles */});
  }, []);

  // Track visited rooms
  useEffect(() => {
    if (mapPosition === 0) return;
    const key = screenType === 'dungeon' ? dungeonLevel : 0;
    if (!visitedRef.current.has(key)) visitedRef.current.set(key, new Set());
    visitedRef.current.get(key)!.add(mapPosition);
  }, [mapPosition, screenType, dungeonLevel]);

  // Draw room tile onto canvas
  useEffect(() => {
    templates.forEach(t => {
      const canvas = canvasRefs.current.get(`${t.col}-${t.row}`);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const imageData = ctx.createImageData(64, 44);
      for (let i = 0; i < t.pixels.length / 3; i++) {
        imageData.data[i * 4 + 0] = Math.round(t.pixels[i * 3 + 0] * 255);
        imageData.data[i * 4 + 1] = Math.round(t.pixels[i * 3 + 1] * 255);
        imageData.data[i * 4 + 2] = Math.round(t.pixels[i * 3 + 2] * 255);
        imageData.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    });
  }, [templates]);

  const isDungeon = screenType === 'dungeon';
  const currentPos = decodePosition(mapPosition);
  const visitedKey = isDungeon ? dungeonLevel : 0;
  const visited = visitedRef.current.get(visitedKey) ?? new Set<number>();

  if (isDungeon) {
    // 8×8 dungeon traversal grid
    return (
      <div>
        <div className="text-xs text-gray-400 mb-1">Dungeon {dungeonLevel}</div>
        <div className="grid gap-px" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
          {Array.from({ length: 64 }, (_, i) => {
            const col = (i % 8) + 1;
            const row = Math.floor(i / 8) + 1;
            const pos = ((row - 1) << 4) | (col - 1);
            const isCurrent = currentPos.col === col && currentPos.row === row;
            const isVisited = visited.has(pos);
            return (
              <div
                key={i}
                className={`w-4 h-4 rounded-sm ${
                  isCurrent ? 'bg-yellow-400' :
                  isVisited ? 'bg-blue-600 opacity-70' :
                  'bg-gray-800'
                }`}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // 16×8 overworld tile grid
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">Overworld</div>
      <div className="grid gap-px" style={{ gridTemplateColumns: 'repeat(16, 1fr)' }}>
        {Array.from({ length: 128 }, (_, i) => {
          const col = (i % 16) + 1;
          const row = Math.floor(i / 16) + 1;
          const isCurrent = currentPos.col === col && currentPos.row === row;
          const pos = ((row - 1) << 4) | (col - 1);
          const isVisited = visited.has(pos);
          return (
            <div
              key={i}
              className={`relative ${isCurrent ? 'ring-2 ring-yellow-400 ring-inset z-10' : ''}`}
            >
              <canvas
                ref={el => {
                  if (el) canvasRefs.current.set(`${col}-${row}`, el);
                }}
                width={64}
                height={44}
                className={`w-full block ${!isVisited && !isCurrent ? 'opacity-40' : ''}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 3: Build dashboard to verify no TypeScript errors**

```bash
cd dashboard && npm run build 2>&1 | tail -5
```
Expected: clean build

**Step 4: Commit**

```bash
git add dashboard/src/components/vision/WebGPUMinimap.tsx
git commit -m "feat: WebGPUMinimap component — OW tile grid + dungeon traversal grid"
```

---

## Task 7: DebugFrame + WebGPUEventLog components

Two focused components: one renders the 30fps JPEG stream, the other renders the color-coded
event log.

**Files:**
- Create: `dashboard/src/components/vision/DebugFrame.tsx`
- Create: `dashboard/src/components/vision/WebGPUEventLog.tsx`

**Step 1: Create DebugFrame.tsx**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useSocketEvent } from '../../hooks/useSocket.js';

interface Props {
  racerId: string | null;
}

export function DebugFrame({ racerId }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const prevSrcRef = useRef<string | null>(null);

  useSocketEvent<{ racerId: string; jpeg: string }>('vision:webgpu:frame', (data) => {
    if (data.racerId !== racerId) return;
    // Revoke previous object URL to avoid memory leak
    if (prevSrcRef.current) URL.revokeObjectURL(prevSrcRef.current);
    const bytes = Uint8Array.from(atob(data.jpeg), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    prevSrcRef.current = url;
    setSrc(url);
  });

  useEffect(() => {
    return () => {
      if (prevSrcRef.current) URL.revokeObjectURL(prevSrcRef.current);
    };
  }, []);

  if (!racerId) {
    return <div className="flex items-center justify-center h-full text-gray-500 text-sm">No racer selected</div>;
  }
  if (!src) {
    return <div className="flex items-center justify-center h-full text-gray-500 text-sm">Waiting for frames…</div>;
  }
  return <img src={src} alt="debug frame" className="w-full h-full object-contain" />;
}
```

**Step 2: Create WebGPUEventLog.tsx**

High-priority events from the design doc, matching the existing VisionLab color scheme:

```tsx
import { useState } from 'react';
import { useSocketEvent } from '../../hooks/useSocket.js';

interface GameEvent {
  type: string;
  description?: string;
}

interface FlatEvent {
  id: number;
  racerId: string;
  type: string;
  description: string;
  timestamp: number;
}

const HIGH_EVENTS = new Set(['triforce_inferred', 'death', 'game_complete', 'ganon_fight', 'ganon_kill']);
const MEDIUM_EVENTS = new Set(['heart_container', 'dungeon_first_visit', 'sword_upgrade', 'staircase_item_acquired']);

function eventColor(type: string): string {
  if (HIGH_EVENTS.has(type)) return 'text-red-400';
  if (MEDIUM_EVENTS.has(type)) return 'text-yellow-400';
  return 'text-gray-400';
}

let idCounter = 0;

interface Props {
  racerId: string | null;
}

export function WebGPUEventLog({ racerId }: Props) {
  const [events, setEvents] = useState<FlatEvent[]>([]);

  useSocketEvent<{ racerId: string; events: GameEvent[] }>('vision:events', (data) => {
    if (data.racerId !== racerId) return;
    const flat = data.events.map(e => ({
      id: ++idCounter,
      racerId: data.racerId,
      type: e.type,
      description: e.description ?? '',
      timestamp: Date.now(),
    }));
    setEvents(prev => [...flat, ...prev].slice(0, 100));
  });

  return (
    <div className="h-full overflow-y-auto text-xs font-mono space-y-1">
      {events.length === 0 && (
        <div className="text-gray-500">No events yet</div>
      )}
      {events.map(e => (
        <div key={e.id} className="flex gap-2">
          <span className="text-gray-500 shrink-0">
            {new Date(e.timestamp).toLocaleTimeString()}
          </span>
          <span className={`font-semibold shrink-0 ${eventColor(e.type)}`}>{e.type}</span>
          {e.description && <span className="text-gray-400 truncate">{e.description}</span>}
        </div>
      ))}
    </div>
  );
}
```

**Step 3: Build to verify**

```bash
cd dashboard && npm run build 2>&1 | tail -5
```
Expected: clean

**Step 4: Commit**

```bash
git add dashboard/src/components/vision/DebugFrame.tsx dashboard/src/components/vision/WebGPUEventLog.tsx
git commit -m "feat: DebugFrame (30fps JPEG stream) and WebGPUEventLog components"
```

---

## Task 8: WebGPUVision main page

The main page composes all components, manages the racer dropdown, shows game state and pending
fields, and starts/stops the debug stream when the selected racer changes.

**Files:**
- Create: `dashboard/src/pages/WebGPUVision.tsx`

**Step 1: Create the page**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useSocket, useSocketEvent } from '../hooks/useSocket.js';
import { WebGPUMinimap } from '../components/vision/WebGPUMinimap.js';
import { DebugFrame } from '../components/vision/DebugFrame.js';
import { WebGPUEventLog } from '../components/vision/WebGPUEventLog.js';
import type { StableGameState } from '../../../server/src/vision/StateStabilizer.js';
import type { PendingFieldInfo, WebGPUStateUpdate } from '../../../server/src/vision/types.js';

// Friendly display names for pending fields
const FIELD_LABELS: Record<string, string> = {
  heartsCurrent: 'hearts', heartsMax: 'hearts max', screenType: 'screen',
  rupees: 'rupees', keys: 'keys', bombs: 'bombs', dungeonLevel: 'dungeon',
  bItem: 'b-item', swordLevel: 'sword', hasMasterKey: 'master key',
  mapPosition: 'room', triforce: 'triforce',
};

function HeartDisplay({ current, max }: { current: number; max: number }) {
  return (
    <span>
      {'❤'.repeat(current)}{'🖤'.repeat(Math.max(0, max - current))} /{max}
    </span>
  );
}

function TriforceDisplay({ value }: { value: number }) {
  return (
    <span>
      {Array.from({ length: 8 }, (_, i) => (value >> i) & 1 ? '■' : '□').join('')}
    </span>
  );
}

function SwordLabel(level: number): string {
  return ['none', 'wood', 'white', 'magical'][level] ?? `L${level}`;
}

export default function WebGPUVision() {
  const socket = useSocket();
  const [racerIds, setRacerIds] = useState<string[]>([]);
  const [selectedRacer, setSelectedRacer] = useState<string | null>(null);
  const [stable, setStable] = useState<StableGameState | null>(null);
  const [pending, setPending] = useState<PendingFieldInfo[]>([]);
  const [fps, setFps] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [latency, setLatency] = useState(0);
  const frameTimesRef = useRef<number[]>([]);
  const prevRacerRef = useRef<string | null>(null);

  // Fetch active racers on mount
  useEffect(() => {
    fetch('/api/vision/racers')
      .then(r => r.json())
      .then((d: { racerIds: string[] }) => setRacerIds(d.racerIds))
      .catch(() => {});
  }, []);

  // Manage debug stream start/stop when selected racer changes
  useEffect(() => {
    if (prevRacerRef.current && prevRacerRef.current !== selectedRacer) {
      socket.emit('vision:stopDebugStream', prevRacerRef.current);
    }
    if (selectedRacer) {
      socket.emit('vision:startDebugStream', selectedRacer);
    }
    prevRacerRef.current = selectedRacer;
    return () => {
      if (selectedRacer) socket.emit('vision:stopDebugStream', selectedRacer);
    };
  }, [selectedRacer, socket]);

  // Receive state updates
  useSocketEvent<WebGPUStateUpdate>('vision:webgpu:state', (update) => {
    if (update.racerId !== selectedRacer) return;
    setStable(update.stable);
    setPending(update.pending);
    const now = Date.now();
    setLatency(now - update.raw.timestamp);
    setFrameCount(update.raw.frameNumber);
    frameTimesRef.current.push(now);
    frameTimesRef.current = frameTimesRef.current.filter(t => now - t < 1000);
    setFps(frameTimesRef.current.length);
  });

  const isRunning = racerIds.includes(selectedRacer ?? '');

  async function handleStart() {
    if (!selectedRacer) return;
    // streamUrl would come from racer config in a real race; for now use a placeholder
    await fetch(`/api/vision/${selectedRacer}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamUrl: '' }),
    });
    setRacerIds(prev => prev.includes(selectedRacer) ? prev : [...prev, selectedRacer]);
  }

  async function handleStop() {
    if (!selectedRacer) return;
    await fetch(`/api/vision/${selectedRacer}`, { method: 'DELETE' });
    setRacerIds(prev => prev.filter(id => id !== selectedRacer));
    setStable(null);
    setPending([]);
  }

  return (
    <div className="h-screen flex flex-col bg-[#0f0f1a] text-white p-2 gap-2">

      {/* Header */}
      <div className="flex items-center gap-4 px-2 py-1 bg-[#1a1a2e] rounded">
        <select
          className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm"
          value={selectedRacer ?? ''}
          onChange={e => setSelectedRacer(e.target.value || null)}
        >
          <option value="">— select racer —</option>
          {racerIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <span className={`text-xs ${fps > 0 ? 'text-green-400' : 'text-gray-500'}`}>
          ● {fps}fps
        </span>
        <span className="text-xs text-gray-400">⬡ {frameCount.toLocaleString()} frames</span>
        <span className="text-xs text-gray-400">⚡ {latency}ms</span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={handleStart}
            disabled={!selectedRacer || isRunning}
            className="px-3 py-1 text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded"
          >Start</button>
          <button
            onClick={handleStop}
            disabled={!isRunning}
            className="px-3 py-1 text-xs bg-red-800 hover:bg-red-700 disabled:opacity-40 rounded"
          >Stop</button>
        </div>
      </div>

      {/* Top state row */}
      <div className="grid grid-cols-2 gap-2">
        {/* Left: primary state */}
        <div className="bg-[#1a1a2e] rounded p-3 text-sm space-y-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-gray-400">screen</span>
            <span>{stable?.screenType ?? '—'}</span>
            <span className="text-gray-400">hearts</span>
            <span>{stable ? <HeartDisplay current={stable.heartsCurrentStable} max={stable.heartsMaxStable} /> : '—'}</span>
            <span className="text-gray-400">rupees</span>
            <span>{stable?.rupees ?? '—'}</span>
            <span className="text-gray-400">keys</span>
            <span>{stable?.keys ?? '—'}</span>
            <span className="text-gray-400">bombs</span>
            <span>{stable?.bombs ?? '—'}</span>
          </div>
        </div>

        {/* Right: secondary state */}
        <div className="bg-[#1a1a2e] rounded p-3 text-sm space-y-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-gray-400">sword</span>
            <span>{stable ? SwordLabel(stable.swordLevel) : '—'}</span>
            <span className="text-gray-400">b-item</span>
            <span>{stable?.bItem ?? '—'}</span>
            <span className="text-gray-400">dungeon</span>
            <span>{stable?.dungeonLevel ?? '—'}</span>
            <span className="text-gray-400">triforce</span>
            <span>{stable ? <TriforceDisplay value={stable.triforce} /> : '—'}</span>
          </div>
          {/* Pending fields */}
          {pending.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-700">
              <div className="text-xs text-yellow-500 font-semibold mb-1">PENDING</div>
              {pending.map(p => (
                <div key={p.field} className="text-xs text-yellow-300">
                  {FIELD_LABELS[p.field] ?? p.field}:{' '}
                  {String(p.stableValue)}→{String(p.pendingValue)}{' '}
                  <span className="text-gray-500">({p.count}/{p.threshold})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom panels */}
      <div className="flex-1 grid gap-2 min-h-0" style={{ gridTemplateColumns: '15% 50% 35%' }}>
        {/* Event log */}
        <div className="bg-[#1a1a2e] rounded p-2 min-h-0 overflow-hidden">
          <div className="text-xs font-semibold text-gray-400 mb-2">EVENTS</div>
          <WebGPUEventLog racerId={selectedRacer} />
        </div>

        {/* Minimap */}
        <div className="bg-[#1a1a2e] rounded p-2 min-h-0 overflow-auto">
          <WebGPUMinimap
            mapPosition={stable?.mapPosition ?? 0}
            screenType={stable?.screenType ?? 'unknown'}
            dungeonLevel={stable?.dungeonLevel ?? 0}
          />
        </div>

        {/* Debug frame */}
        <div className="bg-[#1a1a2e] rounded p-2 min-h-0">
          <div className="text-xs font-semibold text-gray-400 mb-1">DEBUG FRAME</div>
          <div className="h-full">
            <DebugFrame racerId={selectedRacer} />
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Build to verify**

```bash
cd dashboard && npm run build 2>&1 | tail -10
```
Expected: clean build (may have warnings about unused imports in other files — those are pre-existing)

**Step 3: Commit**

```bash
git add dashboard/src/pages/WebGPUVision.tsx
git commit -m "feat: WebGPUVision page — state grid, minimap, debug frame, event log"
```

---

## Task 9: Routing + navigation link

Wire the new page into the dashboard router and sidebar.

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/sidebar/AppSidebar.tsx`

**Step 1: Add route to App.tsx**

In `dashboard/src/App.tsx`:

Add import with the other page imports:
```typescript
import WebGPUVision from './pages/WebGPUVision.js';
```

Add route inside the `<Routes>` block, after the `/vision` route:
```tsx
<Route path="/vision/webgpu" element={<WebGPUVision />} />
```

**Step 2: Add sidebar link**

In `dashboard/src/components/sidebar/AppSidebar.tsx`:

Find the Vision Lab `SidebarLink` (around line 110):
```tsx
<SidebarLink to="/vision" icon={<Eye size={16} />} label="Vision Lab" />
```

Add directly after it:
```tsx
<SidebarLink to="/vision/webgpu" icon={<Eye size={16} />} label="WebGPU Vision" />
```

**Step 3: Build dashboard**

```bash
cd dashboard && npm run build 2>&1 | tail -5
```
Expected: clean

**Step 4: Build server**

```bash
cd server && npm run build 2>&1 | tail -5
```
Expected: clean

**Step 5: Run server tests**

```bash
cd server && npx vitest run
```
Expected: 148+ passed, 1 pre-existing failure (VisionManager hearts_max debounce)

**Step 6: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src/components/sidebar/AppSidebar.tsx
git commit -m "feat: add /vision/webgpu route and sidebar link"
```

---

## Verification

### Build checks
```bash
cd server && npm run build    # must be clean
cd dashboard && npm run build # must be clean
cd server && npx vitest run   # 148+ pass, same 1 pre-existing failure
```

### Manual smoke test
1. Start server: `nssm start TTP.TV` (or `node server/dist/index.js`)
2. Navigate to `http://localhost:3000/dashboard` → sidebar shows "WebGPU Vision"
3. Navigate to `/vision/webgpu`
4. Call `POST /api/vision/test-racer/start` with a valid `streamUrl` (any HLS .m3u8)
5. Select `test-racer` in the dropdown — pipeline status goes green
6. Confirm game state fields populate, debug frame appears, minimap shows position
7. Move to a new room — minimap updates, visited rooms stay lit
8. Trigger an event (death, dungeon enter) — event log shows entry with correct color
9. Navigate away from page — debug stream stops (no more `debugFrame` WS messages)

---

## Files Summary

| Action | File | Task |
|--------|------|------|
| Modify | `server/src/vision/StateStabilizer.ts` | 1 |
| Modify | `server/src/vision/types.ts` | 1, 2 |
| New | `server/tests/StateStabilizer.test.ts` (additions) | 1 |
| Modify | `server/src/vision/VisionPipelineController.ts` | 2 |
| New | `server/tests/VisionPipelineController.test.ts` | 2 |
| Modify | `server/src/vision/VisionWorkerManager.ts` | 3, 5 |
| Modify | `server/tests/VisionWorkerManager.pool.test.ts` | 3 |
| Modify | `server/src/public/vision-tab/worker.js` | 4 |
| Modify | `server/src/index.ts` | 5 |
| Modify | `server/src/api/visionEndpoints.ts` | 5 |
| New | `dashboard/src/components/vision/WebGPUMinimap.tsx` | 6 |
| New | `dashboard/src/components/vision/DebugFrame.tsx` | 7 |
| New | `dashboard/src/components/vision/WebGPUEventLog.tsx` | 7 |
| New | `dashboard/src/pages/WebGPUVision.tsx` | 8 |
| Modify | `dashboard/src/App.tsx` | 9 |
| Modify | `dashboard/src/components/sidebar/AppSidebar.tsx` | 9 |

9 tasks, 7 new files, 9 modified files.
