import type { RawGameState } from './types.js';

interface TrackerOptions { neverDecrease?: boolean; }

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
  reset(v: T): void { this.current = v; this.pending = v; this.count = 0; }
}

export interface StableGameState {
  screenType: string;
  dungeonLevel: number;
  rupees: number;
  keys: number;
  bombs: number;
  heartsCurrentStable: number;
  heartsMaxStable: number;
  bItem: string | null;
  swordLevel: number;
  hasMasterKey: boolean;
  mapPosition: number;
  floorItems: Array<{ name: string; x: number; y: number; score: number }>;
  triforceCollected: number;
}

export class StateStabilizer {
  // Thresholds in frames at 30fps
  private trackers = {
    screenType:    new StreakTracker<string>(6, 'unknown'),
    dungeonLevel:  new StreakTracker<number>(6, 0),
    rupees:        new StreakTracker<number>(3, 0),
    keys:          new StreakTracker<number>(3, 0),
    bombs:         new StreakTracker<number>(3, 0),
    heartsMax:     new StreakTracker<number>(15, 3, { neverDecrease: true }),
    heartsCurrent: new StreakTracker<number>(3, 3),
    bItem:         new StreakTracker<string | null>(6, null),
    swordLevel:    new StreakTracker<number>(6, 0),
    hasMasterKey:  new StreakTracker<boolean>(6, false),
    mapPosition:   new StreakTracker<number>(3, 0),
    triforce:      new StreakTracker<number>(3, 0),
  };

  update(raw: RawGameState): StableGameState {
    return {
      screenType:          this.trackers.screenType.update(raw.screenType),
      dungeonLevel:        this.trackers.dungeonLevel.update(raw.dungeonLevel),
      rupees:              this.trackers.rupees.update(raw.rupees),
      keys:                this.trackers.keys.update(raw.keys),
      bombs:               this.trackers.bombs.update(raw.bombs),
      heartsMaxStable:     this.trackers.heartsMax.update(raw.heartsMaxRaw),
      heartsCurrentStable: this.trackers.heartsCurrent.update(raw.heartsCurrentRaw),
      bItem:               this.trackers.bItem.update(raw.bItem),
      swordLevel:          this.trackers.swordLevel.update(raw.swordLevel),
      hasMasterKey:        this.trackers.hasMasterKey.update(raw.hasMasterKey),
      mapPosition:         this.trackers.mapPosition.update(raw.mapPosition),
      floorItems:          raw.floorItems, // floor item tracking handled separately
      triforceCollected:   this.trackers.triforce.update(raw.triforceCollected),
    };
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
