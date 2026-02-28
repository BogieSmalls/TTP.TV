import { describe, it, expect } from 'vitest';
import { EventInferencer } from '../src/vision/EventInferencer';
import type { StableGameState } from '../src/vision/StateStabilizer';

function state(overrides: Partial<StableGameState> = {}): StableGameState {
  return {
    screenType: 'dungeon', dungeonLevel: 3,
    rupees: 5, keys: 1, bombs: 3,
    heartsCurrentStable: 6, heartsMaxStable: 6,
    bItem: null, swordLevel: 1, hasMasterKey: false,
    mapPosition: 42, floorItems: [], triforceCollected: 0,
    ...overrides,
  };
}

describe('EventInferencer', () => {
  it('emits heart_container when heartsMax increases', () => {
    const inf = new EventInferencer('racer1');
    inf.update(state({ heartsMaxStable: 3 }), 1000, 1);
    inf.update(state({ heartsMaxStable: 3 }), 1033, 2);
    const events = inf.update(state({ heartsMaxStable: 5 }), 1066, 3);
    expect(events.some(e => e.type === 'heart_container')).toBe(true);
  });

  it('emits dungeon_first_visit on first entry to a dungeon level', () => {
    const inf = new EventInferencer('racer1');
    inf.update(state({ screenType: 'overworld', dungeonLevel: 0 }), 0, 1);
    const events = inf.update(state({ screenType: 'dungeon', dungeonLevel: 4 }), 33, 2);
    expect(events.some(e => e.type === 'dungeon_first_visit')).toBe(true);
  });

  it('does not emit dungeon_first_visit on re-entry', () => {
    const inf = new EventInferencer('racer1');
    inf.update(state({ screenType: 'dungeon', dungeonLevel: 4 }), 0, 1);
    inf.update(state({ screenType: 'overworld', dungeonLevel: 0 }), 33, 2);
    const events = inf.update(state({ screenType: 'dungeon', dungeonLevel: 4 }), 66, 3);
    expect(events.some(e => e.type === 'dungeon_first_visit')).toBe(false);
  });

  it('death has 900-frame cooldown per racer', () => {
    const inf = new EventInferencer('racer1');
    // First death: transition from hearts > 0 to 0
    inf.update(state({ heartsCurrentStable: 6 }), 0, 1);     // frame 1: alive
    const first = inf.update(state({ heartsCurrentStable: 0 }), 33, 2);  // frame 2: death transition
    expect(first.some(e => e.type === 'death')).toBe(true);  // first death fires

    // Second death within cooldown window (frames 3-4, well within 900 frame cooldown)
    inf.update(state({ heartsCurrentStable: 6 }), 66, 3);    // frame 3: revived
    const second = inf.update(state({ heartsCurrentStable: 0 }), 99, 4);  // frame 4: transition again
    expect(second.some(e => e.type === 'death')).toBe(false); // second suppressed by cooldown
  });
});
