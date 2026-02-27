import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { RacetimeApi } from './RacetimeApi.js';
import { type TwitchApiClient, parseTwitchDuration } from '../twitch/TwitchApiClient.js';
import { logger } from '../logger.js';

/** Seconds before race start to begin the VOD playback */
const PRE_ROLL_SECONDS = 15;

export function parseRacetimeSlug(url: string): string {
  const match = url.match(/racetime\.gg\/(.+?)(?:\?|$)/);
  return match?.[1] ?? url;
}

export function computeVodOffset(raceStart: Date, vodCreated: Date): number {
  return Math.round((raceStart.getTime() - vodCreated.getTime()) / 1000);
}

export interface ReplayEntrant {
  racetimeId: string;
  displayName: string;
  twitchChannel: string | null;
  vodUrl: string | null;
  vodOffsetSeconds: number;
  finishTime: string | null;
  place: number | null;
}

export interface ReplayData {
  id: string;
  racetimeUrl: string;
  raceStart: Date;
  raceEnd: Date | null;
  goal: string | null;
  seed: string | null;
  entrants: ReplayEntrant[];
}

export class ReplayOrchestrator extends EventEmitter {
  constructor(
    private racetimeApi: RacetimeApi,
    private twitchApi: TwitchApiClient,
    private db: Kysely<Database>,
  ) {
    super();
  }

  async resolveRace(racetimeUrl: string): Promise<ReplayData> {
    const slug = parseRacetimeSlug(racetimeUrl);
    const raceDetail = await this.racetimeApi.getRaceDetail(slug);

    if (!raceDetail.started_at) {
      throw new Error('Race has not started yet');
    }
    const raceStart = new Date(raceDetail.started_at);
    const raceEnd = raceDetail.ended_at ? new Date(raceDetail.ended_at) : null;

    const entrants: ReplayEntrant[] = [];

    for (const ent of raceDetail.entrants) {
      const twitchChannel = ent.user.twitch_name ?? null;
      let vodUrl: string | null = null;
      let vodOffsetSeconds = 0;

      if (twitchChannel && this.twitchApi.isConfigured()) {
        try {
          // Resolve Twitch login → user ID → recent VODs
          const users = await this.twitchApi.getUsersByLogins([twitchChannel]);
          if (users.length > 0) {
            const videos = await this.twitchApi.getVideosForUser(users[0].id, 20);
            logger.info(`[Replay] ${ent.user.name} (${twitchChannel}): ${videos.length} VODs found, race started ${raceStart.toISOString()}`);
            // Find VOD with the smallest positive offset that actually contains the race
            let bestOffset = Infinity;
            for (const v of videos) {
              const vodStart = new Date(v.created_at);
              const vodDuration = parseTwitchDuration(v.duration);
              const offset = computeVodOffset(raceStart, vodStart);
              // Offset must be positive (VOD started before race) and within VOD duration
              if (offset >= 0 && offset < vodDuration && offset < bestOffset) {
                vodUrl = v.url;
                vodOffsetSeconds = Math.max(0, offset - PRE_ROLL_SECONDS);
                bestOffset = offset;
                logger.info(`[Replay]   -> matched VOD: ${v.url} (created ${v.created_at}, duration ${v.duration}=${vodDuration}s, raceOffset=${offset}s, seekTo=${vodOffsetSeconds}s)`);
              } else if (offset >= 0) {
                logger.debug(`[Replay]   -> skipped VOD: ${v.url} (created ${v.created_at}, duration ${v.duration}=${vodDuration}s, offset=${offset}s — ${offset >= vodDuration ? 'offset exceeds duration' : 'not best match'})`);
              }
            }
            if (!vodUrl) {
              logger.warn(`[Replay] ${ent.user.name}: no VOD found covering race start`);
            }
          }
        } catch (err) {
          logger.warn(`[Replay] Failed to resolve VOD for ${twitchChannel}`, { err });
        }
      }

      entrants.push({
        racetimeId: ent.user.id,
        displayName: ent.user.name,
        twitchChannel,
        vodUrl,
        vodOffsetSeconds,
        finishTime: ent.finish_time ?? null,
        place: ent.place ?? null,
      });
    }

    const replay: ReplayData = {
      id: uuid(),
      racetimeUrl,
      raceStart,
      raceEnd,
      goal: raceDetail.goal?.name ?? null,
      seed: raceDetail.info ?? null,
      entrants,
    };

    // Persist
    await this.db.insertInto('race_replays').values({
      id: replay.id,
      racetime_url: racetimeUrl,
      race_start: raceStart,
      race_end: raceEnd,
      goal: replay.goal,
      seed: replay.seed,
      entrants: JSON.stringify(entrants),
    } as any).execute();

    return replay;
  }

  async getReplay(id: string): Promise<ReplayData | null> {
    const row = await this.db.selectFrom('race_replays')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      racetimeUrl: row.racetime_url,
      raceStart: new Date(row.race_start),
      raceEnd: row.race_end ? new Date(row.race_end) : null,
      goal: row.goal,
      seed: row.seed,
      entrants: typeof row.entrants === 'string' ? JSON.parse(row.entrants) : row.entrants as ReplayEntrant[],
    };
  }

  async listReplays(): Promise<Array<{ id: string; racetimeUrl: string; raceStart: Date; goal: string | null }>> {
    const rows = await this.db.selectFrom('race_replays')
      .select(['id', 'racetime_url', 'race_start', 'goal'])
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();

    return rows.map(r => ({
      id: r.id,
      racetimeUrl: r.racetime_url,
      raceStart: new Date(r.race_start),
      goal: r.goal,
    }));
  }
}
