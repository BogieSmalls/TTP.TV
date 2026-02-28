# TTP.TV Dashboard Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ground-up rebuild of the TTP dashboard as a professional content studio for Z1R race broadcasting, with light/dark theming, grouped navigation, merged pages, and new features (Scene Builder, Schedule, Voice Studio).

**Architecture:** React 19 + Vite 7 + Tailwind 4 + TanStack Query 5. CSS custom properties for theming via `data-theme` on `<html>`. Collapsible sidebar with 4 sections (PRODUCE / CONFIGURE / TRAIN / SYSTEM). Existing API layer (`dashboard/src/lib/`) is preserved — changes are almost entirely in UI/page layer. Server gets 4 new DB tables + 3 new API route files.

**Tech Stack:** TypeScript, React, Tailwind CSS 4, Socket.IO, MySQL (Kysely ORM)

**Design doc:** `docs/plans/2026-02-26-dashboard-redesign-design.md`

---

## Phase 1: Foundation (Design System + Shell)

### Task 1: Theme CSS + useTheme hook

**Files:**
- Create: `dashboard/src/styles/theme.css`
- Create: `dashboard/src/hooks/useTheme.ts`
- Modify: `dashboard/src/index.css`
- Modify: `dashboard/index.html`

**Step 1:** Create `dashboard/src/styles/theme.css` with CSS custom properties for light and dark themes:

```css
/* Theme tokens — applied via data-theme on <html> */

:root,
[data-theme="dark"] {
  --bg-base: #0a0a12;
  --bg-surface: #12122a;
  --bg-elevated: #1a1a3a;
  --border: rgba(255,255,255,0.08);
  --text-primary: #f0f0f5;
  --text-secondary: rgba(255,255,255,0.6);
  --text-muted: rgba(255,255,255,0.3);
  --accent: #D4AF37;
  --accent-subtle: rgba(212,175,55,0.15);
  --success: #34D399;
  --danger: #F87171;
  --warning: #FBBF24;
}

[data-theme="light"] {
  --bg-base: #f8f8fa;
  --bg-surface: #ffffff;
  --bg-elevated: #f0f0f5;
  --border: rgba(0,0,0,0.08);
  --text-primary: #1a1a2e;
  --text-secondary: rgba(0,0,0,0.55);
  --text-muted: rgba(0,0,0,0.3);
  --accent: #B8960F;
  --accent-subtle: rgba(184,150,15,0.1);
  --success: #16A34A;
  --danger: #DC2626;
  --warning: #D97706;
}
```

**Step 2:** Create `dashboard/src/hooks/useTheme.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getEffective(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? getSystemTheme() : theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem('ttp-theme') as Theme) ?? 'system';
  });

  const effective = getEffective(theme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effective);
  }, [effective]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => document.documentElement.setAttribute('data-theme', getSystemTheme());
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem('ttp-theme', t);
  }, []);

  return { theme, effective, setTheme };
}
```

**Step 3:** Rewrite `dashboard/src/index.css` to import theme.css and use CSS variables:

```css
@import "tailwindcss";
@import "./styles/theme.css";

@theme {
  --color-gold: #D4AF37;
  --color-gold-dim: #B8941F;
  --color-panel: var(--bg-surface);
  --color-panel-light: var(--bg-elevated);
  --color-surface: var(--bg-base);
  --color-danger: var(--danger);
  --color-success: var(--success);
  --color-warning: var(--warning);
}

@font-face {
  font-family: 'Press Start 2P';
  src: url('https://fonts.gstatic.com/s/pressstart2p/v15/e3t4euO8T-267oIAQAu6jDQyK3nVivM.woff2') format('woff2');
  font-weight: 400;
  font-display: swap;
}

body {
  font-family: 'Inter', system-ui, sans-serif;
  background: var(--bg-base);
  color: var(--text-primary);
  margin: 0;
}

.font-pixel {
  font-family: 'Press Start 2P', monospace;
}
```

**Step 4:** Add `<link>` for Inter + Press Start 2P in `dashboard/index.html` `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Press+Start+2P&display=swap" rel="stylesheet">
```

**Verify:** `cd dashboard && npm run build` — no errors.

---

### Task 2: Shared UI component library

**Files:**
- Create: `dashboard/src/ui/Card.tsx`
- Create: `dashboard/src/ui/Badge.tsx`
- Create: `dashboard/src/ui/Button.tsx`
- Create: `dashboard/src/ui/StatCard.tsx`
- Create: `dashboard/src/ui/Tabs.tsx`
- Create: `dashboard/src/ui/FormField.tsx`
- Create: `dashboard/src/ui/SectionHeader.tsx`
- Create: `dashboard/src/ui/EmptyState.tsx`
- Create: `dashboard/src/ui/Modal.tsx`
- Create: `dashboard/src/ui/SearchInput.tsx`
- Create: `dashboard/src/ui/ThemeToggle.tsx`
- Create: `dashboard/src/ui/Select.tsx`
- Create: `dashboard/src/ui/DataGrid.tsx`
- Create: `dashboard/src/ui/index.ts`

Build all shared components as minimal, composable building blocks using CSS variable tokens. Every component uses `var(--bg-surface)`, `var(--text-primary)`, etc. — no hardcoded colors.

**Card:** Surface container with optional header (title + action), body slot, optional footer. Props: `title?: string`, `action?: ReactNode`, `children`, `className?`, `noPadding?: boolean`.

**Badge:** Status pill. Props: `variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral'`, `label: string`, `pulse?: boolean` (breathing dot for LIVE).

**Button:** Props: `variant: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size: 'sm' | 'md'`, `loading?: boolean`, `icon?: ReactNode`, `children`, standard button attrs. Primary = gold accent, secondary = surface, ghost = transparent, danger = red.

**StatCard:** Single metric display. Props: `label: string`, `value: string | number`, `icon: ReactNode`, `status?: 'ok' | 'warn' | 'error'`, `onClick?: () => void`.

**Tabs:** Horizontal tab bar. Props: `tabs: { id: string; label: string; icon?: ReactNode }[]`, `active: string`, `onChange: (id: string) => void`. Gold underline on active tab.

**FormField:** Props: `label: string`, `error?: string`, `description?: string`, `children` (wraps the actual input).

**SectionHeader:** Props: `title: string`, `action?: ReactNode`.

**EmptyState:** Props: `icon: ReactNode`, `title: string`, `description?: string`, `action?: ReactNode`.

**Modal:** Props: `open: boolean`, `onClose: () => void`, `title: string`, `children`, `footer?: ReactNode`. Fade backdrop + scale content. Escape key closes.

**SearchInput:** Props: `value: string`, `onChange: (v: string) => void`, `placeholder?: string`. Has search icon + clear button.

**ThemeToggle:** Uses `useTheme()`. Renders 3-segment toggle (light/dark/system) or icon-based cycler for sidebar.

**Select:** Styled `<select>` wrapper using CSS variables. Props: `options: { value: string; label: string }[]`, `value`, `onChange`, `placeholder?`.

**DataGrid:** Stripe-style table. Props: `columns: { key: string; label: string; sortable?: boolean; render?: (row) => ReactNode }[]`, `data: T[]`, `onRowClick?: (row: T) => void`, `emptyMessage?: string`. Handles sorting state internally. Zebra striping via CSS vars.

**index.ts:** Re-exports all components.

**Verify:** `cd dashboard && npm run build` — no errors. Components are tree-shakeable and unused ones don't affect bundle.

---

### Task 3: Collapsible sidebar

**Files:**
- Create: `dashboard/src/components/sidebar/AppSidebar.tsx`
- Create: `dashboard/src/components/sidebar/SidebarSection.tsx`
- Create: `dashboard/src/components/sidebar/SidebarLink.tsx`

**AppSidebar:** Replaces current `Sidebar.tsx`. Structure:

```
◆ TTP.TV (logo + wordmark)

PRODUCE
  Dashboard        (LayoutDashboard)
  Broadcast        (Radio)
  Schedule         (Calendar)

CONFIGURE
  Scene Builder    (Layers)
  Racers           (Users)
  Crops            (Scissors)
  Commentary       (MessageSquare)

TRAIN
  Learn Mode       (GraduationCap)
  Knowledge Base   (BookOpen)
  Vision Lab       (Eye)

SYSTEM
  Settings         (Settings)

[Theme toggle]     v0.9
```

**SidebarSection:** Collapsible group. Props: `title: string`, `defaultOpen?: boolean`, `children`. Click header to toggle. Collapse state stored in `localStorage('ttp-sidebar-${title}')`. Uses `var(--text-muted)` for section labels, uppercase, small tracking.

**SidebarLink:** Single nav item wrapping `NavLink`. Props: `to: string`, `icon: LucideIcon`, `label: string`. Active state: gold left-border + `var(--accent-subtle)` background. Hover: `var(--bg-elevated)`.

**AppSidebar top:** Gold "◆ TTP.TV" wordmark. Below: "TriforceTriplePlay". Border bottom.

**AppSidebar bottom:** ThemeToggle + version `v0.9`.

**AppSidebar layout:** `w-56 shrink-0`, background `var(--bg-surface)`, border-right `var(--border)`.

**Verify:** `cd dashboard && npm run build`

---

### Task 4: App.tsx routing restructure

**Files:**
- Modify: `dashboard/src/App.tsx`

Replace current flat routing with new grouped structure:

```typescript
import { Routes, Route, Navigate } from 'react-router-dom';
import AppSidebar from './components/sidebar/AppSidebar';

// PRODUCE
import Dashboard from './pages/Dashboard';
import Broadcast from './pages/Broadcast';
// Schedule is Phase 3

// CONFIGURE
// SceneBuilder is Phase 3
import Racers from './pages/Racers';
import Crops from './pages/Crops';
import Commentary from './pages/Commentary';

// TRAIN
import LearnMode from './pages/LearnMode';
import KnowledgeManager from './pages/KnowledgeManager';
import VisionLab from './pages/VisionLab';

// SYSTEM
import Settings from './pages/Settings';

export default function App() {
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      <AppSidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1440px] mx-auto p-6">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/broadcast" element={<Broadcast />} />
            <Route path="/broadcast/:tab" element={<Broadcast />} />
            <Route path="/racers" element={<Racers />} />
            <Route path="/racers/:tab" element={<Racers />} />
            <Route path="/crops" element={<Crops />} />
            <Route path="/crops/:profileId" element={<Crops />} />
            <Route path="/commentary" element={<Commentary />} />
            <Route path="/learn" element={<LearnMode />} />
            <Route path="/knowledge" element={<KnowledgeManager />} />
            <Route path="/vision" element={<VisionLab />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
```

**Important:** Pages that don't exist yet (Dashboard, Broadcast, Racers, Crops, Settings) will be created as stub pages in the next tasks. The old Sidebar.tsx is no longer imported but NOT deleted yet (safe rollback).

Old routes (`/status`, `/control`, `/streams`, `/profiles`, `/pool`, `/bulk-crop`, `/vod-race`, `/replay`) are removed. The old pages continue to exist as files but are unreachable until they're either merged into new pages or deleted.

**Verify:** `cd dashboard && npm run build`

---

### Task 5: Dashboard home page

**Files:**
- Create: `dashboard/src/pages/Dashboard.tsx`
- Modify: `dashboard/src/lib/api.ts` (add `getRaceFeed` function)

**Dashboard.tsx** — Home page with:

1. **StatCards row** (top): 4 `StatCard` components sourcing from `/api/health`:
   - OBS: connected/disconnected, current scene
   - Streams: count of active streams
   - Vision: active bridge count
   - Commentary: enabled/disabled, turn count

2. **Race Feed panel** (left ~60%): Placeholder for now — "Race Feed coming in Phase 3". In this phase, just show recent replays from `listReplays()` API as a teaser.

3. **System Health panel** (right ~40%): Condensed version of current SystemStatus — show server, OBS, TTS, Knowledge Base as compact rows with Badge status indicators.

Query: `useQuery(['health'], getHealth, { refetchInterval: 5000 })`.

Use `Card`, `StatCard`, `Badge` from `ui/` library.

**Verify:** `cd dashboard && npm run build` — navigate to `/dashboard`, confirm stat cards + health display render.

---

### Task 6: Settings page

**Files:**
- Create: `dashboard/src/pages/Settings.tsx`

**Settings.tsx** — Read-only system config display for now. Later phases will add write capability.

Use `Tabs` component with sections:
- **General:** Show server version, uptime (from `/api/health`)
- **Display:** Theme selector using `useTheme()` — 3-option radio (Light / Dark / System)

This is intentionally minimal in Phase 1. More settings tabs added in Phase 3.

**Verify:** `cd dashboard && npm run build`

---

### Task 7: Verify Phase 1 builds + deploy

**Run:**
```bash
cd dashboard && npm run build
```

Verify no errors. Load `http://localhost:3000/dashboard/` and confirm:
- New sidebar renders with 4 sections
- Theme toggle works (light → dark → system)
- Dashboard home shows stat cards + health
- Settings page renders

**Commit Phase 1.**

---

## Phase 2: Page Migrations

### Task 8: Broadcast page (merge Live + VOD + Replay)

**Files:**
- Create: `dashboard/src/pages/Broadcast.tsx`
- Modify: `dashboard/src/lib/api.ts` (no new endpoints — reuses existing)

**Broadcast.tsx** — Unified broadcast page with 3 tabs: Live / VOD / Replay.

Uses `Tabs` component at top. Tab state driven by URL param (`/broadcast/live`, `/broadcast/vod`, `/broadcast/replay`). Default: `live`.

**Shared broadcast header** (above tabs):
- OBS connection status `Badge` (from `getObsStatus()`)
- Commentary on/off toggle button (from commentary API)
- Active broadcast indicator — if any streams are running, show red pulsing `LIVE` badge

**Live tab:** Port content from `RaceControl.tsx`:
- Same queries: profiles, streams, OBS status
- Same mutations: startStream, stopStream, buildScene, startStreaming, stopStreaming
- Same UI structure but rebuilt with `Card`, `Button`, `Badge`, `Select` components
- Keep EntrantCard component (adapt to use CSS vars)

**VOD tab:** Port content from `VodRaceSetup.tsx`:
- 2-4 racer slot builder
- VOD URL inputs with offset
- Go-live button

**Replay tab:** Port content from `ReplaySetup.tsx`:
- Racetime URL input + resolve
- Entrant → profile mapping
- Recent replays list
- Go-live button

Each tab is its own component within the file (or extracted to `components/broadcast/LiveTab.tsx`, etc. if the file gets large).

**Key:** Preserve ALL existing functionality. This is a migration, not a rewrite of business logic. Copy the query/mutation hooks and handlers directly from the old pages. Only change the JSX to use the new component library.

**Verify:** `cd dashboard && npm run build` — test each tab.

---

### Task 9: Racers page (merge Profiles + Pool)

**Files:**
- Create: `dashboard/src/pages/Racers.tsx`

**Racers.tsx** — Two tabs: Roster / Import.

**Roster tab:** Port from `ProfileManager.tsx`:
- `DataGrid` showing all profiles
- Columns: display_name, twitch_channel, preferred_color (color dot), crop count, actions (edit, delete, view crops)
- Inline expandable editor for profile fields
- Create new profile button → `Modal` with form
- `SearchInput` for filtering by name/channel
- "View Crops" link navigates to `/crops/:profileId`

**Import tab:** Port from `RacerPool.tsx`:
- Pool list with `DataGrid`: name, twitch, leaderboard place, best time, imported badge
- "Sync Leaderboard" button (existing `syncPool()` API)
- Single import by URL (existing `importFromUrl()` API)
- `SearchInput` for filtering pool entries

**Verify:** `cd dashboard && npm run build`

---

### Task 10: Crops page (merge CropManager + BulkCrop)

**Files:**
- Create: `dashboard/src/pages/Crops.tsx`

**Crops.tsx** — Unified crop management.

**Layout:**
- Left panel: racer list (from profiles) with search
- Right panel: selected racer's crop profiles

When a racer is selected (or routed via `/crops/:profileId`), show:
- List of crop profiles for that racer
- Create/edit/delete/set-default actions
- Launch crop wizard button (existing `CropCreationWizard` component)

**Bulk Setup button:** Opens bulk crop flow (existing `BulkCropEditor` component).

Port existing components:
- `CropCanvas.tsx` — used as-is
- `CropCreationWizard.tsx` — used as-is
- `BulkCropEditor.tsx` — used as-is
- `BulkCropRacerList.tsx` — used as-is

The internal crop components are already well-built. This task wraps them in the new page shell with the sidebar racer picker.

**Verify:** `cd dashboard && npm run build`

---

### Task 11: Commentary page expansion

**Files:**
- Modify: `dashboard/src/pages/Commentary.tsx`

Restructure Commentary.tsx to use `Tabs`:

**Config tab:** Current configuration panel (presets, sliders, manual trigger, clear state). Port existing collapsible config section as the main content.

**TTS tab:** Current TTS panel. Port existing voice selectors + test buttons.

**Live Log tab:** Current live broadcast log + Twitch chat. Port existing conversation display + chat panel.

**Flavor tab:** Current flavor bank. Port existing flavor entry list + add form.

Keep ALL existing query/mutation hooks. Only restructure the JSX layout from collapsible accordions to tabs.

Personas and Voice Studio tabs are deferred to Phase 3 (require new DB tables + API routes).

**Verify:** `cd dashboard && npm run build`

---

### Task 12: VisionLab rename

**Files:**
- Create: `dashboard/src/pages/VisionLab.tsx` (copy of VisionDebug.tsx with renamed export)

Simple rename: copy `VisionDebug.tsx` to `VisionLab.tsx`, change export name. The old file stays for now (unreferenced). Update any header text from "Vision Debug" to "Vision Lab".

**Verify:** `cd dashboard && npm run build`

---

### Task 13: Migrate remaining pages to CSS vars

**Files:**
- Modify: `dashboard/src/pages/LearnMode.tsx`
- Modify: `dashboard/src/pages/KnowledgeManager.tsx`
- Modify: `dashboard/src/pages/VisionLab.tsx`

For each page, find-and-replace hardcoded dark theme classes:
- `bg-panel` → still works (mapped to `var(--bg-surface)` via Tailwind theme)
- `bg-surface` → still works (mapped to `var(--bg-base)`)
- `text-white` → `text-[var(--text-primary)]`
- `text-white/60` → `text-[var(--text-secondary)]`
- `text-white/30` or `text-white/40` → `text-[var(--text-muted)]`
- `border-white/10` → `border-[var(--border)]`
- `bg-white/5` → `bg-[var(--bg-elevated)]`
- `hover:bg-white/5` → `hover:bg-[var(--bg-elevated)]`

Note: Since Tailwind `@theme` block now maps `--color-panel` to `var(--bg-surface)`, the Tailwind color utilities `bg-panel`, `bg-surface` etc. already resolve through CSS vars. The main items to fix are the direct `text-white`, `border-white/10` etc. patterns.

This can be done incrementally — pages will still look correct in dark mode even without these changes, they just won't respond to light mode properly.

**Verify:** `cd dashboard && npm run build` — toggle to light mode, verify pages are readable.

---

### Task 14: Clean up old pages + verify Phase 2

**Files:**
- Delete: `dashboard/src/pages/SystemStatus.tsx` (absorbed into Dashboard)
- Delete: `dashboard/src/pages/StreamSetup.tsx` (absorbed into Broadcast)
- Delete: `dashboard/src/pages/RaceControl.tsx` (absorbed into Broadcast → Live)
- Delete: `dashboard/src/pages/VodRaceSetup.tsx` (absorbed into Broadcast → VOD)
- Delete: `dashboard/src/pages/ReplaySetup.tsx` (absorbed into Broadcast → Replay)
- Delete: `dashboard/src/pages/ProfileManager.tsx` (absorbed into Racers → Roster)
- Delete: `dashboard/src/pages/RacerPool.tsx` (absorbed into Racers → Import)
- Delete: `dashboard/src/pages/CropProfileManager.tsx` (absorbed into Crops)
- Delete: `dashboard/src/pages/BulkCropOnboarding.tsx` (absorbed into Crops)
- Delete: `dashboard/src/pages/VisionDebug.tsx` (renamed to VisionLab)
- Delete: `dashboard/src/components/Sidebar.tsx` (replaced by AppSidebar)

**IMPORTANT:** Only delete AFTER verifying all functionality has been ported to the new pages.

**Run:**
```bash
cd dashboard && npm run build
```

Verify no import errors. Walk through every page in the browser.

**Commit Phase 2.**

---

## Phase 3: New Features

### Task 15: Server — new DB tables + migrations

**Files:**
- Modify: `server/src/db/database.ts`

Add 4 new table interfaces to the `Database` type:

```typescript
export interface ScenePresetTable {
  id: string;
  name: string;
  description: string | null;
  racer_count: number;
  elements: string; // JSON
  background: string; // JSON
  is_builtin: number;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleBlockTable {
  id: string;
  type: string;
  source_url: string | null;
  title: string | null;
  scene_preset_id: string | null;
  commentary_enabled: number;
  commentary_persona_ids: string | null; // JSON
  scheduled_at: Date;
  duration_minutes: number | null;
  auto_broadcast: number;
  status: string;
  created_at: Date;
}

export interface CommentaryPersonaTable {
  id: string;
  name: string;
  role: string;
  system_prompt: string | null;
  personality: string | null;
  voice_id: string | null;
  is_active: number;
  created_at: Date;
}

export interface VoiceProfileTable {
  id: string;
  name: string;
  type: string;
  kokoro_voice_id: string | null;
  clip_count: number;
  quality_score: number | null;
  created_at: Date;
}
```

Add to `Database` interface:
```typescript
export interface Database {
  // ... existing 8 tables ...
  scene_presets: ScenePresetTable;
  schedule_blocks: ScheduleBlockTable;
  commentary_personas: CommentaryPersonaTable;
  voice_profiles: VoiceProfileTable;
}
```

Add `CREATE TABLE IF NOT EXISTS` statements to `runMigrations()` for all 4 tables (matching the SQL in the design doc).

**Verify:** `cd server && npm run build`

---

### Task 16: Server — Scene Preset API routes

**Files:**
- Create: `server/src/api/scenePresetRoutes.ts`
- Modify: `server/src/api/routes.ts` (mount new router)

CRUD routes:

```
GET    /api/scene-presets          → list all presets
GET    /api/scene-presets/:id      → get preset by id
POST   /api/scene-presets          → create preset
PUT    /api/scene-presets/:id      → update preset
DELETE /api/scene-presets/:id      → delete preset (not builtins)
```

Each handler uses Kysely `db` from route context. Standard JSON request/response. UUID generation via `crypto.randomUUID()`.

Mount in `routes.ts`:
```typescript
import { scenePresetRoutes } from './scenePresetRoutes.js';
// ...
router.use('/scene-presets', scenePresetRoutes(ctx));
```

**Verify:** `cd server && npm run build`

---

### Task 17: Server — Schedule API routes

**Files:**
- Create: `server/src/api/scheduleRoutes.ts`
- Modify: `server/src/api/routes.ts` (mount new router)

CRUD routes:

```
GET    /api/schedule               → list blocks (optional ?from=&to= date range)
GET    /api/schedule/:id           → get block by id
POST   /api/schedule               → create block
PUT    /api/schedule/:id           → update block
DELETE /api/schedule/:id           → delete block
POST   /api/schedule/:id/go-live   → manually trigger a scheduled block
```

Mount in `routes.ts`.

**Verify:** `cd server && npm run build`

---

### Task 18: Server — Persona + Voice Profile API routes

**Files:**
- Create: `server/src/api/personaRoutes.ts`
- Modify: `server/src/api/routes.ts` (mount new router)

Routes:

```
GET    /api/personas               → list personas
POST   /api/personas               → create persona
PUT    /api/personas/:id           → update persona
DELETE /api/personas/:id           → delete persona

GET    /api/voices                 → list voice profiles (custom + builtins)
POST   /api/voices                 → create voice profile
PUT    /api/voices/:id             → update voice profile
DELETE /api/voices/:id             → delete voice profile
POST   /api/voices/:id/test        → test voice (generate sample audio)
```

The `GET /api/voices` route should merge DB custom voices with the 8 Kokoro built-in voices (am_adam, am_michael, af_heart, af_nice, bf_emma, bf_isabella, bm_george, bm_lewis) so the frontend sees a unified list.

Mount in `routes.ts`.

**Verify:** `cd server && npm run build && nssm restart TTP.TV`

---

### Task 19: Server — Full leaderboard pagination

**Files:**
- Modify: `server/src/race/RacerPoolService.ts`

Current `syncLeaderboard()` only fetches page 1 of racetime.gg leaderboard. Modify to:

1. Fetch page 1, check for `next` pagination URL in response
2. Loop: fetch each subsequent page until `next` is null
3. Merge all entries into the upsert batch
4. Return total count

This enables importing all 269+ Z1R players instead of just the top ~30.

**Verify:** `cd server && npm run build`

---

### Task 20: Dashboard API layer — new endpoints

**Files:**
- Create: `dashboard/src/lib/sceneApi.ts`
- Create: `dashboard/src/lib/scheduleApi.ts`
- Create: `dashboard/src/lib/personaApi.ts`

Each file exports typed fetch wrappers for the new API routes, following the same pattern as existing `api.ts`:

```typescript
// Example: sceneApi.ts
import type { ScenePreset } from './types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function listScenePresets() { return request<ScenePreset[]>('/scene-presets'); }
export function getScenePreset(id: string) { return request<ScenePreset>(`/scene-presets/${id}`); }
// ... etc
```

**Verify:** `cd dashboard && npm run build`

---

### Task 21: Scene Builder page

**Files:**
- Create: `dashboard/src/pages/SceneBuilder.tsx`
- Modify: `dashboard/src/App.tsx` (add route)

**SceneBuilder.tsx** — Visual overlay editor.

**Phase 3 scope (MVP):**
- Preset library sidebar (list + CRUD)
- Scaled 1920×1080 canvas preview (CSS aspect-ratio container)
- Element list showing all elements in preset with position/size
- Click element → property inspector panel
- Drag-to-reposition on canvas (mouse events, CSS transform)
- Add/remove elements
- Save preset

**Canvas:** A `<div>` with `aspect-ratio: 16/9`, `max-width: 100%`, `position: relative`. Each element is an absolutely positioned `<div>` with border outline. Scale factor = container width / 1920.

**Element types** (from design doc): Player Feed, Extended HUD Strip, Triforce Race Bar, Seed Tracker Footer, Shared Map, Commentary Box, Timer, Event Footer, Chat Highlight, Replay Badge, Background, Custom Text.

**MVP simplification:** Elements are positioned/sized but render as labeled rectangles with type name + dimensions. Full element preview rendering is Phase 4.

**Inspector panel:** When an element is selected, show its properties as form fields (x, y, width, height, zIndex, locked, visible, plus type-specific config).

This is the most complex new page. Focus on getting the data model + CRUD + basic positioning working. Visual polish is Phase 4.

**Verify:** `cd dashboard && npm run build`

---

### Task 22: Schedule page

**Files:**
- Create: `dashboard/src/pages/Schedule.tsx`
- Modify: `dashboard/src/App.tsx` (add route)

**Schedule.tsx** — Content calendar.

**MVP scope:**
- Day view (default) showing time slots
- List of scheduled blocks with status badges (QUEUED / LIVE / COMPLETED / CANCELLED)
- Create block button → Modal with form:
  - Type selector (Live / VOD / Replay)
  - Source URL input
  - Title
  - Scene preset selector (from `listScenePresets()`)
  - Commentary toggle
  - Scheduled time picker
  - Auto-broadcast toggle
- Edit/delete existing blocks
- "Go Live" manual trigger button per block

Week view is Phase 4 polish.

**Verify:** `cd dashboard && npm run build`

---

### Task 23: Commentary — Personas + Voice Studio tabs

**Files:**
- Modify: `dashboard/src/pages/Commentary.tsx`

Add two new tabs to the existing Commentary Tabs component:

**Personas tab:**
- `DataGrid` listing personas: name, role (play-by-play / color), assigned voice, active toggle
- Create persona → Modal with form (name, role, system prompt, personality, voice selector)
- Edit/delete actions
- Uses `personaApi.ts` endpoints

**Voice Studio tab:**
- List of voice profiles (custom + built-in Kokoro voices)
- Built-in voices shown as read-only with Kokoro badge
- Create custom voice → Modal (name, placeholder for audio upload — actual training is future)
- Test playback button per voice
- Uses `personaApi.ts` voice endpoints

**Verify:** `cd dashboard && npm run build`

---

### Task 24: Learn Mode — playlist support

**Files:**
- Modify: `dashboard/src/pages/LearnMode.tsx`
- Modify: `dashboard/src/lib/learnApi.ts` (add playlist endpoint wrapper)
- Modify: `server/src/api/routes.ts` (add playlist endpoint if needed)

Add new source type options to Learn Mode session creation:

- **YouTube Playlist:** Input for YouTube playlist URL. Frontend extracts video count from URL format. Sends to server which queues sequential sessions.
- **Twitch Collection:** Input for Twitch collection URL. Same batch processing.

For MVP: Add the UI inputs and send to a new `/api/learn/batch` endpoint. Server-side batch processing can initially just create individual sessions sequentially.

Progress display: "Processing 3/12 videos" with `ProgressBar` component.

**Verify:** `cd dashboard && npm run build`

---

### Task 25: Verify Phase 3 + deploy

**Run:**
```bash
cd server && npm run build && nssm restart TTP.TV
cd dashboard && npm run build
```

Walk through:
- Scene Builder: create preset, add elements, save
- Schedule: create block, view in calendar
- Commentary: create persona, view voice profiles
- Learn Mode: playlist URL input visible
- Racers → Import: "Sync All" fetches all pages

**Commit Phase 3.**

---

## Phase 4: Polish

### Task 26: Empty states for all pages

**Files:**
- Modify: All new pages that can have empty data

Add `EmptyState` components for:
- Dashboard race feed: "No recent races. Check racetime.gg for active Z1R rooms."
- Broadcast Live: "No active race. Start a new broadcast or check the Schedule."
- Schedule: "No content scheduled. Create your first broadcast block."
- Scene Builder: "No presets yet. Create your first scene preset."
- Racers roster (empty): "No racer profiles. Import from the Racer Pool."
- Commentary personas (empty): "No personas configured. Create your first AI commentator."

Each uses the `EmptyState` component with appropriate icon + call-to-action button.

**Verify:** `cd dashboard && npm run build`

---

### Task 27: Error boundaries + loading states

**Files:**
- Create: `dashboard/src/ui/ErrorBoundary.tsx`
- Modify: `dashboard/src/App.tsx`

Create a React error boundary component that catches render errors and shows a friendly error card with:
- Error message
- "Reload Page" button
- Stack trace in collapsible details (dev only)

Wrap `<Routes>` in `<ErrorBoundary>` in App.tsx.

For loading states: ensure all pages using `useQuery` show a consistent loading spinner (use `Loader2` from lucide-react with `animate-spin`).

**Verify:** `cd dashboard && npm run build`

---

### Task 28: NES data treatment components

**Files:**
- Create: `dashboard/src/ui/nes/Hearts.tsx`
- Create: `dashboard/src/ui/nes/TriforceTracker.tsx`
- Create: `dashboard/src/ui/nes/NesCounter.tsx`
- Create: `dashboard/src/ui/nes/ItemIcon.tsx`

**Hearts:** Renders hearts as red `♥` glyphs in Press Start 2P font. Props: `current: number`, `max: number`. Full hearts = red, empty = outline/gray.

**TriforceTracker:** 8 triangles in a row. Props: `collected: number`. Collected = gold filled CSS triangles, uncollected = outline.

**NesCounter:** Pixel-font number with optional icon. Props: `value: number`, `icon?: 'rupee' | 'key' | 'bomb'`, `label?: string`.

**ItemIcon:** Renders 16×16 item sprite. Props: `item: string`. Uses `image-rendering: pixelated`. Sources from `/vision/templates/items/` (served as static files or bundled).

These are used in Vision Lab, Commentary racer state, and Broadcast entrant cards to give game data the NES-native feel.

**Verify:** `cd dashboard && npm run build`

---

### Task 29: Responsive sidebar + motion

**Files:**
- Modify: `dashboard/src/components/sidebar/AppSidebar.tsx`

Add responsive behavior:
- Below 768px width: sidebar collapses to icon-only rail (40px wide)
- Hover on collapsed sidebar: expands temporarily
- Toggle button at top to pin/unpin

Add motion per design doc:
- Sidebar collapse: 150ms width transition
- Card hover: 100ms background ease (add to `Card` component)
- Badge pulse: `LIVE` badge subtle breathing animation (add to `Badge` when `pulse` prop)

**Verify:** `cd dashboard && npm run build` — test at narrow viewport.

---

### Task 30: Final verification + deploy

**Run:**
```bash
# Server
cd server && npm run build

# Dashboard
cd dashboard && npm run build

# Server tests
cd server && npx vitest run

# Deploy
nssm restart TTP.TV
```

**Manual walkthrough:**
1. Dashboard home → stat cards, health panel
2. Broadcast → Live / VOD / Replay tabs all functional
3. Schedule → create block, view calendar
4. Scene Builder → create preset, position elements
5. Racers → Roster CRUD, Import + sync
6. Crops → per-racer view, bulk setup
7. Commentary → all tabs (Config, TTS, Live Log, Flavor, Personas, Voice Studio)
8. Learn Mode → playlist input visible
9. Knowledge Base → unchanged, working
10. Vision Lab → renamed, working
11. Settings → theme toggle works
12. Light mode → all pages readable
13. Dark mode → all pages look correct

**Commit Phase 4.**

---

## Verification

### Automated
```bash
# Server build
cd server && npm run build

# Dashboard build
cd dashboard && npm run build

# Server tests (existing + any new)
cd server && npx vitest run
```

### Manual
- Every page loads without errors
- All existing functionality preserved (streams, crops, commentary, learn mode, etc.)
- Light/dark theme toggle works across all pages
- Sidebar navigation works, sections collapse/expand
- New pages (Dashboard, Broadcast, Schedule, Scene Builder, Settings) render correctly

---

## Files Summary

| Action | File | Phase |
|--------|------|-------|
| New | `dashboard/src/styles/theme.css` | 1 |
| New | `dashboard/src/hooks/useTheme.ts` | 1 |
| Modify | `dashboard/src/index.css` | 1 |
| Modify | `dashboard/index.html` | 1 |
| New | `dashboard/src/ui/*.tsx` (14 components + index) | 1 |
| New | `dashboard/src/components/sidebar/AppSidebar.tsx` | 1 |
| New | `dashboard/src/components/sidebar/SidebarSection.tsx` | 1 |
| New | `dashboard/src/components/sidebar/SidebarLink.tsx` | 1 |
| Modify | `dashboard/src/App.tsx` | 1 |
| New | `dashboard/src/pages/Dashboard.tsx` | 1 |
| New | `dashboard/src/pages/Settings.tsx` | 1 |
| New | `dashboard/src/pages/Broadcast.tsx` | 2 |
| New | `dashboard/src/pages/Racers.tsx` | 2 |
| New | `dashboard/src/pages/Crops.tsx` | 2 |
| Modify | `dashboard/src/pages/Commentary.tsx` | 2, 3 |
| New | `dashboard/src/pages/VisionLab.tsx` | 2 |
| Modify | `dashboard/src/pages/LearnMode.tsx` | 2, 3 |
| Modify | `dashboard/src/pages/KnowledgeManager.tsx` | 2 |
| Delete | 11 old page files + old Sidebar.tsx | 2 |
| Modify | `server/src/db/database.ts` | 3 |
| New | `server/src/api/scenePresetRoutes.ts` | 3 |
| New | `server/src/api/scheduleRoutes.ts` | 3 |
| New | `server/src/api/personaRoutes.ts` | 3 |
| Modify | `server/src/api/routes.ts` | 3 |
| Modify | `server/src/race/RacerPoolService.ts` | 3 |
| New | `dashboard/src/lib/sceneApi.ts` | 3 |
| New | `dashboard/src/lib/scheduleApi.ts` | 3 |
| New | `dashboard/src/lib/personaApi.ts` | 3 |
| New | `dashboard/src/pages/SceneBuilder.tsx` | 3 |
| New | `dashboard/src/pages/Schedule.tsx` | 3 |
| New | `dashboard/src/ui/ErrorBoundary.tsx` | 4 |
| New | `dashboard/src/ui/nes/*.tsx` (4 components) | 4 |

~30 new files, ~12 modified files, ~12 deleted files. 30 tasks across 4 phases.
