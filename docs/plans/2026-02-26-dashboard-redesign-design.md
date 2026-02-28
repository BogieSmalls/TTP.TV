# TTP.TV Dashboard Redesign — Design Document

**Date:** 2026-02-26
**Status:** Approved
**Inspiration:** Linear (navigation) + Stripe (data presentation) + NestrisChamps (game-native personality)

---

## Philosophy

TTP.TV is evolving from a collection of developer tools into a **content studio** for Z1R race broadcasting. The dashboard should reflect this trajectory:

1. **Now:** Setup and training — teaching the system its components
2. **Near-term:** Broadcast operations — running live, VOD, and replay races
3. **Future:** Content programming — curated schedule, automated Twitch broadcasts

The redesign is a **ground-up rebuild** — existing page functionality is preserved and improved, but the UI/UX is not constrained by current implementation. The result should feel like a professional broadcast control room that knows it's about NES Zelda.

---

## Branding

- **Name:** TTP.TV (Triforce Triple Play)
- **Logo:** Gold triforce icon + "TTP.TV" wordmark
- **Domain context:** Twitch channel `twitch.tv/TriforceTriplePlay`

---

## Information Architecture

### Navigation (4 sections, 11 items)

```
◆ TTP.TV

PRODUCE
  Dashboard        Home: system health + race feed + schedule preview
  Broadcast        Tabs: Live / VOD / Replay (unified)
  Schedule         Content calendar — programmed broadcasts

CONFIGURE
  Scene Builder    Visual 1920×1080 overlay editor + preset library
  Racers           Roster (profiles) + Import (all leaderboards)
  Crops            Per-racer + bulk crop tools (unified)
  Commentary       AI personas + TTS voice studio + config

TRAIN
  Learn Mode       VOD analysis pipeline + playlist batch support
  Knowledge Base   RAG ingestion + racetime.gg history import
  Vision Lab       Real-time vision inspection + event log

SYSTEM
  Settings         Config, API keys, tool paths, display prefs

[☀/🌙] Theme toggle    v0.9
```

### Page Migration Map

| Current Page (12 flat) | New Location | Change |
|---|---|---|
| System Status | **Dashboard** (home) | Elevated to home page with race feed |
| Race Control | **Broadcast → Live tab** | Tab within unified Broadcast |
| VOD Race | **Broadcast → VOD tab** | Tab within unified Broadcast |
| Race Replay | **Broadcast → Replay tab** | Tab within unified Broadcast |
| Streams | **Absorbed** into Broadcast tabs | Redundant standalone page removed |
| Profiles | **Racers → Roster tab** | Merged with Racer Pool |
| Racer Pool | **Racers → Import tab** | Merged with Profiles |
| Crop Manager | **Crops** | Unified with Bulk Crop |
| Bulk Crop | **Crops** | Unified with Crop Manager |
| Commentary | **Commentary** | Expanded with voice studio |
| Learn Mode | **Learn Mode** | Added playlist support |
| Knowledge Base | **Knowledge Base** | Unchanged |
| Vision Debug | **Vision Lab** | Renamed, moved to Train |
| *(new)* | **Dashboard** | Race feed + schedule preview |
| *(new)* | **Schedule** | Content calendar |
| *(new)* | **Scene Builder** | Visual overlay editor |
| *(new)* | **Settings** | System-wide config |

### Sidebar Behavior

- **Collapsible sections:** Click section header to collapse/expand (state persisted in localStorage)
- **Active indicator:** Gold left-border + subtle gold background on current page
- **Responsive:** Collapses to icon-only rail on narrow viewports
- **Keyboard (future):** `Cmd/Ctrl+K` command palette for quick navigation

---

## Design System

### Color Tokens (Light/Dark)

Themes are applied via `data-theme="light|dark"` on `<html>`. Toggle stored in `localStorage('ttp-theme')`. Falls back to `prefers-color-scheme` when set to "system."

| Token | Dark | Light | Usage |
|-------|------|-------|-------|
| `--bg-base` | `#0a0a12` | `#f8f8fa` | Page background |
| `--bg-surface` | `#12122a` | `#ffffff` | Cards, panels |
| `--bg-elevated` | `#1a1a3a` | `#f0f0f5` | Nested elements, hover |
| `--border` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` | Dividers |
| `--text-primary` | `#f0f0f5` | `#1a1a2e` | Headings |
| `--text-secondary` | `rgba(255,255,255,0.6)` | `rgba(0,0,0,0.55)` | Labels |
| `--text-muted` | `rgba(255,255,255,0.3)` | `rgba(0,0,0,0.3)` | Hints |
| `--accent` | `#D4AF37` | `#B8960F` | Gold brand accent |
| `--accent-subtle` | `rgba(212,175,55,0.15)` | `rgba(184,150,15,0.1)` | Accent backgrounds |
| `--success` | `#34D399` | `#16A34A` | Connected, finished |
| `--danger` | `#F87171` | `#DC2626` | Errors |
| `--warning` | `#FBBF24` | `#D97706` | Alerts |

### Typography

- **Headings / nav:** Inter 600 — clean, professional
- **Body:** Inter 400
- **Game data:** Press Start 2P — hearts, triforce, counters, dungeon levels (NES personality)
- **Numbers:** `font-variant-numeric: tabular-nums` for aligned columns

### NES Data Treatment (NestrisChamps Influence)

When displaying game-derived data, switch to pixel font and NES-native visuals:

- **Hearts:** Red `♥` glyphs, not progress bars
- **Triforce pieces:** Gold CSS triangles, not checkboxes
- **Item icons:** 16×16 sprites from `vision/templates/items/`, `image-rendering: pixelated`
- **Counters (rupees/keys/bombs):** Pixel font + NES-style icons
- **Dungeon levels:** `L3` in pixel font, not "Level 3" in Inter

Rule: **UI chrome is modern (Inter), game data is retro (pixel font).** The contrast makes both more readable.

### Shared Component Library (`dashboard/src/ui/`)

| Component | Purpose |
|-----------|---------|
| `Card` | Surface container: header, body, optional footer |
| `Badge` | Status pill: semantic color + optional pulsing dot |
| `DataGrid` | Stripe-style table: sorting, density options, row actions |
| `StatCard` | Single metric: number + label + icon |
| `FormField` | Input + label + error + description |
| `Button` | Variants: primary/secondary/ghost/danger. Loading state. |
| `IconButton` | Compact action (edit, delete, expand) |
| `SectionHeader` | Section title + optional action button |
| `EmptyState` | Illustrated placeholder for no-data states |
| `Modal` | Overlay dialog with backdrop |
| `Tabs` | Horizontal tab bar for in-page navigation |
| `ProgressBar` | Determinate/indeterminate with label |
| `ThemeToggle` | Light/dark/system switcher |
| `Select` | Styled dropdown replacing native `<select>` |
| `SearchInput` | Input with search icon + clear button |

### Layout Grid

- **Page max-width:** 1440px centered (full-bleed for Scene Builder)
- **Content padding:** 24px
- **Card gap:** 16px
- **Responsive grid:** `repeat(auto-fit, minmax(320px, 1fr))` for stat cards

### Card Design (Stripe Influence)

- `border-radius: 8px`
- `background: var(--bg-surface)`
- `border: 1px solid var(--border)`
- Dark mode: no shadows (borders do separation)
- Light mode: subtle `box-shadow` for depth
- Cards never have colored backgrounds — color comes from badges and data content

### Motion

Restrained — this is a production tool.

- Page transitions: none (instant)
- Card hover: 100ms background ease
- Badge pulse: `LIVE` badge subtle breathing (2s infinite)
- Toast: slide in top-right, auto-dismiss 5s
- Modal: fade backdrop + scale-up (200ms)
- Sidebar collapse: 150ms width transition
- Scene Builder drag: 60fps CSS transform

---

## Page Designs

### Dashboard (Home)

At-a-glance health, race feed, and today's schedule.

**StatCards row (top):** OBS status, active streams, vision feeds, commentary status. Click any to jump to detail page.

**Race Feed:** Real-time list from racetime.gg Z1R category.
- Live races: entry count, elapsed time, `[→ Schedule]` quick-action
- Completed races: finish times, `[→ Replay]` quick-action
- Filter: All / Live / Completed
- Auto-refreshes via racetime.gg polling

**Today's Schedule:** Preview of programmed content blocks with status badges (LIVE / QUEUED / AUTO). Links to full Schedule page.

**Recent Activity:** System event log (vision calibrations, ingestions, crop updates, etc.)

### Broadcast (Unified: Live + VOD + Replay)

Three tabs sharing common broadcast chrome:

**Shared elements across tabs:**
- Scene preset selector (from Scene Builder)
- Commentary on/off toggle
- OBS connection status bar
- Active broadcast indicator (red LIVE banner when on-air)

**Live tab:** Current Race Control functionality.
- Detected racetime.gg rooms
- Slot picker for entrant assignment
- Go-live state machine workflow
- Real-time entrant monitoring + audio controls
- Scene rebuild, go offline controls

**VOD tab:** Current VOD Race Setup functionality.
- 2-4 racer slots with Twitch/YouTube VOD URLs
- Per-racer start offset (mm:ss)
- Optional title + metadata
- Layout preview, go-live

**Replay tab:** Current Race Replay functionality.
- Paste racetime.gg URL → resolve VODs
- Auto-map entrants to profiles
- Recent replays list for re-replay
- Go-live

### Schedule (NEW)

Content programming calendar.

**Day/week view toggle.** Each content block specifies:
- Type: live (auto-detect racetime.gg) / VOD / replay
- Source: racetime.gg URL, VOD URLs, or "next open race"
- Scene preset (from Scene Builder)
- Commentary config (persona, on/off)
- Start time
- Auto-broadcast flag (system starts at scheduled time)

Actions per block: Edit, Preview (Scene Builder preview), Go Live (manual), Queue.

### Scene Builder (NEW)

Visual overlay editor with preset library.

**Canvas:** Scaled 1920×1080 preview with element outlines.

**Element palette:** Drag elements onto canvas.

| Element | Configurable Properties | Default Size |
|---------|------------------------|-------------|
| Player Feed | Slot, border color, name label position | 940×530 (2P) |
| Extended HUD Strip | Items shown, triforce style, label size | 940×28 |
| Triforce Race Bar | Orientation, show count, leader highlight | 200×120 |
| Seed Tracker Footer | Items tracked, icon size, sort order | 1920×28 |
| Shared Map | Cell size, dot size, legend position | 240×130 |
| Commentary Box | Font size, max lines, persona colors | 600×80 |
| Timer | Format, font, color, background | 268×44 |
| Event Footer | Fields to cycle, interval, font | 1920×32 |
| Chat Highlight | Position, hold duration, slide direction | 500×40 |
| Replay Badge | Position, show date, pulse | 120×30 |
| Background | Type, color, tile pattern, opacity | 1920×1080 |
| Custom Text | Content, font, size, color | Auto |

**Interaction model:**
- Select preset → canvas populates
- Click element → inspector shows properties
- Drag element → reposition (snap to 8px grid)
- Resize handles on corners/edges
- Right-click context menu (duplicate, delete, lock, z-order)
- Keyboard: Delete, arrow nudge (1px), Shift+arrow (8px)

**Preset library:** Built-in presets (2P Race, 4P Tournament, Solo Showcase, Clean, Replay). User can save custom presets. Presets stored in DB as JSON.

**Data model:**
```typescript
interface ScenePreset {
  id: string;
  name: string;
  description?: string;
  racerCount: 1 | 2 | 3 | 4;
  background: BackgroundConfig;
  elements: SceneElement[];
  createdAt: string;
  updatedAt: string;
}

interface SceneElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  locked: boolean;
  visible: boolean;
  config: Record<string, unknown>;
}
```

**Integration:**
- Overlay loads preset via `?preset=<id>` query param
- OBS SceneBuilder reads preset to position browser sources
- `scene_presets` DB table stores JSON documents

### Racers (Merged: Profiles + Pool)

**Roster tab:** DataGrid of all profiles. Inline expandable editor. Crop count badge links to Crops page. Color dot shows preferred color. Search + filter.

**Import tab:**
- "Sync All Leaderboards" button — sweeps all pages of `racetime.gg/z1r/leaderboards` (269+ players). Progress indicator.
- Single racer import by racetime ID or URL
- Imported indicator per racer
- Auto-links Twitch channels from racetime data

### Crops (Merged: Bulk Crop + Crop Manager)

- **Per-racer view:** Select racer → see all crop profiles → create/edit/delete/set default
- **Bulk session:** "Bulk Setup" walks through racers sequentially (current Bulk Crop workflow)
- **Crop wizard:** Full-viewport creation tool (unchanged — already solid)

### Commentary (Expanded)

Four tabs:

**Personas tab:** Named AI commentators.
- Role: play-by-play / color
- System prompt / personality
- Assigned voice model
- Active/inactive toggle
- Create, edit, delete personas

**Voice Studio tab:** TTS voice management.
- Upload audio clips → train voice profile
- Named voices: BogieBot (bogie-v1), DrooisBot (droois-v1), etc.
- Built-in Kokoro voices as defaults
- Quality indicator per voice
- Test playback

**Config tab:** Model selection, temperature, token limits (current config UI).

**Live Log tab:** Real-time commentary stream + manual trigger (current conversation display).

### Learn Mode (Enhanced)

Added source types:

- Twitch VOD (existing)
- File path (existing)
- Video URL (existing)
- **YouTube Playlist** (NEW): paste playlist URL → extract all videos → queue as sequential sessions
- **Twitch Collection** (NEW): paste collection URL → same batch processing

Progress for playlists: "Processing 3/12 videos"

### Knowledge Base (Unchanged)

VOD transcript ingestion, ChromaDB status, history import. No changes needed.

### Vision Lab (Renamed from Vision Debug)

Moved to TRAIN section. Real-time vision inspection + event log. No functional changes, just renamed and repositioned in navigation.

### Settings (NEW)

System-wide configuration, organized as tabs or accordion sections:

- **General:** Server port, data directories
- **Tools:** ffmpeg path, streamlink path (absolute paths for NSSM)
- **Twitch:** Stream key, chat OAuth, channel name, chat buffer size
- **OBS:** WebSocket URL/password, auto-launch path, multitrack toggle
- **AI:** Ollama URL, default model, embedding model
- **Racetime:** Category slug, leaderboard URL
- **Display:** Default theme (light/dark/system), default landing page

---

## Data Model Extensions

### New DB Tables

**`scene_presets`**
```sql
CREATE TABLE scene_presets (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  racer_count INTEGER NOT NULL DEFAULT 2,
  elements JSON NOT NULL,
  background JSON NOT NULL,
  is_builtin BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**`schedule_blocks`**
```sql
CREATE TABLE schedule_blocks (
  id VARCHAR(36) PRIMARY KEY,
  type VARCHAR(20) NOT NULL,          -- 'live', 'vod', 'replay'
  source_url TEXT,                     -- racetime URL, VOD URLs JSON, etc.
  title VARCHAR(200),
  scene_preset_id VARCHAR(36),
  commentary_enabled BOOLEAN DEFAULT TRUE,
  commentary_persona_ids JSON,
  scheduled_at DATETIME NOT NULL,
  duration_minutes INTEGER,
  auto_broadcast BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'queued', -- 'queued', 'live', 'completed', 'cancelled'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**`commentary_personas`**
```sql
CREATE TABLE commentary_personas (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL,          -- 'play_by_play', 'color'
  system_prompt TEXT,
  personality TEXT,
  voice_id VARCHAR(36),
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**`voice_profiles`**
```sql
CREATE TABLE voice_profiles (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL,          -- 'custom', 'builtin'
  kokoro_voice_id VARCHAR(100),       -- for builtin voices
  clip_count INTEGER DEFAULT 0,
  quality_score REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Implementation Priorities

### Phase 1: Foundation
Design system (component library + theming), new sidebar layout, Dashboard home page, Settings page.

### Phase 2: Page Migrations
Broadcast (merge 3 pages), Racers (merge 2 pages), Crops (merge 2 pages). Migrate all pages to new component library.

### Phase 3: New Features
Scene Builder, Schedule page, Commentary voice studio, Learn Mode playlist support, full leaderboard import.

### Phase 4: Polish
Animations, responsive refinement, keyboard shortcuts, empty states, error boundaries.

---

## File Impact Summary

| Action | File/Directory |
|--------|---------------|
| New | `dashboard/src/ui/` — shared component library (14+ components) |
| New | `dashboard/src/pages/Dashboard.tsx` — home page |
| New | `dashboard/src/pages/Broadcast.tsx` — unified broadcast |
| New | `dashboard/src/pages/Schedule.tsx` — content calendar |
| New | `dashboard/src/pages/SceneBuilder.tsx` — visual editor |
| New | `dashboard/src/pages/Settings.tsx` — system config |
| New | `dashboard/src/components/sidebar/` — new collapsible sidebar |
| New | `dashboard/src/hooks/useTheme.ts` — light/dark theme management |
| New | `dashboard/src/styles/theme.css` — CSS custom properties for themes |
| Rewrite | `dashboard/src/App.tsx` — new routing structure |
| Rewrite | `dashboard/src/index.css` — theme tokens, typography |
| Merge | `dashboard/src/pages/Racers.tsx` ← Profiles + Pool |
| Merge | `dashboard/src/pages/Crops.tsx` ← CropManager + BulkCrop |
| Expand | `dashboard/src/pages/Commentary.tsx` — add personas + voice studio tabs |
| Expand | `dashboard/src/pages/LearnMode.tsx` — add playlist support |
| Rename | `VisionDebug.tsx` → `VisionLab.tsx` |
| Delete | `dashboard/src/pages/SystemStatus.tsx` — absorbed into Dashboard |
| Delete | `dashboard/src/pages/Streams.tsx` — absorbed into Broadcast |
| Delete | `dashboard/src/pages/RacerPool.tsx` — merged into Racers |
| Modify | `server/src/db/database.ts` — new tables |
| New | `server/src/api/scenePresetRoutes.ts` — CRUD for presets |
| New | `server/src/api/scheduleRoutes.ts` — CRUD for schedule blocks |
| New | `server/src/api/personaRoutes.ts` — persona + voice CRUD |
