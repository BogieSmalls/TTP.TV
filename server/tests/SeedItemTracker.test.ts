import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SeedItemTracker, SEED_TRACKED_ITEMS } from '../src/race/SeedItemTracker.js';

describe('SeedItemTracker', () => {
  let tracker: SeedItemTracker;

  beforeEach(() => {
    tracker = new SeedItemTracker();
  });

  it('tracks 15 items', () => {
    expect(SEED_TRACKED_ITEMS).toHaveLength(15);
    expect(SEED_TRACKED_ITEMS).toContain('book');
    expect(SEED_TRACKED_ITEMS).toContain('coast_heart');
  });

  it('starts with all items undiscovered', () => {
    const state = tracker.getState();
    for (const item of SEED_TRACKED_ITEMS) {
      expect(state[item]).toBeNull();
    }
  });

  it('records a dungeon item discovery', () => {
    tracker.recordDiscovery('bow', '3');
    const state = tracker.getState();
    expect(state.bow).toBe('3');
  });

  it('records a special location discovery', () => {
    tracker.recordDiscovery('power_bracelet', 'W');
    expect(tracker.getState().power_bracelet).toBe('W');
  });

  it('does not overwrite existing discovery', () => {
    tracker.recordDiscovery('bow', '3');
    tracker.recordDiscovery('bow', '5');
    expect(tracker.getState().bow).toBe('3');
  });

  it('ignores non-tracked items', () => {
    tracker.recordDiscovery('blue_candle', '2');
    const state = tracker.getState();
    expect(state).not.toHaveProperty('blue_candle');
  });

  it('emits discovery event', () => {
    const handler = vi.fn();
    tracker.on('discovery', handler);
    tracker.recordDiscovery('raft', '7');
    expect(handler).toHaveBeenCalledWith({
      item: 'raft',
      location: '7',
      state: expect.objectContaining({ raft: '7' }),
    });
  });

  it('does not emit for duplicate discovery', () => {
    const handler = vi.fn();
    tracker.recordDiscovery('raft', '7');
    tracker.on('discovery', handler);
    tracker.recordDiscovery('raft', '7');
    expect(handler).not.toHaveBeenCalled();
  });

  it('clear resets all discoveries', () => {
    tracker.recordDiscovery('bow', '3');
    tracker.recordDiscovery('raft', '7');
    tracker.clear();
    const state = tracker.getState();
    expect(state.bow).toBeNull();
    expect(state.raft).toBeNull();
  });

  it('processVisionUpdate detects new item in dungeon', () => {
    const handler = vi.fn();
    tracker.on('discovery', handler);
    // First update: no items
    tracker.processVisionUpdate('racer1', { items: { bow: false }, dungeon_level: 3 });
    expect(handler).not.toHaveBeenCalled();
    // Second update: bow found while in L3
    tracker.processVisionUpdate('racer1', { items: { bow: true }, dungeon_level: 3 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ item: 'bow', location: '3' }));
  });

  it('processVisionUpdate ignores item found with dungeon_level 0', () => {
    const handler = vi.fn();
    tracker.on('discovery', handler);
    tracker.processVisionUpdate('racer1', { items: { bow: false }, dungeon_level: 0 });
    tracker.processVisionUpdate('racer1', { items: { bow: true }, dungeon_level: 0 });
    // dungeon_level 0 = overworld, no level to associate
    // C/W/A detection is TBD, so for now we skip overworld pickups
    expect(handler).not.toHaveBeenCalled();
  });
});
