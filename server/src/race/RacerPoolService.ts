import { v4 as uuid } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { RacetimeApi } from './RacetimeApi.js';
import { extractTwitchChannel } from './types.js';
import { logger } from '../logger.js';

export interface PoolEntry {
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
  profile_id: string | null;
  imported: boolean;
}

export class RacerPoolService {
  constructor(
    private db: Kysely<Database>,
    private api: RacetimeApi,
  ) {}

  /**
   * Fetch leaderboard from racetime.gg and upsert all racers into racetime_racers table.
   */
  async syncLeaderboard(): Promise<{ synced: number; total: number }> {
    logger.info('[pool] Syncing leaderboard from racetime.gg...');
    const data = await this.api.getLeaderboard();

    const beatTheGame = data.leaderboards.find(lb => lb.goal === 'Beat the game');
    if (!beatTheGame) {
      throw new Error('No "Beat the game" leaderboard found');
    }

    const now = new Date();
    let synced = 0;
    let failed = 0;

    for (const entry of beatTheGame.rankings) {
      try {
        await this.db.insertInto('racetime_racers')
          .values({
            racetime_id: entry.user.id,
            name: entry.user.name,
            discriminator: entry.user.discriminator,
            full_name: entry.user.full_name,
            twitch_name: entry.user.twitch_name,
            twitch_channel: entry.user.twitch_channel,
            leaderboard_place: entry.place,
            leaderboard_score: entry.score,
            best_time: entry.best_time,
            times_raced: entry.times_raced,
            last_synced_at: now,
          } as any)
          .onDuplicateKeyUpdate({
            name: entry.user.name,
            discriminator: entry.user.discriminator,
            full_name: entry.user.full_name,
            twitch_name: entry.user.twitch_name,
            twitch_channel: entry.user.twitch_channel,
            leaderboard_place: entry.place,
            leaderboard_score: entry.score,
            best_time: entry.best_time,
            times_raced: entry.times_raced,
            last_synced_at: now,
          })
          .execute();
        synced++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[pool] Failed to upsert racer #${entry.place} ${entry.user.full_name}: ${msg}`);
      }
    }

    const numRanked = (data as any).num_ranked ?? beatTheGame.rankings.length;
    logger.info(`[pool] Synced ${synced} racers from leaderboard (${numRanked} total ranked, ${failed} failed)`);
    return { synced, total: numRanked };
  }

  /**
   * Get all racers from the pool, annotated with whether they've been imported as profiles.
   */
  async getPool(): Promise<PoolEntry[]> {
    const rows = await this.db
      .selectFrom('racetime_racers as rr')
      .leftJoin('racer_profiles as rp', 'rr.racetime_id', 'rp.racetime_id')
      .select([
        'rr.racetime_id', 'rr.name', 'rr.discriminator', 'rr.full_name',
        'rr.twitch_name', 'rr.twitch_channel',
        'rr.leaderboard_place', 'rr.leaderboard_score',
        'rr.best_time', 'rr.times_raced', 'rr.last_synced_at',
        'rp.id as profile_id',
      ])
      .orderBy('rr.leaderboard_place', 'asc')
      .execute();

    return rows.map(r => ({
      ...r,
      imported: r.profile_id != null,
    }));
  }

  /**
   * Import a racer from the pool into racer_profiles.
   * Returns the profile ID (existing or newly created).
   */
  async importRacer(racetimeId: string): Promise<string> {
    const racer = await this.db.selectFrom('racetime_racers')
      .selectAll()
      .where('racetime_id', '=', racetimeId)
      .executeTakeFirst();

    if (!racer) {
      throw new Error(`Racer ${racetimeId} not found in pool`);
    }

    // Check if already imported
    const existing = await this.db.selectFrom('racer_profiles')
      .select('id')
      .where('racetime_id', '=', racetimeId)
      .executeTakeFirst();

    if (existing) return existing.id;

    const id = uuid();
    const channel = extractTwitchChannel(racer.twitch_channel) || racer.name.toLowerCase();

    await this.db.insertInto('racer_profiles').values({
      id,
      racetime_id: racer.racetime_id,
      racetime_name: racer.full_name,
      display_name: racer.name,
      twitch_channel: channel,
      crop_x: 0,
      crop_y: 0,
      crop_w: 1920,
      crop_h: 1080,
      stream_width: 1920,
      stream_height: 1080,
      preferred_color: '#D4AF37',
      notes: `Imported from Z1R leaderboard (rank #${racer.leaderboard_place})`,
    } as any).execute();

    logger.info(`[pool] Imported racer ${racer.full_name} as profile ${id}`);
    return id;
  }

  /**
   * Import a racer from a racetime.gg user URL.
   * Parses the userId from the URL, fetches user data, upserts into pool, then imports as profile.
   */
  async importFromUrl(url: string): Promise<{ profileId: string; displayName: string }> {
    const match = url.match(/racetime\.gg\/user\/([A-Za-z0-9]+)/);
    if (!match) {
      throw new Error('Invalid racetime.gg user URL. Expected format: https://racetime.gg/user/{userId}/...');
    }
    const userId = match[1];

    const userData = await this.api.getUserData(userId);

    const channel = extractTwitchChannel(userData.twitch_channel) || userData.name.toLowerCase();
    const now = new Date();

    // Upsert into racetime_racers pool
    await this.db.insertInto('racetime_racers')
      .values({
        racetime_id: userData.id,
        name: userData.name,
        discriminator: userData.discriminator,
        full_name: userData.full_name,
        twitch_name: userData.twitch_name,
        twitch_channel: userData.twitch_channel,
        leaderboard_place: null,
        leaderboard_score: null,
        best_time: null,
        times_raced: null,
        last_synced_at: now,
      } as any)
      .onDuplicateKeyUpdate({
        name: userData.name,
        discriminator: userData.discriminator,
        full_name: userData.full_name,
        twitch_name: userData.twitch_name,
        twitch_channel: userData.twitch_channel,
        last_synced_at: now,
      })
      .execute();

    // Import as racer profile
    const profileId = await this.importRacer(userData.id);

    logger.info(`[pool] Imported racer from URL: ${userData.full_name} (${profileId})`);
    return { profileId, displayName: userData.name };
  }
}
