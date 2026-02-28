import { GameEvent, GameEventType } from './types.js';
import { StableGameState } from './StateStabilizer.js';

const PRIORITY: Record<GameEventType, GameEvent['priority']> = {
  death: 'high', triforce_inferred: 'high', game_complete: 'high',
  ganon_fight: 'high', ganon_kill: 'high',
  heart_container: 'medium', dungeon_first_visit: 'medium',
  sword_upgrade: 'medium',
  up_a_warp: 'low', b_item_change: 'low', subscreen_open: 'low',
  item_drop: 'low', item_pickup: 'low',
};

export class EventInferencer {
  private racerId: string;
  private prev: StableGameState | null = null;
  private visitedDungeons = new Set<number>();
  private lastDeathFrame = -900; // 30s cooldown at 30fps
  private lastWarpFrame = -30;
  private nonGameplayGapStart = -1;
  private lastGameplayHearts = 0;
  private lastGameplayScreen = 'overworld';
  private prevSubscreenOpen = false;
  private triforceOrangeFrames: number[] = [];
  private triforceD9Entered = false;

  constructor(racerId: string) {
    this.racerId = racerId;
  }

  update(state: StableGameState, timestamp: number, frameNumber: number): GameEvent[] {
    const events: GameEvent[] = [];
    const prev = this.prev;

    if (prev) {
      this._checkHeartContainer(prev, state, timestamp, frameNumber, events);
      this._checkDungeonFirstVisit(prev, state, timestamp, frameNumber, events);
      this._checkSwordUpgrade(prev, state, timestamp, frameNumber, events);
      this._checkBItemChange(prev, state, timestamp, frameNumber, events);
      this._checkDeath(prev, state, timestamp, frameNumber, events);
      this._checkSubscreenOpen(prev, state, timestamp, frameNumber, events);
      this._checkGanonFight(prev, state, timestamp, frameNumber, events);
      this._checkGameComplete(prev, state, timestamp, frameNumber, events);
    } else {
      // First frame: seed visited dungeons and D9 state without emitting events
      this._seedInitialState(state);
    }

    this.prev = state;
    return events;
  }

  private _seedInitialState(state: StableGameState): void {
    // Record current dungeon as visited so re-entry won't fire dungeon_first_visit
    if (state.screenType === 'dungeon' && state.dungeonLevel > 0) {
      this.visitedDungeons.add(state.dungeonLevel);
    }
    // Seed D9 entered flag
    if (state.dungeonLevel === 9) {
      this.triforceD9Entered = true;
    }
  }

  private emit(events: GameEvent[], type: GameEventType, ts: number, fn: number,
               description: string, data?: Record<string, unknown>): void {
    events.push({ type, racerId: this.racerId, timestamp: ts,
                  frameNumber: fn, priority: PRIORITY[type], description, data });
  }

  private _checkHeartContainer(p: StableGameState, s: StableGameState,
                                ts: number, fn: number, ev: GameEvent[]): void {
    if (s.heartsMaxStable > p.heartsMaxStable) {
      this.emit(ev, 'heart_container', ts, fn,
        `Heart container: ${p.heartsMaxStable} → ${s.heartsMaxStable} hearts`);
    }
  }

  private _checkDungeonFirstVisit(p: StableGameState, s: StableGameState,
                                   ts: number, fn: number, ev: GameEvent[]): void {
    if (s.screenType === 'dungeon' && s.dungeonLevel > 0
        && !this.visitedDungeons.has(s.dungeonLevel)) {
      this.visitedDungeons.add(s.dungeonLevel);
      this.emit(ev, 'dungeon_first_visit', ts, fn,
        `Entered dungeon ${s.dungeonLevel} for the first time`,
        { dungeonLevel: s.dungeonLevel });
    }
  }

  private _checkSwordUpgrade(p: StableGameState, s: StableGameState,
                              ts: number, fn: number, ev: GameEvent[]): void {
    if (s.swordLevel > p.swordLevel) {
      this.emit(ev, 'sword_upgrade', ts, fn,
        `Sword upgrade: level ${p.swordLevel} → ${s.swordLevel}`,
        { from: p.swordLevel, to: s.swordLevel });
    }
  }

  private _checkBItemChange(p: StableGameState, s: StableGameState,
                             ts: number, fn: number, ev: GameEvent[]): void {
    if (s.bItem !== p.bItem && (p.bItem !== null || s.bItem !== null)) {
      this.emit(ev, 'b_item_change', ts, fn,
        `B-item: ${p.bItem ?? 'none'} → ${s.bItem ?? 'none'}`,
        { from: p.bItem, to: s.bItem });
    }
  }

  private _checkDeath(p: StableGameState, s: StableGameState,
                       ts: number, fn: number, ev: GameEvent[]): void {
    const isGameplay = ['overworld', 'dungeon', 'cave'].includes(s.screenType);
    if (isGameplay) {
      this.lastGameplayHearts = s.heartsCurrentStable;
      this.lastGameplayScreen = s.screenType;
    }
    // Death: hearts reach 0 in gameplay, with cooldown
    if (isGameplay && s.heartsCurrentStable === 0 && p.heartsCurrentStable > 0
        && fn - this.lastDeathFrame > 900) {
      this.lastDeathFrame = fn;
      this.emit(ev, 'death', ts, fn, 'Link died');
    }
  }

  private _checkSubscreenOpen(p: StableGameState, s: StableGameState,
                               ts: number, fn: number, ev: GameEvent[]): void {
    if (s.screenType === 'subscreen' && p.screenType !== 'subscreen') {
      this.emit(ev, 'subscreen_open', ts, fn, 'Subscreen opened');
    }
  }

  private _checkGanonFight(p: StableGameState, s: StableGameState,
                            ts: number, fn: number, ev: GameEvent[]): void {
    if (s.dungeonLevel === 9 && !this.triforceD9Entered) {
      this.triforceD9Entered = true;
      this.emit(ev, 'ganon_fight', ts, fn, 'Entered Ganon\'s lair (D9)');
    }
  }

  private _checkGameComplete(p: StableGameState, s: StableGameState,
                              ts: number, fn: number, ev: GameEvent[]): void {
    // D9 exit: was in D9, now not in dungeon for extended period
    if (p.dungeonLevel === 9 && s.dungeonLevel === 0
        && !['dungeon'].includes(s.screenType)) {
      this.emit(ev, 'game_complete', ts, fn, 'Game complete — exited D9');
    }
  }

  reset(): void {
    this.prev = null;
    this.visitedDungeons.clear();
    this.lastDeathFrame = -900;
    this.triforceD9Entered = false;
  }
}
