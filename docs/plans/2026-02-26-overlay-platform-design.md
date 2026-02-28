# TTP Overlay Platform Design

**Date:** 2026-02-26
**Status:** Approved
**Inspiration:** NestrisChamps.io — adapted for Zelda 1 Randomizer (Z1R)

---

## Philosophy

Like NestrisChamps, TTP separates **game state extraction** (Python vision pipeline) from **presentation** (overlay renderers). Game state flows as structured data (~4KB/s per racer) to overlay layouts that render it in real time. This enables:

- Multiple layout variants from the same data stream
- Replay rendering from stored vision log data
- Consistent, pixel-perfect stats regardless of source stream quality
- Computed statistics impossible with video-only analysis

The overlay should feel **modern but retro** — clean dark UI with NES-era pixel fonts for game data, smooth UI fonts for labels, gold accent throughout. Think "broadcast-quality esports production meets 8-bit nostalgia."

---

## Section 1: Per-Runner Extended HUD Strip

### What

A narrow strip rendered below each runner's stream feed showing the 14 routing-critical indicators the native Z1 HUD does not display.

### Items (6)

| Item | Sprite | Notes |
|------|--------|-------|
| Bow | bow.png | |
| Ladder | stepladder.png | |
| Power Bracelet | power_bracelet.png | |
| Raft | raft.png | |
| Recorder | recorder.png | |
| Arrows | arrow.png / silver_arrow.png | Show whichever type the runner has; silver_arrow.png if silver |

### Triforce (8)

L1 through L8 as small triangle indicators. Collected = gold, uncollected = dim outline.

### Layout

```
┌──────────────────────────────────────────┐
│          Runner's Stream Feed             │
│  (native Z1 HUD: hearts/rupees/keys/etc) │
│          (gameplay area)                  │
├──────────────────────────────────────────┤
│ [Bow][Lad][PB][Raft][Rec][Arr] L1 L2 L3 L4 L5 L6 L7 L8 │
└──────────────────────────────────────────┘
```

- Items: 24x24 sprite icons, dim (brightness 0.2, opacity 0.3) when uncollected, full opacity when found
- Triforce: 8 small triangles (12x10px CSS borders), gold when collected
- Total strip height: ~28px
- No glow animations on items — dimmed vs lit is sufficient and avoids visual noise

### Data Source

Existing `vision:update` socket events already carry `items` (Record<string, boolean>) and `triforce` (boolean[]). No server changes needed — just filter to the 6 display items + 8 triforce pieces in the overlay renderer.

---

## Section 2: Race-Wide Seed Tracker (Footer Bar)

### What

A compact footer bar showing the state of 15 race-critical items — where they've been found in the seed. This is **race-level data** aggregated across all runners' vision pipelines. Who found them doesn't matter — just what and where.

### Items (15)

Book, Boomerang, Bow, Ladder, Magical Boomerang, Magical Key, Power Bracelet, Raft, Recorder, Red Candle, Red Ring, Silver Arrows, Wand, White Sword, Coast Heart

### Location Codes

| Code | Meaning |
|------|---------|
| 1-9 | Level 1 through Level 9 |
| C | Coast Heart location |
| W | White Sword Cave |
| A | Armos item |
| ? | Undiscovered |

### Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Book]3  [Boom]  [Bow]6  [Lad]4  [MBoom]  [MKey]  [PB]W  [Raft]  ... │
└──────────────────────────────────────────────────────────────────────────┘
```

Items without a location code are simply dim icons — no placeholder text.

- Each entry: small sprite icon (16x16) + location code (pixel font, gold when found)
- Undiscovered items: just the dim icon, no location code — blank until found
- Full-width bar, ~28px height, positioned at bottom of overlay
- Items sorted by routing importance

### Detection

- **L1-L9**: Vision pipeline already reads `dungeon_level`. When a runner picks up one of the 15 tracked items while `dungeon_level > 0`, record `{item, level}`.
- **C, W, A**: Special overworld/cave locations. Detection rules TBD — will be taught separately. Placeholder in data model.

### Server: SeedItemTracker

New server-side service (or extension to `SeedMapState`):

```typescript
interface SeedItemDiscovery {
  item: string;
  location: string;  // '1'-'9', 'C', 'W', 'A'
  timestamp: number;
}

class SeedItemTracker extends EventEmitter {
  private discoveries = new Map<string, SeedItemDiscovery>();

  recordDiscovery(item: string, location: string): void;
  getState(): Record<string, string | null>;  // item → location or null
  clear(): void;
}
```

Fed by vision POST handler in routes.ts — when any racer's item state changes (false → true for a tracked item), check current dungeon_level and record the discovery.

Socket event: `seed:itemDiscovery` → overlay updates footer.

---

## Section 3: Race Replay Orchestrator

### What

Paste a racetime.gg race URL → TTP finds all runners' VODs, syncs them to race start time, and replays the race with full production quality.

### Workflow

1. Operator pastes URL: `https://racetime.gg/z1r/mysterious-vire-2312`
2. **Fetch**: TTP calls racetime.gg API → gets entrants, start time, finish times, goal
3. **Resolve VODs**: For each entrant, look up Twitch channel (from racer profile DB or racetime user data), call Twitch API to find VOD overlapping race time
4. **Compute offsets**: For each VOD, calculate `race_start_time - vod_created_at` to get the seek offset
5. **Preview**: Dashboard shows all 4 runners with VOD thumbnails, computed offsets, ready state
6. **Queue**: Operator sets replay time (e.g., "start in 2 minutes") or "go now"
7. **Go live**: StreamManager starts all VODs via streamlink with `--hls-start-offset`, offset to 15s before race start. SceneBuilder creates scene. Vision pipelines start.
8. **Playback**: Race timer runs from original start time. Finish placements appear at the exact moments they happened (known from racetime data).

### What Already Exists

- `VodRaceOrchestrator` — orchestrates VOD-based races
- `StreamManager` — plays VODs via streamlink
- `VisionManager` — real-time analysis
- `TwitchApiClient` — can query Twitch API for VODs
- `RaceMonitor.racetimeApi` — fetches racetime.gg data

### What's New

- **`ReplayOrchestrator`** service: coordinates the fetch → resolve → sync → playback pipeline
- **Race archive DB table**: `race_replays` storing `{racetime_url, entrants[], vod_urls[], offsets[], race_start, race_end, goal, seed}` for instant re-replay
- **Dashboard page**: `ReplaySetup.tsx` — paste URL, preview runners/VODs, confirm, schedule
- **VOD seek**: streamlink `--hls-start-offset` or ffmpeg seek for precise time alignment

### Timer Alignment

- Live races: timer is real-time, straightforward
- Replays: timer maps to original race start time. Finish events are known from racetime data, so placements display at exact moments regardless of VOD sync precision.

---

## Section 4: Multiple Overlay Layouts

### Layout System

Layouts are HTML/CSS/JS browser sources. Layout selected via URL parameter: `?layout=race`

All layouts share the same socket data model — they just render differently.

### Defined Layouts

| Layout | Use Case | Description |
|--------|----------|-------------|
| `race` | Default competition | 2-4 player feeds + extended HUD + seed tracker footer + shared map + triforce race bar |
| `featured` | Auto-feature active | 60/40 split, auto-feature engine drives prominent player |
| `standalone` | Qualifier / solo | Single player, full stats, large game feed |
| `clean` | Casual viewing | Minimal — timer, player names, placements. Maximum game area |
| `replay` | VOD replay | Race layout + replay indicator, original timestamps |

### Query String Customization

| Param | Values | Default |
|-------|--------|---------|
| `layout` | race, featured, standalone, clean, replay | race |
| `racers` | 1-4 | 2 |
| `bg` | transparent, dark, tiles, gradient | transparent |
| `seed_tracker` | 1/0 | 1 |
| `map` | 1/0 | 1 |
| `triforce_bar` | 1/0 | 1 |

### Backgrounds

- `transparent`: Default for OBS compositing
- `dark`: Solid dark (#0a0a12)
- `tiles`: Subtle NES-era geometric tile pattern at low opacity (~5%)
- `gradient`: Dark vignette gradient from center

---

## Section 5: Overlay Animations & Polish

### Triforce Piece Collection

When a triforce piece transitions uncollected → collected (both per-runner strip and race bar):

```css
@keyframes piece-pop {
  0% { transform: scale(0.5); filter: drop-shadow(0 0 12px gold); }
  40% { transform: scale(1.4); }
  100% { transform: scale(1); filter: drop-shadow(0 0 3px gold); }
}
```

Track previous triforce state per racer. Apply `just-collected` class for 0.8s.

### Item Pickup

No animation — items simply transition from dim to lit. Clean and non-distracting.

### Signal-Lost

- **Debounce**: 3s timer before showing badge. WiFi blips don't trigger it.
- **Fade-in**: 0.4s ease-out on badge entry
- **Recovery**: "BACK ONLINE" in green for 2s before badge removal
- **Cleanup**: All badges removed on race end

### Multi-Racer Map Dots

When 2+ racers share a map cell:
- 2 racers: side-by-side offset (2px left/right)
- 3+ racers: count badge with gradient of racer colors

### Dungeon Notation

"L3" everywhere (not "D3"). Level = L.

### Race-End Cleanup

On `raceActive === false`:
- Fade out triforce race bar (2s)
- Fade out shared map after 10s delay (final positions visible)
- Remove signal-lost badges
- Clear animation state maps

### Triforce Leader Highlight

Gold left-border + subtle background on the leading row in the triforce race bar. Ties highlight all tied racers.

### Map Cell Size

12px → 14px cells, 6px → 8px racer dots.

---

## Section 6: Chat Highlights (Lower-Third)

### What

Surface notable Twitch chat messages as a **lower-third overlay** — a brief banner that slides in from the left, shows username + message, and slides out after ~8s.

### Triggers

- **Manual**: Operator selects a message from dashboard to feature
- **Auto**: Spike in chat activity (e.g., 10+ messages in 5s) → feature the most-liked or first message in the burst
- **Commentary reaction**: Commentary engine can reference featured messages

### Layout

```
┌─────────────────────────────────────────┐
│  @viewer_name: "That L3 find was nuts!" │
└─────────────────────────────────────────┘
```

Slides in from left, holds 6s, slides out right. Semi-transparent dark background with gold border-left accent. Max 1 featured message at a time, queue subsequent.

### Not Doing

Full chat panel on screen. Chat stays in Twitch chat where viewers expect it.

---

## Section 7: Standalone Tools

### Timer Tool

Standalone browser source at `/overlay/timer`:

- Dimensions: 268x44 (scalable in OBS)
- Params: `?minutes=120&type=up&color=D4AF37&bg=000000`
- Pixel font, minimal, compositable
- Can sync to race start time via socket connection

### Event Footer

Cycling info bar at `/overlay/footer`:

- Dimensions: 1920x32
- Params: `?event=TTP+Winter+2026&round=Swiss+R3&flags=Swordless,FullShuffle&cycle=10`
- Cycles through: event name, round info, seed flags, runner names
- Gold text on dark background, smooth crossfade between slides

---

## Section 8: Data Model Extensions

### New: SeedItemTracker

Tracks race-wide item discoveries. Lives alongside SeedMapState.

```typescript
// 15 tracked items
const SEED_TRACKED_ITEMS = [
  'book', 'boomerang', 'bow', 'ladder', 'magical_boomerang',
  'magical_key', 'power_bracelet', 'raft', 'recorder',
  'red_candle', 'red_ring', 'silver_arrows', 'wand',
  'white_sword', 'coast_heart',
];

// Location codes
type ItemLocation = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'C'|'W'|'A';
```

### New: ReplayOrchestrator

Coordinates replay from racetime.gg URL. Stores race metadata for re-replay.

### New DB: race_replays table

```sql
CREATE TABLE race_replays (
  id VARCHAR(36) PRIMARY KEY,
  racetime_url VARCHAR(255) NOT NULL,
  race_start DATETIME NOT NULL,
  race_end DATETIME,
  goal TEXT,
  seed TEXT,
  entrants JSON,    -- [{racetimeId, displayName, twitchChannel, vodUrl, offsetMs, finishTime, place}]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Overlay Layout Router

The overlay `main.ts` reads `?layout=` and loads the appropriate renderer module. Each layout is a self-contained render function that subscribes to the same socket events.

---

## Detection Notes

### Currently Detectable

- Item pickups: vision pipeline tracks `items` dict (boolean per item)
- Dungeon level: `dungeon_level` (1-9) read from HUD
- Item + dungeon level → "item found in Lx" (for items 1-9)

### To Be Taught

- **Coast Heart (C)**: Special overworld location detection — rules TBD
- **White Sword Cave (W)**: Cave-specific detection — rules TBD
- **Armos Item (A)**: Armos Knights drop detection — rules TBD

### Already Detected (Relevant)

- `b_item_change` event → when B-item changes, we know an item was picked up
- `dungeon_first_visit` event → first time entering a dungeon
- `screen_type` → overworld/dungeon/cave distinction
- `triforce_inferred` event → triforce piece collected

---

## Priorities

### Phase A (Highest Impact)
1. Per-runner extended HUD strip (Section 1)
2. Race-wide seed tracker footer (Section 2)
3. Overlay animations (Section 5)
4. Layout query-string system (Section 4 — just the router, `race` layout first)

### Phase B (Platform Features)
5. Race replay orchestrator (Section 3)
6. Standalone and clean layouts (Section 4)
7. Chat highlights lower-third (Section 6)

### Phase C (Polish & Tools)
8. Timer and footer tools (Section 7)
9. Background options (Section 4)
10. Replay layout with timestamp display

---

## File Impact Summary

| Action | File |
|--------|------|
| New | `server/src/race/SeedItemTracker.ts` |
| New | `server/src/race/ReplayOrchestrator.ts` |
| New | `server/tests/SeedItemTracker.test.ts` |
| New | `dashboard/src/pages/ReplaySetup.tsx` |
| Modify | `overlay/src/main.ts` (layout router, extended HUD, seed footer, animations, chat highlight) |
| Modify | `overlay/src/styles/overlay.css` (all new components + animations) |
| Modify | `overlay/src/index.html` (new containers) |
| Modify | `server/src/index.ts` (wire SeedItemTracker, ReplayOrchestrator) |
| Modify | `server/src/api/routes.ts` (seed tracker feed, replay endpoints) |
| Modify | `server/src/db/database.ts` (race_replays table) |
| Modify | `dashboard/src/App.tsx` (replay route) |
| Modify | `dashboard/src/components/Sidebar.tsx` (replay link) |
