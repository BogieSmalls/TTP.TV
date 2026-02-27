import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SeedMapState } from '../src/race/SeedMapState.js';

describe('SeedMapState', () => {
  let map: SeedMapState;

  beforeEach(() => {
    map = new SeedMapState();
  });

  it('tracks racer positions', () => {
    map.updatePosition('r1', 5, 3, 'overworld');
    map.updatePosition('r2', 10, 7, 'overworld');
    const state = map.getState();
    expect(state.positions).toHaveLength(2);
    expect(state.positions[0]).toEqual(expect.objectContaining({ racerId: 'r1', col: 5, row: 3 }));
  });

  it('pins dungeon markers without duplicates', () => {
    map.addDungeonMarker('r1', 5, 3, 3);
    map.addDungeonMarker('r2', 5, 3, 3); // same location — dedup
    expect(map.getState().markers).toHaveLength(1);
    expect(map.getState().markers[0].discoveredBy).toBe('r1');
  });

  it('pins landmarks', () => {
    map.addLandmark('r1', 12, 1, 'White Sword');
    expect(map.getState().markers).toHaveLength(1);
    expect(map.getState().markers[0].label).toBe('White Sword');
  });

  it('ignores non-gameplay screen types', () => {
    map.updatePosition('r1', 5, 3, 'subscreen');
    expect(map.getState().positions).toHaveLength(0);
  });

  it('clear resets everything', () => {
    map.updatePosition('r1', 5, 3, 'overworld');
    map.addDungeonMarker('r1', 5, 3, 3);
    map.clear();
    expect(map.getState().positions).toHaveLength(0);
    expect(map.getState().markers).toHaveLength(0);
  });

  it('emits positionUpdate events', () => {
    const handler = vi.fn();
    map.on('positionUpdate', handler);
    map.updatePosition('r1', 5, 3, 'overworld');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('emits markerUpdate events', () => {
    const handler = vi.fn();
    map.on('markerUpdate', handler);
    map.addDungeonMarker('r1', 5, 3, 3);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('overwrites position for same racer', () => {
    map.updatePosition('r1', 5, 3, 'overworld');
    map.updatePosition('r1', 6, 4, 'overworld');
    const state = map.getState();
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0]).toEqual(expect.objectContaining({ col: 6, row: 4 }));
  });
});
