import type { StableGameState, GameEvent, GameEventType } from './types.js';

const PRIORITY: Record<string, GameEvent['priority']> = {
  triforce_inferred: 'high',
  game_complete: 'high',
};

const DEATH_MENU_FRAMES = 3;
const D9_EXIT_FRAMES = 30;
const EXIT_TIMEOUT_FRAMES = 40;
const GOLD_THRESHOLD = 10;
const MIN_GOLD_DETECTIONS = 4;
const MIN_GOLD_GAPS = 1;
const MIN_GOLD_TOTAL = 8;
const GOLD_GAP_TIMEOUT = 12;
const HEARTS_PENDING_TIMEOUT = 20;

type ExitPhase = 'idle' | 'exiting';

export class TriforceTracker {
  private racerId: string;
  private triforceInferred: boolean[] = new Array(8).fill(false);
  private gameCompleted = false;

  // Dungeon exit tracking
  private exitPhase: ExitPhase = 'idle';
  private exitDungeon = 0;
  private exitStartFrame = 0;
  private exitHeartsStart = 0;
  private exitHeartsMin = 99;
  private exitDeathFrames = 0;
  private exitSawDeathMenu = false;

  // Gold flash tracking
  private goldDetections = 0;
  private goldGaps = 0;
  private goldTotal = 0;
  private goldLastFrame = -999;
  private goldStartDungeon = 0;
  private goldHeartsStart = 0;
  private goldPending = false;
  private goldPendingFrame = 0;
  private goldTracking = false;

  private prevScreenType = '';
  private prevDungeonLevel = 0;
  private _goldPixelsThisFrame = 0;

  constructor(racerId: string) {
    this.racerId = racerId;
  }

  feedGoldPixels(goldPixels: number): void {
    this._goldPixelsThisFrame = goldPixels;
  }

  update(state: StableGameState, timestamp: number, frameNumber: number,
         events: GameEvent[]): void {
    this._updateDungeonExit(state, timestamp, frameNumber, events);
    this._updateGoldFlash(state, timestamp, frameNumber, events);
    this.prevScreenType = state.screenType;
    this.prevDungeonLevel = state.dungeonLevel;
  }

  private emit(events: GameEvent[], type: GameEventType, ts: number, fn: number,
               desc: string, data?: Record<string, unknown>): void {
    events.push({
      type, racerId: this.racerId, timestamp: ts,
      frameNumber: fn, priority: PRIORITY[type] ?? 'high', description: desc, data,
    });
  }

  private _updateDungeonExit(state: StableGameState, ts: number, fn: number,
                              events: GameEvent[]): void {
    const isGameplay = ['overworld', 'dungeon', 'cave'].includes(state.screenType);

    if (this.exitPhase === 'idle') {
      if (this.prevScreenType === 'dungeon' && this.prevDungeonLevel > 0
          && !isGameplay && state.screenType !== 'subscreen') {
        this.exitPhase = 'exiting';
        this.exitDungeon = this.prevDungeonLevel;
        this.exitStartFrame = fn;
        this.exitHeartsStart = state.heartsCurrentStable;
        this.exitHeartsMin = state.heartsCurrentStable;
        this.exitDeathFrames = state.screenType === 'death' ? 1 : 0;
        this.exitSawDeathMenu = false;
      }
    } else {
      this.exitHeartsMin = Math.min(this.exitHeartsMin, state.heartsCurrentStable);

      if (state.screenType === 'death') {
        this.exitDeathFrames++;
        if (this.exitDeathFrames >= DEATH_MENU_FRAMES) {
          this.exitSawDeathMenu = true;
        }
      } else {
        this.exitDeathFrames = 0;
      }

      const exitFrames = fn - this.exitStartFrame;

      if (state.screenType === 'overworld') {
        const heartsIncreased = state.heartsCurrentStable > this.exitHeartsStart;
        const heartsAtMax = state.heartsCurrentStable >= state.heartsMaxStable;
        const dungeon = this.exitDungeon;

        if (heartsIncreased && heartsAtMax
            && this.exitHeartsMin > 0 && !this.exitSawDeathMenu
            && dungeon >= 1 && dungeon <= 8
            && !this.triforceInferred[dungeon - 1]) {
          this.triforceInferred[dungeon - 1] = true;
          this.emit(events, 'triforce_inferred', ts, fn,
            `Triforce piece ${dungeon} inferred (dungeon exit + hearts refill)`,
            { dungeonLevel: dungeon });
        }
        this._resetExit();
      }
      else if (['dungeon', 'cave'].includes(state.screenType)) {
        this._resetExit();
      }
      else if (this.exitDungeon === 9 && exitFrames > D9_EXIT_FRAMES
               && this.exitHeartsMin > 0 && !this.gameCompleted) {
        this.gameCompleted = true;
        this.emit(events, 'game_complete', ts, fn, 'Game complete — exited D9');
        this._resetExit();
      }
      else if (exitFrames > EXIT_TIMEOUT_FRAMES) {
        this._resetExit();
      }
    }
  }

  private _resetExit(): void {
    this.exitPhase = 'idle';
    this.exitDungeon = 0;
    this.exitHeartsMin = 99;
    this.exitDeathFrames = 0;
    this.exitSawDeathMenu = false;
  }

  private _updateGoldFlash(state: StableGameState, ts: number, fn: number,
                            events: GameEvent[]): void {
    const goldPixels = this._goldPixelsThisFrame;
    const isGold = goldPixels >= GOLD_THRESHOLD;
    const isDungeon = ['dungeon', 'cave'].includes(state.screenType);

    if (this.goldPending) {
      if (state.heartsCurrentStable > this.goldHeartsStart
          && state.heartsCurrentStable >= state.heartsMaxStable
          && state.heartsMaxStable > 0) {
        const dungeon = this.goldStartDungeon;
        if (dungeon >= 1 && dungeon <= 8 && !this.triforceInferred[dungeon - 1]) {
          this.triforceInferred[dungeon - 1] = true;
          this.emit(events, 'triforce_inferred', ts, fn,
            `Triforce piece ${dungeon} inferred (gold flash + hearts refill)`,
            { dungeonLevel: dungeon });
        }
        this._resetGold();
        return;
      }
      if (fn - this.goldPendingFrame > HEARTS_PENDING_TIMEOUT) {
        this._resetGold();
        return;
      }
    }

    if (isGold && isDungeon && state.dungeonLevel > 0 && !this.goldTracking) {
      this.goldTracking = true;
      this.goldDetections = 1;
      this.goldGaps = 0;
      this.goldTotal = 1;
      this.goldLastFrame = fn;
      this.goldStartDungeon = state.dungeonLevel;
      this.goldHeartsStart = state.heartsCurrentStable;
      return;
    }

    if (!this.goldTracking) return;

    if (isGold) {
      this.goldDetections++;
      this.goldTotal++;
      this.goldLastFrame = fn;
    } else {
      if (fn - this.goldLastFrame > GOLD_GAP_TIMEOUT) {
        if (this.goldDetections >= MIN_GOLD_DETECTIONS
            && this.goldGaps >= MIN_GOLD_GAPS
            && this.goldTotal >= MIN_GOLD_TOTAL) {
          if (state.heartsCurrentStable > this.goldHeartsStart
              && state.heartsCurrentStable >= state.heartsMaxStable) {
            const dungeon = this.goldStartDungeon;
            if (dungeon >= 1 && dungeon <= 8 && !this.triforceInferred[dungeon - 1]) {
              this.triforceInferred[dungeon - 1] = true;
              this.emit(events, 'triforce_inferred', ts, fn,
                `Triforce piece ${dungeon} inferred (gold flash + hearts refill)`,
                { dungeonLevel: dungeon });
            }
            this._resetGold();
          } else {
            this.goldPending = true;
            this.goldPendingFrame = fn;
          }
        } else {
          this._resetGold();
        }
      } else {
        this.goldGaps++;
        this.goldTotal++;
      }
    }
  }

  private _resetGold(): void {
    this.goldTracking = false;
    this.goldPending = false;
    this.goldDetections = 0;
    this.goldGaps = 0;
    this.goldTotal = 0;
    this.goldStartDungeon = 0;
  }

  get triforceState(): boolean[] {
    return [...this.triforceInferred];
  }

  get isGameCompleted(): boolean {
    return this.gameCompleted;
  }

  reset(): void {
    this.triforceInferred.fill(false);
    this.gameCompleted = false;
    this._resetExit();
    this._resetGold();
    this.prevScreenType = '';
    this.prevDungeonLevel = 0;
  }
}
