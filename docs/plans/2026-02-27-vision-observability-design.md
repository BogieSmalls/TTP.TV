# Vision Observability Design

**Date:** 2026-02-27
**Status:** Approved
**Component:** VisionLab dashboard page

---

## Problem

Vision is producing data of unknown quality. Commentary consumes vision output blindly and produces garbage (false deaths every 10 seconds, fixation on triforce, repetition). There is no way to watch what vision is detecting in real-time and verify accuracy against a known VOD. The existing VisionLab shows only event notifications — not the underlying game state that generated them.

## Process Contract

This component is built first. Before touching commentary or overlay:

1. Build VisionLab enhancements
2. User runs a VOD session against a known race
3. User verifies each item in the Definition of Done
4. Any failures are fixed before moving on

No exceptions. Feedback given during verification will be acted on immediately, not deferred to a future plan.

---

## Design

### Per-Racer State Cards

One card per active racer. Updates in real-time on every `vision:update` socket event.

**Top strip:**
- Screen type badge: `OVERWORLD` / `DUNGEON-3` / `SUBSCREEN` / `DEATH` / `TITLE` — color-coded
- Death counter badge: red if >3 deaths in 60s, shows "14 deaths" count
- HUD values inline: hearts as ♥/♡ icons (current/max), rupees, keys, bombs, sword level, B-item name, triforce pieces collected

**Visual Minimap (main area of card):**

*Overworld mode* — 16×8 grid of actual room tile images:
- Source: `content/overworld_rooms/C{col}_R{row}.jpg` served via Express `/content` static route
- Current room: gold border + glow
- Visited rooms (this session): full brightness
- Unvisited rooms: 30% opacity
- Switches to this mode when `screen_type` is `overworld`

*Dungeon mode* — 8×8 color grid (no tile art for dungeons):
- Gray = unvisited, dim teal = visited, gold = current position
- Dungeon level label above grid: `LEVEL 3`
- Switches to this mode when `screen_type` is `dungeon`

*Other modes* (subscreen, death, title, transition):
- Last-known minimap stays visible (dimmed)
- Screen type badge updates to reflect current state

### Event Log Panel

Positioned below the racer cards, full width.

- Last 100 events (up from current 50)
- Color-coded by priority:
  - Red: `death`, `game_complete`, `ganon_kill`, `triforce_inferred`, `ganon_fight`
  - Yellow: `heart_container`, `dungeon_first_visit`, `sword_upgrade`, `staircase_item_acquired`
  - Dim: `up_a_warp`, `item_pickup`, `item_drop`, `subscreen_open`, `b_item_change`
- Each entry: timestamp, racer name, event type badge, description text
- **Death Rate Alarm:** Red banner at top of page if any racer exceeds 3 deaths in 60 seconds — "⚠ FALSE DEATH LIKELY: [racerName] has 14 deaths in 5 min"

---

## Implementation

### Server change (1 line)
Add static file serving for room tile images:
```typescript
app.use('/content', express.static('content'));
```

### Dashboard change (VisionLab.tsx)

Replace the existing basic event log with:
1. `vision:update` socket listener → update per-racer state map + visited rooms set
2. Per-racer state cards (screen type, HUD, minimap)
3. Enhanced event log (100 events, death counter, death rate alarm)

Key data sources:
- `vision:update` payload: `{ racerId, state: GameState }` — contains `screen_type`, `hearts`, `hearts_max`, `rupees`, `keys`, `bombs`, `sword`, `b_item`, `triforce_count`, `overworld_col`, `overworld_row`, `dungeon_level`, `dungeon_col`, `dungeon_row`
- `vision:events` payload: `{ racerId, events: [{ type, description, priority }] }`

---

## Definition of Done

1. **Minimap updates in real-time:** Start a VOD session → open VisionLab → the overworld grid highlights the correct room as the racer moves. Cross-referenceable with the VOD video.

2. **Screen type is accurate:** When the racer opens their subscreen, the badge changes to `SUBSCREEN`. When they die, it shows `DEATH` briefly then returns. If it's showing `DEATH` 14 times in 5 minutes, the false-death bug is confirmed.

3. **Hearts are correct:** Heart icons match what's visible in the VOD frame. If they show 3/8 hearts and the VOD shows 5/8, we have a reading problem to fix.

4. **Death alarm works:** Running against a session with known false deaths triggers the red banner.

---

## What This Does NOT Include

- Dungeon room tile art (don't have it — color grid only)
- Minimap in the broadcast overlay (separate component, designed separately)
- Commentary fixes (after vision is verified)
- Overlay changes (after vision is verified)
