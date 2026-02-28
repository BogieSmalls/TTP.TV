/**
 * PlayerItemTracker — TypeScript port of the Python PlayerItemTracker class
 * from vision/detector/game_logic.py.
 *
 * Tracks items the player has obtained. State only ever increases.
 * Vocabulary: Vision *identifies* items; this tracker records that the player
 * has *obtained* them.
 */

/** One-way upgrade pairs: obtaining the superior item clears the inferior. */
const UPGRADES: ReadonlyArray<readonly [string, string]> = [
  ['blue_candle', 'red_candle'],
  ['blue_ring', 'red_ring'],
  ['boomerang', 'magical_boomerang'],
] as const;

export class PlayerItemTracker {
  private _items: Map<string, boolean> = new Map();

  /** 0–3, never decreases. */
  sword_level = 0;

  /** 0=none, 1=wooden, 2=silver, never decreases. */
  arrows_level = 0;

  /** Process a newly identified B-item slot value. */
  updateFromBItem(bItem: string | null): void {
    if (bItem === null) {
      return;
    }
    this._set(bItem, true);
    if (bItem === 'arrows') {
      // Arrows in B-slot definitively means Bow is in inventory
      this._set('bow', true);
      // At minimum wooden arrows (level 1)
      this.arrows_level = Math.max(this.arrows_level, 1);
    }
  }

  /** Record that the player obtained a specific item. */
  updateItemObtained(item: string): void {
    this._set(item, true);
  }

  /** Sword level never decreases. */
  updateSwordLevel(level: number): void {
    this.sword_level = Math.max(this.sword_level, level);
  }

  /** Arrows level never decreases. Does NOT set bow. */
  updateArrowsLevel(level: number): void {
    this.arrows_level = Math.max(this.arrows_level, level);
  }

  /**
   * Merge a subscreen scan: True values override; False values only accepted
   * if we have no prior True for that item.
   */
  mergeSubscreen(subscreenItems: Record<string, boolean>): void {
    for (const [item, value] of Object.entries(subscreenItems)) {
      if (value) {
        this._set(item, true);
      } else if (!this._items.get(item)) {
        // False only accepted if we have no prior True
        this._items.set(item, false);
      }
    }
  }

  /** Return a copy of the current item inventory. */
  getItems(): Record<string, boolean> {
    return Object.fromEntries(this._items);
  }

  private _set(item: string, value: boolean): void {
    this._items.set(item, value);
    if (!value) {
      return;
    }
    // Apply one-way upgrades: obtaining the superior item clears the inferior
    for (const [inferior, superior] of UPGRADES) {
      if (item === superior) {
        this._items.set(inferior, false);
      }
    }
  }
}
