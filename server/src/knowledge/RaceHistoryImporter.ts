import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { RacetimeApi } from '../race/RacetimeApi.js';
import { logger } from '../logger.js';

interface RacePageData {
  count: number;
  num_pages: number;
  races: Array<{
    name: string;
    status: { value: string };
    entrants_count: number;
    entrants: Array<{
      user: { id: string; name: string };
      status: { value: string };
      finish_time: string | null;
      place: number | null;
    }>;
    opened_at: string;
    started_at: string | null;
  }>;
}

interface RacerStats {
  racetime_id: string;
  name: string;
  races: number;
  wins: number;
  finishes: number;
  dnfs: number;
  totalTimeMs: number;
}

export class RaceHistoryImporter {
  constructor(
    private racetimeApi: RacetimeApi,
    private db: Kysely<Database>,
    private category: string,
  ) {}

  async importHistory(pages = 10): Promise<{ racesImported: number; racersUpdated: number }> {
    const stats = new Map<string, RacerStats>();
    let racesImported = 0;

    for (let page = 1; page <= pages; page++) {
      try {
        const data = await this.fetchRacePage(page);
        if (!data.races || data.races.length === 0) break;

        for (const race of data.races) {
          if (race.status.value !== 'finished') continue;
          racesImported++;

          for (const entrant of race.entrants) {
            const id = entrant.user.id;
            let s = stats.get(id);
            if (!s) {
              s = { racetime_id: id, name: entrant.user.name, races: 0, wins: 0, finishes: 0, dnfs: 0, totalTimeMs: 0 };
              stats.set(id, s);
            }
            s.races++;

            if (entrant.status.value === 'done' && entrant.finish_time) {
              s.finishes++;
              if (entrant.place === 1) s.wins++;
              s.totalTimeMs += this.parseDuration(entrant.finish_time);
            } else if (entrant.status.value === 'dnf') {
              s.dnfs++;
            }
          }
        }

        // Respect rate limits
        if (page < pages) {
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch (err) {
        logger.warn(`[HistoryImport] Failed on page ${page}`, { err });
        break;
      }
    }

    // Update racer stats in DB
    let racersUpdated = 0;
    for (const s of stats.values()) {
      try {
        const avgTime = s.finishes > 0
          ? this.formatDuration(Math.round(s.totalTimeMs / s.finishes))
          : null;

        await this.db.updateTable('racetime_racers')
          .set({ times_raced: s.races, best_time: avgTime })
          .where('racetime_id', '=', s.racetime_id)
          .execute();
        racersUpdated++;
      } catch {
        // racer not in our pool — skip
      }
    }

    logger.info(`[HistoryImport] Imported ${racesImported} races, updated ${racersUpdated} racers`);
    return { racesImported, racersUpdated };
  }

  private async fetchRacePage(page: number): Promise<RacePageData> {
    const url = `https://racetime.gg/${this.category}/races/data?page=${page}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`racetime.gg ${res.status}: ${await res.text().catch(() => '')}`);
    }

    return res.json() as Promise<RacePageData>;
  }

  private parseDuration(iso: string): number {
    // Parse ISO 8601 duration like "P0DT1H23M45.678S"
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
    if (!match) return 0;
    const h = parseInt(match[1] ?? '0', 10);
    const m = parseInt(match[2] ?? '0', 10);
    const s = parseFloat(match[3] ?? '0');
    return (h * 3600 + m * 60 + s) * 1000;
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
