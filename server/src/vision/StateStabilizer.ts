import type { RawGameState, PendingFieldInfo, StableGameState } from './types.js';

interface TrackerOptions { neverDecrease?: boolean; maxDelta?: number; }

export class StreakTracker<T> {
  private current: T;
  private pending: T;
  private count: number = 0;
  private readonly threshold: number;
  private readonly options: TrackerOptions;

  constructor(threshold: number, initial: T, options: TrackerOptions = {}) {
    this.threshold = threshold;
    this.current = initial;
    this.pending = initial;
    this.options = options;
  }

  update(value: T): T {
    if (this.options.neverDecrease && (value as unknown as number) < (this.current as unknown as number)) {
      this.count = 0;
      this.pending = this.current;
      return this.current;
    }
    // Reject values outside ±maxDelta from current (prevents corruption jumps like 3→12)
    if (this.options.maxDelta !== undefined) {
      const delta = Math.abs((value as unknown as number) - (this.current as unknown as number));
      if (delta > this.options.maxDelta) {
        this.count = 0;
        this.pending = this.current;
        return this.current;
      }
    }
    if (value === this.pending) {
      this.count++;
      if (this.count >= this.threshold) {
        this.current = value;
      }
    } else {
      this.pending = value;
      this.count = 1;
    }
    return this.current;
  }

  get value(): T { return this.current; }
  get pendingValue(): T { return this.pending; }
  get pendingCount(): number { return this.count; }
  get streakThreshold(): number { return this.threshold; }
  reset(v: T): void { this.current = v; this.pending = v; this.count = 0; }
}

export class StateStabilizer {
  // Thresholds in frames at 30fps
  private trackers = {
    screenType:    new StreakTracker<string>(6, 'unknown'),
    dungeonLevel:  new StreakTracker<number>(6, 0),
    rupees:        new StreakTracker<number>(3, 0),
    keys:          new StreakTracker<number>(3, 0),
    bombs:         new StreakTracker<number>(3, 0),
    heartsMax:     new StreakTracker<number>(15, 3, { maxDelta: 1 }),
    heartsCurrent: new StreakTracker<number>(3, 3, { maxDelta: 1 }),
    bItem:         new StreakTracker<string | null>(6, null),
    swordLevel:    new StreakTracker<number>(6, 0),
    hasMasterKey:  new StreakTracker<boolean>(6, false),
    mapPosition:   new StreakTracker<number>(8, -1),
    triforce:      new StreakTracker<number>(3, 0),
  };

  update(raw: RawGameState): StableGameState {
    const screenType = this.trackers.screenType.update(raw.screenType);
    // Master gate: when HUD digit NCC scores aren't confident, freeze ALL HUD fields.
    // This prevents inventory/subscreen corruption (e.g. yellow map → 12 hearts).
    const hud = raw.hudVisible;
    return {
      screenType,
      dungeonLevel:        hud ? this.trackers.dungeonLevel.update(raw.dungeonLevel) : this.trackers.dungeonLevel.value,
      rupees:              hud ? this.trackers.rupees.update(raw.rupees) : this.trackers.rupees.value,
      keys:                hud ? this.trackers.keys.update(raw.keys) : this.trackers.keys.value,
      bombs:               hud ? this.trackers.bombs.update(raw.bombs) : this.trackers.bombs.value,
      heartsMaxStable:     hud ? this.trackers.heartsMax.update(raw.heartsMaxRaw) : this.trackers.heartsMax.value,
      heartsCurrentStable: hud ? this.trackers.heartsCurrent.update(raw.heartsCurrentRaw) : this.trackers.heartsCurrent.value,
      bItem:               hud ? this.trackers.bItem.update(raw.bItem) : this.trackers.bItem.value,
      swordLevel:          hud ? this.trackers.swordLevel.update(raw.swordLevel) : this.trackers.swordLevel.value,
      hasMasterKey:        hud ? this.trackers.hasMasterKey.update(raw.hasMasterKey) : this.trackers.hasMasterKey.value,
      mapPosition:         raw.mapPosition >= 0 ? this.trackers.mapPosition.update(raw.mapPosition) : this.trackers.mapPosition.value,
      floorItems:          raw.floorItems,
      triforceCollected:   this.trackers.triforce.update(raw.triforceCollected),
    };
  }

  getPendingFields(): PendingFieldInfo[] {
    return (Object.entries(this.trackers) as [string, StreakTracker<unknown>][])
      .filter(([, t]) => t.pendingValue !== t.value)
      .map(([field, t]) => ({
        field,
        stableValue: t.value,
        pendingValue: t.pendingValue,
        count: t.pendingCount,
        threshold: t.streakThreshold,
      }));
  }

  reset(): void {
    this.trackers.screenType.reset(this.trackers.screenType.value);
    this.trackers.dungeonLevel.reset(this.trackers.dungeonLevel.value);
    this.trackers.rupees.reset(this.trackers.rupees.value);
    this.trackers.keys.reset(this.trackers.keys.value);
    this.trackers.bombs.reset(this.trackers.bombs.value);
    this.trackers.heartsMax.reset(this.trackers.heartsMax.value);
    this.trackers.heartsCurrent.reset(this.trackers.heartsCurrent.value);
    this.trackers.bItem.reset(this.trackers.bItem.value);
    this.trackers.swordLevel.reset(this.trackers.swordLevel.value);
    this.trackers.hasMasterKey.reset(this.trackers.hasMasterKey.value);
    this.trackers.mapPosition.reset(this.trackers.mapPosition.value);
    this.trackers.triforce.reset(this.trackers.triforce.value);
  }
}
