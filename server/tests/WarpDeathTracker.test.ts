import { describe, it, expect } from 'vitest';
import { WarpDeathTracker } from '../src/vision/WarpDeathTracker';
import type { StableGameState, GameEvent } from '../src/vision/types';

function state(overrides: Partial<StableGameState> = {}): StableGameState {
  return {
    screenType: 'overworld', dungeonLevel: 0,
    rupees: 5, keys: 1, bombs: 3,
    heartsCurrentStable: 6, heartsMaxStable: 6,
    bItem: null, swordLevel: 1, hasMasterKey: false,
    mapPosition: 42, floorItems: [], triforceCollected: 0,
    ...overrides,
  };
}

describe('WarpDeathTracker', () => {
  it('emits death when hearts reach 0 and position resets', () => {
    const tracker = new WarpDeathTracker('racer1');
    const events: GameEvent[] = [];

    // Need 120 frames of gameplay to start
    for (let i = 0; i < 120; i++) {
      tracker.update(state({ screenType: 'overworld', mapPosition: 119 }), i * 33, i, events);
    }
    tracker.registerStart(119);

    // Hearts drop to 0
    tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 0, mapPosition: 50 }), 4000, 121, events);
    // Need 4+ consecutive 0-heart frames for ZERO_HEARTS_STREAK_THRESHOLD
    for (let i = 0; i < 3; i++) {
      tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 0, mapPosition: 50 }), 4033 + i * 33, 122 + i, events);
    }
    // Non-gameplay gap (4+ frames)
    for (let i = 0; i < 5; i++) {
      tracker.update(state({ screenType: 'transition', heartsCurrentStable: 0 }), 4200 + i * 33, 125 + i, events);
    }
    // Resume at start position
    tracker.update(state({ screenType: 'overworld', mapPosition: 119, heartsCurrentStable: 6 }), 4400, 130, events);

    expect(events.some(e => e.type === 'death')).toBe(true);
  });

  it('emits up_a_warp when hearts > 0 and position resets', () => {
    const tracker = new WarpDeathTracker('racer1');
    const events: GameEvent[] = [];

    for (let i = 0; i < 120; i++) {
      tracker.update(state({ screenType: 'overworld', mapPosition: 119 }), i * 33, i, events);
    }
    tracker.registerStart(119);

    // Hearts still positive
    tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 4, mapPosition: 50 }), 4000, 121, events);
    // Non-gameplay gap
    for (let i = 0; i < 5; i++) {
      tracker.update(state({ screenType: 'transition', heartsCurrentStable: 4 }), 4033 + i * 33, 122 + i, events);
    }
    // Resume at start position
    tracker.update(state({ screenType: 'overworld', mapPosition: 119, heartsCurrentStable: 4 }), 4200, 127, events);

    expect(events.some(e => e.type === 'up_a_warp')).toBe(true);
  });

  it('does not fire multiple events per gap', () => {
    const tracker = new WarpDeathTracker('racer1');
    const events: GameEvent[] = [];

    for (let i = 0; i < 120; i++) {
      tracker.update(state({ screenType: 'overworld', mapPosition: 119 }), i * 33, i, events);
    }
    tracker.registerStart(119);

    tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 0, mapPosition: 50 }), 4000, 121, events);
    for (let i = 0; i < 3; i++) {
      tracker.update(state({ screenType: 'overworld', heartsCurrentStable: 0, mapPosition: 50 }), 4033 + i * 33, 122 + i, events);
    }

    for (let i = 0; i < 10; i++) {
      tracker.update(state({ screenType: 'transition', heartsCurrentStable: 0 }), 4200 + i * 33, 125 + i, events);
    }
    tracker.update(state({ screenType: 'overworld', mapPosition: 119, heartsCurrentStable: 6 }), 4600, 135, events);

    const deaths = events.filter(e => e.type === 'death');
    expect(deaths.length).toBe(1);
  });
});
