import type { Config } from '../config.js';
import { logger } from '../logger.js';

// ─── Twitch Helix API types ───

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export interface TwitchChannelInfo {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  game_name: string;
  game_id: string;
  broadcaster_language: string;
  title: string;
  tags: string[];
}

export interface TwitchCategory {
  id: string;
  name: string;
  box_art_url: string;
}

export interface TwitchVideo {
  id: string;
  user_id: string;
  user_login: string;
  title: string;
  url: string;
  created_at: string;
  duration: string; // e.g. "3h2m15s"
  view_count: number;
  thumbnail_url: string;
}

interface AppToken {
  accessToken: string;
  expiresAt: number; // Date.now() + ttl
}

interface HelixResponse<T> {
  data: T[];
  pagination?: { cursor?: string };
}

// ─── Duration parser ───

export function parseTwitchDuration(duration: string): number {
  const match = duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match) return 0;
  return (
    parseInt(match[1] || '0') * 3600 +
    parseInt(match[2] || '0') * 60 +
    parseInt(match[3] || '0')
  );
}

// ─── Client ───

export class TwitchApiClient {
  private token: AppToken | null = null;
  private clientId: string;
  private clientSecret: string;
  private userToken: string; // User OAuth token for channel management

  constructor(private config: Config) {
    this.clientId = config.twitch.clientId;
    this.clientSecret = config.twitch.clientSecret;
    this.userToken = config.twitch.oauthToken;
  }

  /** Check if credentials are configured */
  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  // ─── OAuth: client_credentials flow ───

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('Twitch API credentials not configured (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    });

    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: params,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Twitch OAuth failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    logger.info('[TwitchApi] App access token acquired');
    return this.token.accessToken;
  }

  // ─── Generic Helix GET ───

  private async helixGet<T>(path: string, params: Record<string, string> = {}): Promise<HelixResponse<T>> {
    const token = await this.ensureToken();
    const url = new URL(`https://api.twitch.tv/helix/${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: {
        'Client-ID': this.clientId,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Twitch API ${path} failed (${res.status}): ${body}`);
    }

    return (await res.json()) as HelixResponse<T>;
  }

  // Helix GET with multi-value params (e.g. ?login=a&login=b)
  private async helixGetMulti<T>(path: string, key: string, values: string[]): Promise<HelixResponse<T>> {
    const token = await this.ensureToken();
    const url = new URL(`https://api.twitch.tv/helix/${path}`);
    for (const v of values) {
      url.searchParams.append(key, v);
    }

    const res = await fetch(url.toString(), {
      headers: {
        'Client-ID': this.clientId,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Twitch API ${path} failed (${res.status}): ${body}`);
    }

    return (await res.json()) as HelixResponse<T>;
  }

  // ─── Public methods ───

  /**
   * Resolve Twitch logins to user objects. Up to 100 per call.
   */
  async getUsersByLogins(logins: string[]): Promise<TwitchUser[]> {
    if (logins.length === 0) return [];

    const results: TwitchUser[] = [];
    // Batch in groups of 100 (Twitch limit)
    for (let i = 0; i < logins.length; i += 100) {
      const batch = logins.slice(i, i + 100);
      const res = await this.helixGetMulti<TwitchUser>('users', 'login', batch);
      results.push(...res.data);

      // Small delay between batches
      if (i + 100 < logins.length) {
        await sleep(100);
      }
    }

    return results;
  }

  /**
   * Get archived VODs for a Twitch user.
   */
  async getVideosForUser(userId: string, first = 20): Promise<TwitchVideo[]> {
    const res = await this.helixGet<TwitchVideo>('videos', {
      user_id: userId,
      type: 'archive',
      first: String(first),
    });
    return res.data;
  }

  /**
   * Find the most recent Zelda VOD for a Twitch channel.
   * Returns null if no VODs found or no matching VOD.
   */
  async findZeldaVod(twitchLogin: string): Promise<TwitchVideo | null> {
    // Strip full URL to just login name if needed
    const login = twitchLogin.includes('twitch.tv')
      ? twitchLogin.replace(/\/$/, '').split('/').pop()!
      : twitchLogin;

    // 1. Resolve login to user ID
    const users = await this.getUsersByLogins([login]);
    if (users.length === 0) {
      logger.debug(`[TwitchApi] User not found: ${twitchLogin}`);
      return null;
    }

    const userId = users[0].id;

    // 2. Fetch recent VODs
    const videos = await this.getVideosForUser(userId, 20);
    if (videos.length === 0) {
      logger.debug(`[TwitchApi] No VODs for ${twitchLogin}`);
      return null;
    }

    // 3. Filter for Zelda-related titles
    const zeldaKeywords = /zelda|z1r|randomizer|rando/i;
    const zeldaVod = videos.find((v) => zeldaKeywords.test(v.title));

    if (zeldaVod) {
      logger.debug(`[TwitchApi] Found Zelda VOD for ${twitchLogin}: "${zeldaVod.title}"`);
      return zeldaVod;
    }

    // 4. Fallback: most recent VOD (human will verify from screenshots)
    logger.debug(`[TwitchApi] No Zelda title match for ${twitchLogin}, falling back to most recent VOD`);
    return videos[0];
  }

  // ─── User-token Helix calls (channel management) ───

  private async helixUserGet<T>(path: string, params: Record<string, string> = {}): Promise<HelixResponse<T>> {
    if (!this.userToken) throw new Error('No user OAuth token configured (TWITCH_OAUTH_TOKEN)');
    const url = new URL(`https://api.twitch.tv/helix/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      headers: { 'Client-ID': this.clientId, Authorization: `Bearer ${this.userToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Twitch API ${path} failed (${res.status}): ${body}`);
    }
    return (await res.json()) as HelixResponse<T>;
  }

  private async helixUserPatch(path: string, params: Record<string, string>, body: Record<string, unknown>): Promise<void> {
    if (!this.userToken) throw new Error('No user OAuth token configured (TWITCH_OAUTH_TOKEN)');
    const url = new URL(`https://api.twitch.tv/helix/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        'Client-ID': this.clientId,
        Authorization: `Bearer ${this.userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twitch API PATCH ${path} failed (${res.status}): ${text}`);
    }
  }

  /** Get broadcaster user ID for the configured channel */
  async getBroadcasterId(): Promise<string> {
    const users = await this.getUsersByLogins([this.config.twitch.channel]);
    if (users.length === 0) throw new Error(`Channel not found: ${this.config.twitch.channel}`);
    return users[0].id;
  }

  /** Get channel info (title, game, tags) */
  async getChannelInfo(): Promise<TwitchChannelInfo> {
    const broadcasterId = await this.getBroadcasterId();
    const res = await this.helixUserGet<TwitchChannelInfo>('channels', { broadcaster_id: broadcasterId });
    if (res.data.length === 0) throw new Error('Channel info not found');
    return res.data[0];
  }

  /** Update channel info (title, game_id, tags). Requires user token with channel:manage:broadcast scope. */
  async updateChannelInfo(updates: { title?: string; game_id?: string; tags?: string[] }): Promise<void> {
    const broadcasterId = await this.getBroadcasterId();
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.game_id !== undefined) body.game_id = updates.game_id;
    if (updates.tags !== undefined) body.tags = updates.tags;
    await this.helixUserPatch('channels', { broadcaster_id: broadcasterId }, body);
    logger.info('[TwitchApi] Channel info updated', { updates });
  }

  /** Search for game/category by name */
  async searchCategories(query: string): Promise<TwitchCategory[]> {
    const token = await this.ensureToken();
    const url = new URL('https://api.twitch.tv/helix/search/categories');
    url.searchParams.set('query', query);
    url.searchParams.set('first', '10');

    const res = await fetch(url.toString(), {
      headers: { 'Client-ID': this.clientId, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Category search failed (${res.status})`);
    const data = (await res.json()) as HelixResponse<TwitchCategory>;
    return data.data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
