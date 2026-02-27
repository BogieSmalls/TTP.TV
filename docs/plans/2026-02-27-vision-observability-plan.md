# Vision Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance VisionLab to show per-racer game state with a visual minimap (real room art for overworld, color grid for dungeons), death rate alarm, and 100-event log — so the operator can verify vision accuracy against a live VOD session.

**Architecture:** Single file edit (`dashboard/src/pages/VisionLab.tsx`). No server changes — room tiles are already served at `/api/learn/rooms/C{col}_R{row}.jpg`. State is accumulated client-side: visited rooms per racer (Set), death counts per racer (array of timestamps for sliding 60s window).

**Tech Stack:** React, TypeScript, Tailwind v4 / CSS variables (existing pattern), Socket.IO client via `useSocketEvent` hook

---

## Context

**Socket events received by VisionLab:**
- `vision:raw` → `{ racerId, screen_type, dungeon_level, hearts_current, hearts_max, has_half_heart, rupees, keys, bombs, b_item, sword_level, items, triforce, map_position }`
  - `map_position`: raw NES byte. Overworld: col = `(pos % 16) + 1`, row = `Math.floor(pos / 16) + 1`. Dungeon: col = `(pos % 8) + 1`, row = `Math.floor(pos / 8) + 1`
- `vision:events` → `{ racerId, events: [{ type, description?, priority? }] }`

**Existing VisionLab.tsx structure (226 lines):**
- `VisionState` interface — already has all needed fields including `map_position`
- `states: Record<string, VisionState>` — per-racer current state
- `events: FlatEvent[]` — capped at 50, needs 100
- Racer cards in 2-col grid, shows HUD values + items + triforce
- Event log panel below cards
- Listens to `vision:raw` (not `vision:update`) + `vision:events`

**Room tile image URL pattern:** `/api/learn/rooms/C{col}_R{row}.jpg`
Files: `content/overworld_rooms/C1_R1.jpg` through `C16_R8.jpg`

---

## Definition of Done

1. Run a VOD session → open VisionLab → the overworld minimap highlights the correct room as the racer moves (verifiable by cross-referencing VOD video)
2. Deaths show as `DEATH` screen type badge briefly then return to `OVERWORLD` / `DUNGEON` — if death counter hits >3 in 60s, the red alarm banner appears
3. Heart counts visible and matchable against VOD frame-by-frame

---

## Task 1: Position decoding + visited rooms tracking

**Files:** Modify `dashboard/src/pages/VisionLab.tsx`

This task adds the data plumbing with no visual change. We add:
- `decodePosition()` utility
- `visitedRooms` state per racer
- Death timestamp tracking per racer for the 60s alarm window

**Step 1: Add position decode utility and death tracking types**

After the existing `ITEMS` array (line ~50), add:

```typescript
// Decode NES map_position byte → 1-based {col, row}
function decodePosition(mapPos: number, screenType: string): { col: number; row: number } | null {
  if (mapPos == null || mapPos < 0) return null;
  if (screenType === 'overworld' || screenType === 'cave') {
    return { col: (mapPos % 16) + 1, row: Math.floor(mapPos / 16) + 1 };
  }
  if (screenType === 'dungeon') {
    return { col: (mapPos % 8) + 1, row: Math.floor(mapPos / 8) + 1 };
  }
  return null;
}

function roomImageUrl(col: number, row: number): string {
  return `/api/learn/rooms/C${col}_R${row}.jpg`;
}
```

**Step 2: Expand component state to track visited rooms + death timestamps**

Replace the existing state declarations in the `VisionLab` function body (lines ~53-55):

```typescript
const [states, setStates] = useState<Record<string, VisionState>>({});
const [events, setEvents] = useState<FlatEvent[]>([]);
const [visitedRooms, setVisitedRooms] = useState<Record<string, Set<string>>>({});
const [deathTimes, setDeathTimes] = useState<Record<string, number[]>>({});
const nextId = useRef(0);
```

**Step 3: Update `handleVision` to accumulate visited rooms**

Replace the existing `handleVision` callback:

```typescript
const handleVision = useCallback((data: VisionState) => {
  setStates(prev => ({ ...prev, [data.racerId]: data }));

  // Track visited rooms for minimap dimming
  const pos = decodePosition(data.map_position ?? 0, data.screen_type);
  if (pos) {
    const key = `${pos.col},${pos.row}`;
    setVisitedRooms(prev => {
      const existing = prev[data.racerId] ?? new Set<string>();
      if (existing.has(key)) return prev; // no change needed
      const next = new Set(existing);
      next.add(key);
      return { ...prev, [data.racerId]: next };
    });
  }
}, []);
```

**Step 4: Update `handleVisionEvents` to track death timestamps + expand to 100 events**

Replace the existing `handleVisionEvents` callback:

```typescript
const handleVisionEvents = useCallback((data: { racerId: string; events: Array<{ type: string; description?: string }> }) => {
  const now = Date.now();

  // Track death timestamps for alarm (keep last 60s only)
  const deaths = data.events.filter(e => e.type === 'death');
  if (deaths.length > 0) {
    setDeathTimes(prev => {
      const cutoff = now - 60_000;
      const existing = (prev[data.racerId] ?? []).filter(t => t > cutoff);
      return { ...prev, [data.racerId]: [...existing, ...deaths.map(() => now)] };
    });
  }

  const flat: FlatEvent[] = data.events.map(e => ({
    id: nextId.current++,
    racerId: data.racerId,
    type: e.type,
    description: e.description ?? e.type,
    timestamp: now,
  }));
  setEvents(prev => [...flat, ...prev].slice(0, 100));
}, []);
```

**Step 5: Verify no TypeScript errors**

```bash
cd D:/Projects/Streaming/TTPRestream/dashboard && npx tsc --noEmit
```
Expected: no errors

**Step 6: Commit**

```bash
cd D:/Projects/Streaming/TTPRestream
git add dashboard/src/pages/VisionLab.tsx
git commit -m "feat(visionlab): add position decoding, visited rooms, death tracking"
```

---

## Task 2: OverworldMinimap component

**Files:** Modify `dashboard/src/pages/VisionLab.tsx` (add component at bottom of file)

**Step 1: Add OverworldMinimap component**

Add after the existing `HudVal` component (after line ~225):

```typescript
const OW_COLS = 16;
const OW_ROWS = 8;

function OverworldMinimap({
  currentCol,
  currentRow,
  visited,
}: {
  currentCol: number;
  currentRow: number;
  visited: Set<string>;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${OW_COLS}, 1fr)`,
        gap: 1,
        background: 'var(--bg-base)',
        padding: 4,
        borderRadius: 4,
      }}
    >
      {Array.from({ length: OW_ROWS }, (_, rowIdx) =>
        Array.from({ length: OW_COLS }, (_, colIdx) => {
          const col = colIdx + 1;
          const row = rowIdx + 1;
          const isCurrent = col === currentCol && row === currentRow;
          const isVisited = visited.has(`${col},${row}`);
          return (
            <div
              key={`${col}-${row}`}
              title={`C${col},R${row}`}
              style={{
                position: 'relative',
                aspectRatio: '256/176',
                overflow: 'hidden',
                borderRadius: 1,
                outline: isCurrent ? '2px solid #D4AF37' : undefined,
                boxShadow: isCurrent ? '0 0 6px rgba(212,175,55,0.8)' : undefined,
                zIndex: isCurrent ? 1 : 0,
              }}
            >
              <img
                src={roomImageUrl(col, row)}
                alt={`C${col}R${row}`}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                  opacity: isCurrent ? 1 : isVisited ? 0.85 : 0.25,
                  filter: isCurrent ? 'none' : isVisited ? 'none' : 'grayscale(60%)',
                }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}
```

**Step 2: Verify no TypeScript errors**

```bash
cd D:/Projects/Streaming/TTPRestream/dashboard && npx tsc --noEmit
```
Expected: no errors

**Step 3: Commit**

```bash
cd D:/Projects/Streaming/TTPRestream
git add dashboard/src/pages/VisionLab.tsx
git commit -m "feat(visionlab): add OverworldMinimap component with room art"
```

---

## Task 3: DungeonMinimap component

**Files:** Modify `dashboard/src/pages/VisionLab.tsx`

**Step 1: Add DungeonMinimap component** (after OverworldMinimap):

```typescript
const DG_COLS = 8;
const DG_ROWS = 8;

function DungeonMinimap({
  currentCol,
  currentRow,
  dungeonLevel,
  visited,
}: {
  currentCol: number;
  currentRow: number;
  dungeonLevel: number;
  visited: Set<string>;
}) {
  return (
    <div>
      <div
        className="text-xs font-bold mb-1 text-center"
        style={{ color: 'var(--text-muted)', letterSpacing: '0.1em' }}
      >
        LEVEL {dungeonLevel}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${DG_COLS}, 1fr)`,
          gap: 2,
          background: 'var(--bg-base)',
          padding: 4,
          borderRadius: 4,
        }}
      >
        {Array.from({ length: DG_ROWS }, (_, rowIdx) =>
          Array.from({ length: DG_COLS }, (_, colIdx) => {
            const col = colIdx + 1;
            const row = rowIdx + 1;
            const isCurrent = col === currentCol && row === currentRow;
            const isVisited = visited.has(`${col},${row}`);
            let bg = 'var(--bg-elevated)';
            if (isCurrent) bg = '#D4AF37';
            else if (isVisited) bg = 'rgba(52,211,153,0.3)';
            return (
              <div
                key={`${col}-${row}`}
                title={`C${col},R${row}`}
                style={{
                  aspectRatio: '1',
                  borderRadius: 2,
                  background: bg,
                  outline: isCurrent ? '1px solid rgba(212,175,55,0.8)' : undefined,
                  boxShadow: isCurrent ? '0 0 4px rgba(212,175,55,0.6)' : undefined,
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify no TypeScript errors**

```bash
cd D:/Projects/Streaming/TTPRestream/dashboard && npx tsc --noEmit
```

**Step 3: Commit**

```bash
cd D:/Projects/Streaming/TTPRestream
git add dashboard/src/pages/VisionLab.tsx
git commit -m "feat(visionlab): add DungeonMinimap component with color grid"
```

---

## Task 4: Death alarm banner

**Files:** Modify `dashboard/src/pages/VisionLab.tsx`

**Step 1: Add alarm derivation + banner JSX**

Add this derived value inside the `VisionLab` function body, after the `racers` line:

```typescript
// Build alarm list: racers with >3 deaths in last 60s
const now = Date.now();
const alarms = racers
  .map(s => ({
    racerId: s.racerId,
    recentDeaths: (deathTimes[s.racerId] ?? []).filter(t => t > now - 60_000).length,
  }))
  .filter(a => a.recentDeaths > 3);
```

In the JSX, add the alarm banner immediately after `<SectionHeader title="Vision Lab" />` and before the empty-state check:

```tsx
{alarms.length > 0 && (
  <div
    className="rounded-lg px-4 py-3 flex items-center gap-2 text-sm font-medium"
    style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid var(--danger)', color: 'var(--danger)' }}
  >
    <span>⚠</span>
    <span>
      FALSE DEATH LIKELY:{' '}
      {alarms.map(a => `${a.racerId} (${a.recentDeaths} deaths/min)`).join(', ')}
    </span>
  </div>
)}
```

**Step 2: Verify no TypeScript errors**

```bash
cd D:/Projects/Streaming/TTPRestream/dashboard && npx tsc --noEmit
```

**Step 3: Commit**

```bash
cd D:/Projects/Streaming/TTPRestream
git add dashboard/src/pages/VisionLab.tsx
git commit -m "feat(visionlab): add death rate alarm banner (>3 deaths/60s)"
```

---

## Task 5: Wire minimap + death counter into racer cards

**Files:** Modify `dashboard/src/pages/VisionLab.tsx`

This task replaces the existing racer card layout with the full design: color-coded screen type badge, death counter, visual minimap, HUD strip.

**Step 1: Add screen type badge color helper**

Add after `eventColor()` function (line ~25):

```typescript
function screenTypeBadge(screenType: string): { bg: string; color: string } {
  switch (screenType) {
    case 'overworld': return { bg: 'rgba(52,211,153,0.2)', color: 'var(--success)' };
    case 'dungeon':   return { bg: 'rgba(99,102,241,0.2)', color: '#a5b4fc' };
    case 'cave':      return { bg: 'rgba(234,179,8,0.2)', color: 'var(--warning)' };
    case 'subscreen': return { bg: 'rgba(59,130,246,0.2)', color: '#93c5fd' };
    case 'death':     return { bg: 'rgba(239,68,68,0.2)', color: 'var(--danger)' };
    case 'title':     return { bg: 'var(--bg-elevated)', color: 'var(--text-muted)' };
    default:          return { bg: 'var(--bg-elevated)', color: 'var(--text-muted)' };
  }
}
```

**Step 2: Replace the racer card inner JSX**

Replace the `{racers.map(s => (` block (lines ~98-172) with:

```tsx
{racers.map(s => {
  const pos = decodePosition(s.map_position ?? 0, s.screen_type);
  const visited = visitedRooms[s.racerId] ?? new Set<string>();
  const recentDeaths = (deathTimes[s.racerId] ?? []).filter(t => t > Date.now() - 60_000).length;
  const totalDeaths = (deathTimes[s.racerId] ?? []).length;
  const sbadge = screenTypeBadge(s.screen_type);
  const isOverworld = s.screen_type === 'overworld' || s.screen_type === 'cave';
  const isDungeon = s.screen_type === 'dungeon';

  return (
    <div
      key={s.racerId}
      className="rounded-lg p-4 border space-y-3"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
    >
      {/* Header: name + screen type badge + death counter */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {s.racerId}
        </h3>
        <div className="flex items-center gap-2 shrink-0">
          {totalDeaths > 0 && (
            <span
              className="text-xs px-2 py-0.5 rounded font-medium"
              style={{
                background: recentDeaths > 3 ? 'rgba(239,68,68,0.2)' : 'var(--bg-elevated)',
                color: recentDeaths > 3 ? 'var(--danger)' : 'var(--text-muted)',
              }}
            >
              {totalDeaths}☠ {recentDeaths > 0 ? `(${recentDeaths}/min)` : ''}
            </span>
          )}
          <span
            className="text-xs px-2 py-0.5 rounded font-medium"
            style={{ background: sbadge.bg, color: sbadge.color }}
          >
            {s.screen_type === 'dungeon' ? `DUNGEON-${s.dungeon_level}` : s.screen_type.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Visual minimap */}
      {pos && isOverworld && (
        <OverworldMinimap currentCol={pos.col} currentRow={pos.row} visited={visited} />
      )}
      {pos && isDungeon && (
        <DungeonMinimap
          currentCol={pos.col}
          currentRow={pos.row}
          dungeonLevel={s.dungeon_level}
          visited={visited}
        />
      )}
      {!pos && (
        <div
          className="text-xs text-center py-3 rounded"
          style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}
        >
          no position data
        </div>
      )}

      {/* HUD values */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <HudVal label="Hearts" value={`${s.hearts_current}/${s.hearts_max}${s.has_half_heart ? '½' : ''}`} />
        <HudVal label="Rupees" value={s.rupees} />
        <HudVal label="Keys" value={s.keys} />
        <HudVal label="Bombs" value={s.bombs} />
      </div>

      {/* Sword + B-item */}
      <div className="flex gap-4 text-xs">
        <span style={{ color: 'var(--text-muted)' }}>Sword: <span style={{ color: 'var(--text-secondary)' }}>{s.sword_level}</span></span>
        <span style={{ color: 'var(--text-muted)' }}>B-item: <span style={{ color: 'var(--text-secondary)' }}>{s.b_item ?? 'none'}</span></span>
      </div>

      {/* Triforce */}
      <div>
        <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Triforce</div>
        <div className="flex gap-1">
          {(s.triforce || Array(8).fill(false)).map((has, i) => (
            <div
              key={i}
              className="w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold"
              style={{
                background: has ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                color: has ? 'var(--accent)' : 'var(--text-muted)',
              }}
            >
              {i + 1}
            </div>
          ))}
        </div>
      </div>

      {/* Items */}
      <div>
        <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Items</div>
        <div className="flex flex-wrap gap-1">
          {ITEMS.map(item => {
            const has = s.items?.[item];
            return (
              <span
                key={item}
                className="px-1.5 py-0.5 rounded text-[10px]"
                style={{
                  background: has ? 'rgba(52,211,153,0.15)' : 'var(--bg-elevated)',
                  color: has ? 'var(--success)' : 'var(--text-muted)',
                }}
              >
                {item.replace(/_/g, ' ')}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
})}
```

**Step 3: Verify no TypeScript errors**

```bash
cd D:/Projects/Streaming/TTPRestream/dashboard && npx tsc --noEmit
```
Expected: no errors

**Step 4: Commit**

```bash
cd D:/Projects/Streaming/TTPRestream
git add dashboard/src/pages/VisionLab.tsx
git commit -m "feat(visionlab): wire minimap + death counter into racer cards"
```

---

## Task 6: Build, push, verify

**Step 1: Build dashboard**

```bash
cd D:/Projects/Streaming/TTPRestream/dashboard && npm run build
```
Expected: build completes with no errors

**Step 2: Push to GitHub**

```bash
cd D:/Projects/Streaming/TTPRestream && git push origin main
```

**Step 3: Verify in browser**

1. Ensure server is running (`nssm start TTP.TV` or `node server/dist/index.js`)
2. Open `http://localhost:3000/dashboard/#/vision-lab`
3. Start a VOD session for any racer
4. Confirm:
   - Overworld minimap shows 16×8 room art grid with current room highlighted in gold
   - Moving to a new room highlights the new room, previous room stays bright (visited)
   - Screen type badge reads `OVERWORLD`, `DUNGEON-3`, `SUBSCREEN` etc. correctly
   - Deaths appear as brief `DEATH` badge — if death counter climbs fast, alarm fires
   - HUD values (hearts, rupees) visible and matchable to VOD

**Step 4: Report findings**

Tell the user exactly what you see — what's working, what looks wrong. **Do not move on to commentary or overlay until user confirms Definition of Done is met.**
