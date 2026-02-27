import { describe, it, expect, beforeEach } from 'vitest';
import { VisionManager } from '../src/vision/VisionManager.js';

describe('VisionManager.updateState()', () => {
  let vm: VisionManager;

  beforeEach(() => {
    vm = new VisionManager({} as any, {} as any);
  });

  it('extracts game_events and excludes them from merged state', () => {
    const events = [{ event: 'death', description: 'Player died' }];
    const result = vm.updateState('racer1', {
      screen_type: 'overworld',
      hearts_current: 3,
      game_events: events,
    });

    expect(result.events).toEqual(events);
    expect(result.state).not.toHaveProperty('game_events');
    expect(result.state).toHaveProperty('screen_type', 'overworld');
  });

  it('merges partial state into cached state across calls', () => {
    vm.updateState('racer1', { screen_type: 'overworld', hearts_current: 3 });
    const result = vm.updateState('racer1', { rupees: 50 });

    expect(result.state.screen_type).toBe('overworld');
    expect(result.state.hearts_current).toBe(3);
    expect(result.state.rupees).toBe(50);
  });

  it('hearts_max never decreases (debounce)', () => {
    vm.updateState('racer1', { hearts_max: 6 });
    const result = vm.updateState('racer1', { hearts_max: 3 });

    expect(result.state.hearts_max).toBe(6);
  });

  it('hearts_max can increase normally', () => {
    vm.updateState('racer1', { hearts_max: 3 });
    const result = vm.updateState('racer1', { hearts_max: 5 });

    expect(result.state.hearts_max).toBe(5);
  });

  it('handles empty game_events gracefully', () => {
    const result = vm.updateState('racer1', { screen_type: 'dungeon' });
    expect(result.events).toEqual([]);
  });

  it('handles explicit empty game_events array', () => {
    const result = vm.updateState('racer1', { screen_type: 'dungeon', game_events: [] });
    expect(result.events).toEqual([]);
    expect(result.state).not.toHaveProperty('game_events');
  });

  it('isolates state per racerId', () => {
    vm.updateState('racer1', { hearts_current: 5 });
    vm.updateState('racer2', { hearts_current: 2 });

    const r1 = vm.getState('racer1');
    const r2 = vm.getState('racer2');

    expect(r1?.hearts_current).toBe(5);
    expect(r2?.hearts_current).toBe(2);
  });
});
