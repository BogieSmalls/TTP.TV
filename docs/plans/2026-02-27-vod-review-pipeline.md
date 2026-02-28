# VOD Review Pipeline — Gap Closure Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make VOD processing (learn_mode.py) use native-resolution HUD extraction, and make the dashboard timeline display full HUD data, human-readable map position, and a Twitch deep-link button.

**Architecture:** Five independent changes that together close every known gap: (1) native resolution in batch processing, (2) HUD fields surfaced through the TypeScript API boundary, (3) HUD data rendered in the snapshot viewer, (4) map position shown as C,R coordinates, (5) Twitch VOD deep-link per snapshot. A sixth task adds game events (deaths, triforce, etc.) as markers on the timeline scrubber.

**Tech Stack:** Python (OpenCV / NumPy), TypeScript/React, Tailwind v4

---

## Background — what each gap is

| Gap | Root cause | Impact |
|-----|-----------|--------|
| learn_mode.py doesn't call `set_native_frame()` | The native-res pipeline was added for live streams only | HUD reads in batch use lossy 256×240 canonical; same errors the live stream had before the fix |
| Hearts/rupees/keys/bombs never reach dashboard | `LearnSnapshot` TypeScript interface stops at 7 fields; Python sends 13 | Can't verify HUD accuracy in review |
| Map position shows as `#23` | SnapshotViewer converts nothing; MapGrid (review mode only) has the converter | Unreadable in main playback mode |
| No Twitch deep-link | Source URL + videoTimestamp both exist; nobody wired them up | Manual timestamp lookup for every frame you want to verify |
| Game events (deaths, triforce) invisible on scrubber | `game_events` in report is parsed but never rendered in TimelineScrubber | Miss important moments when scrubbing |

---

## Task 1 — Native resolution in learn_mode.py

**Files:**
- Modify: `vision/learn_mode.py` (around line 496–506, the per-frame detect block)

**Context:**
The live stream pipeline calls `detector.set_native_frame(frame, cx, cy, cw, ch)` before every `detect()` call so HudReader can extract tiles at stream resolution instead of from the 256×240 downscale. learn_mode.py never calls this — it only feeds the canonical frame. The crop is already known (`cx, cy, cw, ch` from `crop_result`).

**Step 1: Verify the failing behaviour**

Run the detector manually on a known frame at canonical vs native to confirm the difference:
```bash
cd vision
py - <<'EOF'
import cv2, numpy as np, sys; sys.path.insert(0,'.')
from detector.nes_state import NesStateDetector
CROP=(544,0,1376,1080)
frame = cv2.imread('tests/fixtures/bogie_v2708_t1051.png')
cx,cy,cw,ch = CROP
can = cv2.resize(frame[cy:cy+ch,cx:cx+cw],(256,240),interpolation=cv2.INTER_NEAREST)
det = NesStateDetector('templates',grid_offset=(2,0),life_row=5)
# WITHOUT native
state_no_native = det.detect(can)
print(f"No native: rupees={state_no_native.rupees} bombs={state_no_native.bombs} b_item={state_no_native.b_item}")
# WITH native
det2 = NesStateDetector('templates',grid_offset=(2,0),life_row=5)
det2.set_native_frame(frame,cx,cy,cw,ch)
state_native = det2.detect(can)
det2.clear_native_frame()
print(f"Native:    rupees={state_native.rupees} bombs={state_native.bombs} b_item={state_native.b_item}")
EOF
```
Expected: `No native` reads may differ (wrong rupees/bombs/b_item). `Native` should read correctly.

**Step 2: Add `set_native_frame` / `clear_native_frame` to the per-frame loop**

In `vision/learn_mode.py`, find the block around line 496–506:

```python
        nes_region = ...
        nes_canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)

        # Detect with optional temporal smoothing
        if buffer:
            raw_state, stable_state = buffer.get_raw_and_stable(nes_canonical)
        else:
            raw_state = nes_detector.detect(nes_canonical)
            stable_state = raw_state
```

Replace with:

```python
        nes_region = ...
        nes_canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)

        # Feed native-resolution frame so HudReader extracts tiles at stream
        # resolution instead of from the lossy 256×240 canonical downscale.
        nes_detector.set_native_frame(frame, cx, cy, cw, ch)
        try:
            # Detect with optional temporal smoothing
            if buffer:
                raw_state, stable_state = buffer.get_raw_and_stable(nes_canonical)
            else:
                raw_state = nes_detector.detect(nes_canonical)
                stable_state = raw_state
        finally:
            nes_detector.clear_native_frame()
```

**Step 3: Verify it works on a short VOD clip**

Run learn_mode.py on a 30-second slice of the known VOD:
```bash
cd vision
py learn_mode.py \
  --source "https://www.twitch.tv/videos/2708726412" \
  --start-time 1040 --end-time 1070 \
  --fps 2 --snapshot-interval 2 \
  --snapshots-dir /tmp/test_native_learn \
  --output /tmp/test_native_learn/report.json
```
Expected: Runs without error. Check `/tmp/test_native_learn/report.json` — rupees, bombs, b_item values should match the fixture ground truth (rupees=3, bombs=3, b_item=red_candle around t=1051).

**Step 4: Commit**
```bash
git add vision/learn_mode.py
git commit -m "fix: use native-resolution frame extraction in learn_mode.py"
```

---

## Task 2 — HUD fields in `LearnSnapshot` TypeScript interface

**Files:**
- Modify: `dashboard/src/lib/learnApi.ts` (lines 64–78, `LearnSnapshot` interface)

**Context:**
Python's `save_snapshot()` already puts `heartsCurrent`, `heartsMax`, `rupees`, `keys`, `bombs`, `bombMax` in every snapshot dict. The TypeScript interface only declares 7 fields — the rest are silently dropped when the JSON is deserialized.

**Step 1: Add the missing fields to `LearnSnapshot`**

In `dashboard/src/lib/learnApi.ts`, replace the `LearnSnapshot` interface:

```typescript
export interface LearnSnapshot {
  filename: string;
  reason: 'transition' | 'interval';
  frame: number;
  videoTimestamp: number;
  screenType: string;
  dungeonLevel: number;
  hasMasterKey: boolean;
  gannonNearby: boolean;
  mapPosition: number;
  swordLevel: number;
  bItem: string;
  extra: string;
  positionConfidence?: 'high' | 'medium' | 'low';
  // HUD counters — collected by Python, now surfaced to the dashboard
  heartsCurrent?: number;
  heartsMax?: number;
  rupees?: number;
  keys?: number;
  bombs?: number;
  bombMax?: number;
}
```

**Step 2: Build and verify TypeScript compiles**
```bash
cd dashboard
npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors (the fields are optional so no existing call sites break).

**Step 3: Commit**
```bash
git add dashboard/src/lib/learnApi.ts
git commit -m "feat: add HUD fields (hearts/rupees/keys/bombs) to LearnSnapshot type"
```

---

## Task 3 — Display HUD data in SnapshotViewer

**Files:**
- Modify: `dashboard/src/components/learn/SnapshotViewer.tsx` (lines 143–170, the metadata inline div)

**Context:**
The metadata strip currently shows: `timestamp | screen | Lx | Swx | B:item | MK | ROAR | #pos`.
We need to add `♥ cur/max | ¤ NN | key NN | bomb NN` when any of those fields are non-zero.
Keep it compact — all on the same line, small text, standard symbols.

**Step 1: Add HUD display to the metadata line**

Replace the `{/* Metadata inline */}` div (lines 143–170) with:

```tsx
        {/* Metadata inline */}
        <div className="flex items-center gap-2 ml-auto text-xs text-white/50">
          <span className="font-mono text-white/80">{formatTimestampLong(snap.videoTimestamp)}</span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: screenColor }} />
            {snap.screenType}
          </span>
          {snap.dungeonLevel > 0 && (
            <span className="text-red-400 font-medium text-[11px]">L{snap.dungeonLevel}</span>
          )}
          {snap.swordLevel > 0 && (
            <span className="text-blue-300 text-[11px]">Sw{snap.swordLevel}</span>
          )}
          {snap.bItem && snap.bItem !== '' && (
            <span className="text-purple-300 text-[11px]">B:{snap.bItem}</span>
          )}
          {snap.hasMasterKey && (
            <span className="text-yellow-300 font-medium text-[11px]">MK</span>
          )}
          {snap.gannonNearby && (
            <span className="text-red-500 font-bold text-[11px]">ROAR</span>
          )}
          {/* HUD counters */}
          {(snap.heartsCurrent != null || snap.heartsMax != null) && (
            <span className="text-pink-300 text-[11px]">
              ♥{snap.heartsCurrent ?? 0}/{snap.heartsMax ?? 3}
            </span>
          )}
          {snap.rupees != null && snap.rupees > 0 && (
            <span className="text-yellow-200 text-[11px]">¤{snap.rupees}</span>
          )}
          {snap.keys != null && snap.keys > 0 && (
            <span className="text-white/70 text-[11px]">🗝{snap.keys}</span>
          )}
          {snap.bombs != null && snap.bombs > 0 && (
            <span className="text-orange-300 text-[11px]">💣{snap.bombs}</span>
          )}
          {snap.mapPosition > 0 && (
            <span className="text-white/40 text-[11px]">#{snap.mapPosition}</span>
          )}
          {snap.reason === 'transition' && snap.extra && (
            <span className="text-gold text-[11px]">{snap.extra}</span>
          )}
        </div>
```

**Step 2: Build dashboard**
```bash
cd dashboard && npm run build 2>&1 | tail -5
```

**Step 3: Verify visually**
Open the dashboard, navigate to Learn Mode, open any completed session. In snapshot playback, the metadata line should now show hearts (♥1/3), rupees (¤59), etc. when they're non-zero.

**Step 4: Commit**
```bash
git add dashboard/src/components/learn/SnapshotViewer.tsx
git commit -m "feat: display hearts/rupees/keys/bombs in snapshot viewer metadata"
```

---

## Task 4 — Map position as C,R coordinates in SnapshotViewer

**Files:**
- Modify: `dashboard/src/components/learn/SnapshotViewer.tsx` (the `mapPosition` span added above)
- Reference: `dashboard/src/components/learn/MapGrid.tsx` for the position-to-CR conversion

**Context:**
`mapPosition` is a raw NES room byte (0–127 overworld, 0–63 dungeon). The MapGrid already has a helper that converts it to column/row. We need to replicate that in SnapshotViewer.

Overworld: 16 columns × 8 rows → `col = (pos % 16) + 1`, `row = Math.floor(pos / 16) + 1`
Dungeon: 8 columns × 8 rows → `col = (pos % 8) + 1`, `row = Math.floor(pos / 8) + 1`

**Step 1: Add the position formatter**

At the top of `SnapshotViewer.tsx`, before the component function, add:

```typescript
function formatMapPos(pos: number, dungeonLevel: number): string {
  if (pos <= 0) return '';
  if (dungeonLevel > 0) {
    const col = (pos % 8) + 1;
    const row = Math.floor(pos / 8) + 1;
    return `C${col}R${row}`;
  }
  const col = (pos % 16) + 1;
  const row = Math.floor(pos / 16) + 1;
  return `C${col}R${row}`;
}
```

**Step 2: Replace the raw `#pos` span**

Change:
```tsx
          {snap.mapPosition > 0 && (
            <span className="text-white/40 text-[11px]">#{snap.mapPosition}</span>
          )}
```
To:
```tsx
          {snap.mapPosition > 0 && (
            <span className="text-white/40 text-[11px]">
              {formatMapPos(snap.mapPosition, snap.dungeonLevel)}
            </span>
          )}
```

**Step 3: Build and verify**
```bash
cd dashboard && npm run build 2>&1 | tail -5
```
Open a session with dungeon frames — position should show `C5R3` not `#36`.

**Step 4: Commit**
```bash
git add dashboard/src/components/learn/SnapshotViewer.tsx
git commit -m "feat: show map position as C,R coordinates in snapshot viewer"
```

---

## Task 5 — Twitch VOD deep-link button

**Files:**
- Modify: `dashboard/src/components/learn/SnapshotViewer.tsx`
- Modify: `dashboard/src/components/learn/TimelineReview.tsx` (to pass `sessionSource` down)
- Reference: `dashboard/src/lib/learnApi.ts` — `LearnSession.source` is the VOD URL

**Context:**
Each snapshot has a `videoTimestamp` (seconds). Each session has a `source` URL (e.g. `https://www.twitch.tv/videos/2708726412`). Twitch VOD deep links use `?t=XhYmZs` format. This lets you click from any snapshot straight to the exact point in the VOD.

**Step 1: Add `sessionSource` prop to SnapshotViewer**

In `SnapshotViewer.tsx`, add `sessionSource?: string` to the props interface:

```typescript
interface SnapshotViewerProps {
  sessionId: string;
  sessionSource?: string;   // ← add this
  snapshots: LearnSnapshot[];
  currentIndex: number;
  setCurrentIndex: (i: number) => void;
  isPlaying: boolean;
  setIsPlaying: (p: boolean) => void;
  playbackSpeed: number;
  setPlaybackSpeed: (s: number) => void;
}
```

**Step 2: Add the deep-link button**

Add a helper function (after `formatMapPos`):

```typescript
function twitchDeepLink(source: string | undefined, seconds: number): string | null {
  if (!source) return null;
  const match = source.match(/twitch\.tv\/videos\/(\d+)/);
  if (!match) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const t = h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`;
  return `https://www.twitch.tv/videos/${match[1]}?t=${t}`;
}
```

Then in the controls row (after the speed buttons, before the metadata), add:

```tsx
        {/* Twitch deep-link */}
        {twitchDeepLink(sessionSource, snap.videoTimestamp) && (
          <a
            href={twitchDeepLink(sessionSource, snap.videoTimestamp)!}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 px-1.5 py-0.5 rounded text-[11px] text-purple-300 hover:text-purple-100 hover:bg-white/10 transition-colors"
            title="Open in Twitch"
          >
            ▶ twitch
          </a>
        )}
```

**Step 3: Pass `sessionSource` from TimelineReview**

In `TimelineReview.tsx`, find where `SnapshotViewer` is rendered and add the prop:

```tsx
<SnapshotViewer
  sessionId={sessionId}
  sessionSource={session.source}   // ← add this
  snapshots={snapshots}
  ...
/>
```

The `session` object is already available from the `useQuery` call in `TimelineReview.tsx`.

**Step 4: Build and verify**
```bash
cd dashboard && npm run build 2>&1 | tail -5
```
Open a Twitch VOD session → click "▶ twitch" → opens browser to the exact timestamp.

**Step 5: Commit**
```bash
git add dashboard/src/components/learn/SnapshotViewer.tsx dashboard/src/components/learn/TimelineReview.tsx
git commit -m "feat: add Twitch VOD deep-link button per snapshot"
```

---

## Task 6 — Game events on timeline scrubber

**Files:**
- Modify: `dashboard/src/components/learn/TimelineScrubber.tsx`
- Modify: `dashboard/src/components/learn/TimelineReview.tsx` (pass `gameEvents` prop)

**Context:**
`LearnReport.game_events` contains frame-level events: `death`, `up_a_warp`, `triforce_inferred`, `heart_container`, `ganon_fight`, etc. Each has a `frame` number. The scrubber already renders annotation dots — we add a second row of colored triangles for game events, mapped to timeline position by `videoTimestamp = frame / fps`.

**Step 1: Add `gameEvents` and `fps` props to TimelineScrubber**

In `TimelineScrubber.tsx`, extend the props interface:

```typescript
interface TimelineScrubberProps {
  snapshots: LearnSnapshot[];
  annotations: LearnAnnotation[];
  currentIndex: number;
  onSeek: (index: number) => void;
  gameEvents?: Array<{ frame: number; event: string; description: string; dungeon_level: number }>;
  fps?: number;
}
```

**Step 2: Add event markers to the canvas draw function**

Find the canvas draw logic in `TimelineScrubber.tsx`. After the existing annotation dot rendering, add:

```typescript
  // Game event markers — small colored triangles at top of bar
  const EVENT_COLORS: Record<string, string> = {
    death: '#ef4444',          // red
    up_a_warp: '#f97316',      // orange
    triforce_inferred: '#eab308', // yellow/gold
    game_complete: '#22c55e',  // green
    heart_container: '#ec4899', // pink
    ganon_fight: '#a855f7',    // purple
    ganon_kill: '#8b5cf6',     // violet
  };

  if (gameEvents && fps && totalDuration > 0) {
    for (const ev of gameEvents) {
      const evTs = ev.frame / fps;
      const ex = Math.round((evTs / totalDuration) * width);
      const color = EVENT_COLORS[ev.event] ?? '#6b7280';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(ex, 4);
      ctx.lineTo(ex - 3, 11);
      ctx.lineTo(ex + 3, 11);
      ctx.closePath();
      ctx.fill();
    }
  }
```

**Step 3: Pass `gameEvents` and `fps` from TimelineReview**

In `TimelineReview.tsx`:
```tsx
<TimelineScrubber
  snapshots={snapshots}
  annotations={annotations}
  currentIndex={currentIndex}
  onSeek={setCurrentIndex}
  gameEvents={session.report?.game_events}
  fps={session.report ? (session.report.total_frames / session.report.video_duration_s) : 2}
/>
```

**Step 4: Add tooltip on hover**

In the canvas `mousemove` handler, check if cursor is near a game event marker and show its `description` in the tooltip. (Look for the existing hover/tooltip logic in `TimelineScrubber.tsx` and extend it.)

**Step 5: Build and verify**
```bash
cd dashboard && npm run build 2>&1 | tail -5
```
Open a session with known deaths/triforce events — colored triangles should appear on the scrubber at the correct positions. Hover over them for description.

**Step 6: Commit**
```bash
git add dashboard/src/components/learn/TimelineScrubber.tsx dashboard/src/components/learn/TimelineReview.tsx
git commit -m "feat: show game events (death/triforce/warp) as markers on timeline scrubber"
```

---

## Final verification — run the full VOD

After all tasks are done, run a learn session on the target VOD and verify everything end-to-end:

```bash
# From dashboard: Learn Mode page
# Source: https://www.twitch.tv/videos/2708726412
# FPS: 2
# Training mode: ON (snapshot interval: 2s)
# Start: (leave empty for full VOD, or narrow to a test range first)
```

Or from CLI for faster iteration on a 5-minute slice:
```bash
cd vision
py learn_mode.py \
  --source "https://www.twitch.tv/videos/2708726412" \
  --start-time 900 --end-time 1200 \
  --fps 2 --snapshot-interval 2 \
  --server http://localhost:3000
```

Then in the dashboard:
- [ ] Snapshot playback at 1x shows ♥, ¤, key, bomb values on each frame
- [ ] Map position shows as `C5R3` (not `#36`)
- [ ] Deaths and triforce events appear as colored triangles on scrubber
- [ ] "▶ twitch" link on each snapshot opens correct timestamp in browser
- [ ] HUD values match what you see in the Twitch video at those timestamps

---

## Summary of changes

| File | Change |
|------|--------|
| `vision/learn_mode.py` | Add `set_native_frame` / `clear_native_frame` around each detect call |
| `dashboard/src/lib/learnApi.ts` | Add 6 HUD fields to `LearnSnapshot` interface |
| `dashboard/src/components/learn/SnapshotViewer.tsx` | Display HUD data + C,R map position + Twitch link |
| `dashboard/src/components/learn/TimelineReview.tsx` | Pass `sessionSource` + `gameEvents`/`fps` to children |
| `dashboard/src/components/learn/TimelineScrubber.tsx` | Render game event triangles on canvas |
