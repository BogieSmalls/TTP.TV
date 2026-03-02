# Race Analyzer & Vision Lab Retirement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add item tracker and per-piece triforce to WebGPU Vision, retire Vision Lab, and build a Race Analyzer page for faster-than-realtime VOD analysis.

**Architecture:** Extend `WebGPUStateUpdate` with item/triforce fields emitted from `VisionPipelineController`. Delete VisionLab and Python vision routes. Build `RaceAnalyzerSession` server class that controls playback rate and collects events, paired with a React dashboard page showing an event timeline and state scrubber.

**Tech Stack:** TypeScript, React, Socket.IO, Playwright (headless Chromium), vitest

---

## Part A: Close WebGPU Vision Gaps

### Task 1: Extend WebGPUStateUpdate type with item/triforce fields

**Files:**
- Modify: `server/src/vision/types.ts:94-103`

**Step 1: Add fields to WebGPUStateUpdate interface**

Add after line 100 (`frameCount`):

```typescript
// In WebGPUStateUpdate interface, add:
  items: Record<string, boolean>;
  swordLevel: number;
  arrowsLevel: number;
  triforcePieces: boolean[];
```

The full interface becomes:
```typescript
export interface WebGPUStateUpdate {
  racerId: string;
  raw: RawGameState;
  stable: StableGameState;
  pending: PendingFieldInfo[];
  timestamp: number;
  frameCount: number;
  items: Record<string, boolean>;
  swordLevel: number;
  arrowsLevel: number;
  triforcePieces: boolean[];
  diag?: { brightness: number; redAtLife: number; goldPixels: number };
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit 2>&1 | head -20`
Expected: Errors in VisionPipelineController.ts (missing new fields) — this is correct, we fix it next task.

**Step 3: Commit**

```bash
git add server/src/vision/types.ts && git commit -m "feat: add items, swordLevel, arrowsLevel, triforcePieces to WebGPUStateUpdate"
```

---

### Task 2: Emit item/triforce data from VisionPipelineController

**Files:**
- Modify: `server/src/vision/VisionPipelineController.ts:142-154`

**Step 1: Add item and triforce fields to the state update emission**

In `_processRaw()`, the `onStateUpdateCallback` call (line 142) needs four new fields. Change from:

```typescript
    this.onStateUpdateCallback?.({
      racerId: raw.racerId,
      raw: rawState,
      stable: stableState,
      pending: pipeline.stabilizer.getPendingFields(),
      timestamp: raw.timestamp,
      frameCount: raw.frameNumber,
      diag: {
        brightness: raw.gameBrightness,
        redAtLife: raw.redRatioAtLife,
        goldPixels: raw.goldPixelCount,
      },
    });
```

To:

```typescript
    this.onStateUpdateCallback?.({
      racerId: raw.racerId,
      raw: rawState,
      stable: stableState,
      pending: pipeline.stabilizer.getPendingFields(),
      timestamp: raw.timestamp,
      frameCount: raw.frameNumber,
      items: pipeline.playerItems.getItems(),
      swordLevel: pipeline.playerItems.sword_level,
      arrowsLevel: pipeline.playerItems.arrows_level,
      triforcePieces: pipeline.triforce.triforceState,
      diag: {
        brightness: raw.gameBrightness,
        redAtLife: raw.redRatioAtLife,
        goldPixels: raw.goldPixelCount,
      },
    });
```

**Step 2: Also update sword level from stable state each frame**

Add before the `onStateUpdateCallback` call, after the b_item_change loop:

```typescript
    // Update sword level from stable state
    pipeline.playerItems.updateSwordLevel(stableState.swordLevel);
```

**Step 3: Verify TypeScript compiles clean**

Run: `cd server && npx tsc --noEmit`
Expected: Clean (0 errors)

**Step 4: Run existing tests**

Run: `cd server && npx vitest run`
Expected: All pass (the existing tests don't check the state update emission)

**Step 5: Commit**

```bash
git add server/src/vision/VisionPipelineController.ts && git commit -m "feat: emit items, swordLevel, arrowsLevel, triforcePieces in WebGPU state update"
```

---

### Task 3: Add ItemGrid and per-piece TriforceDisplay to WebGPUVision.tsx

**Files:**
- Modify: `dashboard/src/pages/WebGPUVision.tsx`

**Step 1: Update the local WebGPUStateUpdate interface**

Add the new fields to the local mirror (around line 32):

```typescript
interface WebGPUStateUpdate {
  racerId: string;
  stable: StableGameState;
  pending: PendingFieldInfo[];
  timestamp: number;
  frameCount: number;
  items?: Record<string, boolean>;
  swordLevel?: number;
  arrowsLevel?: number;
  triforcePieces?: boolean[];
  diag?: { brightness: number; redAtLife: number; goldPixels: number };
}
```

**Step 2: Add state for items and triforce pieces**

Add state hooks after existing state declarations:

```typescript
const [items, setItems] = useState<Record<string, boolean>>({});
const [triforcePieces, setTriforcePieces] = useState<boolean[]>(new Array(8).fill(false));
```

**Step 3: Update handleStateUpdate to capture items/triforce**

In the `handleStateUpdate` callback, add:

```typescript
if (update.items) setItems(update.items);
if (update.triforcePieces) setTriforcePieces(update.triforcePieces);
```

**Step 4: Replace TriforceDisplay with per-piece version**

Replace the existing `TriforceDisplay` component:

```typescript
function TriforceDisplay({ pieces }: { pieces: boolean[] }) {
  return (
    <span className="font-mono tracking-wider">
      {pieces.map((has, i) => (
        <span key={i} className={has ? 'text-yellow-400' : 'text-gray-600'}>
          {i + 1}
        </span>
      ))}
    </span>
  );
}
```

Update the usage from `<TriforceDisplay value={stable.triforceCollected} />` to `<TriforceDisplay pieces={triforcePieces} />`.

**Step 5: Add the ITEMS constant and ItemGrid component**

```typescript
const ITEMS = [
  'boomerang', 'magical_boomerang', 'bow', 'silver_arrows',
  'blue_candle', 'red_candle', 'recorder', 'food',
  'letter', 'potion_red', 'potion_blue', 'magic_rod',
  'raft', 'ladder', 'book', 'ring_blue', 'ring_red',
  'power_bracelet', 'magic_shield', 'magic_key',
];

function ItemGrid({ items }: { items: Record<string, boolean> }) {
  return (
    <div className="grid grid-cols-5 gap-1">
      {ITEMS.map(id => {
        const has = items[id] === true;
        return (
          <span
            key={id}
            className={`text-[10px] px-1 py-0.5 rounded text-center truncate ${
              has ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-600'
            }`}
            title={id}
          >
            {id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 8)}
          </span>
        );
      })}
    </div>
  );
}
```

**Step 6: Add ItemGrid to the layout**

Insert an ItemGrid panel. Add it below the existing `grid grid-cols-2` state panels (around line 272). Add a new row between the state row and the bottom panels:

```typescript
{/* Item tracker + triforce pieces */}
<div className="bg-[#1a1a2e] rounded p-3 text-sm">
  <div className="flex gap-4">
    <div className="flex-1">
      <div className="text-xs font-semibold text-gray-400 mb-2">ITEMS</div>
      <ItemGrid items={items} />
    </div>
    <div className="shrink-0">
      <div className="text-xs font-semibold text-gray-400 mb-2">TRIFORCE</div>
      <TriforceDisplay pieces={triforcePieces} />
      <div className="text-xs text-gray-500 mt-1">
        sword: {stable ? swordLabel(stable.swordLevel) : '—'}
      </div>
    </div>
  </div>
</div>
```

**Step 7: Build dashboard to verify**

Run: `cd dashboard && npm run build`
Expected: Clean build

**Step 8: Commit**

```bash
git add dashboard/src/pages/WebGPUVision.tsx && git commit -m "feat: add item grid and per-piece triforce display to WebGPU Vision"
```

---

## Part B: Retire Vision Lab

### Task 4: Remove VisionLab page and Python vision routes

**Files:**
- Delete: `dashboard/src/pages/VisionLab.tsx`
- Modify: `dashboard/src/App.tsx` (remove VisionLab import and route, move WebGPU Vision to `/vision`)
- Modify: `dashboard/src/components/sidebar/AppSidebar.tsx` (remove Vision Lab link, rename WebGPU Vision link, update route)

**Step 1: Update App.tsx**

Remove the VisionLab import (line 19: `import VisionLab from './pages/VisionLab';`).

Remove the VisionLab route: `<Route path="/vision" element={<VisionLab />} />`

Change the WebGPU Vision route from `/vision/webgpu` to `/vision`:
```typescript
<Route path="/vision" element={<WebGPUVision />} />
```

**Step 2: Update AppSidebar.tsx**

In the Train section (lines 107-112), remove the Vision Lab link and update WebGPU Vision:

```typescript
<SidebarSection title="Train" collapsed={collapsed}>
  <SidebarLink to="/learn" icon={GraduationCap} label="Learn Mode" collapsed={collapsed} />
  <SidebarLink to="/knowledge" icon={BookOpen} label="Knowledge Base" collapsed={collapsed} />
  <SidebarLink to="/vision" icon={Eye} label="Vision" collapsed={collapsed} />
</SidebarSection>
```

**Step 3: Delete VisionLab.tsx**

```bash
rm dashboard/src/pages/VisionLab.tsx
```

**Step 4: Build dashboard**

Run: `cd dashboard && npm run build`
Expected: Clean build (no references to VisionLab remain)

**Step 5: Commit**

```bash
git add dashboard/src/pages/VisionLab.tsx dashboard/src/App.tsx dashboard/src/components/sidebar/AppSidebar.tsx && git commit -m "feat: retire Vision Lab page, move WebGPU Vision to /vision"
```

---

### Task 5: Remove Python vision routes from server

**Files:**
- Modify: `server/src/api/routes.ts` (remove Python vision routes)
- Modify: `server/src/index.ts` (remove `vision:raw` Python Socket.IO emission)

**Step 1: Remove Python-specific routes from routes.ts**

Remove the `POST /vision/:racerId` route (lines 532-606) — this is the Python state push endpoint.

Remove the `GET /vision-py/:racerId/frame` route (lines 618-621).

Remove the `POST /vision-vod/start` route (lines 666-679).

Remove the `POST /vision-vod/stop` route (lines 681-689).

Keep these WebGPU routes (they're used by the dashboard):
- `GET /vision/seed-items`
- `GET /vision/:racerId` (state query)
- `GET /vision` (list active bridges)
- `POST /vision/:racerId/start` (Python bridge start — will be removed in Phase 3)
- `POST /vision/:racerId/stop` (Python bridge stop — will be removed in Phase 3)
- `POST /vision/:racerId/reset`
- `GET /vision/:racerId/verification`

**Step 2: Remove `vision:raw` emission from index.ts**

In `index.ts`, the `visionController.onGameEvents` callback (lines 110-113) emits to both `'overlay'` and `'vision'` channels. The `'vision'` channel was for VisionLab — keep the `'overlay'` emission (used by race overlay), remove only the Python-era Socket.IO emission from the `POST /vision/:racerId` route in routes.ts (already removed in Step 1).

The `visionController.onGameEvents` in index.ts is fine to keep — it's WebGPU events, not Python.

**Step 3: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

**Step 4: Run tests**

Run: `cd server && npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add server/src/api/routes.ts server/src/index.ts && git commit -m "feat: remove Python vision routes (POST state push, vision-py frame, vision-vod)"
```

---

## Part C: Race Analyzer

### Task 6: Add playbackRate and vodEnded support to worker.js

**Files:**
- Modify: `server/src/public/vision-tab/worker.js`

**Step 1: Handle setPlaybackRate message**

In the `handleServerMessage` function (line 49), add:

```javascript
if (msg.type === 'setPlaybackRate') {
  video.playbackRate = msg.rate;
  console.log(`[${racerId}] playbackRate set to ${msg.rate}`);
}
```

**Step 2: Detect video ended**

Add a `video.ended` event listener after the video setup (after line 96):

```javascript
video.addEventListener('ended', () => {
  console.log(`[${racerId}] video ended`);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'vodEnded', racerId }));
  }
});
```

**Step 3: Commit**

```bash
git add server/src/public/vision-tab/worker.js && git commit -m "feat: add playbackRate control and vodEnded detection to vision tab worker"
```

---

### Task 7: Handle vodEnded in VisionWorkerManager

**Files:**
- Modify: `server/src/vision/VisionWorkerManager.ts`

**Step 1: Add vodEnded callback**

Add a new callback property and method:

```typescript
private onVodEndedCallback: ((racerId: string) => void) | null = null;

onVodEnded(cb: (racerId: string) => void): void {
  this.onVodEndedCallback = cb;
}
```

**Step 2: Handle vodEnded message in registerTabWebSocket**

In the WebSocket message handler (around line 87-114), add a case for `vodEnded` before the final `else if`:

```typescript
} else if (msg.type === 'vodEnded') {
  this.onVodEndedCallback?.(racerId);
```

**Step 3: Add sendPlaybackRate convenience method**

```typescript
setPlaybackRate(racerId: string, rate: number): void {
  this.sendToTab(racerId, { type: 'setPlaybackRate', rate });
}
```

**Step 4: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

**Step 5: Commit**

```bash
git add server/src/vision/VisionWorkerManager.ts && git commit -m "feat: add vodEnded callback and setPlaybackRate to VisionWorkerManager"
```

---

### Task 8: Write the RaceAnalyzerSession test

**Files:**
- Create: `server/tests/RaceAnalyzerSession.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaceAnalyzerSession } from '../src/vision/RaceAnalyzerSession.js';

// Mock VisionWorkerManager
function mockManager() {
  return {
    addRacer: vi.fn().mockResolvedValue(undefined),
    removeRacer: vi.fn().mockResolvedValue(undefined),
    setPlaybackRate: vi.fn(),
    onVodEnded: vi.fn(),
    getActiveRacerIds: vi.fn().mockReturnValue([]),
  };
}

// Mock VisionPipelineController
function mockController() {
  return {
    addRacer: vi.fn(),
    removeRacer: vi.fn(),
    onStateUpdate: vi.fn(),
    onGameEvents: vi.fn(),
  };
}

describe('RaceAnalyzerSession', () => {
  it('starts in idle state', () => {
    const session = new RaceAnalyzerSession(mockManager() as any, mockController() as any);
    expect(session.getStatus().state).toBe('idle');
  });

  it('transitions to running on start', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    await session.start({
      racerId: 'test',
      vodUrl: 'https://twitch.tv/videos/123',
      playbackRate: 2,
    });
    expect(session.getStatus().state).toBe('running');
    expect(mgr.addRacer).toHaveBeenCalledOnce();
    expect(ctrl.addRacer).toHaveBeenCalledWith('analyzer-test');
  });

  it('records events fed to it', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    await session.start({ racerId: 'test', vodUrl: 'https://twitch.tv/videos/123', playbackRate: 2 });

    session.feedEvents([
      { type: 'death', racerId: 'analyzer-test', timestamp: 1000, frameNumber: 30, priority: 'high', description: 'Player died' },
    ]);
    session.feedState({ screenType: 'overworld', dungeonLevel: 0, rupees: 50, keys: 0, bombs: 3, heartsCurrentStable: 3, heartsMaxStable: 3, bItem: null, swordLevel: 1, hasMasterKey: false, mapPosition: 5, floorItems: [], triforceCollected: 0 }, {}, 10.5);

    const status = session.getStatus();
    expect(status.eventsFound).toBe(1);
  });

  it('produces result on stop', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    await session.start({ racerId: 'test', vodUrl: 'https://twitch.tv/videos/123', playbackRate: 2 });

    session.feedEvents([
      { type: 'death', racerId: 'analyzer-test', timestamp: 1000, frameNumber: 30, priority: 'high', description: 'Player died' },
    ]);

    const result = await session.stop();
    expect(result).not.toBeNull();
    expect(result!.events).toHaveLength(1);
    expect(result!.summary.deaths).toBe(1);
    expect(session.getStatus().state).toBe('completed');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/RaceAnalyzerSession.test.ts`
Expected: FAIL (module not found)

**Step 3: Commit**

```bash
git add server/tests/RaceAnalyzerSession.test.ts && git commit -m "test: add RaceAnalyzerSession tests (red)"
```

---

### Task 9: Implement RaceAnalyzerSession

**Files:**
- Create: `server/src/vision/RaceAnalyzerSession.ts`

**Step 1: Implement the class**

```typescript
import type { VisionWorkerManager } from './VisionWorkerManager.js';
import type { VisionPipelineController } from './VisionPipelineController.js';
import type { GameEvent, StableGameState } from './types.js';

export interface AnalyzerStartOptions {
  racerId: string;
  vodUrl: string;
  playbackRate?: number;
  startOffset?: number;
}

export interface AnalyzerResult {
  racerId: string;
  vodUrl: string;
  duration: number;
  playbackRate: number;
  events: GameEvent[];
  stateSnapshots: Array<{
    vodTime: number;
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

type SessionState = 'idle' | 'running' | 'completed';

export class RaceAnalyzerSession {
  private state: SessionState = 'idle';
  private internalRacerId = '';
  private vodUrl = '';
  private playbackRate = 2;
  private events: GameEvent[] = [];
  private stateSnapshots: Array<{ vodTime: number; state: StableGameState; items: Record<string, boolean> }> = [];
  private lastSnapshotTime = -1;
  private frameCount = 0;
  private dungeonsVisited = new Set<number>();
  private result: AnalyzerResult | null = null;
  private onProgressCallback: ((progress: { racerId: string; vodTime: number; frameCount: number; eventsFound: number }) => void) | null = null;
  private onCompleteCallback: ((result: AnalyzerResult) => void) | null = null;

  constructor(
    private manager: VisionWorkerManager,
    private controller: VisionPipelineController,
  ) {}

  onProgress(cb: (progress: { racerId: string; vodTime: number; frameCount: number; eventsFound: number }) => void): void {
    this.onProgressCallback = cb;
  }

  onComplete(cb: (result: AnalyzerResult) => void): void {
    this.onCompleteCallback = cb;
  }

  async start(options: AnalyzerStartOptions): Promise<void> {
    if (this.state === 'running') throw new Error('Session already running');

    this.internalRacerId = `analyzer-${options.racerId}`;
    this.vodUrl = options.vodUrl;
    this.playbackRate = options.playbackRate ?? 2;
    this.events = [];
    this.stateSnapshots = [];
    this.lastSnapshotTime = -1;
    this.frameCount = 0;
    this.dungeonsVisited.clear();
    this.result = null;
    this.state = 'running';

    await this.manager.addRacer({
      racerId: this.internalRacerId,
      streamUrl: options.vodUrl,
      calibration: {} as any,
      role: 'monitored',
      startOffset: options.startOffset,
    });
    this.controller.addRacer(this.internalRacerId);

    // Set playback rate after a short delay to let the tab load
    setTimeout(() => {
      this.manager.setPlaybackRate(this.internalRacerId, this.playbackRate);
    }, 3000);
  }

  feedEvents(events: GameEvent[]): void {
    if (this.state !== 'running') return;
    this.events.push(...events);
    for (const e of events) {
      if (e.type === 'dungeon_first_visit' && e.data?.dungeon_level) {
        this.dungeonsVisited.add(e.data.dungeon_level as number);
      }
    }
  }

  feedState(stable: StableGameState, items: Record<string, boolean>, vodTime: number): void {
    if (this.state !== 'running') return;
    this.frameCount++;

    // Track dungeons from stable state
    if (stable.dungeonLevel > 0) {
      this.dungeonsVisited.add(stable.dungeonLevel);
    }

    // Snapshot every ~1 second of VOD time
    if (vodTime - this.lastSnapshotTime >= 1.0) {
      this.stateSnapshots.push({ vodTime, state: { ...stable }, items: { ...items } });
      this.lastSnapshotTime = vodTime;
    }

    // Emit progress every 60 frames
    if (this.frameCount % 60 === 0) {
      this.onProgressCallback?.({
        racerId: this.internalRacerId,
        vodTime,
        frameCount: this.frameCount,
        eventsFound: this.events.length,
      });
    }
  }

  async stop(): Promise<AnalyzerResult | null> {
    if (this.state !== 'running') return this.result;
    return this._finalize();
  }

  async handleVodEnded(): Promise<void> {
    if (this.state !== 'running') return;
    await this._finalize();
  }

  private async _finalize(): Promise<AnalyzerResult> {
    this.controller.removeRacer(this.internalRacerId);
    await this.manager.removeRacer(this.internalRacerId);

    const lastSnapshot = this.stateSnapshots[this.stateSnapshots.length - 1];
    this.result = {
      racerId: this.internalRacerId.replace('analyzer-', ''),
      vodUrl: this.vodUrl,
      duration: lastSnapshot?.vodTime ?? 0,
      playbackRate: this.playbackRate,
      events: this.events,
      stateSnapshots: this.stateSnapshots,
      summary: {
        deaths: this.events.filter(e => e.type === 'death').length,
        triforceCount: lastSnapshot?.state.triforceCollected ?? 0,
        dungeonsVisited: [...this.dungeonsVisited].sort((a, b) => a - b),
        gameComplete: this.events.some(e => e.type === 'game_complete'),
        totalFrames: this.frameCount,
      },
    };

    this.state = 'completed';
    this.onCompleteCallback?.(this.result);
    return this.result;
  }

  getStatus(): { state: SessionState; eventsFound: number; frameCount: number; vodTime: number } {
    const lastSnapshot = this.stateSnapshots[this.stateSnapshots.length - 1];
    return {
      state: this.state,
      eventsFound: this.events.length,
      frameCount: this.frameCount,
      vodTime: lastSnapshot?.vodTime ?? 0,
    };
  }

  getResult(): AnalyzerResult | null {
    return this.result;
  }

  getInternalRacerId(): string {
    return this.internalRacerId;
  }
}
```

**Step 2: Run tests**

Run: `cd server && npx vitest run tests/RaceAnalyzerSession.test.ts`
Expected: All pass

**Step 3: Run full test suite**

Run: `cd server && npx vitest run`
Expected: All pass

**Step 4: Commit**

```bash
git add server/src/vision/RaceAnalyzerSession.ts && git commit -m "feat: implement RaceAnalyzerSession class"
```

---

### Task 10: Add analyzer REST endpoints and Socket.IO events

**Files:**
- Create: `server/src/api/analyzerRoutes.ts`
- Modify: `server/src/index.ts` (wire up analyzer session, routes, socket events)

**Step 1: Create analyzerRoutes.ts**

```typescript
import { Router } from 'express';
import type { RaceAnalyzerSession } from '../vision/RaceAnalyzerSession.js';

export function createAnalyzerRoutes(session: RaceAnalyzerSession): Router {
  const router = Router();

  router.post('/start', async (req, res) => {
    const { racerId, vodUrl, playbackRate, startOffset } = req.body;
    if (!racerId || !vodUrl) {
      res.status(400).json({ error: 'racerId and vodUrl are required' });
      return;
    }
    try {
      await session.start({
        racerId,
        vodUrl,
        playbackRate: playbackRate ?? 2,
        startOffset,
      });
      res.json({ status: 'started', racerId });
    } catch (err: unknown) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/stop', async (_req, res) => {
    const result = await session.stop();
    res.json({ status: 'stopped', result });
  });

  router.get('/status', (_req, res) => {
    res.json(session.getStatus());
  });

  router.get('/result', (_req, res) => {
    const result = session.getResult();
    if (!result) {
      res.status(404).json({ error: 'No result available' });
      return;
    }
    res.json(result);
  });

  return router;
}
```

**Step 2: Wire up in index.ts**

Add imports:
```typescript
import { RaceAnalyzerSession } from './vision/RaceAnalyzerSession.js';
import { createAnalyzerRoutes } from './api/analyzerRoutes.js';
```

After the VisionPipelineController setup (around line 109), create the analyzer session:

```typescript
// ─── Race Analyzer Session ───
const analyzerSession = new RaceAnalyzerSession(visionWorkerManager, visionController);
analyzerSession.onProgress((progress) => {
  io.to('vision').emit('analyzer:progress', progress);
});
analyzerSession.onComplete((result) => {
  io.to('vision').emit('analyzer:complete', { racerId: result.racerId, result });
});
```

Wire the analyzer to receive events from the pipeline. Modify the existing `visionController.onGameEvents` to also feed the analyzer:

```typescript
visionController.onGameEvents((racerId, events) => {
  io.to('overlay').emit('vision:events', { racerId, events });
  io.to('vision').emit('vision:events', { racerId, events });
  // Feed analyzer if this racer belongs to the analyzer session
  if (racerId === analyzerSession.getInternalRacerId()) {
    analyzerSession.feedEvents(events);
  }
});
```

Similarly modify `visionController.onStateUpdate` to also feed the analyzer:

```typescript
visionController.onStateUpdate((update) => {
  // ... existing logging and emit ...
  io.to('vision').emit('vision:webgpu:state', update);
  // Feed analyzer if this racer belongs to the analyzer session
  if (update.racerId === analyzerSession.getInternalRacerId()) {
    analyzerSession.feedState(update.stable, update.items, update.frameCount / 30);
  }
});
```

Wire vodEnded to the analyzer:

```typescript
visionWorkerManager.onVodEnded((racerId) => {
  if (racerId === analyzerSession.getInternalRacerId()) {
    analyzerSession.handleVodEnded();
  }
});
```

Mount the routes:

```typescript
app.use('/api/analyzer', createAnalyzerRoutes(analyzerSession));
```

**Step 3: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

**Step 4: Run tests**

Run: `cd server && npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add server/src/api/analyzerRoutes.ts server/src/index.ts && git commit -m "feat: add analyzer REST endpoints and Socket.IO events"
```

---

### Task 11: Build the Race Analyzer dashboard page

**Files:**
- Create: `dashboard/src/pages/RaceAnalyzer.tsx`
- Modify: `dashboard/src/App.tsx` (add route)
- Modify: `dashboard/src/components/sidebar/AppSidebar.tsx` (replace Learn Mode link)

**Step 1: Create RaceAnalyzer.tsx**

```typescript
import { useCallback, useEffect, useState } from 'react';
import { useSocket, useSocketEvent } from '../hooks/useSocket.js';

interface GameEvent {
  type: string;
  racerId: string;
  timestamp: number;
  frameNumber: number;
  priority: 'high' | 'medium' | 'low';
  description: string;
  data?: Record<string, unknown>;
}

interface StableGameState {
  screenType: string;
  dungeonLevel: number;
  rupees: number;
  keys: number;
  bombs: number;
  heartsCurrentStable: number;
  heartsMaxStable: number;
  bItem: string | null;
  swordLevel: number;
  hasMasterKey: boolean;
  mapPosition: number;
  floorItems: Array<{ name: string; x: number; y: number; score: number }>;
  triforceCollected: number;
}

interface AnalyzerResult {
  racerId: string;
  vodUrl: string;
  duration: number;
  playbackRate: number;
  events: GameEvent[];
  stateSnapshots: Array<{ vodTime: number; state: StableGameState; items: Record<string, boolean> }>;
  summary: {
    deaths: number;
    triforceCount: number;
    dungeonsVisited: number[];
    gameComplete: boolean;
    totalFrames: number;
  };
}

interface AnalyzerProgress {
  racerId: string;
  vodTime: number;
  frameCount: number;
  eventsFound: number;
}

const EVENT_COLORS: Record<string, string> = {
  high: 'text-red-400',
  medium: 'text-yellow-400',
  low: 'text-gray-400',
};

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function swordLabel(level: number): string {
  return ['none', 'wood', 'white', 'magical'][level] ?? `L${level}`;
}

export default function RaceAnalyzer() {
  const socket = useSocket();
  const [vodUrl, setVodUrl] = useState('');
  const [racerId, setRacerId] = useState('analyzer');
  const [startOffset, setStartOffset] = useState('');
  const [playbackRate, setPlaybackRate] = useState(2);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<AnalyzerProgress | null>(null);
  const [result, setResult] = useState<AnalyzerResult | null>(null);
  const [scrubIndex, setScrubIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleProgress = useCallback((data: AnalyzerProgress) => {
    setProgress(data);
  }, []);
  useSocketEvent<AnalyzerProgress>('analyzer:progress', handleProgress);

  const handleComplete = useCallback((data: { racerId: string; result: AnalyzerResult }) => {
    setResult(data.result);
    setIsRunning(false);
    setScrubIndex(0);
  }, []);
  useSocketEvent<{ racerId: string; result: AnalyzerResult }>('analyzer:complete', handleComplete);

  function parseOffset(s: string): number | undefined {
    const trimmed = s.trim();
    if (!trimmed) return undefined;
    const parts = trimmed.split(':').map(Number);
    if (parts.some(isNaN)) return undefined;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }

  async function handleStart() {
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      const body: Record<string, unknown> = { racerId, vodUrl, playbackRate };
      const offset = parseOffset(startOffset);
      if (offset !== undefined) body.startOffset = offset;
      const res = await fetch('/api/analyzer/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setIsRunning(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleStop() {
    await fetch('/api/analyzer/stop', { method: 'POST' });
    setIsRunning(false);
  }

  const snapshot = result?.stateSnapshots[scrubIndex];

  return (
    <div className="h-screen flex flex-col bg-[#0f0f1a] text-white p-2 gap-2">
      {/* Header */}
      <div className="flex flex-col gap-1 px-2 py-2 bg-[#1a1a2e] rounded">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">VOD URL</label>
            <input
              value={vodUrl}
              onChange={e => setVodUrl(e.target.value)}
              placeholder="https://twitch.tv/videos/123456"
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-80"
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">Racer</label>
            <input
              value={racerId}
              onChange={e => setRacerId(e.target.value)}
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-28"
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">Start at</label>
            <input
              value={startOffset}
              onChange={e => setStartOffset(e.target.value)}
              placeholder="0:11:30"
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-20"
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">Speed</label>
            <select
              value={playbackRate}
              onChange={e => setPlaybackRate(Number(e.target.value))}
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm"
              disabled={isRunning}
            >
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={handleStart}
              disabled={isRunning || !vodUrl.trim()}
              className="px-3 py-1 text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded"
            >Start</button>
            <button
              onClick={handleStop}
              disabled={!isRunning}
              className="px-3 py-1 text-xs bg-red-800 hover:bg-red-700 disabled:opacity-40 rounded"
            >Stop</button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isRunning && progress && (
            <span className="text-xs text-green-400">
              Processing: {formatTime(progress.vodTime)} | {progress.frameCount} frames | {progress.eventsFound} events
            </span>
          )}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>

      {/* Results */}
      {result && (
        <>
          {/* Summary */}
          <div className="flex gap-4 px-2 py-2 bg-[#1a1a2e] rounded text-sm">
            <span>Deaths: <strong className="text-red-400">{result.summary.deaths}</strong></span>
            <span>Triforce: <strong className="text-yellow-400">{result.summary.triforceCount}/8</strong></span>
            <span>Dungeons: <strong>{result.summary.dungeonsVisited.join(', ') || 'none'}</strong></span>
            <span>Complete: <strong className={result.summary.gameComplete ? 'text-green-400' : 'text-gray-500'}>{result.summary.gameComplete ? 'Yes' : 'No'}</strong></span>
            <span>Frames: {result.summary.totalFrames.toLocaleString()}</span>
            <span>Duration: {formatTime(result.duration)}</span>
            <span className="text-gray-500">({result.playbackRate}x)</span>
          </div>

          {/* State Scrubber */}
          <div className="bg-[#1a1a2e] rounded p-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-gray-400">TIME</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, result.stateSnapshots.length - 1)}
                value={scrubIndex}
                onChange={e => setScrubIndex(Number(e.target.value))}
                className="flex-1"
              />
              <span className="text-xs font-mono w-16 text-right">{snapshot ? formatTime(snapshot.vodTime) : '—'}</span>
            </div>
            {snapshot && (
              <div className="grid grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-gray-400">screen:</span> {snapshot.state.screenType}
                  {snapshot.state.dungeonLevel > 0 && <span className="text-indigo-400"> L{snapshot.state.dungeonLevel}</span>}
                </div>
                <div>
                  <span className="text-gray-400">hearts:</span> {snapshot.state.heartsCurrentStable}/{snapshot.state.heartsMaxStable}
                </div>
                <div>
                  <span className="text-gray-400">rupees:</span> {snapshot.state.rupees}
                  <span className="text-gray-400 ml-2">keys:</span> {snapshot.state.keys}
                  <span className="text-gray-400 ml-2">bombs:</span> {snapshot.state.bombs}
                </div>
                <div>
                  <span className="text-gray-400">sword:</span> {swordLabel(snapshot.state.swordLevel)}
                  <span className="text-gray-400 ml-2">b:</span> {snapshot.state.bItem ?? '—'}
                </div>
              </div>
            )}
          </div>

          {/* Event Timeline */}
          <div className="flex-1 bg-[#1a1a2e] rounded p-2 min-h-0 overflow-auto">
            <div className="text-xs font-semibold text-gray-400 mb-2">EVENTS ({result.events.length})</div>
            <div className="space-y-0.5">
              {result.events.map((evt, i) => (
                <div key={i} className={`text-xs flex gap-2 ${EVENT_COLORS[evt.priority] ?? 'text-gray-400'}`}>
                  <span className="font-mono w-14 shrink-0 text-gray-500">{formatTime(evt.frameNumber / 30)}</span>
                  <span className="font-semibold w-32 shrink-0">{evt.type}</span>
                  <span className="text-gray-300">{evt.description}</span>
                </div>
              ))}
              {result.events.length === 0 && <div className="text-gray-600 text-xs">No events detected</div>}
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {!result && !isRunning && (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          Enter a VOD URL and click Start to analyze a race
        </div>
      )}
    </div>
  );
}
```

**Step 2: Add route to App.tsx**

Add import:
```typescript
import RaceAnalyzer from './pages/RaceAnalyzer';
```

Add route (replacing Learn Mode or adding alongside):
```typescript
<Route path="/analyzer" element={<RaceAnalyzer />} />
```

**Step 3: Update sidebar**

In AppSidebar.tsx, replace the Learn Mode link:

```typescript
<SidebarLink to="/analyzer" icon={GraduationCap} label="Race Analyzer" collapsed={collapsed} />
```

Keep the Learn Mode route in App.tsx for now (it's a separate page that still works), but remove its sidebar link.

**Step 4: Build dashboard**

Run: `cd dashboard && npm run build`
Expected: Clean build

**Step 5: Commit**

```bash
git add dashboard/src/pages/RaceAnalyzer.tsx dashboard/src/App.tsx dashboard/src/components/sidebar/AppSidebar.tsx && git commit -m "feat: add Race Analyzer dashboard page with event timeline and state scrubber"
```

---

### Task 12: Run full test suite and verify TypeScript

**Step 1: Run server tests**

Run: `cd server && npx vitest run`
Expected: All pass

**Step 2: Verify server TypeScript**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

**Step 3: Build dashboard**

Run: `cd dashboard && npm run build`
Expected: Clean

**Step 4: Final commit**

If any fixes were needed, commit them. Otherwise, no action needed.

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Extend WebGPUStateUpdate type | `types.ts` |
| 2 | Emit items/triforce from pipeline | `VisionPipelineController.ts` |
| 3 | ItemGrid + per-piece triforce in UI | `WebGPUVision.tsx` |
| 4 | Remove VisionLab page | `VisionLab.tsx`, `App.tsx`, `AppSidebar.tsx` |
| 5 | Remove Python vision routes | `routes.ts`, `index.ts` |
| 6 | Playback rate + vodEnded in worker | `worker.js` |
| 7 | vodEnded handler in manager | `VisionWorkerManager.ts` |
| 8 | RaceAnalyzerSession test (red) | `RaceAnalyzerSession.test.ts` |
| 9 | RaceAnalyzerSession implementation | `RaceAnalyzerSession.ts` |
| 10 | Analyzer routes + wiring | `analyzerRoutes.ts`, `index.ts` |
| 11 | Race Analyzer dashboard page | `RaceAnalyzer.tsx`, `App.tsx`, `AppSidebar.tsx` |
| 12 | Full verification | — |
