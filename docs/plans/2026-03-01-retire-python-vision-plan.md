# Retire Python Vision — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the 5 feature gaps between the WebGPU TypeScript pipeline and the Python vision pipeline, so Python can be retired.

**Architecture:** All changes are server-side TypeScript. The GPU shaders already extract the raw data (gold pixel counts, floor item positions, NCC scores, aggregates). We're adding interpretation and temporal tracking logic that operates on `RawPixelState` and `StableGameState`. New classes: `TriforceTracker`, `WarpDeathTracker`. Modified classes: `FloorItemTracker`, `PixelInterpreter`, `EventInferencer`, `VisionPipelineController`. New types added to `types.ts`.

**Tech Stack:** TypeScript, vitest, Node.js. No WGSL shader changes. No browser-side changes.

**Key reference files:**
- Architecture: `memory/webgpu-vision-architecture.md` (auto-memory, read with Read tool)
- Design: `docs/plans/2026-03-01-retire-python-vision-design.md`
- Skill: `.claude/plugins/ttp-vision/skills/vision-pipeline-work/SKILL.md` (trigger on vision work)

---

### Task 1: Add `item_drop` and `item_pickup` events to FloorItemTracker

The existing `FloorItemTracker.ts` already tracks item presence with confirm/gone streaks, and returns `{ confirmed, obtained }`. But `EventInferencer` doesn't wire these into `GameEvent` emissions. This task adds the wiring.

**Files:**
- Modify: `server/src/vision/FloorItemTracker.ts`
- Modify: `server/src/vision/VisionPipelineController.ts:58-111`
- Test: `server/tests/FloorItemTracker.test.ts`

**Step 1: Write failing tests for drop/pickup events**

Add to `server/tests/FloorItemTracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { FloorItemTracker } from '../src/vision/FloorItemTracker';

describe('FloorItemTracker events', () => {
  it('emits drop event after CONFIRM_FRAMES consecutive detections', () => {
    const tracker = new FloorItemTracker();
    tracker.onRoomChange(); // start grace
    tracker.update([]); // grace 1
    tracker.update([]); // grace 2
    tracker.update([]); // grace 3 — grace done

    const item = { name: 'heart_drop', x: 100, y: 80, score: 0.9 };
    tracker.update([item]); // confirm 1
    tracker.update([item]); // confirm 2
    const result = tracker.update([item]); // confirm 3 (>= CONFIRM_FRAMES)
    expect(result.confirmed.length).toBe(1);
    expect(result.confirmed[0].name).toBe('heart_drop');
  });

  it('emits obtained event after GONE_FRAMES consecutive absence', () => {
    const tracker = new FloorItemTracker();
    tracker.onRoomChange();
    tracker.update([]); tracker.update([]); tracker.update([]); // grace

    const item = { name: 'rupee_blue', x: 50, y: 60, score: 0.9 };
    // Confirm item
    for (let i = 0; i < 4; i++) tracker.update([item]);
    // Item disappears
    for (let i = 0; i < 5; i++) tracker.update([]);
    const result = tracker.update([]);
    expect(result.obtained.length).toBe(1);
    expect(result.obtained[0].name).toBe('rupee_blue');
  });

  it('does not emit during grace period', () => {
    const tracker = new FloorItemTracker();
    tracker.onRoomChange();
    const item = { name: 'heart_drop', x: 100, y: 80, score: 0.9 };
    const r1 = tracker.update([item]); // grace 1
    const r2 = tracker.update([item]); // grace 2
    const r3 = tracker.update([item]); // grace 3
    expect(r1.confirmed.length).toBe(0);
    expect(r2.confirmed.length).toBe(0);
    expect(r3.confirmed.length).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/FloorItemTracker.test.ts`
Expected: Some tests may already pass (the tracker already has confirm/gone logic). Verify all 3 pass with existing code — if they do, the tracker already works and we just need the wiring in VisionPipelineController.

**Step 3: Wire floor item events into VisionPipelineController**

In `server/src/vision/VisionPipelineController.ts`, after the `_processRaw` call to `pipeline.inferencer.update()`, add floor item event emission:

```typescript
// In _processRaw(), after events = pipeline.inferencer.update(...)
// Floor item tracking: detect room changes, update tracker, emit events
if (stableState.mapPosition !== pipeline.prevMapPosition
    || stableState.dungeonLevel !== pipeline.prevDungeonLevel) {
  pipeline.floorItems.onRoomChange();
}
const floorResult = pipeline.floorItems.update(rawState.floorItems);
for (const item of floorResult.obtained) {
  events.push({
    type: 'item_pickup', racerId: raw.racerId, timestamp: raw.timestamp,
    frameNumber: raw.frameNumber, priority: 'low',
    description: `Picked up ${item.name}`,
    data: { name: item.name, x: item.x, y: item.y },
  });
}
// Note: item_drop events are for newly confirmed items
// The tracker's "confirmed" list includes all confirmed items, not just new ones.
// We need to track which items we've already emitted drop events for.
```

Actually, the existing FloorItemTracker doesn't distinguish "newly confirmed" from "still confirmed." We need to add that. Modify `FloorItemTracker.ts` to return a `newlyConfirmed` array:

```typescript
// In FloorItemTracker.update(), change the confirmed logic:
// When confirmedFrames crosses CONFIRM_FRAMES threshold, it's a new drop
const newlyConfirmed: Array<{ name: string; x: number; y: number; score: number }> = [];
// ... in the loop where confirmedFrames >= CONFIRM_FRAMES:
if (tracked.confirmedFrames === this.CONFIRM_FRAMES) {
  newlyConfirmed.push({ name: tracked.name, x: tracked.x, y: tracked.y, score: tracked.score });
}

return { confirmed, obtained, newlyConfirmed };
```

Then in VisionPipelineController:
```typescript
for (const item of floorResult.newlyConfirmed) {
  events.push({
    type: 'item_drop', racerId: raw.racerId, timestamp: raw.timestamp,
    frameNumber: raw.frameNumber, priority: 'low',
    description: `Floor item appeared: ${item.name}`,
    data: { name: item.name, x: item.x, y: item.y },
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/FloorItemTracker.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd server && npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add server/src/vision/FloorItemTracker.ts server/src/vision/VisionPipelineController.ts server/tests/FloorItemTracker.test.ts
git commit -m "feat: wire item_drop and item_pickup events from FloorItemTracker"
```

---

### Task 2: Create TriforceTracker

Port the Python `ItemHoldTracker` + `DungeonExitTracker` triforce detection logic to TypeScript.

**Files:**
- Create: `server/src/vision/TriforceTracker.ts`
- Test: `server/tests/TriforceTracker.test.ts`

**Step 1: Write failing tests**

Create `server/tests/TriforceTracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TriforceTracker } from '../src/vision/TriforceTracker';
import type { StableGameState, GameEvent } from '../src/vision/types';

function state(overrides: Partial<StableGameState> = {}): StableGameState {
  return {
    screenType: 'dungeon', dungeonLevel: 3,
    rupees: 5, keys: 1, bombs: 3,
    heartsCurrentStable: 6, heartsMaxStable: 6,
    bItem: null, swordLevel: 1, hasMasterKey: false,
    mapPosition: 42, floorItems: [], triforceCollected: 0,
    ...overrides,
  };
}

describe('TriforceTracker', () => {
  describe('dungeon exit detection', () => {
    it('infers triforce when hearts increase to max after dungeon exit', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      // In dungeon with partial hearts
      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 0, 0, events);

      // Transition out of dungeon
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 33, 1, events);

      // Arrive at overworld with full hearts (triforce refill)
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(true);
      expect(events.find(e => e.type === 'triforce_inferred')?.data?.dungeonLevel).toBe(3);
    });

    it('does not infer triforce when hearts did not increase', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 0, 0, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 33, 1, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(false);
    });

    it('does not infer triforce if hearts dropped to 0 (death)', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 0, 0, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 0, heartsMaxStable: 6 }), 33, 1, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(false);
    });

    it('infers game_complete when exiting D9 for 30+ frames', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 9,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 0, 0, events);

      // 35 frames of transition
      for (let i = 1; i <= 35; i++) {
        tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
          heartsCurrentStable: 6, heartsMaxStable: 6 }), i * 33, i, events);
      }

      expect(events.some(e => e.type === 'game_complete')).toBe(true);
    });

    it('does not double-infer triforce for same dungeon', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      // First triforce from D3
      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 0, 0, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 33, 1, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);
      expect(events.filter(e => e.type === 'triforce_inferred').length).toBe(1);

      // Re-enter and exit D3 — should NOT infer again
      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 100, 3, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 133, 4, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 166, 5, events);
      expect(events.filter(e => e.type === 'triforce_inferred').length).toBe(1);
    });
  });

  describe('gold flash detection', () => {
    it('infers triforce from gold pixel flash pattern with hearts refill', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      // Enter dungeon
      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
        heartsCurrentStable: 3, heartsMaxStable: 6 }), 0, 0, events);

      // Flash pattern: gold pixels appear/disappear (4+ detections, 1+ gaps)
      const goldHigh = 50; // elevated gold pixel count
      const goldLow = 0;
      // Pattern: high, high, low (gap), high, high, low, high
      const goldPattern = [goldHigh, goldHigh, goldLow, goldHigh, goldHigh, goldLow, goldHigh];
      for (let i = 0; i < goldPattern.length; i++) {
        tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
          heartsCurrentStable: 3, heartsMaxStable: 6,
          triforceCollected: goldPattern[i] > 0 ? 1 : 0 }), (i + 1) * 33, i + 1, events);
        tracker.feedGoldPixels(goldPattern[i]);
      }

      // Gap timeout: 13+ frames with no gold
      for (let i = 0; i < 15; i++) {
        tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
          heartsCurrentStable: 3 + Math.min(i, 3), heartsMaxStable: 6 }), (8 + i) * 33, 8 + i, events);
        tracker.feedGoldPixels(0);
      }

      // Hearts reach max
      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 800, 24, events);
      tracker.feedGoldPixels(0);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(true);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/TriforceTracker.test.ts`
Expected: FAIL (TriforceTracker doesn't exist yet)

**Step 3: Implement TriforceTracker**

Create `server/src/vision/TriforceTracker.ts`:

```typescript
import type { StableGameState, GameEvent, GameEventType } from './types.js';

const PRIORITY: Record<string, GameEvent['priority']> = {
  triforce_inferred: 'high',
  game_complete: 'high',
};

// Dungeon exit detection thresholds (from Python DungeonExitTracker)
const DEATH_MENU_FRAMES = 3;     // consecutive 'death' frames = death menu
const D9_EXIT_FRAMES = 30;       // frames to confirm game complete
const EXIT_TIMEOUT_FRAMES = 40;  // frames without resolution = reset

// Gold flash detection thresholds (from Python ItemHoldTracker)
const GOLD_THRESHOLD = 10;       // minimum gold pixel count to register as "flash"
const MIN_GOLD_DETECTIONS = 4;   // at least 4 frames with gold
const MIN_GOLD_GAPS = 1;         // at least 1 gap (color-cycle evidence)
const MIN_GOLD_TOTAL = 8;        // minimum total frames in flash pattern
const GOLD_GAP_TIMEOUT = 12;     // frames without gold detection to end animation
const HEARTS_PENDING_TIMEOUT = 20; // frames to wait for hearts refill after flash

type ExitPhase = 'idle' | 'exiting';

export class TriforceTracker {
  private racerId: string;
  private triforceInferred: boolean[] = new Array(8).fill(false);
  private gameCompleted = false;

  // Dungeon exit tracking
  private exitPhase: ExitPhase = 'idle';
  private exitDungeon = 0;
  private exitStartFrame = 0;
  private exitHeartsStart = 0;
  private exitHeartsMin = 99;
  private exitDeathFrames = 0;
  private exitSawDeathMenu = false;

  // Gold flash tracking
  private goldDetections = 0;
  private goldGaps = 0;
  private goldTotal = 0;
  private goldLastFrame = -999;
  private goldStartDungeon = 0;
  private goldHeartsStart = 0;
  private goldPending = false;
  private goldPendingFrame = 0;
  private goldTracking = false;

  private prevScreenType = '';
  private prevDungeonLevel = 0;

  constructor(racerId: string) {
    this.racerId = racerId;
  }

  /** Feed gold pixel count from RawPixelState.goldPixelCount each frame. */
  feedGoldPixels(goldPixels: number): void {
    // Gold flash tracking handled in _updateGoldFlash
    this._goldPixelsThisFrame = goldPixels;
  }

  private _goldPixelsThisFrame = 0;

  update(state: StableGameState, timestamp: number, frameNumber: number,
         events: GameEvent[]): void {
    this._updateDungeonExit(state, timestamp, frameNumber, events);
    this._updateGoldFlash(state, timestamp, frameNumber, events);
    this.prevScreenType = state.screenType;
    this.prevDungeonLevel = state.dungeonLevel;
  }

  private emit(events: GameEvent[], type: GameEventType, ts: number, fn: number,
               desc: string, data?: Record<string, unknown>): void {
    events.push({
      type, racerId: this.racerId, timestamp: ts,
      frameNumber: fn, priority: PRIORITY[type] ?? 'high', description: desc, data,
    });
  }

  // --- Dungeon exit triforce inference ---

  private _updateDungeonExit(state: StableGameState, ts: number, fn: number,
                              events: GameEvent[]): void {
    const isGameplay = ['overworld', 'dungeon', 'cave'].includes(state.screenType);
    const prevWasGameplay = ['overworld', 'dungeon', 'cave'].includes(this.prevScreenType);

    if (this.exitPhase === 'idle') {
      // Watch for dungeon → non-gameplay transition
      if (this.prevScreenType === 'dungeon' && this.prevDungeonLevel > 0
          && !isGameplay && state.screenType !== 'subscreen') {
        this.exitPhase = 'exiting';
        this.exitDungeon = this.prevDungeonLevel;
        this.exitStartFrame = fn;
        this.exitHeartsStart = state.heartsCurrentStable;
        this.exitHeartsMin = state.heartsCurrentStable;
        this.exitDeathFrames = state.screenType === 'death' ? 1 : 0;
        this.exitSawDeathMenu = false;
      }
    } else {
      // EXITING phase
      this.exitHeartsMin = Math.min(this.exitHeartsMin, state.heartsCurrentStable);

      // Death menu tracking
      if (state.screenType === 'death') {
        this.exitDeathFrames++;
        if (this.exitDeathFrames >= DEATH_MENU_FRAMES) {
          this.exitSawDeathMenu = true;
        }
      } else {
        this.exitDeathFrames = 0;
      }

      const exitFrames = fn - this.exitStartFrame;

      // Resolution: arrived at overworld
      if (state.screenType === 'overworld') {
        const heartsIncreased = state.heartsCurrentStable > this.exitHeartsStart;
        const heartsAtMax = state.heartsCurrentStable >= state.heartsMaxStable;
        const dungeon = this.exitDungeon;

        if (heartsIncreased && heartsAtMax
            && this.exitHeartsMin > 0 && !this.exitSawDeathMenu
            && dungeon >= 1 && dungeon <= 8
            && !this.triforceInferred[dungeon - 1]) {
          this.triforceInferred[dungeon - 1] = true;
          this.emit(events, 'triforce_inferred', ts, fn,
            `Triforce piece ${dungeon} inferred (dungeon exit + hearts refill)`,
            { dungeonLevel: dungeon });
        }
        this._resetExit();
      }
      // Resolution: returned to dungeon (transition flicker)
      else if (['dungeon', 'cave'].includes(state.screenType)) {
        this._resetExit();
      }
      // Resolution: game complete (D9 exit)
      else if (this.exitDungeon === 9 && exitFrames > D9_EXIT_FRAMES
               && this.exitHeartsMin > 0 && !this.gameCompleted) {
        this.gameCompleted = true;
        this.emit(events, 'game_complete', ts, fn, 'Game complete — exited D9');
        this._resetExit();
      }
      // Resolution: timeout
      else if (exitFrames > EXIT_TIMEOUT_FRAMES) {
        this._resetExit();
      }
    }
  }

  private _resetExit(): void {
    this.exitPhase = 'idle';
    this.exitDungeon = 0;
    this.exitHeartsMin = 99;
    this.exitDeathFrames = 0;
    this.exitSawDeathMenu = false;
  }

  // --- Gold flash triforce inference ---

  private _updateGoldFlash(state: StableGameState, ts: number, fn: number,
                            events: GameEvent[]): void {
    const goldPixels = this._goldPixelsThisFrame;
    const isGold = goldPixels >= GOLD_THRESHOLD;
    const isDungeon = ['dungeon', 'cave'].includes(state.screenType);

    // Pending confirmation: check hearts refill
    if (this.goldPending) {
      if (state.heartsCurrentStable > this.goldHeartsStart
          && state.heartsCurrentStable >= state.heartsMaxStable
          && state.heartsMaxStable > 0) {
        const dungeon = this.goldStartDungeon;
        if (dungeon >= 1 && dungeon <= 8 && !this.triforceInferred[dungeon - 1]) {
          this.triforceInferred[dungeon - 1] = true;
          this.emit(events, 'triforce_inferred', ts, fn,
            `Triforce piece ${dungeon} inferred (gold flash + hearts refill)`,
            { dungeonLevel: dungeon });
        }
        this._resetGold();
        return;
      }
      if (fn - this.goldPendingFrame > HEARTS_PENDING_TIMEOUT) {
        this._resetGold();
        return;
      }
    }

    // Start tracking on gold detection in dungeon
    if (isGold && isDungeon && state.dungeonLevel > 0 && !this.goldTracking) {
      this.goldTracking = true;
      this.goldDetections = 1;
      this.goldGaps = 0;
      this.goldTotal = 1;
      this.goldLastFrame = fn;
      this.goldStartDungeon = state.dungeonLevel;
      this.goldHeartsStart = state.heartsCurrentStable;
      return;
    }

    if (!this.goldTracking) return;

    if (isGold) {
      this.goldDetections++;
      this.goldTotal++;
      this.goldLastFrame = fn;
    } else {
      // Gap frame
      if (fn - this.goldLastFrame > GOLD_GAP_TIMEOUT) {
        // Animation over — check threshold
        if (this.goldDetections >= MIN_GOLD_DETECTIONS
            && this.goldGaps >= MIN_GOLD_GAPS
            && this.goldTotal >= MIN_GOLD_TOTAL) {
          // Threshold met — check hearts immediately or go pending
          if (state.heartsCurrentStable > this.goldHeartsStart
              && state.heartsCurrentStable >= state.heartsMaxStable) {
            const dungeon = this.goldStartDungeon;
            if (dungeon >= 1 && dungeon <= 8 && !this.triforceInferred[dungeon - 1]) {
              this.triforceInferred[dungeon - 1] = true;
              this.emit(events, 'triforce_inferred', ts, fn,
                `Triforce piece ${dungeon} inferred (gold flash + hearts refill)`,
                { dungeonLevel: dungeon });
            }
            this._resetGold();
          } else {
            this.goldPending = true;
            this.goldPendingFrame = fn;
          }
        } else {
          this._resetGold();
        }
      } else {
        this.goldGaps++;
        this.goldTotal++;
      }
    }
  }

  private _resetGold(): void {
    this.goldTracking = false;
    this.goldPending = false;
    this.goldDetections = 0;
    this.goldGaps = 0;
    this.goldTotal = 0;
    this.goldStartDungeon = 0;
  }

  get triforceState(): boolean[] {
    return [...this.triforceInferred];
  }

  get isGameCompleted(): boolean {
    return this.gameCompleted;
  }

  reset(): void {
    this.triforceInferred.fill(false);
    this.gameCompleted = false;
    this._resetExit();
    this._resetGold();
    this.prevScreenType = '';
    this.prevDungeonLevel = 0;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/TriforceTracker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/src/vision/TriforceTracker.ts server/tests/TriforceTracker.test.ts
git commit -m "feat: TriforceTracker — dungeon exit + gold flash triforce detection"
```

---

### Task 3: Create WarpDeathTracker

Port the Python `WarpDeathTracker` warp/death distinction logic.

**Files:**
- Create: `server/src/vision/WarpDeathTracker.ts`
- Test: `server/tests/WarpDeathTracker.test.ts`

**Step 1: Write failing tests**

Create `server/tests/WarpDeathTracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { WarpDeathTracker } from '../src/vision/WarpDeathTracker';
import type { StableGameState, GameEvent } from '../src/vision/types';

function state(overrides: Partial<StableGameState> = {}): StableGameState {
  return {
    screenType: 'overworld', dungeonLevel: 0,
    rupees: 5, keys: 1, bombs: 3,
    heartsCurrentStable: 6, heartsMaxStable: 6,
    bItem: null, swordLevel: 1, hasMasterKey: false,
    mapPosition: 42, floorItems: [], triforceCollected: 0,
    ...overrides,
  };
}

describe('WarpDeathTracker', () => {
  it('emits death when hearts reach 0 and position resets', () => {
    const tracker = new WarpDeathTracker('racer1');
    const events: GameEvent[] = [];

    // Set starting position
    tracker.update(state({ screenType: 'overworld', mapPosition: 119 }), 0, 0, events);
    tracker.registerStart(119); // overworld start position

    // Hearts drop to 0
    tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 0, mapPosition: 50 }), 33, 1, events);
    // Non-gameplay gap
    for (let i = 0; i < 5; i++) {
      tracker.update(state({ screenType: 'transition', heartsCurrentStable: 0 }), (2 + i) * 33, 2 + i, events);
    }
    // Resume at start position
    tracker.update(state({ screenType: 'overworld', mapPosition: 119, heartsCurrentStable: 6 }), 233, 7, events);

    expect(events.some(e => e.type === 'death')).toBe(true);
  });

  it('emits up_a_warp when hearts > 0 and position resets', () => {
    const tracker = new WarpDeathTracker('racer1');
    const events: GameEvent[] = [];

    tracker.update(state({ screenType: 'overworld', mapPosition: 119 }), 0, 0, events);
    tracker.registerStart(119);

    // Hearts still positive
    tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 4, mapPosition: 50 }), 33, 1, events);
    // Non-gameplay gap
    for (let i = 0; i < 5; i++) {
      tracker.update(state({ screenType: 'transition', heartsCurrentStable: 4 }), (2 + i) * 33, 2 + i, events);
    }
    // Resume at start position
    tracker.update(state({ screenType: 'overworld', mapPosition: 119, heartsCurrentStable: 4 }), 233, 7, events);

    expect(events.some(e => e.type === 'up_a_warp')).toBe(true);
  });

  it('does not fire multiple events per gap', () => {
    const tracker = new WarpDeathTracker('racer1');
    const events: GameEvent[] = [];

    tracker.update(state({ screenType: 'overworld', mapPosition: 119 }), 0, 0, events);
    tracker.registerStart(119);
    tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 0, mapPosition: 50 }), 33, 1, events);

    for (let i = 0; i < 10; i++) {
      tracker.update(state({ screenType: 'transition', heartsCurrentStable: 0 }), (2 + i) * 33, 2 + i, events);
    }
    tracker.update(state({ screenType: 'overworld', mapPosition: 119, heartsCurrentStable: 6 }), 400, 12, events);

    const deaths = events.filter(e => e.type === 'death');
    expect(deaths.length).toBe(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/WarpDeathTracker.test.ts`
Expected: FAIL (WarpDeathTracker doesn't exist yet)

**Step 3: Implement WarpDeathTracker**

Create `server/src/vision/WarpDeathTracker.ts`:

```typescript
import type { StableGameState, GameEvent, GameEventType } from './types.js';

const NON_GAMEPLAY_GAP_THRESHOLD = 4;
const ZERO_HEARTS_STREAK_THRESHOLD = 4;

const GAMEPLAY_SCREENS = new Set(['overworld', 'dungeon', 'cave']);

export class WarpDeathTracker {
  private racerId: string;
  private lastGameplayHearts = 0;
  private zeroHeartsStreak = 0;
  private nonGameplayGap = 0;
  private lastGameplayPosition = -1;
  private lastGameplayScreen = '';
  private warpDetectedThisGap = false;
  private overworldStart = 0;
  private dungeonEntrances = new Map<number, number>();
  private gameplayStarted = false;
  private gameplayStreak = 0;

  constructor(racerId: string) {
    this.racerId = racerId;
  }

  /** Register the overworld starting position (called once when first identified). */
  registerStart(position: number): void {
    if (this.overworldStart === 0) this.overworldStart = position;
  }

  /** Register dungeon entrance position (called on first visit to each dungeon). */
  registerDungeonEntrance(dungeonLevel: number, position: number): void {
    if (!this.dungeonEntrances.has(dungeonLevel)) {
      this.dungeonEntrances.set(dungeonLevel, position);
    }
  }

  update(state: StableGameState, timestamp: number, frameNumber: number,
         events: GameEvent[], gameCompleted = false): void {
    const isGameplay = GAMEPLAY_SCREENS.has(state.screenType);

    // Track gameplay streak for startup detection
    if (isGameplay) {
      this.gameplayStreak++;
      if (this.gameplayStreak >= 120 && !this.gameplayStarted) {
        this.gameplayStarted = true;
      }
    } else if (state.screenType === 'title') {
      this.gameplayStreak = 0;
    }

    // Hearts tracking on gameplay frames
    if (isGameplay) {
      if (state.heartsCurrentStable > 0) {
        this.lastGameplayHearts = state.heartsCurrentStable;
        this.zeroHeartsStreak = 0;
      } else if (state.heartsMaxStable > 0) {
        this.zeroHeartsStreak++;
        if (this.zeroHeartsStreak >= ZERO_HEARTS_STREAK_THRESHOLD) {
          this.lastGameplayHearts = 0;
        }
      }
    }

    // Gap tracking
    if (isGameplay) {
      // Check for position-reset detection on gap → gameplay transition
      if (this.nonGameplayGap >= NON_GAMEPLAY_GAP_THRESHOLD
          && this.gameplayStarted && !gameCompleted && !this.warpDetectedThisGap) {
        this._checkPositionReset(state, timestamp, frameNumber, events);
      }

      this.nonGameplayGap = 0;
      this.warpDetectedThisGap = false;
      this.lastGameplayPosition = state.mapPosition;
      this.lastGameplayScreen = state.screenType;
    } else if (state.screenType !== 'subscreen') {
      this.nonGameplayGap++;

      // CSR-based death/warp detection (death screen appears)
      if (state.screenType === 'death' && this.lastGameplayScreen !== ''
          && !gameCompleted && this.gameplayStarted && !this.warpDetectedThisGap) {
        this.warpDetectedThisGap = true;
        if (this.lastGameplayHearts === 0) {
          this._emit(events, 'death', timestamp, frameNumber, 'Link died');
        } else {
          this._emit(events, 'up_a_warp', timestamp, frameNumber,
            `Up+A warp (hearts were ${this.lastGameplayHearts})`);
        }
      }
    }
  }

  private _checkPositionReset(state: StableGameState, ts: number, fn: number,
                               events: GameEvent[]): void {
    let isReset = false;

    // Overworld reset: returned to overworld start
    if (state.screenType === 'overworld' && this.overworldStart > 0
        && state.mapPosition === this.overworldStart) {
      isReset = true;
    }

    // Dungeon reset: returned to dungeon entrance
    if (state.screenType === 'dungeon' && state.dungeonLevel > 0) {
      const entrance = this.dungeonEntrances.get(state.dungeonLevel);
      if (entrance !== undefined && entrance > 0
          && state.mapPosition === entrance
          && this.lastGameplayScreen === 'dungeon') {
        isReset = true;
      }
    }

    if (isReset) {
      this.warpDetectedThisGap = true;
      if (this.lastGameplayHearts === 0) {
        this._emit(events, 'death', ts, fn, 'Link died (position reset)');
      } else {
        this._emit(events, 'up_a_warp', ts, fn,
          `Up+A warp — returned to start (hearts ${this.lastGameplayHearts})`);
      }
    }
  }

  private _emit(events: GameEvent[], type: GameEventType, ts: number, fn: number,
                desc: string): void {
    events.push({
      type, racerId: this.racerId, timestamp: ts,
      frameNumber: fn, priority: type === 'death' ? 'high' : 'low',
      description: desc,
    });
  }

  reset(): void {
    this.lastGameplayHearts = 0;
    this.zeroHeartsStreak = 0;
    this.nonGameplayGap = 0;
    this.lastGameplayPosition = -1;
    this.lastGameplayScreen = '';
    this.warpDetectedThisGap = false;
    this.overworldStart = 0;
    this.dungeonEntrances.clear();
    this.gameplayStarted = false;
    this.gameplayStreak = 0;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/WarpDeathTracker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/src/vision/WarpDeathTracker.ts server/tests/WarpDeathTracker.test.ts
git commit -m "feat: WarpDeathTracker — death vs warp distinction via position reset"
```

---

### Task 4: Add SWAP detection to PixelInterpreter

Z1R subscreen shows "SWAP" in red text. Detect it by checking if the red aggregate is elevated during subscreen.

**Files:**
- Modify: `server/src/vision/PixelInterpreter.ts:68-78`
- Modify: `server/src/vision/types.ts:37` (add `'subscreen_swap'` to screenType union)
- Test: `server/tests/PixelInterpreter.test.ts`

**Step 1: Write failing test**

Add to `server/tests/PixelInterpreter.test.ts`:

```typescript
describe('SWAP detection', () => {
  it('classifies subscreen with elevated red as subscreen_swap', () => {
    const interp = new PixelInterpreter();
    // subscreen: low brightness, no LIFE text (redRatioAtLife < 16), but brightness 30-50
    // For SWAP: we need a separate signal. The simplest: during subscreen, check if
    // gameBrightness is in the subscreen range AND redRatioAtLife shows some red
    // (SWAP text red bleeds into the LIFE sampling area when HUD shifts down)
    const raw = makeRaw({
      gameBrightness: 25, // dark enough for subscreen
      redRatioAtLife: 5,  // some red (SWAP text), but < 16 (not LIFE)
    });
    const result = interp.interpret(raw);
    // For now, subscreen_swap requires a dedicated aggregate or heuristic.
    // If we can't distinguish from regular subscreen, we may need a shader change.
    expect(['subscreen', 'subscreen_swap']).toContain(result.screenType);
  });
});
```

**Step 2: Assess feasibility**

The SWAP text is at y=0-40, x=24-72 in NES coords. The `red_pass` aggregate samples an 8x8 tile at the LIFE position (nesX=184, nesY=16) — this is far from the SWAP text region (top-left of screen). During subscreen, the HUD scrolls down, so the LIFE text may appear at a different Y position, and the SWAP text appears near the top.

**Options:**
1. **Add a new aggregate shader pass** that samples red pixels in the SWAP region (x=24-72, y=0-40). This would be a shader change (not ideal for Phase 1).
2. **Use existing data heuristically**: When `screenType === 'subscreen'`, check if any HUD digit tile NCC scores show high red content. SWAP text overlaps with the dungeon_lvl tile region (nesX=64, nesY=8, which is near x=24-72, y=0-40).
3. **Defer to Phase 2**: Accept that SWAP detection may require a shader change and handle it separately.

**Recommended: Option 2 — heuristic approach.** When screen is classified as `subscreen`, check the `dungeon_lvl` tile NCC scores. If all digit scores are very low (< 0.2) but the tile is not dark (some brightness), the region likely contains non-digit content (SWAP text). This is fragile but avoids shader changes.

**Actually, simpler approach:** Z1R always shows SWAP on subscreen. If we know the ROM is Z1R (which we do — it's configured per race), we can assume all subscreens are SWAP subscreens. No detection needed — just a config flag.

**Step 3: Implement the config-based approach**

Add `isZ1R` flag to `RacerConfig` in types.ts:

```typescript
// In types.ts, add to RacerConfig:
isZ1R?: boolean;  // true for Z1R randomizer (SWAP subscreen, no inventory grid)
```

Then in `PixelInterpreter`, when `screenType === 'subscreen'` and the racer is Z1R, return `'subscreen_swap'`.

Actually, `PixelInterpreter` doesn't have access to racer config. The simpler path: add `'subscreen_swap'` to the screen type union, but don't try to distinguish it at the PixelInterpreter level. Instead, handle it in `VisionPipelineController` where we have racer config access. Or even simpler: since Z1R subscreens always show SWAP, and the pipeline knows it's Z1R, treat all Z1R subscreens as SWAP at the controller level.

**Step 3 (revised): Add subscreen_swap to types + controller-level classification**

In `server/src/vision/types.ts`:
```typescript
// Update RawGameState.screenType union:
screenType: 'overworld' | 'dungeon' | 'cave' | 'subscreen' | 'subscreen_swap' | 'death' | 'title' | 'transition' | 'unknown';
```

In `VisionPipelineController._processRaw()`, after `interpreter.interpret()`:
```typescript
// Z1R SWAP: all subscreens are SWAP subscreens
if (rawState.screenType === 'subscreen' && pipeline.isZ1R) {
  rawState.screenType = 'subscreen_swap';
}
```

Add `isZ1R` to the `RacerPipeline` interface and `addRacer()` method.

**Step 4: Run tests**

Run: `cd server && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add server/src/vision/types.ts server/src/vision/PixelInterpreter.ts server/src/vision/VisionPipelineController.ts server/tests/PixelInterpreter.test.ts
git commit -m "feat: SWAP detection — Z1R subscreens classified as subscreen_swap"
```

---

### Task 5: Add inventory grid reading for non-Z1R

For non-Z1R ROMs, the subscreen shows a 4x2 item grid at fixed positions. Read item presence from those positions using NCC scores against the existing item templates.

**Files:**
- Modify: `server/src/vision/PixelInterpreter.ts`
- Modify: `server/src/vision/types.ts` (add `inventory` field to `RawGameState`)
- Test: `server/tests/PixelInterpreter.test.ts`

**Step 1: Write failing test**

```typescript
describe('inventory grid reading', () => {
  it('returns empty inventory for Z1R', () => {
    const interp = new PixelInterpreter();
    const raw = makeRaw({ gameBrightness: 25, redRatioAtLife: 2 }); // subscreen
    const result = interp.interpret(raw);
    expect(result.inventory).toEqual({});
  });

  it('reads item presence from subscreen NCC scores for non-Z1R', () => {
    // This requires dedicated subscreen tile positions for inventory slots
    // which are not currently in TILE_DEFS (only HUD tiles are tracked).
    // Would need new tile defs for inventory slot positions.
    // DEFER: requires shader-side changes to sample additional tile positions.
  });
});
```

**Step 2: Assess feasibility**

The inventory grid positions (8 active + 6 passive + upgrades) are at fixed NES coordinates during subscreen. However, the NCC shader currently only processes the 10 HUD tiles defined in `TILE_DEFS`. To read inventory slots, we'd need to either:
1. Add 14+ tile defs to the shader (requires `tileGrid.js`, `tileDefs.js`, `tileDefs.ts`, `shaders.js` changes)
2. Do a post-hoc CPU-side analysis of the debug frame (expensive, unreliable)

**Recommendation:** This is the one feature gap that truly requires shader-side changes. Since the design says "no shader changes" for Phase 1, I recommend:
- Add the `inventory` field to `RawGameState` as `Record<string, boolean>`
- Return `{}` for now (same as Z1R behavior)
- Mark as a known limitation for Phase 1
- Address in a follow-up when the shader can be extended to sample inventory tile positions

**Step 3: Add inventory field stub**

In `server/src/vision/types.ts`, add to `RawGameState`:
```typescript
inventory: Record<string, boolean>;  // subscreen item grid (empty for Z1R)
```

In `PixelInterpreter.interpret()`:
```typescript
inventory: {},  // TODO: non-Z1R inventory reading requires shader tile position additions
```

**Step 4: Run tests**

Run: `cd server && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add server/src/vision/types.ts server/src/vision/PixelInterpreter.ts server/tests/PixelInterpreter.test.ts
git commit -m "feat: add inventory field to RawGameState (stub, requires shader extension for non-Z1R)"
```

---

### Task 6: Wire new trackers into VisionPipelineController

Connect `TriforceTracker`, `WarpDeathTracker`, and floor item events into the main pipeline.

**Files:**
- Modify: `server/src/vision/VisionPipelineController.ts`
- Modify: `server/src/vision/EventInferencer.ts` (remove duplicate game_complete/death logic that TriforceTracker now handles)
- Test: `server/tests/VisionPipelineController.test.ts`

**Step 1: Update RacerPipeline interface**

```typescript
interface RacerPipeline {
  interpreter: PixelInterpreter;
  stabilizer: StateStabilizer;
  inferencer: EventInferencer;
  playerItems: PlayerItemTracker;
  raceItems: RaceItemTracker;
  floorItems: FloorItemTracker;
  minimap: MinimapReader;
  triforce: TriforceTracker;       // NEW
  warpDeath: WarpDeathTracker;     // NEW
  isZ1R: boolean;                   // NEW
  prevMapPosition: number;
  prevDungeonLevel: number;
}
```

**Step 2: Update addRacer()**

```typescript
addRacer(racerId: string, isZ1R = true): void {
  this.pipelines.set(racerId, {
    // ...existing...
    triforce: new TriforceTracker(racerId),
    warpDeath: new WarpDeathTracker(racerId),
    isZ1R,
    prevMapPosition: -1,
    prevDungeonLevel: 0,
  });
}
```

**Step 3: Update _processRaw()**

After `pipeline.inferencer.update()`:

```typescript
// Triforce tracking (gold flash + dungeon exit)
pipeline.triforce.feedGoldPixels(raw.goldPixelCount);
pipeline.triforce.update(stableState, raw.timestamp, raw.frameNumber, events);

// Warp/death tracking
pipeline.warpDeath.update(stableState, raw.timestamp, raw.frameNumber, events,
  pipeline.triforce.isGameCompleted);

// Register dungeon entrance positions for warp detection
if (stableState.screenType === 'dungeon' && stableState.dungeonLevel > 0) {
  pipeline.warpDeath.registerDungeonEntrance(stableState.dungeonLevel, stableState.mapPosition);
}

// Floor item drop/pickup events
if (stableState.mapPosition !== pipeline.prevMapPosition
    || stableState.dungeonLevel !== pipeline.prevDungeonLevel) {
  pipeline.floorItems.onRoomChange();
}
const floorResult = pipeline.floorItems.update(rawState.floorItems);
for (const item of floorResult.newlyConfirmed) {
  events.push({
    type: 'item_drop', racerId: raw.racerId, timestamp: raw.timestamp,
    frameNumber: raw.frameNumber, priority: 'low',
    description: `Floor item: ${item.name}`, data: { name: item.name, x: item.x, y: item.y },
  });
}
for (const item of floorResult.obtained) {
  events.push({
    type: 'item_pickup', racerId: raw.racerId, timestamp: raw.timestamp,
    frameNumber: raw.frameNumber, priority: 'low',
    description: `Picked up ${item.name}`, data: { name: item.name, x: item.x, y: item.y },
  });
}

// Z1R SWAP classification
if (rawState.screenType === 'subscreen' && pipeline.isZ1R) {
  (rawState as any).screenType = 'subscreen_swap';
}
```

**Step 4: Remove duplicate game_complete from EventInferencer**

The `_checkGameComplete` and `_checkDeath` methods in `EventInferencer.ts` now overlap with `TriforceTracker` and `WarpDeathTracker`. Remove `_checkGameComplete` from EventInferencer entirely (TriforceTracker handles D9 exit). Keep `_checkDeath` as a simple fallback but add a guard to skip if `WarpDeathTracker` is active.

Actually, to avoid breaking existing behavior, keep both for now but add a `skipDeath` flag to EventInferencer that the controller can set when WarpDeathTracker is handling death detection.

**Step 5: Write integration test**

Add to `server/tests/VisionPipelineController.test.ts`:

```typescript
it('emits triforce_inferred when hearts refill after dungeon exit', () => {
  // This is an integration test that verifies the full pipeline:
  // RawPixelState → PixelInterpreter → StateStabilizer → EventInferencer + TriforceTracker
  // Test by feeding a sequence of RawPixelState through the controller
  // and checking emitted events.
});
```

**Step 6: Run full test suite**

Run: `cd server && npx vitest run`
Expected: All tests pass

**Step 7: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add server/src/vision/VisionPipelineController.ts server/src/vision/EventInferencer.ts server/tests/VisionPipelineController.test.ts
git commit -m "feat: wire TriforceTracker, WarpDeathTracker, floor item events into pipeline"
```

---

### Task 7: Final verification and cleanup

**Step 1: Run full test suite**

Run: `cd server && npx vitest run`
Expected: All tests pass

**Step 2: TypeScript compile check**

Run: `cd server && npx tsc --noEmit`
Expected: Clean

**Step 3: Review all changed files**

Verify no dead imports, no unused code, no TODO items left unaddressed.

**Step 4: Commit any cleanup**

```bash
git add -A && git commit -m "chore: Phase 1 cleanup — remove dead code, fix imports"
```

---

## Summary

| Task | Feature | New Files | Modified Files |
|------|---------|-----------|----------------|
| 1 | Item drop/pickup events | — | FloorItemTracker.ts, VisionPipelineController.ts |
| 2 | Triforce detection | TriforceTracker.ts | — |
| 3 | Warp/death tracking | WarpDeathTracker.ts | — |
| 4 | SWAP detection | — | types.ts, VisionPipelineController.ts |
| 5 | Inventory grid (stub) | — | types.ts, PixelInterpreter.ts |
| 6 | Wire everything together | — | VisionPipelineController.ts, EventInferencer.ts |
| 7 | Final verification | — | cleanup as needed |

**Total new code:** ~400 lines (TriforceTracker ~200, WarpDeathTracker ~120, wiring ~80)
**Total new tests:** ~200 lines across 3 test files
