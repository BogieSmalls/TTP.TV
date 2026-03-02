import type { StableGameState, GameEvent, GameEventType } from './types.js';

const NON_GAMEPLAY_GAP_THRESHOLD = 4;
const ZERO_HEARTS_STREAK_THRESHOLD = 4;

const GAMEPLAY_SCREENS = new Set(['overworld', 'dungeon', 'cave']);

export class WarpDeathTracker {
  private racerId: string;
  private lastGameplayHearts = 0;
  private zeroHeartsStreak = 0;
  private nonGameplayGap = 0;
  private lastGameplayPosition = -1;
  private lastGameplayScreen = '';
  private warpDetectedThisGap = false;
  private overworldStart = 0;
  private dungeonEntrances = new Map<number, number>();
  private gameplayStarted = false;
  private gameplayStreak = 0;

  constructor(racerId: string) {
    this.racerId = racerId;
  }

  registerStart(position: number): void {
    if (this.overworldStart === 0) this.overworldStart = position;
  }

  registerDungeonEntrance(dungeonLevel: number, position: number): void {
    if (!this.dungeonEntrances.has(dungeonLevel)) {
      this.dungeonEntrances.set(dungeonLevel, position);
    }
  }

  update(state: StableGameState, timestamp: number, frameNumber: number,
         events: GameEvent[], gameCompleted = false): void {
    const isGameplay = GAMEPLAY_SCREENS.has(state.screenType);

    if (isGameplay) {
      this.gameplayStreak++;
      if (this.gameplayStreak >= 120 && !this.gameplayStarted) {
        this.gameplayStarted = true;
      }
    } else if (state.screenType === 'title') {
      this.gameplayStreak = 0;
    }

    if (isGameplay) {
      if (this.nonGameplayGap >= NON_GAMEPLAY_GAP_THRESHOLD
          && this.gameplayStarted && !gameCompleted && !this.warpDetectedThisGap) {
        this._checkPositionReset(state, timestamp, frameNumber, events);
      }

      this.nonGameplayGap = 0;
      this.warpDetectedThisGap = false;
      this.lastGameplayPosition = state.mapPosition;
      this.lastGameplayScreen = state.screenType;
    } else if (state.screenType !== 'subscreen') {
      this.nonGameplayGap++;

      if (state.screenType === 'death' && this.lastGameplayScreen !== ''
          && !gameCompleted && this.gameplayStarted && !this.warpDetectedThisGap) {
        this.warpDetectedThisGap = true;
        if (this.lastGameplayHearts === 0) {
          this._emit(events, 'death', timestamp, frameNumber, 'Link died');
        } else {
          this._emit(events, 'up_a_warp', timestamp, frameNumber,
            `Up+A warp (hearts were ${this.lastGameplayHearts})`);
        }
      }
    }

    if (isGameplay) {
      if (state.heartsCurrentStable > 0) {
        this.lastGameplayHearts = state.heartsCurrentStable;
        this.zeroHeartsStreak = 0;
      } else if (state.heartsMaxStable > 0) {
        this.zeroHeartsStreak++;
        if (this.zeroHeartsStreak >= ZERO_HEARTS_STREAK_THRESHOLD) {
          this.lastGameplayHearts = 0;
        }
      }
    }
  }

  private _checkPositionReset(state: StableGameState, ts: number, fn: number,
                               events: GameEvent[]): void {
    let isReset = false;

    if (state.screenType === 'overworld' && this.overworldStart > 0
        && state.mapPosition === this.overworldStart) {
      isReset = true;
    }

    if (state.screenType === 'dungeon' && state.dungeonLevel > 0) {
      const entrance = this.dungeonEntrances.get(state.dungeonLevel);
      if (entrance !== undefined && entrance > 0
          && state.mapPosition === entrance
          && this.lastGameplayScreen === 'dungeon') {
        isReset = true;
      }
    }

    if (isReset) {
      this.warpDetectedThisGap = true;
      if (this.lastGameplayHearts === 0) {
        this._emit(events, 'death', ts, fn, 'Link died (position reset)');
      } else {
        this._emit(events, 'up_a_warp', ts, fn,
          `Up+A warp — returned to start (hearts ${this.lastGameplayHearts})`);
      }
    }
  }

  private _emit(events: GameEvent[], type: GameEventType, ts: number, fn: number,
                desc: string): void {
    events.push({
      type, racerId: this.racerId, timestamp: ts,
      frameNumber: fn, priority: type === 'death' ? 'high' : 'low',
      description: desc,
    });
  }

  reset(): void {
    this.lastGameplayHearts = 0;
    this.zeroHeartsStreak = 0;
    this.nonGameplayGap = 0;
    this.lastGameplayPosition = -1;
    this.lastGameplayScreen = '';
    this.warpDetectedThisGap = false;
    this.overworldStart = 0;
    this.dungeonEntrances.clear();
    this.gameplayStarted = false;
    this.gameplayStreak = 0;
  }
}
