# TTP.TV Visual Upgrade + Settings Configuration — Design Document

**Date:** 2026-02-26
**Status:** Approved
**Style:** Refined Depth — layered surfaces, mesh gradient backgrounds, royal blue accent, gold reserved for NES/Zelda game data

---

## Philosophy

The dashboard redesign (Phase 1-4) delivered structure and functionality. This pass delivers **visual identity and configuration access**. The goal is to take the current flat dark UI and add modern depth, warmth, and personality — while making the system configurable without SSH.

---

## Part A: Visual System Overhaul

### Brand Identity

- **Logo:** "TTP.TV" rendered in Legend of Zelda font (~20-24px). White in dark mode, black in light mode. Subtle `text-shadow: 0 2px 4px rgba(0,0,0,0.4)` for depth. No diamond/icon — the font is the brand.
- **Font file:** Bundled as local asset in `dashboard/src/fonts/zelda.ttf`, loaded via `@font-face`.
- **Subtitle:** "TriforceTriplePlay" remains below in Inter, muted text color.

### Color System

**Primary accent — Royal Blue:**
| Token | Dark | Light |
|-------|------|-------|
| `--accent` | `#6366f1` | `#4f46e5` |
| `--accent-subtle` | `rgba(99,102,241,0.12)` | `rgba(79,70,229,0.08)` |
| `--accent-hover` | `#818cf8` | `#6366f1` |

**Status/semantic colors:**
| Token | Dark | Light | Usage |
|-------|------|-------|-------|
| `--success` | `#34D399` | `#16A34A` | Connected, healthy, finished |
| `--danger` | `#F87171` | `#DC2626` | Errors, disconnected |
| `--warning` | `#FBBF24` | `#D97706` | Alerts, degraded |
| `--info` | `#60A5FA` | `#3B82F6` | Informational badges |

**Gold — game data only:**
| Token | Value | Usage |
|-------|-------|-------|
| `--gold` | `#D4AF37` | Triforce pieces, NES counters, pixel-font game elements |
| `--gold-dim` | `#B8941F` | Muted gold for inactive triforce slots |

Gold never appears in UI chrome (buttons, links, sidebar, tabs). It is exclusively for NES/Zelda-themed game data rendered in Press Start 2P font.

### Page Background — Mesh Gradient

Replace flat solid backgrounds with subtle radial mesh gradients:

**Dark mode:**
```css
background:
  radial-gradient(ellipse at 20% 0%, rgba(99,102,241,0.04), transparent 50%),
  radial-gradient(ellipse at 80% 100%, rgba(59,130,246,0.03), transparent 50%),
  #0a0a12;
```

**Light mode:**
```css
background:
  radial-gradient(ellipse at 20% 0%, rgba(99,102,241,0.04), transparent 50%),
  radial-gradient(ellipse at 80% 100%, rgba(59,130,246,0.02), transparent 50%),
  #f8f8fa;
```

The gradients are barely perceptible — they add warmth and depth without distraction. Applied to `body` or the main layout container.

### Card Depth System (3 Tiers)

**Tier 1 — Surface** (main content cards):
```css
background: var(--bg-surface);
border: 1px solid var(--border);
box-shadow: 0 1px 3px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.03);
```

**Tier 2 — Elevated** (nested panels, popovers):
```css
background: var(--bg-elevated);
border: 1px solid var(--border);
box-shadow: 0 4px 12px rgba(0,0,0,0.15);
```

**Tier 3 — Overlay** (modals, command palette):
```css
background: var(--bg-surface);
border: 1px solid var(--border);
box-shadow: 0 16px 48px rgba(0,0,0,0.3);
backdrop-filter: blur(12px);
```

Light mode: shadows become softer (`rgba(0,0,0,0.05)` base) and cards gain visible depth without borders being the sole separator.

### Gradient Top-Border on Feature Cards

StatCards and featured panels get a gradient top border for visual punch:

```css
border-top: 2px solid transparent;
border-image: linear-gradient(to right, var(--accent), transparent 80%) 1;
```

Status-themed StatCards use their status color in the gradient instead of accent.

### Interactive Effects

**Button hover glow (primary):**
```css
.btn-primary:hover {
  box-shadow: 0 0 20px rgba(99,102,241,0.3);
}
```

**StatCard hover glow:** Glow color matches status:
```css
/* ok status */
box-shadow: 0 0 16px rgba(52,211,153,0.15);
/* error status */
box-shadow: 0 0 16px rgba(248,113,113,0.15);
```

**Sidebar active link inner glow:**
```css
box-shadow: inset 3px 0 12px -4px rgba(99,102,241,0.2);
```

### Badge Polish

Badges use gradient backgrounds instead of flat:
```css
/* success */
background: linear-gradient(135deg, rgba(52,211,153,0.15), rgba(52,211,153,0.05));
/* danger */
background: linear-gradient(135deg, rgba(248,113,113,0.15), rgba(248,113,113,0.05));
```

### Typography Refinements

- Headings: `letter-spacing: -0.02em` for tighter, modern feel
- Section headers (`SectionHeader`): `font-weight: 700`
- `font-variant-numeric: tabular-nums` on all number displays
- Logo: `font-family: 'Zelda', sans-serif` via @font-face

### Modal Enhancement

```css
.modal-backdrop {
  backdrop-filter: blur(8px);
  background: rgba(0,0,0,0.5);
}
.modal-content {
  box-shadow: 0 16px 48px rgba(0,0,0,0.3);
  animation: scaleIn 200ms ease-out;
}
```

---

## Part B: Settings Configuration Page

### Server-Side: Config Read/Write API

**`GET /api/config`** — Returns non-secret config values:

```typescript
{
  server: { port: 3000 },
  rtmp: { port: 1935, httpPort: 8888 },
  obs: { url: "ws://127.0.0.1:4466" },           // password excluded
  twitch: {
    channel: "TriforceTriplePlay",
    chatEnabled: false,
    chatBufferSize: 100,
    streamKey: "●●●●●●●●",                        // masked, read-only
  },
  racetime: { category: "z1r", pollIntervalMs: 30000, goalFilter: "TTP Season 4" },
  vision: { fps: 2, confidence: { digit: 0.75, item: 0.70, heart: 0.60 } },
  canvas: { width: 1920, height: 1080 },
  knowledgeBase: {
    chromaUrl: "http://localhost:8100",
    chromaCollection: "z1r_knowledge",
    ollamaUrl: "http://localhost:11434",
    embeddingModel: "nomic-embed-text",
  },
  commentary: {
    model: "qwen2.5:32b",
    periodicIntervalSec: 20,
    cooldownSec: 8,
    maxTokens: 150,
    temperature: 0.8,
    historySize: 20,
    kbChunksPerQuery: 3,
  },
  tts: {
    enabled: false,
    serviceUrl: "http://127.0.0.1:5123",
    defaultVoice: "af_heart",
    speed: 1.0,
    voices: { play_by_play: "am_adam", color: "bf_emma" },
  },
  tools: {
    ffmpegPath: "C:/Users/bogie/AppData/.../ffmpeg.exe",
    streamlinkPath: "C:/Program Files/Streamlink/bin/streamlink.exe",
  },
}
```

**Excluded from response:** `twitch.streamKey` (masked), `twitch.oauthToken`, `twitch.clientId`, `twitch.clientSecret`, `twitch.turboToken`, `obs.password`, `racetime.clientId`, `racetime.clientSecret`, all `mysql.*`.

**`PUT /api/config`** — Accepts partial config object. Deep-merges into loaded config, writes `ttp.config.json`. Returns `{ status: 'saved', restartRequired: boolean }`. The `restartRequired` flag is true if any field outside of commentary/tts (which are hot-reloadable) was changed.

**`POST /api/restart`** — Calls `process.exit(0)`. NSSM auto-restarts the service. Returns `{ status: 'restarting' }` (response may not arrive if process exits first — dashboard handles this gracefully with a reconnect loop).

### Implementation

**Config helpers in `server/src/config.ts`:**
- `getEditableConfig(config: Config)` — returns sanitized config object (strips secrets, masks stream key)
- `writeConfigFile(updates: Partial<...>)` — reads `ttp.config.json`, deep-merges updates, writes back. Only touches `ttp.config.json` fields — `.env` values are never written.

### Settings Page — 8 Tabs

| Tab | Fields | Input Types |
|-----|--------|-------------|
| **General** | server.port, canvas.width, canvas.height | Number inputs |
| **Tools** | tools.ffmpegPath, tools.streamlinkPath | Text inputs with file-path styling |
| **OBS** | obs.url, obs.execPath | Text inputs |
| **Twitch** | twitch.channel, twitch.chatEnabled, twitch.chatBufferSize, twitch.streamKey (masked, read-only) | Text, toggle, number |
| **AI** | knowledgeBase.ollamaUrl, knowledgeBase.chromaUrl, knowledgeBase.chromaCollection, knowledgeBase.embeddingModel, commentary.model | Text inputs |
| **Racetime** | racetime.category, racetime.pollIntervalMs, racetime.goalFilter | Text, number |
| **Broadcast** | vision.fps, vision.confidence.*, tts.serviceUrl, tts.defaultVoice, tts.speed, tts.voices.play_by_play, tts.voices.color, tts.enabled | Number, select, toggle, range |
| **Display** | Theme (light/dark/system) | Segmented toggle (existing) |

### UX Flow

1. User navigates to Settings
2. Current config loaded via `GET /api/config`
3. User edits fields in any tab
4. Clicks "Save" → `PUT /api/config` with changed fields only
5. Success toast: "Settings saved"
6. If `restartRequired: true`, amber banner: "Some changes require a restart." + "Restart Now" button
7. "Restart Now" → `POST /api/restart` → dashboard shows "Reconnecting..." overlay → auto-reconnects when server is back

### Secret Fields Display

Secret fields appear in a grayed-out "Secrets" card at the bottom of relevant tabs:
```
Stream Key: ●●●●●●●●4900
OAuth Token: ●●●●●●●●
Client ID: ●●●●●●●●
Edit these in the .env file on the server.
```

---

## File Impact Summary

| Action | File | Scope |
|--------|------|-------|
| Modify | `dashboard/src/styles/theme.css` | Royal blue tokens, gold as game-data token, mesh gradient bg |
| Modify | `dashboard/src/index.css` | Zelda @font-face, letter-spacing, mesh gradient on body |
| New | `dashboard/src/fonts/zelda.ttf` | Legend of Zelda font file |
| Modify | `dashboard/src/ui/Card.tsx` | Shadow depth tiers, gradient top-border prop |
| Modify | `dashboard/src/ui/StatCard.tsx` | Gradient border, status glow on hover |
| Modify | `dashboard/src/ui/Button.tsx` | Royal blue primary, hover glow |
| Modify | `dashboard/src/ui/Badge.tsx` | Gradient backgrounds |
| Modify | `dashboard/src/ui/Modal.tsx` | Backdrop blur, overlay shadow tier |
| Modify | `dashboard/src/components/sidebar/AppSidebar.tsx` | Zelda font logo, remove diamond |
| Modify | `dashboard/src/components/sidebar/SidebarLink.tsx` | Blue active state, inner glow |
| Modify | `dashboard/src/components/sidebar/SidebarSection.tsx` | Refined section header styling |
| Rewrite | `dashboard/src/pages/Settings.tsx` | Full 8-tab config editor |
| New | `dashboard/src/lib/configApi.ts` | getConfig, updateConfig, restartServer |
| Modify | `server/src/config.ts` | getEditableConfig(), writeConfigFile() |
| Modify | `server/src/api/routes.ts` | GET/PUT /config, POST /restart |

15 files touched. No new DB tables. No new npm dependencies.
