# 100% Architectural Maturity By Layer — Design Document

**Date:** 2026-02-25
**Status:** Approved
**Priority:** Viewer experience first, balanced across all areas

---

## Product Vision Checkpoint

The original vision: *"A Twitch restream channel featuring Z1R racers with a unified feed, overlay, auto-tracker that identifies items for chat to understand the race, 2-4 racers on screen, coordinates-based NES capture, synced timers, visual overlays, auto-tracking data, output via RTMP to Twitch."*

**What's been delivered:** Stream pipeline, OBS composition, race orchestration (live + VOD), full NES game state detection (HUD, items, triforce, events), AI commentary with TTS, overlay with player panels, dashboard with 10 pages. The core vision is fulfilled.

**What this design adds:** The viewer-facing polish, intelligent broadcast direction, shared game knowledge visualization, and a training pipeline to make the AI commentary genuinely expert-level.

---

## Section 1: Viewer Experience

### 1a. Overlay Item Icons

**Problem:** Item tracker shows 7px text abbreviations ("B", "MB", "MR") that viewers can't read.

**Solution:** Serve NES sprite templates from `vision/templates/items/` as static assets. Render 16x16 icons (2x native) in the item tracker grid. Each slot shows the sprite when found, dimmed silhouette when not.

**Files:** `overlay/src/main.ts` (renderBottomBar), `overlay/src/styles/overlay.css`, `server/src/index.ts` (static route for templates)

### 1b. Triforce Race Bar

**Problem:** Triforce progress is per-racer, buried in panels. No at-a-glance comparison.

**Solution:** Persistent strip in the top bar area showing all racers' triforce counts side-by-side. Each racer gets a row of 8 triangles with their name. Color-coded by racer slot. Updates in real-time as triforce pieces are collected.

**Files:** `overlay/src/main.ts` (new renderTriforceRaceBar), `overlay/src/styles/overlay.css`

### 1c. Shared Overworld Map

**Problem:** We detect minimap position per racer but don't show it. Viewers can't see the big picture.

**Solution:** A single shared overworld map (16x8 grid) displayed on the overlay. Features:
- Color-coded racer position markers (updated in real-time)
- Dungeon entrance pins (L1-L9) — discovered as any racer enters them, persisted for the seed
- Landmark annotations: White Sword cave, Magical Sword cave, roads, other key locations
- Dungeon map view toggle when a racer enters a dungeon

This is a **seed knowledge accumulator**: as racers explore, the map fills in with discoveries from ALL racers. The more exploration happens, the more complete the picture becomes.

**Server-side:** New `SeedMapState` class that aggregates position data + dungeon discoveries across racers.

**Files:** New `server/src/race/SeedMapState.ts`, `overlay/src/main.ts` (renderSharedMap), `overlay/src/styles/overlay.css`

### 1d. Stream Health Indicator

**Problem:** When a racer's stream dies, overlay shows frozen frame with no indication.

**Solution:** Forward `stream:stateChange` events to overlay. Show "SIGNAL LOST" badge on affected racer panel. Commentary engine can optionally mention it.

**Files:** `overlay/src/main.ts` (stream health listener), `server/src/index.ts` (forward to overlay room)

### 1e. VOD Race Auto-Sync

**Problem:** Setting up VOD races requires manual offset calculation to sync racer starts.

**Solution:** Auto-calculate start offsets from racetime.gg race data (each racer's start time relative to race start). Default 15-second pre-roll before seed start. For live races, sync to racetime.gg `started_at` timestamp.

**Files:** `server/src/race/VodRaceOrchestrator.ts` (auto-offset calculation), `dashboard/src/pages/VodRaceSetup.tsx` (pre-roll config)

---

## Section 2: Intelligent Broadcast Direction ("NFL Red Zone")

### 2a. Auto-Feature Engine

**Problem:** In 3-4 racer races, equal quadrant layout means viewers miss exciting moments happening on one racer's screen.

**Solution:** New `AutoFeatureEngine` that monitors game events across all racers and decides when to switch the OBS layout to feature one racer prominently (e.g., 60% screen for featured racer, 3 small feeds for others). Triggers on high-excitement events:

- **Entering Level 9** — endgame is approaching
- **Ganon fight** — the climactic moment
- **Finding Silver Arrows** — the winning item
- **Triforce collection** (especially pieces 6-8) — race is tightening
- **Death in a dungeon** — dramatic moment
- **Close race finish** (within 2 triforce pieces of each other)

The engine uses a **priority scoring system**: each event type has a weight, and the racer with the highest recent excitement score gets featured. Minimum dwell time (15s) prevents jarring rapid switches. Returns to equal layout when no racer is notably more exciting.

**OBS integration:** SceneBuilder already supports `featureRacer()`. The Auto-Feature Engine calls this + emits layout changes to overlay.

**Commentary integration:** When auto-feature triggers, commentary engine gets a hint ("Focus has shifted to Alice who is entering Level 9...").

**Files:** New `server/src/race/AutoFeatureEngine.ts`, modify `server/src/obs/SceneBuilder.ts` (featured layout), modify `overlay/src/main.ts` (layout transitions)

### 2b. Layout Presets

**Problem:** Only fixed 2/3/4-player equal layouts exist.

**Solution:** Add layout presets: `equal` (current), `featured` (one racer large + others small), `duo-focus` (two racers large + others small). Auto-Feature Engine selects between these. Dashboard can override.

**Files:** `server/src/obs/layouts.ts` (new presets), `server/src/obs/SceneBuilder.ts` (preset switching)

---

## Section 3: Cross-System Integration

### 3a. Vision → Shared Map State

Game events and minimap positions feed into SeedMapState:
- `dungeon_first_visit` with position → pins dungeon location on shared map
- Overworld position updates → racer markers on map
- Future: item locations (if we can correlate floor items to map positions)

### 3b. Crop Changes → Auto Scene Rebuild

CropProfileService emits `'cropUpdated'` event. During live/VOD races, RaceOrchestrator/VodRaceOrchestrator listens and auto-calls `rebuildScene()`.

### 3c. Race End → Commentary Summary

When race ends (all entrants finished/forfeit), commentary engine generates a summary turn with trigger type `'race_summary'`. Includes final standings, key moments, lead changes.

### 3d. Stream Health → Overlay + Commentary

StreamManager health events forwarded to overlay channel. Commentary can reference stream issues when generating periodic turns.

---

## Section 4: Operator Reliability

### 4a. System Status Dashboard Page

New dashboard page `/status` showing at-a-glance health:
- OBS: connected/disconnected, current scene, streaming state
- Streams: per-racer status (running/error/stopped)
- Vision: per-racer pipeline state + verification status
- Commentary: enabled/disabled, last generation time, Ollama reachable
- TTS: service running, last synthesis time
- ChromaDB: reachable, collection size
- Twitch chat: connected, message rate

Single polling endpoint `GET /api/health` that aggregates all subsystem status.

### 4b. Race History Persistence

Save race results to DB after each race:
- Final standings (place, time, status)
- Key events timeline (deaths, triforce, dungeons visited)
- Seed info (flags, goal)

Queryable by commentary engine for historical context ("Alice's 3rd race today, she won the first two").

---

## Section 5: Training Pipeline

### 5a. VOD Commentary Ingestion

**Goal:** Extract expert commentary knowledge from existing Z1R restream VODs (SpeedGaming, Z1Randomizer channel).

**Pipeline:**
1. Input: Twitch/YouTube VOD URL of a Z1R restream
2. Audio extraction: ffmpeg → WAV
3. Transcription: Whisper (via local model or API) → timestamped text
4. Chunking: Split by natural breaks (silence gaps, topic shifts), ~200-500 word chunks
5. Context enrichment: Use Ollama to summarize each chunk's topic ("Discussion of dungeon routing strategy when swordless", "Analysis of runner's decision to Up+A after getting hit")
6. Embedding + ingestion: Embed via Ollama → store in ChromaDB with metadata (source VOD, timestamp, topic, racers mentioned)

**Operator workflow:** Dashboard page where you paste a VOD URL, it processes in background, shows progress, and chunks appear in the knowledge base.

### 5b. Racetime.gg History Import

**Goal:** Build a race performance database from historical racetime.gg data.

**Pipeline:**
1. Fetch race history for Z1R category from racetime.gg API (paginated)
2. Parse: entrants, finish times, seeds, flags, dates
3. Compute per-racer stats: win rate, average time, DNF rate, performance by flag set
4. Store in DB tables for query by commentary engine

**Commentary integration:** "Alice has a 72% completion rate in swordless seeds, with a best time of 1:45:23."

### 5c. Structured Knowledge Ingestion

**Goal:** Make it easy to add domain knowledge articles (Z1R strategy guides, dungeon walkthroughs, item tier lists).

**Pipeline:** Markdown files in a `data/knowledge/` directory. A CLI or dashboard endpoint triggers ingestion: parse → chunk → embed → ChromaDB. Re-ingestible (update existing docs).

---

## Implementation Phases (Suggested Order)

1. **Viewer Experience Core** (1a item icons, 1b triforce bar, 1d stream health) — immediate visual improvement
2. **Shared Map + Seed State** (1c, 3a) — the signature feature
3. **Auto-Feature Engine** (2a, 2b) — "NFL Red Zone" broadcast direction
4. **Cross-System Wiring** (3b, 3c, 3d) — reliability improvements
5. **Operator Dashboard** (4a, 4b) — system health visibility
6. **VOD Sync** (1e) — quality-of-life for VOD race setup
7. **Training Pipeline** (5a, 5b, 5c) — knowledge base enrichment

---

## New Files Summary

| File | Purpose |
|------|---------|
| `server/src/race/SeedMapState.ts` | Shared map state aggregator |
| `server/src/race/AutoFeatureEngine.ts` | Intelligent layout switching |
| `server/tests/SeedMapState.test.ts` | Unit tests |
| `server/tests/AutoFeatureEngine.test.ts` | Unit tests |
| Dashboard: new Status page | System health overview |
| Dashboard: new Training page | VOD ingestion workflow |
| `server/src/knowledge/VodIngestionService.ts` | VOD → transcript → KB pipeline |
| `server/src/knowledge/RaceHistoryService.ts` | Racetime.gg history import |

Plus modifications to: overlay (map, icons, triforce bar, layouts), server (health endpoint, race history tables, commentary summary trigger), dashboard (VOD sync UI, status page, training page), OBS layouts (featured presets).
