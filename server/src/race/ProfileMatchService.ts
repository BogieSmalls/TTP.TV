import { v4 as uuid } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { RacetimeEntrant, EntrantMatch } from './types.js';
import { extractTwitchChannel } from './types.js';
import { logger } from '../logger.js';

export class ProfileMatchService {
  constructor(private db: Kysely<Database>) {}

  /**
   * Match an array of racetime.gg entrants to local profiles.
   * Priority: racetime_id > twitch_channel > no match.
   * Returns EntrantMatch[] with slot assignments (0-indexed).
   */
  async matchEntrants(entrants: RacetimeEntrant[]): Promise<EntrantMatch[]> {
    const profiles = await this.db.selectFrom('racer_profiles')
      .selectAll()
      .execute();

    // Pre-fetch crop profile existence for all profiles
    const cropProfiles = await this.db.selectFrom('crop_profiles')
      .select(['racer_profile_id'])
      .execute();
    const profilesWithCrop = new Set(cropProfiles.map(cp => cp.racer_profile_id));

    const matches: EntrantMatch[] = [];

    for (let i = 0; i < entrants.length; i++) {
      const entrant = entrants[i];

      // 1. Try racetime_id match
      let profile = profiles.find((p) => p.racetime_id === entrant.user.id);
      let method: EntrantMatch['matchMethod'] = profile ? 'racetime_id' : null;

      // 2. Try twitch_channel match (normalize URLs to bare channel names)
      const entrantChannel = extractTwitchChannel(entrant.user.twitch_channel);
      if (!profile && entrantChannel) {
        profile = profiles.find(
          (p) => extractTwitchChannel(p.twitch_channel) === entrantChannel,
        );
        if (profile) method = 'twitch_channel';
      }

      matches.push({
        entrant,
        profileId: profile?.id ?? null,
        profileDisplayName: profile?.display_name ?? null,
        matchMethod: method,
        twitchChannel: extractTwitchChannel(profile?.twitch_channel ?? null) ?? entrantChannel,
        slot: i,
        hasCropProfile: profile ? profilesWithCrop.has(profile.id) : false,
      });
    }

    return matches;
  }

  /**
   * Auto-create a profile from a racetime.gg entrant.
   */
  async createFromEntrant(entrant: RacetimeEntrant): Promise<string> {
    const id = uuid();
    await this.db.insertInto('racer_profiles').values({
      id,
      racetime_id: entrant.user.id,
      racetime_name: entrant.user.full_name,
      display_name: entrant.user.name,
      twitch_channel: extractTwitchChannel(entrant.user.twitch_channel) || entrant.user.name.toLowerCase(),
      crop_x: 0,
      crop_y: 0,
      crop_w: 1920,
      crop_h: 1080,
      stream_width: 1920,
      stream_height: 1080,
      preferred_color: '#D4AF37',
      notes: `Auto-created from racetime.gg: ${entrant.user.full_name}`,
    } as any).execute();

    logger.info(`Auto-created profile for ${entrant.user.full_name} (${id})`);
    return id;
  }

  /**
   * Update an existing profile with racetime_id linkage.
   */
  async linkRacetimeId(profileId: string, racetimeId: string, racetimeName: string): Promise<void> {
    await this.db.updateTable('racer_profiles')
      .set({ racetime_id: racetimeId, racetime_name: racetimeName })
      .where('id', '=', profileId)
      .execute();

    logger.info(`Linked profile ${profileId} to racetime.gg user ${racetimeName}`);
  }
}
