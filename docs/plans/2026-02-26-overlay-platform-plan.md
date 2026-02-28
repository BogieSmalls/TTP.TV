# Overlay Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform TTP's overlay from a single hardcoded layout into a NestrisChamps-inspired platform with per-runner extended HUD, race-wide seed item tracker, triforce animations, multiple layouts, and a one-click race replay system.

**Architecture:** Server-side `SeedItemTracker` aggregates item discoveries across vision pipelines. Overlay reads `?layout=` query param to select renderer. `ReplayOrchestrator` fetches racetime.gg data, resolves Twitch VODs, and orchestrates synced replay playback via existing `StreamManager` + `VodRaceOrchestrator`.

**Tech Stack:** TypeScript (server + overlay), Vite (overlay build), Express + Socket.IO (server), Kysely (DB), CSS keyframes (animations), Twitch Helix API (VOD resolution)

**Design Doc:** `docs/plans/2026-02-26-overlay-platform-design.md`

**Suggested batch grouping:**
- Batch 1 (Phase A-1): Tasks 1-4 — SeedItemTracker service + wiring
- Batch 2 (Phase A-2): Tasks 5-7 — Overlay: extended HUD, seed footer, layout router
- Batch 3 (Phase A-3): Tasks 8-12 — Overlay polish: animations, signal-lost, map, race-end, leader
- Batch 4 (Phase B-1): Tasks 13-16 — ReplayOrchestrator service + DB + wiring
- Batch 5 (Phase B-2): Tasks 17-19 — Replay dashboard, standalone/clean layouts
- Batch 6 (Phase B-3): Tasks 20-21 — Chat highlights lower-third
- Batch 7 (Phase C): Tasks 22-24 — Timer tool, footer tool, backgrounds

---

## Phase A: Highest Impact

### Task 1: Create SeedItemTracker with tests

**Files:**
- Create: `server/src/race/SeedItemTracker.ts`
- Create: `server/tests/SeedItemTracker.test.ts`

**Context:** This service tracks race-wide item discoveries. When ANY runner finds one of the 15 tracked items, we record WHAT item and WHERE (L1-L9, C, W, A). This is race-level data, not per-runner.

**Step 1: Write the test file**

```typescript
// server/tests/SeedItemTracker.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SeedItemTracker, SEED_TRACKED_ITEMS } from '../src/race/SeedItemTracker.js';

describe('SeedItemTracker', () => {
  let tracker: SeedItemTracker;

  beforeEach(() => {
    tracker = new SeedItemTracker();
  });

  it('tracks 15 items', () => {
    expect(SEED_TRACKED_ITEMS).toHaveLength(15);
    expect(SEED_TRACKED_ITEMS).toContain('book');
    expect(SEED_TRACKED_ITEMS).toContain('coast_heart');
  });

  it('starts with all items undiscovered', () => {
    const state = tracker.getState();
    for (const item of SEED_TRACKED_ITEMS) {
      expect(state[item]).toBeNull();
    }
  });

  it('records a dungeon item discovery', () => {
    tracker.recordDiscovery('bow', '3');
    const state = tracker.getState();
    expect(state.bow).toBe('3');
  });

  it('records a special location discovery', () => {
    tracker.recordDiscovery('power_bracelet', 'W');
    expect(tracker.getState().power_bracelet).toBe('W');
  });

  it('does not overwrite existing discovery', () => {
    tracker.recordDiscovery('bow', '3');
    tracker.recordDiscovery('bow', '5');
    expect(tracker.getState().bow).toBe('3');
  });

  it('ignores non-tracked items', () => {
    tracker.recordDiscovery('blue_candle', '2');
    const state = tracker.getState();
    expect(state).not.toHaveProperty('blue_candle');
  });

  it('emits discovery event', () => {
    const handler = vi.fn();
    tracker.on('discovery', handler);
    tracker.recordDiscovery('raft', '7');
    expect(handler).toHaveBeenCalledWith({
      item: 'raft',
      location: '7',
      state: expect.objectContaining({ raft: '7' }),
    });
  });

  it('does not emit for duplicate discovery', () => {
    const handler = vi.fn();
    tracker.recordDiscovery('raft', '7');
    tracker.on('discovery', handler);
    tracker.recordDiscovery('raft', '7');
    expect(handler).not.toHaveBeenCalled();
  });

  it('clear resets all discoveries', () => {
    tracker.recordDiscovery('bow', '3');
    tracker.recordDiscovery('raft', '7');
    tracker.clear();
    const state = tracker.getState();
    expect(state.bow).toBeNull();
    expect(state.raft).toBeNull();
  });

  it('processVisionUpdate detects new item in dungeon', () => {
    const handler = vi.fn();
    tracker.on('discovery', handler);
    // First update: no items
    tracker.processVisionUpdate('racer1', { items: { bow: false }, dungeon_level: 3 });
    expect(handler).not.toHaveBeenCalled();
    // Second update: bow found while in L3
    tracker.processVisionUpdate('racer1', { items: { bow: true }, dungeon_level: 3 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ item: 'bow', location: '3' }));
  });

  it('processVisionUpdate ignores item found with dungeon_level 0', () => {
    const handler = vi.fn();
    tracker.on('discovery', handler);
    tracker.processVisionUpdate('racer1', { items: { bow: false }, dungeon_level: 0 });
    tracker.processVisionUpdate('racer1', { items: { bow: true }, dungeon_level: 0 });
    // dungeon_level 0 = overworld, no level to associate
    // C/W/A detection is TBD, so for now we skip overworld pickups
    expect(handler).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/SeedItemTracker.test.ts`
Expected: FAIL — module not found

**Step 3: Write the SeedItemTracker implementation**

```typescript
// server/src/race/SeedItemTracker.ts
import { EventEmitter } from 'node:events';

export const SEED_TRACKED_ITEMS = [
  'book', 'boomerang', 'bow', 'ladder', 'magical_boomerang',
  'magical_key', 'power_bracelet', 'raft', 'recorder',
  'red_candle', 'red_ring', 'silver_arrows', 'wand',
  'white_sword', 'coast_heart',
] as const;

export type SeedTrackedItem = typeof SEED_TRACKED_ITEMS[number];
export type ItemLocation = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'C'|'W'|'A';

const TRACKED_SET = new Set<string>(SEED_TRACKED_ITEMS);

interface SeedItemDiscovery {
  item: string;
  location: ItemLocation;
  timestamp: number;
}

export class SeedItemTracker extends EventEmitter {
  private discoveries = new Map<string, SeedItemDiscovery>();
  /** Track each racer's previous item states for edge detection */
  private prevItems = new Map<string, Map<string, boolean>>();

  recordDiscovery(item: string, location: string): void {
    if (!TRACKED_SET.has(item)) return;
    if (this.discoveries.has(item)) return;

    const discovery: SeedItemDiscovery = {
      item,
      location: location as ItemLocation,
      timestamp: Date.now(),
    };
    this.discoveries.set(item, discovery);
    this.emit('discovery', {
      item,
      location,
      state: this.getState(),
    });
  }

  /** Process a vision update to detect new item pickups in dungeons */
  processVisionUpdate(racerId: string, state: Record<string, unknown>): void {
    const items = state.items as Record<string, boolean> | undefined;
    const dungeonLevel = state.dungeon_level as number | undefined;
    if (!items) return;

    let prev = this.prevItems.get(racerId);
    if (!prev) {
      prev = new Map();
      this.prevItems.set(racerId, prev);
    }

    for (const [itemName, found] of Object.entries(items)) {
      if (!TRACKED_SET.has(itemName)) continue;
      const wasPrev = prev.get(itemName) ?? false;
      prev.set(itemName, found);

      // Edge detection: false → true
      if (found && !wasPrev) {
        if (dungeonLevel && dungeonLevel >= 1 && dungeonLevel <= 9) {
          this.recordDiscovery(itemName, String(dungeonLevel));
        }
        // C/W/A detection: TBD — will be added when rules are taught
      }
    }
  }

  getState(): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const item of SEED_TRACKED_ITEMS) {
      const d = this.discoveries.get(item);
      result[item] = d ? d.location : null;
    }
    return result;
  }

  clear(): void {
    this.discoveries.clear();
    this.prevItems.clear();
  }
}
```

**Step 4: Run tests**

Run: `cd server && npx vitest run tests/SeedItemTracker.test.ts`
Expected: All 11 tests PASS

**Step 5: Commit**

```
feat: add SeedItemTracker for race-wide item location tracking
```

---

### Task 2: Wire SeedItemTracker into server

**Files:**
- Modify: `server/src/index.ts` (import, instantiate, pass to routes, clear on race start)
- Modify: `server/src/api/routes.ts` (add to RouteContext, feed from vision POST handler, emit to overlay)

**Context:** The vision POST handler at `routes.ts:481` already feeds `SeedMapState` and `AutoFeatureEngine`. We add the same pattern for `SeedItemTracker` — call `processVisionUpdate()` on every vision update.

**Step 1: Update `server/src/index.ts`**

Add import (after line 30 `import { RaceHistoryService }`):
```typescript
import { SeedItemTracker } from './race/SeedItemTracker.js';
```

Add instantiation (after `const seedMapState = new SeedMapState();` block, ~line 136):
```typescript
// ─── Seed Item Tracker ───
const seedItemTracker = new SeedItemTracker();
seedItemTracker.on('discovery', (data) => {
  io.to('overlay').emit('seed:itemDiscovery', data);
});
```

Add `seedItemTracker` to the `createApiRoutes()` call (~line 327):
```typescript
seedItemTracker,
```

Add `seedItemTracker.clear()` to both `raceGoLive` handlers (alongside `seedMapState.clear()`, ~lines 179 and 262):
```typescript
seedItemTracker.clear();
```

**Step 2: Update `server/src/api/routes.ts`**

Add to `RouteContext` interface (~line 54):
```typescript
seedItemTracker: import('../race/SeedItemTracker.js').SeedItemTracker;
```

In the vision POST handler (`router.post('/vision/:racerId', ...)` at ~line 481), add after the autoFeature feeding block (~line 534):
```typescript
// Feed seed item tracker
ctx.seedItemTracker.processVisionUpdate(racerId, fullState as Record<string, unknown>);
```

**Step 3: Build and verify**

Run: `cd server && npm run build`
Expected: Clean build

Run: `cd server && npx vitest run`
Expected: All tests pass (including new SeedItemTracker tests)

**Step 4: Commit**

```
feat: wire SeedItemTracker into vision pipeline and socket events
```

---

### Task 3: Add seed tracker GET endpoint

**Files:**
- Modify: `server/src/api/routes.ts` (add GET `/vision/seed-items`)

**Step 1: Add endpoint** after the existing vision routes (~line 562):

```typescript
router.get('/vision/seed-items', (_req, res) => {
  res.json(ctx.seedItemTracker.getState());
});
```

**Step 2: Build and verify**

Run: `cd server && npm run build`

**Step 3: Commit**

```
feat: add GET /vision/seed-items endpoint
```

---

### Task 4: Redesign overlay bottom bar as extended HUD strip

**Files:**
- Modify: `overlay/src/main.ts` (replace `renderBottomBar` with per-runner extended HUD)
- Modify: `overlay/src/styles/overlay.css` (restyle item tracker as compact strip)

**Context:** The current bottom bar shows ALL 18 tracked items per racer. The design narrows this to 6 key items + 8 triforce pieces. The strip sits directly below each runner's panel area.

**Step 1: Update the item constants in `overlay/src/main.ts`**

Replace `TRACKED_ITEMS` (lines 35-39) with:
```typescript
// Per-runner HUD items (6 routing-critical + arrows type detection)
const HUD_ITEMS = ['bow', 'ladder', 'power_bracelet', 'raft', 'recorder'] as const;
// Arrows: show whichever type the runner has (silver > wood)
```

Keep `ITEM_SPRITE_FILES` as-is (it already has all the sprite mappings we need).

**Step 2: Replace `renderBottomBar()` with `renderExtendedHud()`**

Replace the function at lines 553-602:

```typescript
function renderExtendedHud(): void {
  const container = document.getElementById('bottom-bar');
  if (!container) return;
  container.innerHTML = '';

  const positions = getPanelPositions(state.racers.length || racerCount);

  for (let i = 0; i < (state.racers.length || racerCount); i++) {
    const racer = state.racers[i];
    const pos = positions[i];
    if (!pos || !racer) continue;

    const strip = document.createElement('div');
    strip.className = 'extended-hud-strip';
    strip.style.position = 'absolute';
    strip.style.left = `${pos.x}px`;
    strip.style.bottom = '0px';
    strip.style.width = `${pos.width}px`;

    // ── Item icons (6) ──
    const itemsRow = document.createElement('div');
    itemsRow.className = 'hud-items-row';

    for (const itemName of HUD_ITEMS) {
      const found = racer.items?.[itemName] === true;
      const slot = document.createElement('div');
      slot.className = `hud-item${found ? ' found' : ''}`;
      const spriteFile = ITEM_SPRITE_FILES[itemName];
      if (spriteFile) {
        const icon = document.createElement('div');
        icon.className = 'hud-item-icon';
        icon.style.backgroundImage = `url(/overlay/sprites/items/${spriteFile})`;
        slot.appendChild(icon);
      }
      itemsRow.appendChild(slot);
    }

    // Arrows: show silver_arrow if has silver, else arrow if has wood, else dim
    const hasSilver = racer.items?.['silver_arrows'] === true;
    const hasWood = racer.items?.['arrow'] === true;
    const arrowSlot = document.createElement('div');
    arrowSlot.className = `hud-item${(hasSilver || hasWood) ? ' found' : ''}`;
    const arrowSprite = hasSilver ? 'silver_arrow.png' : 'arrow.png';
    const arrowIcon = document.createElement('div');
    arrowIcon.className = 'hud-item-icon';
    arrowIcon.style.backgroundImage = `url(/overlay/sprites/items/${arrowSprite})`;
    arrowSlot.appendChild(arrowIcon);
    itemsRow.appendChild(arrowSlot);

    strip.appendChild(itemsRow);

    // ── Triforce pieces (L1-L8) ──
    const tfRow = document.createElement('div');
    tfRow.className = 'hud-triforce-row';
    const triforce = racer.triforce ?? Array(8).fill(false);

    for (let t = 0; t < 8; t++) {
      const piece = document.createElement('div');
      const collected = triforce[t];
      const stateKey = `${racer.racerId}:tf:${t}`;
      const prevCollected = previousTriforceStates.get(stateKey) ?? false;
      const justCollected = collected && !prevCollected;
      piece.className = `hud-tf-piece${collected ? ' collected' : ''}${justCollected ? ' just-collected' : ''}`;

      const label = document.createElement('span');
      label.className = 'hud-tf-label';
      label.textContent = `L${t + 1}`;
      piece.appendChild(label);

      tfRow.appendChild(piece);
      previousTriforceStates.set(stateKey, collected);
    }

    strip.appendChild(tfRow);
    container.appendChild(strip);
  }
}
```

Add the triforce state tracking (near line 73 where `previousItemStates` is):
```typescript
const previousTriforceStates = new Map<string, boolean>();
```

Update `render()` to call `renderExtendedHud()` instead of `renderBottomBar()`.

**Step 3: Add CSS for the extended HUD strip in `overlay/src/styles/overlay.css`**

Replace the `.item-tracker` / `.item-slot` / `.item-icon` CSS block (lines 330-393) with:

```css
/* ─── Extended HUD Strip (Per-Runner) ─── */

.extended-hud-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--panel-bg);
  border-top: 1px solid var(--panel-border);
  height: 28px;
}

.hud-items-row {
  display: flex;
  gap: 3px;
  align-items: center;
}

.hud-item {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.25;
  transition: opacity 0.3s;
}

.hud-item.found {
  opacity: 1;
}

.hud-item-icon {
  width: 16px;
  height: 16px;
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
  image-rendering: pixelated;
}

.hud-triforce-row {
  display: flex;
  gap: 2px;
  align-items: center;
  margin-left: 4px;
}

.hud-tf-piece {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0px;
}

.hud-tf-piece .hud-tf-label {
  font-family: var(--font-pixel);
  font-size: 6px;
  color: rgba(255, 255, 255, 0.2);
  line-height: 1;
}

.hud-tf-piece.collected .hud-tf-label {
  color: var(--gold);
}

.hud-tf-piece::before {
  content: '';
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-bottom: 10px solid rgba(255, 255, 255, 0.08);
  transition: border-bottom-color 0.3s;
}

.hud-tf-piece.collected::before {
  border-bottom-color: var(--gold);
  filter: drop-shadow(0 0 3px rgba(212, 175, 55, 0.4));
}

.hud-tf-piece.just-collected::before {
  animation: piece-pop 0.8s ease-out;
}

@keyframes piece-pop {
  0% { transform: scale(0.5); filter: drop-shadow(0 0 12px rgba(212, 175, 55, 1)); }
  40% { transform: scale(1.4); }
  100% { transform: scale(1); filter: drop-shadow(0 0 3px rgba(212, 175, 55, 0.4)); }
}
```

**Step 4: Build overlay**

Run: `cd overlay && npm run build`
Expected: Clean build

**Step 5: Commit**

```
feat: replace bottom bar with per-runner extended HUD strip (6 items + L1-L8 triforce)
```

---

### Task 5: Add seed tracker footer bar to overlay

**Files:**
- Modify: `overlay/src/main.ts` (add socket listener, render function, sprite mappings)
- Modify: `overlay/src/styles/overlay.css` (footer styling)
- Modify: `overlay/src/index.html` (add `#seed-tracker` container)

**Context:** The server now emits `seed:itemDiscovery` events. The overlay needs a footer bar showing 15 items with location codes when discovered.

**Step 1: Add container to `overlay/src/index.html`**

After `<div id="bottom-bar"></div>` (~line 40):
```html
<!-- Seed Item Tracker (race-wide footer) -->
<div id="seed-tracker"></div>
```

**Step 2: Add constants and state to `overlay/src/main.ts`**

```typescript
// Seed-tracked items (race-wide) — order = routing importance
const SEED_ITEMS = [
  'bow', 'ladder', 'raft', 'recorder', 'power_bracelet',
  'red_candle', 'book', 'magical_key', 'red_ring', 'wand',
  'silver_arrows', 'magical_boomerang', 'boomerang', 'white_sword', 'coast_heart',
];

const SEED_ITEM_SPRITES: Record<string, string> = {
  bow: 'bow.png', ladder: 'stepladder.png', raft: 'raft.png',
  recorder: 'recorder.png', power_bracelet: 'power_bracelet.png',
  red_candle: 'red_candle.png', book: 'book_of_magic.png',
  magical_key: 'magical_key.png', red_ring: 'red_ring.png',
  wand: 'wand.png', silver_arrows: 'silver_arrow.png',
  magical_boomerang: 'magical_boomerang.png', boomerang: 'boomerang.png',
  white_sword: 'white_sword.png', coast_heart: 'heart_container.png',
};

let seedItemState: Record<string, string | null> = {};
for (const item of SEED_ITEMS) seedItemState[item] = null;
```

**Step 3: Add socket listener**

```typescript
socket.on('seed:itemDiscovery', (data: { item: string; location: string; state: Record<string, string | null> }) => {
  seedItemState = data.state;
  renderSeedTracker();
});
```

**Step 4: Add render function**

```typescript
function renderSeedTracker(): void {
  const container = document.getElementById('seed-tracker');
  if (!container) return;

  // Hide if query param says no
  if (params.get('seed_tracker') === '0') {
    container.classList.remove('visible');
    return;
  }

  const hasAny = Object.values(seedItemState).some(v => v !== null);
  if (!hasAny) {
    container.classList.remove('visible');
    return;
  }
  container.classList.add('visible');
  container.innerHTML = '';

  for (const item of SEED_ITEMS) {
    const location = seedItemState[item];
    const entry = document.createElement('div');
    entry.className = `seed-entry${location ? ' found' : ''}`;

    const icon = document.createElement('div');
    icon.className = 'seed-icon';
    const sprite = SEED_ITEM_SPRITES[item];
    if (sprite) {
      icon.style.backgroundImage = `url(/overlay/sprites/items/${sprite})`;
    }
    entry.appendChild(icon);

    if (location) {
      const code = document.createElement('span');
      code.className = 'seed-location';
      code.textContent = location;
      entry.appendChild(code);
    }

    container.appendChild(entry);
  }
}
```

Add `renderSeedTracker()` call to `render()`.

**Step 5: Add CSS**

```css
/* ─── Seed Tracker Footer ─── */

#seed-tracker {
  position: absolute;
  bottom: 28px;  /* above extended HUD strip */
  left: 0;
  right: 0;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(10, 10, 18, 0.85);
  border-top: 1px solid rgba(212, 175, 55, 0.2);
  z-index: 8;
  opacity: 0;
  transition: opacity 0.5s;
}

#seed-tracker.visible {
  opacity: 1;
}

.seed-entry {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0.2;
  transition: opacity 0.3s;
}

.seed-entry.found {
  opacity: 1;
}

.seed-icon {
  width: 16px;
  height: 16px;
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
  image-rendering: pixelated;
}

.seed-location {
  font-family: var(--font-pixel);
  font-size: 9px;
  color: var(--gold);
  line-height: 1;
}
```

**Step 6: Build and verify**

Run: `cd overlay && npm run build`

**Step 7: Commit**

```
feat: add race-wide seed item tracker footer to overlay
```

---

### Task 6: Check for missing sprites

**Files:** Check `vision/templates/items/` for all needed sprites

**Context:** The seed tracker needs sprites for `white_sword` and `coast_heart` (heart_container). Check if they exist.

**Step 1:** Run `ls vision/templates/items/` and check for: white_sword.png, heart_container.png

If missing, we need to create them (8x16 NES sprites). For now, use placeholder names and note them as TODO.

**Step 2: Commit** (if any sprite additions needed)

---

### Task 7: Add overlay layout query-string router

**Files:**
- Modify: `overlay/src/main.ts` (add layout parameter parsing, conditional rendering)

**Context:** Read `?layout=` from URL. For now, only implement `race` (default) and `clean`. The existing code IS the `race` layout. `Clean` hides seed tracker, map, triforce bar — just timer + player names + placements.

**Step 1: Add layout parsing** near the top of `main.ts` (after `const racerCount`):

```typescript
type LayoutType = 'race' | 'featured' | 'standalone' | 'clean' | 'replay';
const layout = (params.get('layout') ?? 'race') as LayoutType;
const showSeedTracker = params.get('seed_tracker') !== '0' && layout !== 'clean';
const showMap = params.get('map') !== '0' && layout !== 'clean';
const showTriforceBar = params.get('triforce_bar') !== '0' && layout !== 'clean';
```

**Step 2: Use flags in render functions**

In `renderTriforceRaceBar()`, add early return: `if (!showTriforceBar) return;`
In `renderSharedMap()`, add early return: `if (!showMap) return;`
In `renderSeedTracker()`, use `showSeedTracker` instead of the param check.

**Step 3: Build and verify**

Run: `cd overlay && npm run build`

**Step 4: Commit**

```
feat: add layout query-string router for overlay (?layout=race|clean)
```

---

### Task 8: Triforce piece collection animation in race bar

**Files:**
- Modify: `overlay/src/main.ts` (track previous triforce state in `renderTriforceRaceBar`)
- Modify: `overlay/src/styles/overlay.css` (add `.just-collected` to `.tf-piece`)

**Context:** The extended HUD strip (Task 4) already has triforce animations. Now add the same pattern to the triforce race bar (top-right panel showing all racers' triforce progress).

**Step 1: Add triforce tracking to `renderTriforceRaceBar()`**

In the piece rendering loop, compare current vs previous state:
```typescript
const stateKey = `tf-bar:${racer.racerId}:${t}`;
const prevCollected = previousTriforceStates.get(stateKey) ?? false;
const justCollected = triforce[t] && !prevCollected;
piece.className = `tf-piece${triforce[t] ? ' collected' : ''}${justCollected ? ' just-collected' : ''}`;
previousTriforceStates.set(stateKey, triforce[t]);
```

**Step 2: Add CSS**

```css
.tf-piece.just-collected {
  animation: piece-pop 0.8s ease-out;
}
```

(The `piece-pop` keyframe is already defined from Task 4.)

**Step 3: Build and verify**

Run: `cd overlay && npm run build`

**Step 4: Commit**

```
feat: add triforce piece collection animation to race bar
```

---

### Task 9: Signal-lost debounce + recovery

**Files:**
- Modify: `overlay/src/main.ts` (replace instant badge with debounced version)
- Modify: `overlay/src/styles/overlay.css` (add fade-in, recovery style)

**Context:** Current signal-lost badge appears instantly on disconnect. WiFi blips cause distracting flashes. Add 3s debounce and "BACK ONLINE" recovery.

**Step 1: Replace the `stream:stateChange` handler** (lines 331-347 of main.ts)

```typescript
const signalLostTimers = new Map<string, ReturnType<typeof setTimeout>>();

socket.on('stream:stateChange', (data: { racerId: string; state: string }) => {
  const panels = document.querySelectorAll('.player-panel');
  const slotIndex = state.racers.findIndex(r => r.racerId === data.racerId);
  if (slotIndex < 0 || slotIndex >= panels.length) return;
  const panel = panels[slotIndex];
  const existing = panel.querySelector('.signal-lost-badge');

  if (data.state === 'disconnected' || data.state === 'error') {
    // Clear any pending recovery
    const existingTimer = signalLostTimers.get(data.racerId);
    if (existingTimer) clearTimeout(existingTimer);

    // Debounce: only show after 3s still disconnected
    if (!existing) {
      const timer = setTimeout(() => {
        const badge = document.createElement('div');
        badge.className = 'signal-lost-badge signal-fade-in';
        badge.textContent = 'SIGNAL LOST';
        panel.appendChild(badge);
        signalLostTimers.delete(data.racerId);
      }, 3000);
      signalLostTimers.set(data.racerId, timer);
    }
  } else {
    // Cancel pending show
    const pendingTimer = signalLostTimers.get(data.racerId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      signalLostTimers.delete(data.racerId);
    }
    // Show recovery if badge was visible
    if (existing) {
      existing.textContent = 'BACK ONLINE';
      existing.className = 'signal-lost-badge signal-recovery';
      setTimeout(() => existing.remove(), 2000);
    }
  }
});
```

**Step 2: Add CSS**

```css
.signal-lost-badge.signal-fade-in {
  animation: signal-appear 0.4s ease-out, signal-blink 1.5s ease-in-out 0.4s infinite;
}

@keyframes signal-appear {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

.signal-lost-badge.signal-recovery {
  color: var(--triforce-green);
  border-color: rgba(64, 192, 64, 0.4);
  animation: none;
  opacity: 1;
}
```

**Step 3: Build and verify**

Run: `cd overlay && npm run build`

**Step 4: Commit**

```
feat: add 3s signal-lost debounce and BACK ONLINE recovery
```

---

### Task 10: Map improvements (cell size, dot collision, L notation)

**Files:**
- Modify: `overlay/src/main.ts` (map rendering improvements)
- Modify: `overlay/src/styles/overlay.css` (cell size increase)

**Step 1: Update `renderSharedMap()` — dot collision handling**

In the racer dot rendering section, offset dots when multiple racers share a cell:

```typescript
// After filtering racersHere:
const dotOffsets = racersHere.length === 2
  ? [{ x: -3, y: 0 }, { x: 3, y: 0 }]
  : racersHere.length === 3
  ? [{ x: -3, y: -2 }, { x: 3, y: -2 }, { x: 0, y: 3 }]
  : racersHere.map((_, idx) => ({ x: 0, y: 0 })); // 1 or 4+ centered

for (let di = 0; di < racersHere.length; di++) {
  const rp = racersHere[di];
  const dot = document.createElement('div');
  dot.className = 'map-racer-dot';
  const slotIndex = state.racers.findIndex(sr => sr.racerId === rp.racerId);
  dot.style.backgroundColor = RACER_COLORS[slotIndex] ?? RACER_COLORS[0];
  if (dotOffsets[di]) {
    dot.style.transform = `translate(${dotOffsets[di].x}px, ${dotOffsets[di].y}px)`;
  }
  cell.appendChild(dot);
}
```

**Step 2: Change dungeon labels from "D" to "L"**

In `SeedMapState.ts` `addDungeonMarker()` — the label is set by the caller. Check `routes.ts` line ~520:
The marker label is set in `SeedMapState.addDungeonMarker()`. Read the SeedMapState source to verify the label format. If it uses "D", change to "L" (e.g., `L${dungeonLevel}`).

**Step 3: Update CSS — cell size 12→14px, dot size 6→8px**

```css
.map-grid {
  grid-template-columns: repeat(16, 14px);
  grid-template-rows: repeat(8, 14px);
}

.map-cell {
  width: 14px;
  height: 14px;
}

.map-racer-dot {
  width: 8px;
  height: 8px;
}
```

**Step 4: Build and verify**

Run: `cd server && npm run build && cd ../overlay && npm run build`

**Step 5: Commit**

```
feat: improve shared map — 14px cells, dot collision offsets, L notation
```

---

### Task 11: Race-end cleanup

**Files:**
- Modify: `overlay/src/main.ts` (add cleanup on race end)

**Step 1: Add race-end detection and cleanup**

Watch for `overlay:state` with `raceActive === false` and clean up:

```typescript
// In the overlay:state handler, after Object.assign:
if (!data.raceActive && state.raceActive) {
  // Race just ended
  onRaceEnd();
}
Object.assign(state, data);
render();

// New function:
function onRaceEnd(): void {
  // Fade out triforce race bar
  const tfBar = document.getElementById('triforce-race-bar');
  if (tfBar) {
    setTimeout(() => tfBar.classList.remove('visible'), 2000);
  }

  // Remove all signal-lost badges
  document.querySelectorAll('.signal-lost-badge').forEach(el => el.remove());
  for (const [, timer] of signalLostTimers) clearTimeout(timer);
  signalLostTimers.clear();

  // Fade out shared map after delay
  setTimeout(() => {
    const map = document.getElementById('shared-map');
    if (map) map.classList.remove('visible');
  }, 10000);

  // Clear animation tracking
  previousTriforceStates.clear();
}
```

**Step 2: Build and verify**

Run: `cd overlay && npm run build`

**Step 3: Commit**

```
feat: add race-end cleanup for triforce bar, map, and signal badges
```

---

### Task 12: Triforce leader highlight

**Files:**
- Modify: `overlay/src/main.ts` (add leader detection in `renderTriforceRaceBar`)
- Modify: `overlay/src/styles/overlay.css` (`.tf-leader` class)

**Step 1: Update `renderTriforceRaceBar()`**

After building all rows, find the leader and add class:

```typescript
// After the row-building loop, find leader(s):
let maxPieces = 0;
const pieceCounts: number[] = [];
for (const racer of state.racers) {
  const count = (racer.triforce ?? []).filter(Boolean).length;
  pieceCounts.push(count);
  if (count > maxPieces) maxPieces = count;
}

if (maxPieces > 0) {
  const rows = container.querySelectorAll('.tf-racer-row');
  for (let i = 0; i < rows.length; i++) {
    if (pieceCounts[i] === maxPieces) {
      rows[i].classList.add('tf-leader');
    }
  }
}
```

**Step 2: Add CSS**

```css
.tf-racer-row.tf-leader {
  border-left: 2px solid var(--gold);
  padding-left: 4px;
  background: rgba(212, 175, 55, 0.05);
  border-radius: 2px;
}
```

**Step 3: Build and verify**

Run: `cd overlay && npm run build`

**Step 4: Commit**

```
feat: highlight triforce race leader with gold accent
```

---

## Phase B: Platform Features

### Task 13: Create race_replays DB table

**Files:**
- Modify: `server/src/db/database.ts` (add interface + migration)

**Step 1: Add table interface and migration**

Add to Database interface:
```typescript
race_replays: RaceReplayTable;
```

Add interface:
```typescript
export interface RaceReplayTable {
  id: string;
  racetime_url: string;
  race_start: Date;
  race_end: Date | null;
  goal: string | null;
  seed: string | null;
  entrants: string; // JSON array
  created_at: Date;
}
```

Add migration in `runMigrations()`:
```sql
CREATE TABLE IF NOT EXISTS race_replays (
  id VARCHAR(36) PRIMARY KEY,
  racetime_url VARCHAR(255) NOT NULL,
  race_start DATETIME NOT NULL,
  race_end DATETIME,
  goal TEXT,
  seed TEXT,
  entrants JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_replays_url (racetime_url)
)
```

**Step 2: Build and verify**

Run: `cd server && npm run build`

**Step 3: Commit**

```
feat: add race_replays DB table for replay orchestration
```

---

### Task 14: Create ReplayOrchestrator service

**Files:**
- Create: `server/src/race/ReplayOrchestrator.ts`
- Create: `server/tests/ReplayOrchestrator.test.ts`

**Context:** This service coordinates: (1) fetch race data from racetime.gg, (2) resolve each entrant's Twitch VOD, (3) compute time offsets, (4) store for replay. The actual playback uses existing VodRaceOrchestrator.

**Step 1: Write tests** for the pure-logic parts (offset computation, entrant resolution)

```typescript
import { describe, it, expect } from 'vitest';
import { computeVodOffset, parseRacetimeSlug } from '../src/race/ReplayOrchestrator.js';

describe('ReplayOrchestrator helpers', () => {
  it('parses racetime slug from URL', () => {
    expect(parseRacetimeSlug('https://racetime.gg/z1r/mysterious-vire-2312'))
      .toBe('z1r/mysterious-vire-2312');
  });

  it('computes VOD offset in seconds', () => {
    const raceStart = new Date('2026-02-20T18:00:00Z');
    const vodCreated = new Date('2026-02-20T17:30:00Z');
    // Race starts 30 min into the VOD
    expect(computeVodOffset(raceStart, vodCreated)).toBe(1800);
  });

  it('handles negative offset (VOD started after race)', () => {
    const raceStart = new Date('2026-02-20T18:00:00Z');
    const vodCreated = new Date('2026-02-20T18:05:00Z');
    expect(computeVodOffset(raceStart, vodCreated)).toBe(-300);
  });
});
```

**Step 2: Write the service**

```typescript
// server/src/race/ReplayOrchestrator.ts
import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { RacetimeApi } from './RacetimeApi.js';
import type { TwitchApiClient } from '../twitch/TwitchApiClient.js';
import { logger } from '../logger.js';

export function parseRacetimeSlug(url: string): string {
  const match = url.match(/racetime\.gg\/(.+?)(?:\?|$)/);
  return match?.[1] ?? url;
}

export function computeVodOffset(raceStart: Date, vodCreated: Date): number {
  return Math.round((raceStart.getTime() - vodCreated.getTime()) / 1000);
}

export interface ReplayEntrant {
  racetimeId: string;
  displayName: string;
  twitchChannel: string | null;
  vodUrl: string | null;
  vodOffsetSeconds: number;
  finishTime: string | null;
  place: number | null;
}

export interface ReplayData {
  id: string;
  racetimeUrl: string;
  raceStart: Date;
  raceEnd: Date | null;
  goal: string | null;
  seed: string | null;
  entrants: ReplayEntrant[];
}

export class ReplayOrchestrator extends EventEmitter {
  constructor(
    private racetimeApi: RacetimeApi,
    private twitchApi: TwitchApiClient,
    private db: Kysely<Database>,
  ) {
    super();
  }

  async resolveRace(racetimeUrl: string): Promise<ReplayData> {
    const slug = parseRacetimeSlug(racetimeUrl);
    const raceDetail = await this.racetimeApi.getRaceDetail(slug);

    const raceStart = new Date(raceDetail.started_at);
    const raceEnd = raceDetail.ended_at ? new Date(raceDetail.ended_at) : null;

    const entrants: ReplayEntrant[] = [];

    for (const ent of raceDetail.entrants) {
      const twitchChannel = ent.user.twitch_name ?? null;
      let vodUrl: string | null = null;
      let vodOffsetSeconds = 0;

      if (twitchChannel && this.twitchApi.isConfigured()) {
        try {
          const videos = await this.twitchApi.getVideosForUser(
            ent.user.twitch_id ?? '',
            20,
          );
          // Find VOD that overlaps with race start
          for (const v of videos) {
            const vodStart = new Date(v.created_at);
            const offset = computeVodOffset(raceStart, vodStart);
            if (offset >= 0) {
              vodUrl = v.url;
              vodOffsetSeconds = offset;
              break;
            }
          }
        } catch (err) {
          logger.warn(`[Replay] Failed to resolve VOD for ${twitchChannel}`, { err });
        }
      }

      entrants.push({
        racetimeId: ent.user.id,
        displayName: ent.user.name,
        twitchChannel,
        vodUrl,
        vodOffsetSeconds,
        finishTime: ent.finish_time ?? null,
        place: ent.place ?? null,
      });
    }

    const replay: ReplayData = {
      id: uuid(),
      racetimeUrl,
      raceStart,
      raceEnd,
      goal: raceDetail.goal?.name ?? null,
      seed: raceDetail.info ?? null,
      entrants,
    };

    // Persist
    await this.db.insertInto('race_replays').values({
      id: replay.id,
      racetime_url: racetimeUrl,
      race_start: raceStart,
      race_end: raceEnd,
      goal: replay.goal,
      seed: replay.seed,
      entrants: JSON.stringify(entrants),
    } as any).execute();

    return replay;
  }

  async getReplay(id: string): Promise<ReplayData | null> {
    const row = await this.db.selectFrom('race_replays')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      racetimeUrl: row.racetime_url,
      raceStart: new Date(row.race_start),
      raceEnd: row.race_end ? new Date(row.race_end) : null,
      goal: row.goal,
      seed: row.seed,
      entrants: JSON.parse(row.entrants as string),
    };
  }

  async listReplays(): Promise<Array<{ id: string; racetimeUrl: string; raceStart: Date; goal: string | null }>> {
    const rows = await this.db.selectFrom('race_replays')
      .select(['id', 'racetime_url', 'race_start', 'goal'])
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();

    return rows.map(r => ({
      id: r.id,
      racetimeUrl: r.racetime_url,
      raceStart: new Date(r.race_start),
      goal: r.goal,
    }));
  }
}
```

**Step 3: Run tests**

Run: `cd server && npx vitest run tests/ReplayOrchestrator.test.ts`

**Step 4: Build**

Run: `cd server && npm run build`

**Step 5: Commit**

```
feat: add ReplayOrchestrator for racetime.gg → VOD replay pipeline
```

---

### Task 15: Wire ReplayOrchestrator into server + add API routes

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/api/routes.ts`

**Step 1:** Import, instantiate `ReplayOrchestrator` in index.ts, pass to routes.

**Step 2:** Add API endpoints:
- `POST /api/replay/resolve` — takes `{ racetimeUrl }`, returns `ReplayData`
- `GET /api/replay/list` — returns recent replays
- `GET /api/replay/:id` — returns specific replay data
- `POST /api/replay/:id/start` — triggers VodRaceOrchestrator with resolved data

**Step 3: Build and run tests**

**Step 4: Commit**

```
feat: wire ReplayOrchestrator into server with API endpoints
```

---

### Task 16: ReplaySetup dashboard page

**Files:**
- Create: `dashboard/src/pages/ReplaySetup.tsx`
- Modify: `dashboard/src/lib/api.ts` (add replay API functions)
- Modify: `dashboard/src/App.tsx` (add route)
- Modify: `dashboard/src/components/Sidebar.tsx` (add link with `RotateCcw` icon)

**Step 1:** Add API functions: `resolveReplay(url)`, `listReplays()`, `startReplay(id)`

**Step 2:** Create ReplaySetup page with:
- URL input + "Resolve" button
- Preview card showing race details + entrants + VODs + offsets
- "Go Live" button that starts the replay
- Recent replays list for quick re-replay

**Step 3: Build dashboard**

**Step 4: Commit**

```
feat: add ReplaySetup dashboard page for one-click race replay
```

---

### Task 17: Standalone overlay layout

**Files:**
- Modify: `overlay/src/main.ts` (add standalone rendering path)
- Modify: `overlay/src/styles/overlay.css` (standalone-specific styles)

**Context:** `?layout=standalone` shows a single player with full stats. Large game feed, extended HUD strip, full triforce display. Used for qualifiers or solo streams.

**Step 1:** In the layout router, when `layout === 'standalone'`:
- Render only racer 0 at full width
- Show extended HUD strip at full width
- Show triforce bar (per-racer, not race-bar)
- Hide shared map, seed tracker (single player = no race-wide data)

**Step 2: Build and verify**

**Step 3: Commit**

```
feat: add standalone overlay layout for qualifiers
```

---

### Task 18: Clean overlay layout

**Files:**
- Modify: `overlay/src/main.ts` (clean layout rendering)

**Context:** `?layout=clean` shows minimal info — timer + player names + placements. Maximum game area. Already partially implemented in Task 7 (query flags hide map/triforce/seed).

**Step 1:** In clean layout: also hide player panels' hearts, HUD counters, sword, B-item indicators. Just show name + finish status.

**Step 2: Build and verify**

**Step 3: Commit**

```
feat: add clean overlay layout (minimal info, max game area)
```

---

### Task 19: Replay overlay layout

**Files:**
- Modify: `overlay/src/main.ts` (replay indicator)
- Modify: `overlay/src/styles/overlay.css`

**Context:** `?layout=replay` is the race layout + a "REPLAY" badge and original timestamp display.

**Step 1:** Add a `#replay-indicator` div showing "REPLAY" badge (top-left, semi-transparent).

**Step 2:** Display original race timestamp alongside the timer.

**Step 3: Build and verify**

**Step 4: Commit**

```
feat: add replay overlay layout with REPLAY badge
```

---

### Task 20: Chat highlights lower-third

**Files:**
- Modify: `overlay/src/main.ts` (chat highlight socket listener + render)
- Modify: `overlay/src/styles/overlay.css` (lower-third styling + slide animation)
- Modify: `overlay/src/index.html` (add `#chat-highlight` container)
- Modify: `server/src/api/routes.ts` (add `POST /api/commentary/feature-chat` endpoint)

**Context:** Surface notable Twitch chat messages as a brief lower-third banner. Slides in from left, holds 6s, slides out.

**Step 1:** Add `#chat-highlight` container to HTML.

**Step 2:** Add socket listener for `chat:highlight` event:
```typescript
socket.on('chat:highlight', (data: { username: string; message: string }) => {
  showChatHighlight(data.username, data.message);
});
```

**Step 3:** Implement `showChatHighlight()` with queue (max 1 at a time).

**Step 4:** Add CSS with slide-in/slide-out keyframe animations.

**Step 5:** Add API endpoint so operator can manually feature a chat message from dashboard.

**Step 6: Build**

**Step 7: Commit**

```
feat: add chat highlights lower-third overlay
```

---

## Phase C: Polish & Tools

### Task 21: Chat highlight dashboard controls

**Files:**
- Modify: `dashboard/src/pages/Commentary.tsx` (add chat highlight button)

**Step 1:** Add a "Feature in Overlay" button next to chat messages in the Commentary page.

**Step 2: Build and verify**

**Step 3: Commit**

---

### Task 22: Standalone timer tool

**Files:**
- Create: `overlay/src/timer.html`
- Create: `overlay/src/timer.ts`

**Context:** Standalone browser source at `/overlay/timer.html?minutes=120&type=up&color=D4AF37&bg=000000`. Dimensions 268x44.

**Step 1:** Create minimal HTML + TS that reads query params and renders a timer.

**Step 2: Build and verify**

**Step 3: Commit**

```
feat: add standalone timer browser source tool
```

---

### Task 23: Event footer tool

**Files:**
- Create: `overlay/src/footer.html`
- Create: `overlay/src/footer.ts`

**Context:** Cycling info bar at `/overlay/footer.html?event=TTP+Winter+2026&round=Swiss+R3&cycle=10`. Dimensions 1920x32.

**Step 1:** Create HTML + TS that cycles through info slides with crossfade.

**Step 2: Build and verify**

**Step 3: Commit**

```
feat: add event footer cycling info bar tool
```

---

### Task 24: Background options

**Files:**
- Modify: `overlay/src/main.ts` (apply background based on `?bg=` param)
- Modify: `overlay/src/styles/overlay.css` (background styles)

**Context:** `?bg=transparent` (default), `dark`, `tiles`, `gradient`.

**Step 1:** Read `?bg=` param, apply CSS class to `#overlay`:
- `.bg-dark`: solid #0a0a12
- `.bg-tiles`: subtle NES geometric tile pattern at 5% opacity (CSS pattern)
- `.bg-gradient`: radial gradient vignette

**Step 2: Build and verify**

**Step 3: Commit**

```
feat: add selectable background options via ?bg= query param
```

---

## Verification

### Automated
```bash
# Server tests (SeedItemTracker + ReplayOrchestrator + existing)
cd server && npx vitest run

# Server build
cd server && npm run build

# Overlay build
cd overlay && npm run build

# Dashboard build
cd dashboard && npm run build
```

### Manual Integration Tests
1. Start VOD race → verify per-runner extended HUD shows 6 items + L1-L8 triforce
2. Racer finds bow in L3 → verify seed tracker footer shows Bow with "3"
3. Triforce piece collected → verify pop animation in both HUD strip and race bar
4. Kill a stream → verify signal-lost appears after 3s, "BACK ONLINE" on reconnect
5. Two racers on same map cell → verify dots offset side-by-side
6. Race ends → verify triforce bar fades, map fades after 10s, badges removed
7. Open `?layout=clean` → verify minimal overlay (no map, no seed tracker, no triforce bar)
8. Paste racetime URL on Replay page → verify entrants + VODs resolved
9. Start replay → verify synced playback with timer aligned to original race start
10. Feature a chat message → verify lower-third slides in and out
11. Open `/overlay/timer.html?minutes=5&type=down` → verify countdown timer
12. Open `/overlay/footer.html?event=Test` → verify cycling text
