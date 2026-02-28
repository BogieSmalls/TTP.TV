/**
 * RaceItemTracker — tracks where each item lives on the seed (seed knowledge map).
 *
 * Records "for each item in the game, where is it?" as detected by vision.
 * Combined with PlayerItemTracker this answers "did Bogie get the silver
 * arrows from Level 5?"
 *
 * Vocabulary: Vision *detects* floor items. This tracker records that an
 * item was *seen* at a location; separately records if it was *obtained*.
 *
 * Direct TypeScript port of Python class RaceItemTracker in game_logic.py.
 */

export interface ItemLocation {
  map_position: number;
  first_seen_frame: number;
  obtained: boolean;
}

export class RaceItemTracker {
  // item_name -> {map_position, first_seen_frame, obtained}
  private _locations: Map<string, ItemLocation> = new Map();

  /**
   * Record that vision detected this item at a map position.
   */
  itemSeen(item: string, mapPosition: number, frame: number): void {
    if (!this._locations.has(item)) {
      this._locations.set(item, {
        map_position: mapPosition,
        first_seen_frame: frame,
        obtained: false,
      });
    }
    // Update location if seen at same position (idempotent).
    // Don't overwrite if already marked obtained from a previous sighting.
  }

  /**
   * Mark an item as obtained by the player (confirmed pickup).
   */
  itemObtained(item: string, frame: number): void {
    const existing = this._locations.get(item);
    if (existing) {
      existing.obtained = true;
    } else {
      // If we see an obtained event without a prior sighting, still record it
      // (handles edge cases where floor detection missed the initial appearance).
      this._locations.set(item, {
        map_position: 0, // unknown location
        first_seen_frame: frame,
        obtained: true,
      });
    }
  }

  /**
   * Return the full seed knowledge map.
   */
  getLocations(): Record<string, ItemLocation> {
    const result: Record<string, ItemLocation> = {};
    for (const [key, value] of this._locations) {
      result[key] = { ...value };
    }
    return result;
  }
}
