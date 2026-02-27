import { EventEmitter } from 'node:events';

export const SEED_TRACKED_ITEMS = [
  'book', 'boomerang', 'bow', 'ladder', 'magical_boomerang',
  'magical_key', 'power_bracelet', 'raft', 'recorder',
  'red_candle', 'red_ring', 'silver_arrows', 'wand',
  'white_sword', 'coast_heart',
] as const;

export type SeedTrackedItem = typeof SEED_TRACKED_ITEMS[number];
export type ItemLocation = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'C'|'W'|'A';

const TRACKED_SET = new Set<string>(SEED_TRACKED_ITEMS);

interface SeedItemDiscovery {
  item: string;
  location: ItemLocation;
  timestamp: number;
}

export class SeedItemTracker extends EventEmitter {
  private discoveries = new Map<string, SeedItemDiscovery>();
  /** Track each racer's previous item states for edge detection */
  private prevItems = new Map<string, Map<string, boolean>>();

  recordDiscovery(item: string, location: string): void {
    if (!TRACKED_SET.has(item)) return;
    if (this.discoveries.has(item)) return;

    const discovery: SeedItemDiscovery = {
      item,
      location: location as ItemLocation,
      timestamp: Date.now(),
    };
    this.discoveries.set(item, discovery);
    this.emit('discovery', {
      item,
      location,
      state: this.getState(),
    });
  }

  /** Process a vision update to detect new item pickups in dungeons */
  processVisionUpdate(racerId: string, state: Record<string, unknown>): void {
    const items = state.items as Record<string, boolean> | undefined;
    const dungeonLevel = state.dungeon_level as number | undefined;
    if (!items) return;

    let prev = this.prevItems.get(racerId);
    if (!prev) {
      prev = new Map();
      this.prevItems.set(racerId, prev);
    }

    for (const [itemName, found] of Object.entries(items)) {
      if (!TRACKED_SET.has(itemName)) continue;
      const wasPrev = prev.get(itemName) ?? false;
      prev.set(itemName, found);

      // Edge detection: false → true
      if (found && !wasPrev) {
        if (dungeonLevel && dungeonLevel >= 1 && dungeonLevel <= 9) {
          this.recordDiscovery(itemName, String(dungeonLevel));
        }
        // C/W/A detection: TBD — will be added when rules are taught
      }
    }
  }

  getState(): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const item of SEED_TRACKED_ITEMS) {
      const d = this.discoveries.get(item);
      result[item] = d ? d.location : null;
    }
    return result;
  }

  clear(): void {
    this.discoveries.clear();
    this.prevItems.clear();
  }
}
