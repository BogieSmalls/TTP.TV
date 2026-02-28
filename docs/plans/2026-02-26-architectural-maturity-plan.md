# Architectural Maturity By Layer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close every remaining gap across viewer experience, broadcast intelligence, cross-system integration, operator reliability, and training pipeline — taking the TTP Restream system from functional to broadcast-quality.

**Architecture:** Seven phases executed sequentially. Each phase is self-contained: it builds, tests, and deploys independently. Viewer experience phases come first (most visible impact), followed by broadcast intelligence, cross-system wiring, operator tools, and training pipeline.

**Tech Stack:** TypeScript (server, overlay, dashboard), CSS, HTML, Python (vision), Vitest (server tests)

---

## Phase 1: Overlay Item Icons

### Task 1: Serve item sprite assets from server

**Files:** Modify `server/src/index.ts`

Add static route for vision template items alongside the existing static routes:

```typescript
// After the existing "Serve crop profile screenshots" line (~line 238)
const itemSpritesPath = resolve(import.meta.dirname, '../../vision/templates/items');
app.use('/overlay/sprites/items', express.static(itemSpritesPath));
```

**Verify:** `cd server && npm run build`
**Deploy:** `cd server && npm run build` + `nssm restart TTP.TV`

### Task 2: Map item names to sprite filenames

**Files:** Modify `overlay/src/main.ts`

The TRACKED_ITEMS array uses names like `boomerang`, `magic_boomerang`, etc. The sprite files in `vision/templates/items/` use names like `boomerang.png`, `magical_boomerang.png`. Add a mapping between them. The sprites are 128x16 PNG (multi-frame animation strips) — we only need the first 8x16 frame.

Replace the `ITEM_LABELS` constant and add a sprite mapping:

```typescript
const ITEM_SPRITE_FILES: Record<string, string> = {
  boomerang: 'boomerang.png',
  magic_boomerang: 'magical_boomerang.png',
  bow: 'bow.png',
  blue_candle: 'blue_candle.png',
  red_candle: 'red_candle.png',
  recorder: 'recorder.png',
  food: 'bait.png',
  letter: 'letter.png',
  blue_potion: 'potion_blue.png',
  red_potion: 'potion_red.png',
  magic_rod: 'wand.png',
  raft: 'raft.png',
  book: 'book_of_magic.png',
  blue_ring: 'blue_ring.png',
  red_ring: 'red_ring.png',
  ladder: 'stepladder.png',
  magic_key: 'magical_key.png',
  power_bracelet: 'power_bracelet.png',
};
```

### Task 3: Render sprite icons in item tracker

**Files:** Modify `overlay/src/main.ts` (renderBottomBar), `overlay/src/styles/overlay.css`

In `renderBottomBar()`, replace the text label span with a canvas-clipped sprite image. The sprites are 128x16 animation strips — we only need the leftmost 8x16 pixels, displayed at 2x (16x32 in the slot).

Replace the label creation inside `renderBottomBar()`:

```typescript
// Replace the existing label creation:
//   const label = document.createElement('span');
//   label.className = 'item-label';
//   label.textContent = ITEM_LABELS[itemName] ?? ...;
//   slot.appendChild(label);

// With sprite icon:
const spriteFile = ITEM_SPRITE_FILES[itemName];
if (spriteFile) {
  const icon = document.createElement('div');
  icon.className = 'item-icon';
  icon.style.backgroundImage = `url(/overlay/sprites/items/${spriteFile})`;
  slot.appendChild(icon);
} else {
  const label = document.createElement('span');
  label.className = 'item-label';
  label.textContent = ITEM_LABELS[itemName] ?? itemName.charAt(0).toUpperCase();
  slot.appendChild(label);
}
```

**CSS** — update `.item-icon` and `.item-slot` in `overlay/src/styles/overlay.css`:

```css
.item-slot {
  width: 24px;
  height: 32px;
  /* ... keep existing styles, just adjust dimensions */
}

.item-icon {
  width: 16px;
  height: 32px;
  background-size: auto 32px; /* Scale 8x16 strip → 16x32 display, auto width keeps ratio */
  background-position: left top; /* First frame of animation strip */
  background-repeat: no-repeat;
  image-rendering: pixelated;
  opacity: 1;
}

.item-slot:not(.found) .item-icon {
  filter: brightness(0.2);
  opacity: 0.4;
}
```

**Verify:** `cd overlay && npm run build` — load overlay URL, confirm sprite icons appear in item slots.
**Deploy:** `cd overlay && npm run build`

---

## Phase 2: Triforce Race Bar

### Task 4: Add triforce race bar to overlay

**Files:** Modify `overlay/src/main.ts`, `overlay/src/index.html`, `overlay/src/styles/overlay.css`

**HTML** — Add container in `index.html` after `#top-bar`:

```html
<!-- Triforce Race Bar -->
<div id="triforce-race-bar"></div>
```

**CSS** — Add styles:

```css
/* ─── Triforce Race Bar ─── */

#triforce-race-bar {
  position: absolute;
  top: 70px;
  right: 40px;
  z-index: 12;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: rgba(10, 10, 18, 0.7);
  border: 1px solid rgba(212, 175, 55, 0.2);
  border-radius: 6px;
  padding: 8px 12px;
  opacity: 0;
  transition: opacity 0.5s;
}

#triforce-race-bar.visible {
  opacity: 1;
}

.tf-racer-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tf-racer-name {
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-white);
  min-width: 80px;
  text-align: right;
}

.tf-pieces {
  display: flex;
  gap: 3px;
}

.tf-piece {
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-bottom: 10px solid rgba(255, 255, 255, 0.08);
  transition: border-bottom-color 0.3s;
}

.tf-piece.collected {
  border-bottom-color: var(--gold);
  filter: drop-shadow(0 0 3px rgba(212, 175, 55, 0.4));
}

.tf-count {
  font-family: var(--font-pixel);
  font-size: 9px;
  color: var(--gold);
  min-width: 20px;
}
```

**JS** — Add `renderTriforceRaceBar()` to `main.ts` and call it from `render()`:

```typescript
function renderTriforceRaceBar(): void {
  const container = document.getElementById('triforce-race-bar');
  if (!container) return;

  // Only show when we have racers with triforce data
  const racersWithTriforce = state.racers.filter(r => r.triforce);
  if (racersWithTriforce.length === 0) {
    container.classList.remove('visible');
    return;
  }

  container.classList.add('visible');
  container.innerHTML = '';

  for (const racer of state.racers) {
    const row = document.createElement('div');
    row.className = 'tf-racer-row';

    const name = document.createElement('span');
    name.className = 'tf-racer-name';
    name.textContent = racer.displayName ?? racer.racerId;
    row.appendChild(name);

    const pieces = document.createElement('div');
    pieces.className = 'tf-pieces';
    const triforce = racer.triforce ?? Array(8).fill(false);
    for (let t = 0; t < 8; t++) {
      const piece = document.createElement('div');
      piece.className = `tf-piece${triforce[t] ? ' collected' : ''}`;
      pieces.appendChild(piece);
    }
    row.appendChild(pieces);

    const count = document.createElement('span');
    count.className = 'tf-count';
    count.textContent = `${triforce.filter(Boolean).length}/8`;
    row.appendChild(count);

    container.appendChild(row);
  }
}

// Update render():
function render(): void {
  renderPlayerPanels();
  renderBottomBar();
  renderTriforceRaceBar();
}
```

**Verify:** `cd overlay && npm run build`
**Deploy:** `cd overlay && npm run build`

---

## Phase 3: Shared Overworld Map + Seed State

### Task 5: Create SeedMapState server-side class

**Files:** New `server/src/race/SeedMapState.ts`

This class aggregates discoveries from all racers into a shared seed knowledge map.

```typescript
import { EventEmitter } from 'node:events';

export interface MapMarker {
  col: number;     // 1-16 (overworld) or 1-8 (dungeon)
  row: number;     // 1-8
  type: 'dungeon' | 'landmark';
  label: string;   // "L3", "White Sword", etc.
  discoveredBy: string; // racerId who found it
  timestamp: number;
}

export interface RacerPosition {
  racerId: string;
  col: number;
  row: number;
  screenType: 'overworld' | 'dungeon' | 'cave';
  dungeonLevel?: number;
}

export class SeedMapState extends EventEmitter {
  private markers = new Map<string, MapMarker>(); // key: "col,row,label"
  private positions = new Map<string, RacerPosition>();

  /** Update a racer's current position on the overworld/dungeon map. */
  updatePosition(racerId: string, col: number, row: number, screenType: string, dungeonLevel?: number): void {
    if (screenType !== 'overworld' && screenType !== 'dungeon' && screenType !== 'cave') return;
    this.positions.set(racerId, {
      racerId,
      col,
      row,
      screenType: screenType as RacerPosition['screenType'],
      dungeonLevel,
    });
    this.emit('positionUpdate', this.getState());
  }

  /** Pin a dungeon entrance discovered by a racer. */
  addDungeonMarker(racerId: string, col: number, row: number, dungeonLevel: number): void {
    const key = `${col},${row},L${dungeonLevel}`;
    if (this.markers.has(key)) return; // already discovered
    this.markers.set(key, {
      col,
      row,
      type: 'dungeon',
      label: `L${dungeonLevel}`,
      discoveredBy: racerId,
      timestamp: Date.now(),
    });
    this.emit('markerUpdate', this.getState());
  }

  /** Pin a landmark (sword cave, etc.). */
  addLandmark(racerId: string, col: number, row: number, label: string): void {
    const key = `${col},${row},${label}`;
    if (this.markers.has(key)) return;
    this.markers.set(key, {
      col,
      row,
      type: 'landmark',
      label,
      discoveredBy: racerId,
      timestamp: Date.now(),
    });
    this.emit('markerUpdate', this.getState());
  }

  getState(): { markers: MapMarker[]; positions: RacerPosition[] } {
    return {
      markers: Array.from(this.markers.values()),
      positions: Array.from(this.positions.values()),
    };
  }

  clear(): void {
    this.markers.clear();
    this.positions.clear();
  }
}
```

**Verify:** `cd server && npm run build`

### Task 6: Write SeedMapState unit tests

**Files:** New `server/tests/SeedMapState.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SeedMapState } from '../src/race/SeedMapState.js';

describe('SeedMapState', () => {
  let map: SeedMapState;

  beforeEach(() => {
    map = new SeedMapState();
  });

  it('tracks racer positions', () => {
    map.updatePosition('r1', 5, 3, 'overworld');
    map.updatePosition('r2', 10, 7, 'overworld');
    const state = map.getState();
    expect(state.positions).toHaveLength(2);
    expect(state.positions[0]).toEqual(expect.objectContaining({ racerId: 'r1', col: 5, row: 3 }));
  });

  it('pins dungeon markers without duplicates', () => {
    map.addDungeonMarker('r1', 5, 3, 3);
    map.addDungeonMarker('r2', 5, 3, 3); // same location — dedup
    expect(map.getState().markers).toHaveLength(1);
    expect(map.getState().markers[0].discoveredBy).toBe('r1');
  });

  it('pins landmarks', () => {
    map.addLandmark('r1', 12, 1, 'White Sword');
    expect(map.getState().markers).toHaveLength(1);
    expect(map.getState().markers[0].label).toBe('White Sword');
  });

  it('ignores non-gameplay screen types', () => {
    map.updatePosition('r1', 5, 3, 'subscreen');
    expect(map.getState().positions).toHaveLength(0);
  });

  it('clear resets everything', () => {
    map.updatePosition('r1', 5, 3, 'overworld');
    map.addDungeonMarker('r1', 5, 3, 3);
    map.clear();
    expect(map.getState().positions).toHaveLength(0);
    expect(map.getState().markers).toHaveLength(0);
  });

  it('emits positionUpdate events', () => {
    const handler = vi.fn();
    map.on('positionUpdate', handler);
    map.updatePosition('r1', 5, 3, 'overworld');
    expect(handler).toHaveBeenCalledOnce();
  });
});
```

Import `vi` from vitest at the top: `import { describe, it, expect, beforeEach, vi } from 'vitest';`

**Verify:** `cd server && npx vitest run tests/SeedMapState.test.ts`

### Task 7: Wire SeedMapState into server + vision pipeline

**Files:** Modify `server/src/index.ts`, `server/src/api/routes.ts`

**index.ts** — Instantiate SeedMapState and wire it to vision updates:

```typescript
// After VisionManager instantiation (~line 94):
import { SeedMapState } from './race/SeedMapState.js';

const seedMapState = new SeedMapState();

// Forward map state changes to overlay
seedMapState.on('positionUpdate', (state) => {
  io.to('overlay').emit('map:state', state);
});
seedMapState.on('markerUpdate', (state) => {
  io.to('overlay').emit('map:state', state);
});
```

**routes.ts** — In the `POST /vision/:racerId` handler, after the existing vision processing, add map position extraction:

```typescript
// After the commentaryEngine.onVisionUpdate() call:

// Feed shared map state
const screenType = fullState.screen_type as string;
const mapPos = fullState.map_position as number | undefined;
const dungeonLevel = fullState.dungeon_level as number | undefined;

if (mapPos != null && (screenType === 'overworld' || screenType === 'dungeon' || screenType === 'cave')) {
  // Convert map_position (0-127 for OW, 0-63 for dungeon) to col,row
  if (screenType === 'overworld') {
    const col = (mapPos % 16) + 1;
    const row = Math.floor(mapPos / 16) + 1;
    ctx.seedMapState.updatePosition(racerId, col, row, screenType);
  } else if (dungeonLevel && dungeonLevel > 0) {
    const col = (mapPos % 8) + 1;
    const row = Math.floor(mapPos / 8) + 1;
    ctx.seedMapState.updatePosition(racerId, col, row, screenType, dungeonLevel);
  }
}

// Pin dungeon markers from game events
for (const evt of events) {
  if ((evt as any).event === 'dungeon_first_visit' && mapPos != null) {
    const dl = (evt as any).dungeon_level as number;
    const owPos = fullState.last_overworld_position as number | undefined;
    if (owPos != null) {
      const col = (owPos % 16) + 1;
      const row = Math.floor(owPos / 16) + 1;
      ctx.seedMapState.addDungeonMarker(racerId, col, row, dl);
    }
  }
}
```

Add `seedMapState` to the route context interface and pass it through `createApiRoutes()`.

Also clear `seedMapState` when races start/end:
```typescript
// In raceGoLive handler:
seedMapState.clear();

// In vodRaceOrchestrator raceGoLive handler:
seedMapState.clear();
```

**Verify:** `cd server && npm run build`
**Deploy:** `cd server && npm run build` + `nssm restart TTP.TV`

### Task 8: Render shared overworld map on overlay

**Files:** Modify `overlay/src/main.ts`, `overlay/src/index.html`, `overlay/src/styles/overlay.css`

**HTML:**
```html
<!-- Shared Map (between commentary and player panels) -->
<div id="shared-map"></div>
```

**JS** — Add Socket.IO listener and render function:

```typescript
// ─── Shared Map State ───

interface MapMarker {
  col: number;
  row: number;
  type: 'dungeon' | 'landmark';
  label: string;
}

interface RacerMapPosition {
  racerId: string;
  col: number;
  row: number;
  screenType: string;
}

interface MapState {
  markers: MapMarker[];
  positions: RacerMapPosition[];
}

let mapState: MapState = { markers: [], positions: [] };

socket.on('map:state', (data: MapState) => {
  mapState = data;
  renderSharedMap();
});

const RACER_COLORS = ['#60A0FF', '#FF6060', '#60D060', '#FFB040'];
const OW_COLS = 16;
const OW_ROWS = 8;
const MAP_CELL_W = 12;
const MAP_CELL_H = 12;

function renderSharedMap(): void {
  const container = document.getElementById('shared-map');
  if (!container) return;

  // Only show if we have position data
  if (mapState.positions.length === 0 && mapState.markers.length === 0) {
    container.classList.remove('visible');
    return;
  }
  container.classList.add('visible');
  container.innerHTML = '';

  // Build grid
  const grid = document.createElement('div');
  grid.className = 'map-grid';

  for (let r = 1; r <= OW_ROWS; r++) {
    for (let c = 1; c <= OW_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'map-cell';

      // Check for markers
      const marker = mapState.markers.find(m => m.col === c && m.row === r);
      if (marker) {
        cell.classList.add(marker.type === 'dungeon' ? 'map-dungeon' : 'map-landmark');
        const label = document.createElement('span');
        label.className = 'map-marker-label';
        label.textContent = marker.label;
        cell.appendChild(label);
      }

      // Check for racer positions
      const racersHere = mapState.positions.filter(p =>
        p.screenType === 'overworld' && p.col === c && p.row === r
      );
      for (const rp of racersHere) {
        const dot = document.createElement('div');
        dot.className = 'map-racer-dot';
        const slotIndex = state.racers.findIndex(r => r.racerId === rp.racerId);
        dot.style.backgroundColor = RACER_COLORS[slotIndex] ?? RACER_COLORS[0];
        cell.appendChild(dot);
      }

      grid.appendChild(cell);
    }
  }

  container.appendChild(grid);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  for (let i = 0; i < state.racers.length; i++) {
    const item = document.createElement('span');
    item.className = 'map-legend-item';
    item.innerHTML = `<span class="map-legend-dot" style="background:${RACER_COLORS[i]}"></span>${state.racers[i].displayName ?? ''}`;
    legend.appendChild(item);
  }
  container.appendChild(legend);
}
```

**CSS:**

```css
/* ─── Shared Map ─── */

#shared-map {
  position: absolute;
  bottom: 150px;
  right: 20px;
  z-index: 11;
  background: rgba(10, 10, 18, 0.85);
  border: 1px solid rgba(212, 175, 55, 0.3);
  border-radius: 6px;
  padding: 8px;
  opacity: 0;
  transition: opacity 0.5s;
}

#shared-map.visible {
  opacity: 1;
}

.map-grid {
  display: grid;
  grid-template-columns: repeat(16, 12px);
  grid-template-rows: repeat(8, 12px);
  gap: 1px;
}

.map-cell {
  width: 12px;
  height: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.map-dungeon {
  background: rgba(212, 175, 55, 0.2);
  border-color: rgba(212, 175, 55, 0.4);
}

.map-landmark {
  background: rgba(96, 192, 255, 0.15);
  border-color: rgba(96, 192, 255, 0.3);
}

.map-marker-label {
  font-family: var(--font-pixel);
  font-size: 5px;
  color: var(--gold);
  line-height: 1;
  text-align: center;
  pointer-events: none;
}

.map-racer-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  position: absolute;
  animation: dot-pulse 2s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.map-legend {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  justify-content: center;
}

.map-legend-item {
  font-family: var(--font-ui);
  font-size: 8px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 3px;
}

.map-legend-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  display: inline-block;
}
```

**Verify:** `cd overlay && npm run build`
**Deploy:** `cd overlay && npm run build`

---

## Phase 4: Auto-Feature Engine ("NFL Red Zone")

### Task 9: Create AutoFeatureEngine

**Files:** New `server/src/race/AutoFeatureEngine.ts`

```typescript
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

interface ExcitementEvent {
  racerId: string;
  score: number;
  reason: string;
  timestamp: number;
}

const EVENT_SCORES: Record<string, number> = {
  ganon_fight: 100,
  ganon_kill: 100,
  game_complete: 100,
  triforce: 60,        // pieces 1-5
  triforce_late: 90,   // pieces 6-8
  death: 40,
  dungeon_entry: 20,
  sword_upgrade: 30,
  staircase_item_acquired: 25,
  silver_arrows: 95,
};

const MIN_DWELL_MS = 15_000; // Minimum 15s on one racer before switching
const EXCITEMENT_DECAY_MS = 30_000; // Events older than 30s don't count
const FEATURE_THRESHOLD = 50; // Minimum excitement to trigger feature

export class AutoFeatureEngine extends EventEmitter {
  private enabled = false;
  private events: ExcitementEvent[] = [];
  private currentFeatured: string | null = null;
  private lastSwitchTime = 0;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.checkInterval = setInterval(() => this.evaluate(), 3000);
    logger.info('[AutoFeature] Enabled');
  }

  disable(): void {
    this.enabled = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.currentFeatured = null;
    logger.info('[AutoFeature] Disabled');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getCurrentFeatured(): string | null {
    return this.currentFeatured;
  }

  /** Called when a game event occurs. Tracks excitement per racer. */
  onGameEvent(racerId: string, eventType: string, triforceCount?: number): void {
    if (!this.enabled) return;

    let score = EVENT_SCORES[eventType] ?? 0;
    if (score === 0) return;

    // Boost late triforce
    if (eventType === 'triforce' && triforceCount && triforceCount >= 6) {
      score = EVENT_SCORES['triforce_late'];
    }

    // Check for silver arrows in staircase items (special case)
    if (eventType === 'staircase_item_acquired') {
      // Score is already set, but silver_arrows gets higher
      // (Caller should pass 'silver_arrows' eventType for that case)
    }

    this.events.push({ racerId, score, reason: eventType, timestamp: Date.now() });
  }

  /** Periodic evaluation: who's most exciting right now? */
  private evaluate(): void {
    if (!this.enabled) return;

    // Prune old events
    const cutoff = Date.now() - EXCITEMENT_DECAY_MS;
    this.events = this.events.filter(e => e.timestamp > cutoff);

    // Score per racer
    const scores = new Map<string, number>();
    for (const e of this.events) {
      scores.set(e.racerId, (scores.get(e.racerId) ?? 0) + e.score);
    }

    // Find highest scorer
    let bestRacer: string | null = null;
    let bestScore = 0;
    for (const [racerId, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestRacer = racerId;
      }
    }

    // Check thresholds
    if (bestScore < FEATURE_THRESHOLD) {
      // Return to equal layout if currently featuring someone
      if (this.currentFeatured !== null) {
        this.currentFeatured = null;
        this.emit('layoutChange', { layout: 'equal', featuredRacer: null });
        logger.info('[AutoFeature] Returning to equal layout');
      }
      return;
    }

    // Check dwell time
    if (bestRacer !== this.currentFeatured && (Date.now() - this.lastSwitchTime) < MIN_DWELL_MS) {
      return; // Too soon to switch
    }

    // Switch to featured racer
    if (bestRacer !== this.currentFeatured) {
      this.currentFeatured = bestRacer;
      this.lastSwitchTime = Date.now();
      this.emit('layoutChange', { layout: 'featured', featuredRacer: bestRacer });
      logger.info(`[AutoFeature] Featuring ${bestRacer} (score: ${bestScore})`);
    }
  }

  clear(): void {
    this.events = [];
    this.currentFeatured = null;
  }
}
```

**Verify:** `cd server && npm run build`

### Task 10: Write AutoFeatureEngine unit tests

**Files:** New `server/tests/AutoFeatureEngine.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutoFeatureEngine } from '../src/race/AutoFeatureEngine.js';

describe('AutoFeatureEngine', () => {
  let engine: AutoFeatureEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new AutoFeatureEngine();
    engine.enable();
  });

  afterEach(() => {
    engine.disable();
    vi.useRealTimers();
  });

  it('does not feature anyone below threshold', () => {
    engine.onGameEvent('r1', 'dungeon_entry'); // 20 points, below 50 threshold
    vi.advanceTimersByTime(3000); // trigger evaluate
    expect(engine.getCurrentFeatured()).toBeNull();
  });

  it('features racer on high-excitement event', () => {
    const handler = vi.fn();
    engine.on('layoutChange', handler);
    engine.onGameEvent('r1', 'ganon_fight'); // 100 points
    vi.advanceTimersByTime(3000);
    expect(engine.getCurrentFeatured()).toBe('r1');
    expect(handler).toHaveBeenCalledWith({ layout: 'featured', featuredRacer: 'r1' });
  });

  it('respects minimum dwell time', () => {
    engine.onGameEvent('r1', 'ganon_fight');
    vi.advanceTimersByTime(3000); // features r1

    engine.onGameEvent('r2', 'ganon_fight');
    vi.advanceTimersByTime(3000); // too soon to switch
    expect(engine.getCurrentFeatured()).toBe('r1'); // still r1

    vi.advanceTimersByTime(15000); // past dwell time
    expect(engine.getCurrentFeatured()).toBe('r2');
  });

  it('returns to equal layout when excitement decays', () => {
    engine.onGameEvent('r1', 'ganon_fight');
    vi.advanceTimersByTime(3000); // features r1
    expect(engine.getCurrentFeatured()).toBe('r1');

    vi.advanceTimersByTime(30000); // events decay
    vi.advanceTimersByTime(3000); // evaluate
    expect(engine.getCurrentFeatured()).toBeNull();
  });

  it('clear resets state', () => {
    engine.onGameEvent('r1', 'ganon_fight');
    vi.advanceTimersByTime(3000);
    engine.clear();
    expect(engine.getCurrentFeatured()).toBeNull();
  });
});
```

Add `import { afterEach } from 'vitest';` to the import.

**Verify:** `cd server && npx vitest run tests/AutoFeatureEngine.test.ts`

### Task 11: Add featured layout to OBS layouts + SceneBuilder

**Files:** Modify `server/src/obs/layouts.ts`, `server/src/obs/SceneBuilder.ts`

**layouts.ts** — Add featured layout variants (3-racer and 4-racer):

```typescript
// Featured layout: slot 0 = large (60% width), others = small stack on right
export const THREE_PLAYER_FEATURED: LayoutDefinition = {
  name: 'three_player_featured',
  racerCount: 3,
  positions: [
    // Featured (left 60%)
    { x: 10, y: GAME_AREA_Y, width: 1140, height: GAME_AREA_H, scaleX: 1140 / 1920, scaleY: GAME_AREA_H / 1080 },
    // Small top-right
    { x: 1170, y: GAME_AREA_Y, width: 730, height: 410, scaleX: 730 / 1920, scaleY: 410 / 1080 },
    // Small bottom-right
    { x: 1170, y: GAME_AREA_Y + 430, width: 730, height: 410, scaleX: 730 / 1920, scaleY: 410 / 1080 },
  ],
};

export const FOUR_PLAYER_FEATURED: LayoutDefinition = {
  name: 'four_player_featured',
  racerCount: 4,
  positions: [
    // Featured (left 60%)
    { x: 10, y: GAME_AREA_Y, width: 1140, height: GAME_AREA_H, scaleX: 1140 / 1920, scaleY: GAME_AREA_H / 1080 },
    // Small top-right
    { x: 1170, y: GAME_AREA_Y, width: 730, height: 270, scaleX: 730 / 1920, scaleY: 270 / 1080 },
    // Small mid-right
    { x: 1170, y: GAME_AREA_Y + 285, width: 730, height: 270, scaleX: 730 / 1920, scaleY: 270 / 1080 },
    // Small bottom-right
    { x: 1170, y: GAME_AREA_Y + 570, width: 730, height: 270, scaleX: 730 / 1920, scaleY: 270 / 1080 },
  ],
};
```

Add a `getFeaturedLayout(racerCount)` export.

**SceneBuilder.ts** — Add `rebuildWithFeatured(featuredRacerId)` method that reorders the racers array to put the featured racer in slot 0, then calls `buildRaceScene()` with the featured layout. Also add `rebuildEqual()` to return to normal layout.

```typescript
async rebuildWithFeatured(sceneName: string, racers: RacerSetup[], featuredRacerId: string): Promise<void> {
  const featured = racers.find(r => r.id === featuredRacerId);
  if (!featured || racers.length <= 2) return; // 2-player doesn't need featuring

  // Reorder: featured first, others maintain relative order
  const reordered = [featured, ...racers.filter(r => r.id !== featuredRacerId)];
  const layout = getFeaturedLayout(racers.length);
  // Rebuild scene with featured layout (reuses buildRaceScene logic)
  await this.buildRaceScene(sceneName, reordered, layout);
}
```

**Verify:** `cd server && npm run build`

### Task 12: Wire AutoFeatureEngine into index.ts

**Files:** Modify `server/src/index.ts`

```typescript
// After commentaryEngine creation:
import { AutoFeatureEngine } from './race/AutoFeatureEngine.js';

const autoFeature = new AutoFeatureEngine();

// Forward game events to auto-feature engine
// In the POST /vision/:racerId handler (in routes.ts), after commentary:
// ctx.autoFeature.onGameEvent(racerId, evt.event, snap?.triforceCount);

// Listen for layout changes
autoFeature.on('layoutChange', async ({ layout, featuredRacer }) => {
  const activeRace = raceOrchestrator.getActiveRace();
  const vodStatus = vodRaceOrchestrator.getStatus();
  const sceneName = activeRace?.sceneName ?? vodStatus.sceneName;
  if (!sceneName) return;

  try {
    if (layout === 'featured' && featuredRacer) {
      // Rebuild scene with featured layout
      await sceneBuilder.featureRacer(featuredRacer);
      io.to('overlay').emit('layout:change', { layout: 'featured', featuredRacer });
    } else {
      await sceneBuilder.featureRacer(null);
      io.to('overlay').emit('layout:change', { layout: 'equal', featuredRacer: null });
    }
  } catch (err) {
    logger.warn('[AutoFeature] Scene rebuild failed', { err });
  }
});
```

Add `autoFeature` to the route context and call `autoFeature.onGameEvent()` in the vision POST handler. Clear on race start/end.

**Verify:** `cd server && npm run build`
**Deploy:** `cd server && npm run build` + `nssm restart TTP.TV`

---

## Phase 5: Cross-System Integration

### Task 13: Stream health → overlay

**Files:** Modify `server/src/index.ts`, `overlay/src/main.ts`, `overlay/src/styles/overlay.css`

**Server** — Forward stream health to overlay room:

```typescript
// After the existing streamHealth forwarding to dashboard (~line 316):
streamManager.on('streamStateChange', (status) => {
  io.to('overlay').emit('stream:stateChange', status);
});
```

**Overlay** — Listen for stream state changes and show indicator:

```typescript
socket.on('stream:stateChange', (data: { racerId: string; state: string }) => {
  // Find racer panel and add/remove signal-lost indicator
  const panels = document.querySelectorAll('.player-panel');
  // Match by racer slot — data.racerId maps to streamKey
  // Implementation: store racerId→panel mapping, toggle .signal-lost class
});
```

**CSS:**
```css
.signal-lost-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-family: var(--font-pixel);
  font-size: 10px;
  color: var(--heart-red);
  background: rgba(10, 10, 18, 0.9);
  padding: 6px 12px;
  border: 1px solid rgba(224, 64, 64, 0.4);
  border-radius: 4px;
  animation: signal-blink 1.5s ease-in-out infinite;
}

@keyframes signal-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

**Verify:** `cd overlay && npm run build`

### Task 14: Race end → commentary summary

**Files:** Modify `server/src/index.ts`, `server/src/commentary/CommentaryEngine.ts`

Add a `generateRaceSummary()` method to CommentaryEngine:

```typescript
async generateRaceSummary(): Promise<void> {
  if (!this.enabled || this.isGenerating) return;

  const trigger: TriggerInfo = {
    type: 'event',
    description: 'The race has ended! Summarize the key moments, final standings, and congratulate the winners.',
    eventType: 'race_summary',
  };

  // Force play-by-play for the summary
  this.currentSpeaker = 'play_by_play';
  await this.generateTurn(trigger);

  // Follow-up from color commentator
  if (this.enabled) {
    await new Promise((r) => setTimeout(r, this.getFollowUpDelay()));
    await this.generateFollowUp(trigger);
  }
}
```

In `index.ts`, trigger summary when race ends:

```typescript
raceOrchestrator.on('stateChange', (newState: string) => {
  if (newState === 'finished') {
    commentaryEngine.generateRaceSummary();
  }
});
```

**Verify:** `cd server && npm run build`

### Task 15: Crop changes → auto scene rebuild

**Files:** Modify `server/src/vision/CropProfileService.ts`, `server/src/index.ts`

Make CropProfileService extend EventEmitter and emit `'cropUpdated'` on save/update. In `index.ts`, listen and auto-rebuild:

```typescript
cropProfileService.on('cropUpdated', async (profileId: string) => {
  // Check if this racer is in an active race
  const activeRace = raceOrchestrator.getActiveRace();
  const vodStatus = vodRaceOrchestrator.getStatus();
  if (activeRace?.orchestratorState === 'live') {
    try {
      await raceOrchestrator.rebuildScene();
      logger.info(`[AutoRebuild] Scene rebuilt after crop update for ${profileId}`);
    } catch (err) {
      logger.warn('[AutoRebuild] Failed', { err });
    }
  } else if (vodStatus.state === 'live') {
    try {
      await vodRaceOrchestrator.rebuildScene();
      logger.info(`[AutoRebuild] VOD scene rebuilt after crop update for ${profileId}`);
    } catch (err) {
      logger.warn('[AutoRebuild] Failed', { err });
    }
  }
});
```

**Verify:** `cd server && npm run build`
**Deploy:** `cd server && npm run build` + `nssm restart TTP.TV`

---

## Phase 6: Operator Reliability

### Task 16: System health API endpoint

**Files:** Modify `server/src/api/routes.ts`

Expand `GET /api/status` to include all subsystem health:

```typescript
router.get('/health', async (_req, res) => {
  const streamStatuses: Record<string, any> = {};
  for (const [id, status] of ctx.streamManager.getStatus()) {
    streamStatuses[id] = status;
  }

  let obsConnected = false;
  let obsStreaming = false;
  let obsScene = '';
  try {
    obsConnected = ctx.obsController.isConnected();
    if (obsConnected) {
      obsStreaming = await ctx.obsController.isStreaming();
      obsScene = await ctx.obsController.getCurrentScene();
    }
  } catch { /* OBS not connected */ }

  const kbStatus = await ctx.knowledgeBase.isAvailable();
  const visionBridges = ctx.visionManager.getActiveBridges();

  res.json({
    server: 'running',
    obs: { connected: obsConnected, streaming: obsStreaming, scene: obsScene },
    streams: streamStatuses,
    vision: {
      activeBridges: visionBridges,
      bridgeCount: visionBridges.length,
    },
    commentary: {
      enabled: ctx.commentaryEngine.isEnabled(),
      generating: ctx.commentaryEngine.getIsGenerating(),
      turnCount: ctx.commentaryEngine.getTurnCount(),
    },
    knowledgeBase: kbStatus,
    tts: {
      enabled: ctx.config.tts.enabled,
    },
  });
});
```

**Verify:** `cd server && npm run build`

### Task 17: System status dashboard page

**Files:** New `dashboard/src/pages/SystemStatus.tsx`, modify `dashboard/src/App.tsx` (router), modify `dashboard/src/components/Sidebar.tsx`

Create a status page that polls `GET /api/health` every 5s and displays all subsystems with green/red indicators.

Add route: `/status` → `SystemStatus` component.
Add sidebar link: "System Status" with Activity icon, placed first in the nav list.

The page should show card-per-subsystem: OBS, Streams, Vision, Commentary, Knowledge Base, TTS — each with status indicator (green dot / red dot) and key metrics.

**Verify:** `cd dashboard && npm run build`
**Deploy:** `cd dashboard && npm run build`

### Task 18: Race history persistence

**Files:** Modify `server/src/db/database.ts`, new `server/src/race/RaceHistoryService.ts`

**Migration** — Add `race_events` table:

```sql
CREATE TABLE IF NOT EXISTS race_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  race_id VARCHAR(36) NOT NULL,
  racer_id VARCHAR(36),
  event_type VARCHAR(64) NOT NULL,
  description TEXT,
  timestamp DATETIME NOT NULL,
  FOREIGN KEY (race_id) REFERENCES races(id)
)
```

**RaceHistoryService** — Records key game events during a race. Called from the vision POST handler. Also records final standings when race ends.

```typescript
export class RaceHistoryService {
  constructor(private db: Kysely<Database>) {}

  async recordEvent(raceId: string, racerId: string, eventType: string, description: string): Promise<void> {
    await this.db.insertInto('race_events').values({
      race_id: raceId,
      racer_id: racerId,
      event_type: eventType,
      description,
      timestamp: new Date(),
    } as any).execute();
  }

  async getEventsForRace(raceId: string): Promise<Array<{ eventType: string; racerId: string; description: string; timestamp: Date }>> {
    return await this.db.selectFrom('race_events')
      .selectAll()
      .where('race_id', '=', raceId)
      .orderBy('timestamp', 'asc')
      .execute() as any;
  }
}
```

Wire into the vision POST handler — record high and medium priority game events.

**Verify:** `cd server && npm run build`
**Deploy:** `cd server && npm run build` + `nssm restart TTP.TV`

---

## Phase 7: Training Pipeline

### Task 19: VOD transcript ingestion service

**Files:** New `server/src/knowledge/VodIngestionService.ts`

Pipeline: VOD URL → ffmpeg audio extraction → Whisper transcription → Ollama summarization → chunk → embed → ChromaDB.

```typescript
export class VodIngestionService extends EventEmitter {
  constructor(
    private config: Config,
    private knowledgeBase: KnowledgeBaseService,
  ) { super(); }

  async ingestVod(vodUrl: string, metadata: { source: string; title?: string }): Promise<void> {
    this.emit('progress', { stage: 'extracting_audio', pct: 0 });

    // Step 1: Extract audio with ffmpeg
    const audioPath = await this.extractAudio(vodUrl);

    this.emit('progress', { stage: 'transcribing', pct: 20 });

    // Step 2: Transcribe with Whisper via Ollama (or external API)
    const transcript = await this.transcribe(audioPath);

    this.emit('progress', { stage: 'chunking', pct: 60 });

    // Step 3: Chunk transcript into ~300-word segments
    const chunks = this.chunkTranscript(transcript);

    this.emit('progress', { stage: 'summarizing', pct: 70 });

    // Step 4: Summarize each chunk with Ollama for topic extraction
    const enrichedChunks = await this.summarizeChunks(chunks);

    this.emit('progress', { stage: 'embedding', pct: 85 });

    // Step 5: Embed and ingest into ChromaDB
    await this.ingestChunks(enrichedChunks, metadata);

    this.emit('progress', { stage: 'complete', pct: 100 });
  }

  // ... implementation details for each step
}
```

The exact Whisper integration depends on available tooling. Options:
1. **whisper.cpp** via CLI subprocess (local, fast, no API key)
2. **Ollama Whisper model** if available
3. **OpenAI Whisper API** (requires API key)

Start with option 1 (whisper.cpp subprocess) since we already have the pattern for subprocess management.

**Verify:** `cd server && npm run build`

### Task 20: Racetime.gg history import

**Files:** New `server/src/knowledge/RaceHistoryImporter.ts`

Fetches paginated race history from racetime.gg API for Z1R category, computes per-racer stats, stores in DB.

```typescript
export class RaceHistoryImporter {
  constructor(
    private racetimeApi: RacetimeApi,
    private db: Kysely<Database>,
  ) {}

  async importHistory(pages: number = 10): Promise<{ racesImported: number; racersUpdated: number }> {
    // Fetch race history pages
    // Parse entrants, finish times, seeds
    // Compute per-racer stats (win rate, avg time, DNF rate)
    // Upsert into racetime_racers table (add stats columns)
  }
}
```

Add API endpoint `POST /api/knowledge/import-history` and dashboard button.

**Verify:** `cd server && npm run build`

### Task 21: Knowledge ingestion dashboard page

**Files:** New `dashboard/src/pages/KnowledgeManager.tsx`, modify router + sidebar

Page with:
- VOD URL input + "Ingest" button (calls VodIngestionService)
- Progress indicator during ingestion
- History import button
- Knowledge base stats (collection size, recent ingestions)

**Verify:** `cd dashboard && npm run build`
**Deploy:** `cd dashboard && npm run build`

---

## Verification

### Automated
```bash
# Server tests (including new SeedMapState + AutoFeature tests)
cd server && npx vitest run
# Expected: ~45+ passed

# Server build
cd server && npm run build

# Dashboard build
cd dashboard && npm run build

# Overlay build
cd overlay && npm run build
```

### Manual Integration Tests
1. Start VOD race → verify item icons render in overlay (sprite images, not text)
2. Collect triforce → verify triforce race bar updates for all racers
3. Move around overworld → verify shared map shows racer positions + dungeon pins
4. Trigger high-excitement event → verify auto-feature switches layout
5. Kill a stream → verify "SIGNAL LOST" appears on overlay
6. End race → verify commentary engine generates race summary
7. Update crop during live race → verify OBS scene auto-rebuilds
8. Open /status dashboard page → verify all subsystem health indicators
9. Ingest a test VOD transcript → verify chunks appear in knowledge base

---

## Files Summary

| Phase | Action | File |
|-------|--------|------|
| 1 | Modify | `server/src/index.ts` (static route) |
| 1 | Modify | `overlay/src/main.ts` (sprite icons) |
| 1 | Modify | `overlay/src/styles/overlay.css` |
| 2 | Modify | `overlay/src/main.ts` (triforce bar) |
| 2 | Modify | `overlay/src/index.html` |
| 2 | Modify | `overlay/src/styles/overlay.css` |
| 3 | New | `server/src/race/SeedMapState.ts` |
| 3 | New | `server/tests/SeedMapState.test.ts` |
| 3 | Modify | `server/src/index.ts` (wire map state) |
| 3 | Modify | `server/src/api/routes.ts` (map position) |
| 3 | Modify | `overlay/src/main.ts` (shared map) |
| 3 | Modify | `overlay/src/index.html` |
| 3 | Modify | `overlay/src/styles/overlay.css` |
| 4 | New | `server/src/race/AutoFeatureEngine.ts` |
| 4 | New | `server/tests/AutoFeatureEngine.test.ts` |
| 4 | Modify | `server/src/obs/layouts.ts` (featured layouts) |
| 4 | Modify | `server/src/obs/SceneBuilder.ts` (featured rebuild) |
| 4 | Modify | `server/src/index.ts` (wire auto-feature) |
| 5 | Modify | `server/src/index.ts` (stream health forward) |
| 5 | Modify | `overlay/src/main.ts` (signal lost) |
| 5 | Modify | `overlay/src/styles/overlay.css` |
| 5 | Modify | `server/src/commentary/CommentaryEngine.ts` (race summary) |
| 5 | Modify | `server/src/vision/CropProfileService.ts` (emit events) |
| 6 | Modify | `server/src/api/routes.ts` (health endpoint) |
| 6 | New | `dashboard/src/pages/SystemStatus.tsx` |
| 6 | Modify | `dashboard/src/App.tsx` (route) |
| 6 | Modify | `dashboard/src/components/Sidebar.tsx` |
| 6 | Modify | `server/src/db/database.ts` (race_events table) |
| 6 | New | `server/src/race/RaceHistoryService.ts` |
| 7 | New | `server/src/knowledge/VodIngestionService.ts` |
| 7 | New | `server/src/knowledge/RaceHistoryImporter.ts` |
| 7 | New | `dashboard/src/pages/KnowledgeManager.tsx` |

**12 new files, ~19 modified files. 21 tasks across 7 phases.**
