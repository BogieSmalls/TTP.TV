/**
 * Backfill existing JSONL vision logs into the SQLite vision-log.db.
 *
 * Usage: node scripts/backfill-vision-logs.mjs
 */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../../data');
const JSONL_DIR = resolve(DATA_DIR, 'race-logs');
const DB_PATH = resolve(DATA_DIR, 'vision-log.db');

// ─── Racer → Race ID mapping (from MySQL race_entrants) ───

const RACER_RACE_MAP = {
  // Race 1: 86afe1be (perfect-vire-5464, 05:16 UTC)
  '47b586d8-86cd-443e-92f9-24dfe79a974e': '86afe1be-d689-4b99-8eaa-8a1899e20ca6',
  '7c16dbdf-8354-4087-bdfe-940ebc161819': '86afe1be-d689-4b99-8eaa-8a1899e20ca6',
  'e5a7aade-e0eb-43ac-a463-57fb965fb374': '86afe1be-d689-4b99-8eaa-8a1899e20ca6',
  'e94cb11f-c150-4038-8a61-257144ad7f47': '86afe1be-d689-4b99-8eaa-8a1899e20ca6',

  // Race 2: b5c7f9ff (shiny-spectaclerock-3044, 17:12 UTC)
  '6b1d5396-5f8b-4866-8caa-82a60cf713ef': 'b5c7f9ff-2df0-45c5-85cc-ac3b8d033c68',
  'd73feac4-1c3c-4e14-a1ab-61523a257972': 'b5c7f9ff-2df0-45c5-85cc-ac3b8d033c68',

  // Race 3: 2188bcff (innocent-bait-1483, 20:00 UTC)
  '2572d5e4-fdd6-4e7b-a55f-3554baca37df': '2188bcff-3326-4ade-ba37-59be84b92ec9',
  '74b6ccb8-80a5-4e17-9b68-7926485d343f': '2188bcff-3326-4ade-ba37-59be84b92ec9',
  'c39916f1-da64-45b9-9054-fd2f61aacf1a': '2188bcff-3326-4ade-ba37-59be84b92ec9',

  // Race 4: 1a937a44 (artful-magicbombwall-4860, 23:03 UTC)
  '72cd9dda-95e9-42dc-8cd0-90dfa7335abf': '1a937a44-1548-4d8f-90bd-a19ddecc2581',
  '8e5ea1bf-94f4-4619-8e3a-bda5fe8b2ff7': '1a937a44-1548-4d8f-90bd-a19ddecc2581',
  'f9b91063-8ee5-4d69-9db4-be8e4c537bc8': '1a937a44-1548-4d8f-90bd-a19ddecc2581',
};

// 12eb22d7 spans TWO races — split by timestamp gap
const SPLIT_RACER = '12eb22d7-c230-4018-bc68-2dae53a162ff';
const SPLIT_RACE_BEFORE = '2188bcff-3326-4ade-ba37-59be84b92ec9';
const SPLIT_RACE_AFTER = '1a937a44-1548-4d8f-90bd-a19ddecc2581';
const GAP_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function getRaceId(racerId, ts, prevTs) {
  if (racerId === SPLIT_RACER) {
    // Detect gap: if >30 min since previous line, switch to second race
    if (prevTs !== null && (ts - prevTs) > GAP_THRESHOLD_MS) {
      return SPLIT_RACE_AFTER;
    }
    return null; // caller tracks state
  }
  return RACER_RACE_MAP[racerId] || 'unknown';
}

// ─── Main ───

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const insert = db.prepare(`INSERT INTO vision_snapshots (
  race_id, racer_id, ts, screen_type, dungeon_level,
  hearts_current, hearts_max, has_half_heart,
  rupees, keys_count, bombs, sword_level, b_item,
  bomb_max, map_position, has_master_key, gannon_nearby,
  detected_item, detected_item_y, items, triforce
) VALUES (
  @race_id, @racer_id, @ts, @screen_type, @dungeon_level,
  @hearts_current, @hearts_max, @has_half_heart,
  @rupees, @keys_count, @bombs, @sword_level, @b_item,
  @bomb_max, @map_position, @has_master_key, @gannon_nearby,
  @detected_item, @detected_item_y, @items, @triforce
)`);

// Wrap in a transaction for speed
const files = readdirSync(JSONL_DIR).filter(f => f.endsWith('.jsonl'));
let totalInserted = 0;
let totalSkipped = 0;

const insertAll = db.transaction(() => {
  for (const file of files) {
    const racerId = file.replace('.jsonl', '');
    const filePath = resolve(JSONL_DIR, file);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let fileInserted = 0;
    let currentRaceId = RACER_RACE_MAP[racerId] || (racerId === SPLIT_RACER ? SPLIT_RACE_BEFORE : 'unknown');
    let prevTs = null;

    for (const line of lines) {
      let state;
      try {
        state = JSON.parse(line);
      } catch {
        totalSkipped++;
        continue;
      }

      const ts = state.ts ?? state.lastUpdated ?? 0;

      // Handle split racer
      if (racerId === SPLIT_RACER && prevTs !== null && (ts - prevTs) > GAP_THRESHOLD_MS) {
        currentRaceId = SPLIT_RACE_AFTER;
      }
      prevTs = ts;

      insert.run({
        race_id: currentRaceId,
        racer_id: racerId,
        ts,
        screen_type: state.screen_type ?? null,
        dungeon_level: state.dungeon_level ?? null,
        hearts_current: state.hearts_current ?? null,
        hearts_max: state.hearts_max ?? null,
        has_half_heart: state.has_half_heart ? 1 : 0,
        rupees: state.rupees ?? null,
        keys_count: state.keys ?? null,
        bombs: state.bombs ?? null,
        sword_level: state.sword_level ?? null,
        b_item: state.b_item ?? null,
        bomb_max: state.bomb_max ?? null,
        map_position: state.map_position ?? null,
        has_master_key: state.has_master_key ? 1 : 0,
        gannon_nearby: state.gannon_nearby ? 1 : 0,
        detected_item: state.detected_item ?? null,
        detected_item_y: state.detected_item_y ?? null,
        items: state.items != null ? JSON.stringify(state.items) : null,
        triforce: state.triforce != null ? JSON.stringify(state.triforce) : null,
      });
      fileInserted++;
    }

    console.log(`  ${file}: ${fileInserted} rows (race: ${currentRaceId.slice(0, 8)}...)`);
    totalInserted += fileInserted;
  }
});

console.log(`\nBackfilling ${files.length} JSONL files into ${DB_PATH}...\n`);
insertAll();
console.log(`\nDone! Inserted ${totalInserted} rows, skipped ${totalSkipped} bad lines.`);

// Verify
const stats = db.prepare(`
  SELECT race_id, racer_id, COUNT(*) as rows, MIN(ts) as first_ts, MAX(ts) as last_ts
  FROM vision_snapshots
  GROUP BY race_id, racer_id
  ORDER BY first_ts
`).all();

console.log('\n─── Verification ───\n');
console.log('Race ID (first 8)  | Racer ID (first 8) | Rows   | Duration (min)');
console.log('───────────────────┼────────────────────┼────────┼───────────────');
for (const row of stats) {
  const dur = ((row.last_ts - row.first_ts) / 60000).toFixed(1);
  console.log(
    `${row.race_id.slice(0, 8)}...        | ${row.racer_id.slice(0, 8)}...        | ${String(row.rows).padStart(6)} | ${dur}`
  );
}

db.close();
