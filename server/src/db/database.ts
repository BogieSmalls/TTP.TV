import { createPool as createPromisePool } from 'mysql2/promise';
import { createPool } from 'mysql2';
import { Kysely, MysqlDialect } from 'kysely';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

// ─── Kysely Database Types ───

export interface RacerProfileTable {
  id: string;
  racetime_id: string | null;
  racetime_name: string | null;
  display_name: string;
  twitch_channel: string;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  stream_width: number;
  stream_height: number;
  preferred_color: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RacetimeRacerTable {
  racetime_id: string;
  name: string;
  discriminator: string;
  full_name: string;
  twitch_name: string | null;
  twitch_channel: string | null;
  leaderboard_place: number | null;
  leaderboard_score: number | null;
  best_time: string | null;
  times_raced: number | null;
  last_synced_at: Date;
}

export interface CropProfileTable {
  id: string;
  racer_profile_id: string;
  label: string;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  stream_width: number;
  stream_height: number;
  grid_offset_dx: number;
  grid_offset_dy: number;
  screenshot_source: string | null;
  is_default: number;
  confidence: number | null;
  landmarks_json: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RaceTable {
  id: string;
  racetime_slug: string | null;
  racetime_url: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  racer_count: number | null;
  status: 'pending' | 'live' | 'finished' | 'cancelled';
  layout_type: 'two_player' | 'three_player' | 'four_player' | null;
  source_type: 'live' | 'vod';
  notes: string | null;
  created_at: Date;
}

export interface VodRaceEntrantTable {
  race_id: string;
  racer_id: string;
  vod_url: string;
  vod_source_type: 'twitch' | 'youtube' | 'direct';
  start_offset_seconds: number;
}

export interface RaceEntrantTable {
  race_id: string;
  racer_id: string;
  slot: number;
  finish_time: string | null;
  finish_place: number | null;
  status: 'racing' | 'finished' | 'forfeit' | 'dq';
}

export interface RaceEventTable {
  id: number;
  race_id: string;
  racer_id: string | null;
  event_type: string;
  description: string | null;
  timestamp: Date;
}

export interface RaceReplayTable {
  id: string;
  racetime_url: string;
  race_start: Date;
  race_end: Date | null;
  goal: string | null;
  seed: string | null;
  entrants: string; // JSON array
  created_at: Date;
}

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

export interface Database {
  racer_profiles: RacerProfileTable;
  crop_profiles: CropProfileTable;
  racetime_racers: RacetimeRacerTable;
  races: RaceTable;
  race_entrants: RaceEntrantTable;
  vod_race_entrants: VodRaceEntrantTable;
  race_events: RaceEventTable;
  race_replays: RaceReplayTable;
  scene_presets: ScenePresetTable;
  schedule_blocks: ScheduleBlockTable;
  commentary_personas: CommentaryPersonaTable;
  voice_profiles: VoiceProfileTable;
}

// ─── Database Initialization ───

let pool: ReturnType<typeof createPool>;
let db: Kysely<Database>;

export function initDatabase(config: Config): Kysely<Database> {
  pool = createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    database: config.mysql.database,
    user: config.mysql.user,
    password: config.mysql.password,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  db = new Kysely<Database>({
    dialect: new MysqlDialect({ pool: pool as any }),
  });

  logger.info('Database connection pool initialized', {
    host: config.mysql.host,
    database: config.mysql.database,
  });

  return db;
}

export function getDb(): Kysely<Database> {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (db) await db.destroy();
  if (pool) {
    await new Promise<void>((resolve, reject) => {
      pool.end((err) => (err ? reject(err) : resolve()));
    });
  }
  logger.info('Database connections closed');
}

// ─── Schema Migration ───

export async function runMigrations(config: Config): Promise<void> {
  const migrationPool = createPromisePool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    multipleStatements: true,
  });
  const conn = await migrationPool.getConnection();

  try {
    // Create database if not exists
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\``);
    await conn.query(`USE \`${config.mysql.database}\``);

    // Create tables
    await conn.query(`
      CREATE TABLE IF NOT EXISTS racer_profiles (
        id VARCHAR(36) PRIMARY KEY,
        racetime_id VARCHAR(64) UNIQUE,
        racetime_name VARCHAR(128),
        display_name VARCHAR(128) NOT NULL,
        twitch_channel VARCHAR(128) NOT NULL,
        crop_x INT DEFAULT 0,
        crop_y INT DEFAULT 0,
        crop_w INT DEFAULT 1920,
        crop_h INT DEFAULT 1080,
        stream_width INT DEFAULT 1920,
        stream_height INT DEFAULT 1080,
        preferred_color VARCHAR(7) DEFAULT '#D4AF37',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS racetime_racers (
        racetime_id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        discriminator VARCHAR(16) NOT NULL,
        full_name VARCHAR(160) NOT NULL,
        twitch_name VARCHAR(128),
        twitch_channel VARCHAR(256),
        leaderboard_place INT,
        leaderboard_score DECIMAL(10,2),
        best_time VARCHAR(32),
        times_raced INT,
        last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS crop_profiles (
        id VARCHAR(36) PRIMARY KEY,
        racer_profile_id VARCHAR(36) NOT NULL,
        label VARCHAR(128) NOT NULL,
        crop_x INT NOT NULL DEFAULT 0,
        crop_y INT NOT NULL DEFAULT 0,
        crop_w INT NOT NULL DEFAULT 1920,
        crop_h INT NOT NULL DEFAULT 1080,
        stream_width INT NOT NULL DEFAULT 1920,
        stream_height INT NOT NULL DEFAULT 1080,
        grid_offset_dx INT NOT NULL DEFAULT 0,
        grid_offset_dy INT NOT NULL DEFAULT 0,
        screenshot_source VARCHAR(512),
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        confidence DECIMAL(3,2),
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (racer_profile_id) REFERENCES racer_profiles(id) ON DELETE CASCADE,
        INDEX idx_crop_racer (racer_profile_id)
      )
    `);

    // Add landmarks_json column (idempotent)
    try {
      await conn.query(`ALTER TABLE crop_profiles ADD COLUMN landmarks_json TEXT DEFAULT NULL`);
    } catch {
      // Column already exists — ignore
    }

    // Migrate existing non-default crop data into crop_profiles
    await conn.query(`
      INSERT IGNORE INTO crop_profiles (id, racer_profile_id, label, crop_x, crop_y, crop_w, crop_h, stream_width, stream_height, is_default)
      SELECT UUID(), id, 'Default', crop_x, crop_y, crop_w, crop_h, stream_width, stream_height, 1
      FROM racer_profiles
      WHERE NOT (crop_x = 0 AND crop_y = 0 AND crop_w = 1920 AND crop_h = 1080)
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS races (
        id VARCHAR(36) PRIMARY KEY,
        racetime_slug VARCHAR(128),
        racetime_url VARCHAR(256),
        started_at DATETIME,
        ended_at DATETIME,
        racer_count INT,
        status ENUM('pending','live','finished','cancelled') DEFAULT 'pending',
        layout_type ENUM('two_player','three_player','four_player'),
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS race_entrants (
        race_id VARCHAR(36),
        racer_id VARCHAR(36),
        slot INT NOT NULL,
        finish_time VARCHAR(32),
        finish_place INT,
        status ENUM('racing','finished','forfeit','dq') DEFAULT 'racing',
        PRIMARY KEY (race_id, racer_id),
        FOREIGN KEY (race_id) REFERENCES races(id),
        FOREIGN KEY (racer_id) REFERENCES racer_profiles(id)
      )
    `);

    // Add source_type column to races (idempotent)
    try {
      await conn.query(`ALTER TABLE races ADD COLUMN source_type VARCHAR(8) DEFAULT 'live'`);
    } catch {
      // Column already exists — ignore
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS vod_race_entrants (
        race_id VARCHAR(36),
        racer_id VARCHAR(36),
        vod_url VARCHAR(512) NOT NULL,
        vod_source_type VARCHAR(16) DEFAULT 'twitch',
        start_offset_seconds INT DEFAULT 0,
        PRIMARY KEY (race_id, racer_id),
        FOREIGN KEY (race_id) REFERENCES races(id),
        FOREIGN KEY (racer_id) REFERENCES racer_profiles(id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS race_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        race_id VARCHAR(36) NOT NULL,
        racer_id VARCHAR(36),
        event_type VARCHAR(64) NOT NULL,
        description TEXT,
        timestamp DATETIME NOT NULL,
        FOREIGN KEY (race_id) REFERENCES races(id),
        INDEX idx_race_events_race (race_id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS race_replays (
        id VARCHAR(36) PRIMARY KEY,
        racetime_url VARCHAR(255) NOT NULL,
        race_start DATETIME NOT NULL,
        race_end DATETIME,
        goal TEXT,
        seed TEXT,
        entrants JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_replays_url (racetime_url)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS scene_presets (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        description TEXT,
        racer_count INT NOT NULL DEFAULT 2,
        elements JSON,
        background JSON,
        is_builtin TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS schedule_blocks (
        id VARCHAR(36) PRIMARY KEY,
        type VARCHAR(32) NOT NULL DEFAULT 'live',
        source_url VARCHAR(512),
        title VARCHAR(256),
        scene_preset_id VARCHAR(36),
        commentary_enabled TINYINT(1) NOT NULL DEFAULT 1,
        commentary_persona_ids JSON,
        scheduled_at DATETIME NOT NULL,
        duration_minutes INT,
        auto_broadcast TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'queued',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_schedule_at (scheduled_at),
        INDEX idx_schedule_status (status)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS commentary_personas (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'play-by-play',
        system_prompt TEXT,
        personality TEXT,
        voice_id VARCHAR(36),
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS voice_profiles (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        type VARCHAR(32) NOT NULL DEFAULT 'kokoro',
        kokoro_voice_id VARCHAR(64),
        clip_count INT NOT NULL DEFAULT 0,
        quality_score DECIMAL(3,2),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    logger.info('Database migrations completed');
  } finally {
    conn.release();
    await migrationPool.end();
  }
}
