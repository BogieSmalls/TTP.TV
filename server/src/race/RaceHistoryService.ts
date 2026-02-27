import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';

const RECORDED_EVENTS = new Set([
  'death',
  'triforce_inferred',
  'game_complete',
  'ganon_fight',
  'ganon_kill',
  'dungeon_first_visit',
  'sword_upgrade',
  'b_item_change',
  'up_a_warp',
  'heart_container',
]);

export class RaceHistoryService {
  constructor(private db: Kysely<Database>) {}

  async recordEvent(raceId: string, racerId: string, eventType: string, description: string): Promise<void> {
    if (!RECORDED_EVENTS.has(eventType)) return;

    await this.db.insertInto('race_events').values({
      race_id: raceId,
      racer_id: racerId,
      event_type: eventType,
      description,
      timestamp: new Date(),
    } as any).execute();
  }

  async getEventsForRace(raceId: string): Promise<Array<{ event_type: string; racer_id: string | null; description: string | null; timestamp: Date }>> {
    return await this.db.selectFrom('race_events')
      .selectAll()
      .where('race_id', '=', raceId)
      .orderBy('timestamp', 'asc')
      .execute() as any;
  }
}
