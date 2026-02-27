import { logger } from '../logger.js';
import type { Config } from '../config.js';
import type { RacetimeCategoryData, RacetimeRace, RacetimeLeaderboardData, RacetimeUser, RacetimePastRacesPage } from './types.js';
import { sanitizeRace } from './types.js';

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class RacetimeApi {
  private baseUrl = 'https://racetime.gg';
  private category: string;
  private _clockOffsetMs = 0;

  constructor(config: Config) {
    this.category = config.racetime.category;
  }

  get clockOffsetMs(): number {
    return this._clockOffsetMs;
  }

  async getCategoryData(): Promise<RacetimeCategoryData> {
    const raw = await this.get<RacetimeCategoryData>(`/${this.category}/data`);
    // Sanitize nested races to strip extra API fields (e.g. category back-references)
    raw.current_races = (raw.current_races ?? []).map(sanitizeRace);
    return raw;
  }

  async getLeaderboard(): Promise<RacetimeLeaderboardData> {
    return this.get<RacetimeLeaderboardData>(`/${this.category}/leaderboards/data`);
  }

  async getUserData(userId: string): Promise<RacetimeUser> {
    return this.get<RacetimeUser>(`/user/${userId}/data`);
  }

  async getPastRaces(page = 1): Promise<RacetimePastRacesPage> {
    return this.get<RacetimePastRacesPage>(`/${this.category}/races/data?page=${page}`);
  }

  async getRaceDetail(slug: string): Promise<RacetimeRace> {
    const raw = await this.get<RacetimeRace>(`/${slug}/data`);
    return sanitizeRace(raw);
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const localBefore = Date.now();

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    // Clock sync from X-Exact-Date header
    const exactDate = res.headers.get('X-Exact-Date');
    if (exactDate) {
      const serverTime = new Date(exactDate).getTime();
      const localAfter = Date.now();
      const localMid = (localBefore + localAfter) / 2;
      this._clockOffsetMs = localMid - serverTime;
    }

    if (res.status === 429) {
      throw new RateLimitError('racetime.gg rate limit hit');
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`racetime.gg ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }
}
