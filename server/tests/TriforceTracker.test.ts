import { describe, it, expect } from 'vitest';
import { TriforceTracker } from '../src/vision/TriforceTracker';
import type { StableGameState, GameEvent } from '../src/vision/types';

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

describe('TriforceTracker', () => {
  describe('dungeon exit detection', () => {
    it('infers triforce when hearts increase to max after dungeon exit', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 0, 0, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 33, 1, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(true);
      expect(events.find(e => e.type === 'triforce_inferred')?.data?.dungeonLevel).toBe(3);
    });

    it('does not infer triforce when hearts did not increase', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 0, 0, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 33, 1, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(false);
    });

    it('does not infer triforce if hearts dropped to 0 (death)', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 0, 0, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 0, heartsMaxStable: 6 }), 33, 1, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(false);
    });

    it('infers game_complete when exiting D9 for 30+ frames', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 9,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 0, 0, events);

      for (let i = 1; i <= 35; i++) {
        tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
          heartsCurrentStable: 6, heartsMaxStable: 6 }), i * 33, i, events);
      }

      expect(events.some(e => e.type === 'game_complete')).toBe(true);
    });

    it('does not double-infer triforce for same dungeon', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 0, 0, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 33, 1, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 66, 2, events);
      expect(events.filter(e => e.type === 'triforce_inferred').length).toBe(1);

      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 3,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 100, 3, events);
      tracker.update(state({ screenType: 'transition', dungeonLevel: 0,
        heartsCurrentStable: 4, heartsMaxStable: 6 }), 133, 4, events);
      tracker.update(state({ screenType: 'overworld', dungeonLevel: 0,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 166, 5, events);
      expect(events.filter(e => e.type === 'triforce_inferred').length).toBe(1);
    });
  });

  describe('gold flash detection', () => {
    it('infers triforce from gold pixel flash pattern with hearts refill', () => {
      const tracker = new TriforceTracker('racer1');
      const events: GameEvent[] = [];

      // Enter dungeon
      tracker.feedGoldPixels(0);
      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
        heartsCurrentStable: 3, heartsMaxStable: 6 }), 0, 0, events);

      // Flash pattern: gold pixels appear/disappear (4+ detections, 1+ gaps)
      const goldHigh = 50;
      const goldLow = 0;
      // Pattern: high, high, low (gap), high, high, low, high
      const goldPattern = [goldHigh, goldHigh, goldLow, goldHigh, goldHigh, goldLow, goldHigh];
      for (let i = 0; i < goldPattern.length; i++) {
        // IMPORTANT: feedGoldPixels BEFORE update (the implementation reads it during update)
        tracker.feedGoldPixels(goldPattern[i]);
        tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
          heartsCurrentStable: 3, heartsMaxStable: 6 }), (i + 1) * 33, i + 1, events);
      }

      // Gap timeout: 13+ frames with no gold
      for (let i = 0; i < 15; i++) {
        tracker.feedGoldPixels(0);
        tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
          heartsCurrentStable: 3 + Math.min(i, 3), heartsMaxStable: 6 }), (8 + i) * 33, 8 + i, events);
      }

      // Hearts reach max
      tracker.feedGoldPixels(0);
      tracker.update(state({ screenType: 'dungeon', dungeonLevel: 5,
        heartsCurrentStable: 6, heartsMaxStable: 6 }), 800, 24, events);

      expect(events.some(e => e.type === 'triforce_inferred')).toBe(true);
    });
  });
});
