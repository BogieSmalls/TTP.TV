import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger.js';

/**
 * Persists vision snapshots to a SQLite database with WAL mode.
 * Replaces the previous per-racer JSONL `appendFileSync` approach.
 *
 * Single DB file with a (race_id, racer_id, ts) index for efficient
 * per-racer-per-race queries and narrative generation.
 */
export class VisionLogDb {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`CREATE TABLE IF NOT EXISTS vision_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id TEXT NOT NULL,
      racer_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      screen_type TEXT,
      dungeon_level INTEGER,
      hearts_current INTEGER,
      hearts_max INTEGER,
      has_half_heart INTEGER,
      rupees INTEGER,
      keys_count INTEGER,
      bombs INTEGER,
      sword_level INTEGER,
      b_item TEXT,
      bomb_max INTEGER,
      map_position INTEGER,
      has_master_key INTEGER,
      gannon_nearby INTEGER,
      detected_item TEXT,
      detected_item_y INTEGER,
      items TEXT,
      triforce TEXT
    )`);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_race_racer_ts
      ON vision_snapshots (race_id, racer_id, ts)`);

    this.insertStmt = this.db.prepare(`INSERT INTO vision_snapshots (
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

    logger.info(`Vision log database opened: ${dbPath}`);
  }

  insert(raceId: string, racerId: string, state: Record<string, unknown>): void {
    try {
      this.insertStmt.run({
        race_id: raceId,
        racer_id: racerId,
        ts: Date.now(),
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
    } catch (err) {
      logger.warn(`Failed to insert vision snapshot for ${racerId}: ${err}`);
    }
  }

  close(): void {
    this.db.close();
    logger.info('Vision log database closed');
  }
}
