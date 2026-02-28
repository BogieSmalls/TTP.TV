# TTP.TV Visual Upgrade + Settings Configuration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the flat dark dashboard into a modern layered UI with royal blue accent, mesh gradient backgrounds, depth effects, Legend of Zelda wordmark, and a full Settings page for editing server configuration.

**Architecture:** CSS custom properties drive all theming. Visual changes are entirely in `theme.css` + UI components — no page logic changes. Settings requires 3 new server endpoints (`GET/PUT /config`, `POST /restart`) reading/writing `ttp.config.json`, plus a rewritten Settings page with 8 tabs of FormField inputs.

**Tech Stack:** TypeScript, React 19, Tailwind CSS 4, CSS custom properties, Express

**Design doc:** `docs/plans/2026-02-26-web3-visual-settings-design.md`

---

## Phase 1: Visual System Foundation

### Task 1: Zelda font asset + @font-face

**Files:**
- Create: `dashboard/src/fonts/zelda.ttf`
- Modify: `dashboard/src/index.css`

**Step 1:** Download the Legend of Zelda font `.ttf` file and place it at `dashboard/src/fonts/zelda.ttf`. The font is "The Legend of Zelda" by Zetavares Games (free for personal use). If unavailable, "Triforce" or "Hylian Serif" are alternatives. A web search will find the .ttf download link.

**Step 2:** Add `@font-face` to `dashboard/src/index.css` (after the existing Press Start 2P face):

```css
@font-face {
  font-family: 'Zelda';
  src: url('./fonts/zelda.ttf') format('truetype');
  font-weight: 400;
  font-display: swap;
}

.font-zelda {
  font-family: 'Zelda', 'Press Start 2P', monospace;
}
```

**Verify:** `cd dashboard && npm run build` — no errors.

---

### Task 2: Theme color overhaul — royal blue accent + gold game token

**Files:**
- Modify: `dashboard/src/styles/theme.css`

Rewrite `theme.css` with the new color system:

```css
/* Theme tokens — applied via data-theme on <html> */

:root,
[data-theme="dark"] {
  --bg-base: #0a0a12;
  --bg-surface: #12122a;
  --bg-elevated: #1c1c3a;
  --border: rgba(255,255,255,0.07);
  --text-primary: #e8e8f0;
  --text-secondary: rgba(255,255,255,0.55);
  --text-muted: rgba(255,255,255,0.28);

  /* Primary accent — royal blue */
  --accent: #6366f1;
  --accent-hover: #818cf8;
  --accent-subtle: rgba(99,102,241,0.12);

  /* Status colors */
  --success: #34D399;
  --danger: #F87171;
  --warning: #FBBF24;
  --info: #60A5FA;

  /* Gold — game data only */
  --gold: #D4AF37;
  --gold-dim: #B8941F;

  /* Depth shadows */
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.25);
  --shadow-lg: 0 16px 48px rgba(0,0,0,0.4);
  --shadow-glow-accent: 0 0 20px rgba(99,102,241,0.25);
  --shadow-glow-success: 0 0 16px rgba(52,211,153,0.15);
  --shadow-glow-danger: 0 0 16px rgba(248,113,113,0.15);
  --shadow-glow-warning: 0 0 16px rgba(251,191,36,0.15);
}

[data-theme="light"] {
  --bg-base: #f5f5f7;
  --bg-surface: #ffffff;
  --bg-elevated: #eeeef2;
  --border: rgba(0,0,0,0.08);
  --text-primary: #18181b;
  --text-secondary: rgba(0,0,0,0.6);
  --text-muted: rgba(0,0,0,0.35);

  --accent: #4f46e5;
  --accent-hover: #6366f1;
  --accent-subtle: rgba(79,70,229,0.08);

  --success: #16A34A;
  --danger: #DC2626;
  --warning: #D97706;
  --info: #3B82F6;

  --gold: #B8960F;
  --gold-dim: #8B7209;

  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
  --shadow-lg: 0 16px 48px rgba(0,0,0,0.12);
  --shadow-glow-accent: 0 0 20px rgba(79,70,229,0.15);
  --shadow-glow-success: 0 0 16px rgba(22,163,74,0.1);
  --shadow-glow-danger: 0 0 16px rgba(220,38,38,0.1);
  --shadow-glow-warning: 0 0 16px rgba(217,119,6,0.1);
}
```

**Verify:** `cd dashboard && npm run build` — no errors.

---

### Task 3: Mesh gradient background + typography refinements

**Files:**
- Modify: `dashboard/src/index.css`

Update the `body` rule and add the Tailwind `@theme` mappings for new tokens:

```css
@import "tailwindcss";
@import "./styles/theme.css";

@theme {
  --color-gold: var(--gold);
  --color-gold-dim: var(--gold-dim);
  --color-accent: var(--accent);
  --color-accent-dim: var(--accent-subtle);
  --color-panel: var(--bg-surface);
  --color-panel-light: var(--bg-elevated);
  --color-surface: var(--bg-base);
  --color-danger: var(--danger);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-info: var(--info);
}

@font-face {
  font-family: 'Press Start 2P';
  src: url('https://fonts.gstatic.com/s/pressstart2p/v15/e3t4euO8T-267oIAQAu6jDQyK3nVivM.woff2') format('woff2');
  font-weight: 400;
  font-display: swap;
}

@font-face {
  font-family: 'Zelda';
  src: url('./fonts/zelda.ttf') format('truetype');
  font-weight: 400;
  font-display: swap;
}

body {
  font-family: 'Inter', system-ui, sans-serif;
  color: var(--text-primary);
  margin: 0;
  background:
    radial-gradient(ellipse at 20% 0%, rgba(99,102,241,0.04), transparent 50%),
    radial-gradient(ellipse at 80% 100%, rgba(59,130,246,0.03), transparent 50%),
    var(--bg-base);
}

[data-theme="light"] body {
  background:
    radial-gradient(ellipse at 20% 0%, rgba(99,102,241,0.04), transparent 50%),
    radial-gradient(ellipse at 80% 100%, rgba(59,130,246,0.02), transparent 50%),
    var(--bg-base);
}

h1, h2, h3, h4, h5, h6 {
  letter-spacing: -0.02em;
}

.font-pixel {
  font-family: 'Press Start 2P', monospace;
}

.font-zelda {
  font-family: 'Zelda', 'Press Start 2P', monospace;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
```

**Verify:** `cd dashboard && npm run build` — load in browser, confirm subtle blue-tinted gradient on page background.

---

### Task 4: Card depth + gradient top-border

**Files:**
- Modify: `dashboard/src/ui/Card.tsx`

Rewrite Card to add shadow depth and optional gradient top-border:

```typescript
import type { ReactNode } from 'react';

interface CardProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  noPadding?: boolean;
  footer?: ReactNode;
  accentBorder?: boolean;
}

export function Card({ title, action, children, className = '', noPadding, footer, accentBorder }: CardProps) {
  return (
    <div
      className={`rounded-lg border transition-colors duration-100 ${className}`}
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border)',
        boxShadow: 'var(--shadow-sm)',
        borderTop: accentBorder ? '2px solid transparent' : undefined,
        borderImage: accentBorder ? 'linear-gradient(to right, var(--accent), transparent 80%) 1' : undefined,
      }}
    >
      {(title || action) && (
        <div
          className="flex items-center justify-between px-5 py-3.5 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          {title && (
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h3>
          )}
          {action && <div>{action}</div>}
        </div>
      )}
      <div className={noPadding ? '' : 'p-5'}>{children}</div>
      {footer && (
        <div
          className="px-5 py-3.5 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
```

**Verify:** `cd dashboard && npm run build`

---

### Task 5: StatCard with gradient border + status glow

**Files:**
- Modify: `dashboard/src/ui/StatCard.tsx`

Rewrite StatCard with gradient top-border and hover glow:

```typescript
import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  icon: ReactNode;
  status?: 'ok' | 'warn' | 'error';
  onClick?: () => void;
}

const statusColors: Record<string, { color: string; glow: string }> = {
  ok: { color: 'var(--success)', glow: 'var(--shadow-glow-success)' },
  warn: { color: 'var(--warning)', glow: 'var(--shadow-glow-warning)' },
  error: { color: 'var(--danger)', glow: 'var(--shadow-glow-danger)' },
};

export function StatCard({ label, value, icon, status, onClick }: StatCardProps) {
  const s = status ? statusColors[status] : null;
  return (
    <div
      className={`group rounded-lg border p-4 flex items-center gap-3 transition-all duration-150 ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border)',
        boxShadow: 'var(--shadow-sm)',
        borderTop: '2px solid transparent',
        borderImage: s
          ? `linear-gradient(to right, ${s.color}, transparent 80%) 1`
          : 'linear-gradient(to right, var(--accent), transparent 80%) 1',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (s) (e.currentTarget as HTMLDivElement).style.boxShadow = s.glow;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-sm)';
      }}
    >
      <div
        className="flex items-center justify-center w-10 h-10 rounded-lg"
        style={{
          background: s ? `${s.color}15` : 'var(--accent-subtle)',
          color: s ? s.color : 'var(--accent)',
        }}
      >
        {icon}
      </div>
      <div>
        <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
          {value}
        </p>
      </div>
    </div>
  );
}
```

**Verify:** `cd dashboard && npm run build`

---

### Task 6: Button with royal blue primary + hover glow

**Files:**
- Modify: `dashboard/src/ui/Button.tsx`

Update Button: primary uses `--accent`, add hover glow:

```typescript
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonProps) {
  const sizeClass = size === 'sm' ? 'px-2.5 py-1 text-xs gap-1.5' : 'px-3.5 py-2 text-sm gap-2';

  const variantStyle: Record<string, React.CSSProperties> = {
    primary: {
      background: 'var(--accent)',
      color: '#fff',
    },
    secondary: {
      background: 'var(--bg-elevated)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-secondary)',
    },
    danger: {
      background: 'var(--danger)',
      color: '#fff',
    },
  };

  return (
    <button
      className={`inline-flex items-center justify-center rounded-md font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${sizeClass} ${className}`}
      style={variantStyle[variant]}
      disabled={disabled || loading}
      onMouseEnter={(e) => {
        if (disabled || loading) return;
        if (variant === 'primary') {
          e.currentTarget.style.boxShadow = 'var(--shadow-glow-accent)';
          e.currentTarget.style.background = 'var(--accent-hover)';
        } else if (variant === 'ghost') {
          e.currentTarget.style.background = 'var(--bg-elevated)';
        } else if (variant === 'danger') {
          e.currentTarget.style.boxShadow = 'var(--shadow-glow-danger)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '';
        e.currentTarget.style.background = variantStyle[variant].background as string;
      }}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
```

**Verify:** `cd dashboard && npm run build`

---

### Task 7: Badge with gradient backgrounds

**Files:**
- Modify: `dashboard/src/ui/Badge.tsx`

Rewrite Badge to use gradient backgrounds:

```typescript
interface BadgeProps {
  variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  label: string;
  pulse?: boolean;
}

const variantStyles: Record<BadgeProps['variant'], { bg: string; text: string; dot: string }> = {
  success: {
    bg: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(52,211,153,0.05))',
    text: 'var(--success)',
    dot: 'var(--success)',
  },
  danger: {
    bg: 'linear-gradient(135deg, rgba(248,113,113,0.15), rgba(248,113,113,0.05))',
    text: 'var(--danger)',
    dot: 'var(--danger)',
  },
  warning: {
    bg: 'linear-gradient(135deg, rgba(251,191,36,0.15), rgba(251,191,36,0.05))',
    text: 'var(--warning)',
    dot: 'var(--warning)',
  },
  info: {
    bg: 'linear-gradient(135deg, rgba(96,165,250,0.15), rgba(96,165,250,0.05))',
    text: 'var(--info)',
    dot: 'var(--info)',
  },
  neutral: {
    bg: 'var(--bg-elevated)',
    text: 'var(--text-secondary)',
    dot: 'var(--text-muted)',
  },
};

export function Badge({ variant, label, pulse }: BadgeProps) {
  const s = variantStyles[variant];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium"
      style={{ background: s.bg, color: s.text }}
    >
      {pulse && (
        <span className="relative flex h-2 w-2">
          <span
            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: s.dot }}
          />
          <span
            className="relative inline-flex rounded-full h-2 w-2"
            style={{ background: s.dot }}
          />
        </span>
      )}
      {label}
    </span>
  );
}
```

**Verify:** `cd dashboard && npm run build`

---

### Task 8: Modal with enhanced backdrop + overlay shadow

**Files:**
- Modify: `dashboard/src/ui/Modal.tsx`

Update Modal to use stronger backdrop blur and overlay-tier shadow:

```typescript
import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 animate-[fadeIn_150ms_ease]"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
        onClick={onClose}
      />
      <div
        className="relative rounded-xl border w-full max-w-lg mx-4 max-h-[85vh] flex flex-col animate-[scaleIn_150ms_ease]"
        style={{
          background: 'var(--bg-surface)',
          borderColor: 'var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-xl leading-none cursor-pointer hover:opacity-70 transition-opacity"
            style={{ color: 'var(--text-muted)' }}
          >
            &times;
          </button>
        </div>
        <div className="p-5 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div
            className="px-5 py-4 border-t flex justify-end gap-2"
            style={{ borderColor: 'var(--border)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
```

**Verify:** `cd dashboard && npm run build`

---

### Task 9: SectionHeader with bolder weight

**Files:**
- Modify: `dashboard/src/ui/SectionHeader.tsx`

```typescript
import type { ReactNode } from 'react';

interface SectionHeaderProps {
  title: string;
  action?: ReactNode;
}

export function SectionHeader({ title, action }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-6">
      <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>
      {action && <div>{action}</div>}
    </div>
  );
}
```

**Verify:** `cd dashboard && npm run build`

---

### Task 10: Sidebar — Zelda wordmark + active link glow

**Files:**
- Modify: `dashboard/src/components/sidebar/AppSidebar.tsx`
- Modify: `dashboard/src/components/sidebar/SidebarLink.tsx`

**AppSidebar.tsx — Logo section:** Replace the diamond + TTP.TV text with Zelda font wordmark. Change the logo area:

```tsx
{/* Logo */}
<div className="px-3 py-4 border-b flex items-center gap-2 min-h-[60px]" style={{ borderColor: 'var(--border)' }}>
  {expanded ? (
    <div className="overflow-hidden">
      <span
        className="font-zelda text-xl tracking-wide whitespace-nowrap"
        style={{
          color: 'var(--text-primary)',
          textShadow: '0 2px 4px rgba(0,0,0,0.4)',
        }}
      >
        TTP.TV
      </span>
      <p className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
        TriforceTriplePlay
      </p>
    </div>
  ) : (
    <span
      className="font-zelda text-sm"
      style={{
        color: 'var(--text-primary)',
        textShadow: '0 2px 4px rgba(0,0,0,0.4)',
      }}
    >
      TTP
    </span>
  )}
</div>
```

**SidebarLink.tsx — Add inner glow on active:**

In the `style` callback, add `boxShadow` when active:

```typescript
style={({ isActive }) => ({
  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
  background: isActive ? 'var(--accent-subtle)' : undefined,
  borderLeftColor: !collapsed && isActive ? 'var(--accent)' : 'transparent',
  boxShadow: !collapsed && isActive ? 'inset 3px 0 12px -4px rgba(99,102,241,0.2)' : undefined,
})}
```

**Verify:** `cd dashboard && npm run build` — load in browser, confirm Zelda font logo, blue active link with glow.

---

### Task 11: Phase 1 verify + deploy

**Run:**
```bash
cd dashboard && npm run build
```

Load `http://localhost:3000/dashboard/` and verify:
- Zelda font "TTP.TV" wordmark (white in dark mode)
- Royal blue accent on active sidebar link, tabs, buttons
- Mesh gradient background visible (subtle blue tint)
- Cards have shadow depth + inner highlight
- StatCards have gradient top-border + glow on hover
- Badges have gradient backgrounds
- Toggle to light mode — everything reads correctly, "TTP.TV" is black

---

## Phase 2: Settings Configuration — Server Side

### Task 12: Config read/write helpers

**Files:**
- Modify: `server/src/config.ts`

Add two new functions after the existing `config` export:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';

// ... existing config code ...

/** Return config with secrets stripped/masked for dashboard display */
export function getEditableConfig(cfg: Config) {
  return {
    server: { port: cfg.server.port },
    rtmp: { port: cfg.rtmp.port, httpPort: cfg.rtmp.httpPort },
    obs: { url: cfg.obs.url, execPath: cfg.obs.execPath },
    twitch: {
      channel: cfg.twitch.channel,
      chatEnabled: cfg.twitch.chatEnabled,
      chatBufferSize: cfg.twitch.chatBufferSize,
      streamKey: cfg.twitch.streamKey ? '●●●●' + cfg.twitch.streamKey.slice(-4) : '',
    },
    racetime: {
      category: cfg.racetime.category,
      pollIntervalMs: cfg.racetime.pollIntervalMs,
      goalFilter: cfg.racetime.goalFilter,
    },
    vision: {
      fps: cfg.vision.fps,
      confidence: { ...cfg.vision.confidence },
    },
    canvas: { width: cfg.canvas.width, height: cfg.canvas.height },
    knowledgeBase: {
      chromaUrl: cfg.knowledgeBase.chromaUrl,
      chromaCollection: cfg.knowledgeBase.chromaCollection,
      ollamaUrl: cfg.knowledgeBase.ollamaUrl,
      embeddingModel: cfg.knowledgeBase.embeddingModel,
    },
    commentary: {
      model: cfg.commentary.model,
      ollamaUrl: cfg.commentary.ollamaUrl,
      periodicIntervalSec: cfg.commentary.periodicIntervalSec,
      cooldownSec: cfg.commentary.cooldownSec,
      maxTokens: cfg.commentary.maxTokens,
      temperature: cfg.commentary.temperature,
      historySize: cfg.commentary.historySize,
      kbChunksPerQuery: cfg.commentary.kbChunksPerQuery,
    },
    tts: {
      enabled: cfg.tts.enabled,
      serviceUrl: cfg.tts.serviceUrl,
      defaultVoice: cfg.tts.defaultVoice,
      speed: cfg.tts.speed,
      voices: { ...cfg.tts.voices },
    },
    tools: {
      ffmpegPath: cfg.tools.ffmpegPath,
      streamlinkPath: cfg.tools.streamlinkPath,
    },
  };
}

/** Deep-merge updates into ttp.config.json and write to disk */
export function writeConfigFile(updates: Record<string, unknown>): { restartRequired: boolean } {
  const configPath = resolve(import.meta.dirname, '../../ttp.config.json');
  const current = JSON.parse(readFileSync(configPath, 'utf-8'));

  // Hot-reloadable sections (no restart needed)
  const hotSections = new Set(['commentary', 'tts']);

  let restartRequired = false;

  for (const [section, values] of Object.entries(updates)) {
    if (!hotSections.has(section)) restartRequired = true;
    if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
      current[section] = { ...current[section], ...(values as Record<string, unknown>) };
    } else {
      current[section] = values;
    }
  }

  writeFileSync(configPath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  return { restartRequired };
}
```

**Verify:** `cd server && npm run build`

---

### Task 13: Config API endpoints

**Files:**
- Modify: `server/src/api/routes.ts`

Add three endpoints before the chat highlight route (around line 688). Import the new helpers at the top:

```typescript
import { getEditableConfig, writeConfigFile } from '../config.js';
```

Then add the routes:

```typescript
  // ─── Config Management ───

  router.get('/config', (_req, res) => {
    res.json(getEditableConfig(ctx.config));
  });

  router.put('/config', (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== 'object') {
        res.status(400).json({ error: 'Request body must be a JSON object' });
        return;
      }
      // Prevent writing secrets via this endpoint
      const forbidden = ['mysql', 'twitch.streamKey', 'twitch.oauthToken', 'twitch.clientId',
        'twitch.clientSecret', 'twitch.turboToken', 'obs.password', 'racetime.clientId', 'racetime.clientSecret'];
      for (const key of forbidden) {
        const [section, field] = key.split('.');
        if (field) {
          if (updates[section] && (updates[section] as Record<string, unknown>)[field] !== undefined) {
            delete (updates[section] as Record<string, unknown>)[field];
          }
        } else {
          delete updates[section];
        }
      }
      const result = writeConfigFile(updates);
      logger.info('[Config] Configuration updated', { sections: Object.keys(updates) });
      res.json({ status: 'saved', ...result });
    } catch (err) {
      logger.error('[Config] Failed to write config', { err });
      res.status(500).json({ error: 'Failed to write configuration' });
    }
  });

  router.post('/restart', (_req, res) => {
    logger.info('[Config] Server restart requested via API');
    res.json({ status: 'restarting' });
    setTimeout(() => process.exit(0), 500);
  });
```

**Verify:** `cd server && npm run build`

---

### Task 14: Server build + deploy

**Run:**
```bash
cd server && npm run build && nssm restart TTP.TV
```

Test endpoints manually:
```bash
curl http://localhost:3000/api/config | jq .
```

Confirm config JSON returned with masked secrets.

---

## Phase 3: Settings Page — Dashboard

### Task 15: Config API client

**Files:**
- Create: `dashboard/src/lib/configApi.ts`

```typescript
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
  return res.json();
}

export interface EditableConfig {
  server: { port: number };
  rtmp: { port: number; httpPort: number };
  obs: { url: string; execPath: string };
  twitch: {
    channel: string;
    chatEnabled: boolean;
    chatBufferSize: number;
    streamKey: string; // masked
  };
  racetime: { category: string; pollIntervalMs: number; goalFilter: string };
  vision: { fps: number; confidence: { digit: number; item: number; heart: number } };
  canvas: { width: number; height: number };
  knowledgeBase: {
    chromaUrl: string;
    chromaCollection: string;
    ollamaUrl: string;
    embeddingModel: string;
  };
  commentary: {
    model: string;
    ollamaUrl: string;
    periodicIntervalSec: number;
    cooldownSec: number;
    maxTokens: number;
    temperature: number;
    historySize: number;
    kbChunksPerQuery: number;
  };
  tts: {
    enabled: boolean;
    serviceUrl: string;
    defaultVoice: string;
    speed: number;
    voices: { play_by_play: string; color: string };
  };
  tools: { ffmpegPath: string; streamlinkPath: string };
}

export function getConfig() {
  return request<EditableConfig>('/config');
}

export function updateConfig(updates: Record<string, unknown>) {
  return request<{ status: string; restartRequired: boolean }>('/config', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export function restartServer() {
  return request<{ status: string }>('/restart', { method: 'POST' });
}
```

**Verify:** `cd dashboard && npm run build`

---

### Task 16: Settings page full rewrite

**Files:**
- Modify: `dashboard/src/pages/Settings.tsx`

Rewrite Settings.tsx with 8 tabs, each with editable FormField inputs and a Save button. The page:

1. Loads config via `useQuery(['config'], getConfig)`
2. Stores working copy in local state via `useState`
3. Each tab renders FormFields for its section
4. "Save" button calls `updateConfig()` mutation with only the changed section
5. Success shows a green toast message
6. If `restartRequired: true`, shows amber banner with "Restart Now" button
7. "Restart Now" calls `restartServer()`, then shows "Reconnecting..." with a polling loop

Tabs: General, Tools, OBS, Twitch, AI, Racetime, Broadcast, Display

Each tab is a function component within the file (e.g., `GeneralTab`, `ToolsTab`, etc.) receiving the config state and an `onSave` callback.

Input styling for all text/number fields:
```typescript
const inputClass = "w-full rounded-md border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]";
const inputStyle = { background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' };
```

Toggle styling for booleans: a styled switch (div with inner dot, transitions).

Masked secret fields: Displayed in a muted card at the bottom of the Twitch tab with a note "Edit secrets in .env on the server."

The full component will be ~300-400 lines. Each tab function is ~30-50 lines of FormFields.

**Verify:** `cd dashboard && npm run build` — navigate to Settings, confirm all 8 tabs render with correct values from the API.

---

### Task 17: Phase 3 verify + deploy

**Run:**
```bash
cd dashboard && npm run build
```

Walk through Settings:
- General tab: edit canvas width, save → success toast
- Tools tab: see ffmpeg/streamlink paths, editable
- OBS tab: see WebSocket URL
- Twitch tab: see channel name, chat toggle, masked stream key
- AI tab: see Ollama URL, model names
- Racetime tab: see category, poll interval, goal filter
- Broadcast tab: see vision FPS, TTS voice selectors
- Display tab: theme toggle (unchanged)
- Save a change → check `ttp.config.json` updated
- If restart required, click "Restart Now" → server restarts, dashboard reconnects

---

## Verification

### Automated
```bash
# Server build
cd server && npm run build

# Dashboard build
cd dashboard && npm run build

# Server tests (should still pass — no test changes)
cd server && npx vitest run
```

### Manual — Visual
1. Dashboard home: mesh gradient bg, blue accent cards, depth shadows
2. Sidebar: Zelda font "TTP.TV", blue active state with inner glow
3. StatCards: gradient top-border, glow on hover
4. Badges: gradient backgrounds (success/danger/warning/info)
5. Buttons: blue primary with hover glow
6. Modals: backdrop blur, overlay-tier shadow
7. Light mode: TTP.TV in black, all cards/badges readable, gradients adapt

### Manual — Settings
1. All 8 tabs load with real config values
2. Edit + Save works (check ttp.config.json on disk)
3. Restart button works (NSSM restarts, dashboard reconnects)
4. Secret fields are masked and not editable

---

## Files Summary

| Action | File | Phase |
|--------|------|-------|
| New | `dashboard/src/fonts/zelda.ttf` | 1 |
| Modify | `dashboard/src/styles/theme.css` | 1 |
| Modify | `dashboard/src/index.css` | 1 |
| Modify | `dashboard/src/ui/Card.tsx` | 1 |
| Modify | `dashboard/src/ui/StatCard.tsx` | 1 |
| Modify | `dashboard/src/ui/Button.tsx` | 1 |
| Modify | `dashboard/src/ui/Badge.tsx` | 1 |
| Modify | `dashboard/src/ui/Modal.tsx` | 1 |
| Modify | `dashboard/src/ui/SectionHeader.tsx` | 1 |
| Modify | `dashboard/src/components/sidebar/AppSidebar.tsx` | 1 |
| Modify | `dashboard/src/components/sidebar/SidebarLink.tsx` | 1 |
| Modify | `server/src/config.ts` | 2 |
| Modify | `server/src/api/routes.ts` | 2 |
| New | `dashboard/src/lib/configApi.ts` | 3 |
| Modify | `dashboard/src/pages/Settings.tsx` | 3 |

2 new files, 13 modified files. 17 tasks across 3 phases.
