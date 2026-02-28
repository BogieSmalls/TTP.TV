import { describe, it, expect, beforeEach } from 'vitest';
import { RaceItemTracker } from '../src/vision/RaceItemTracker';

describe('RaceItemTracker', () => {
  let tracker: RaceItemTracker;

  beforeEach(() => {
    tracker = new RaceItemTracker();
  });

  it('item_seen_recorded — detecting a floor item records its location', () => {
    tracker.itemSeen('magical_boomerang', 45, 100);
    const locs = tracker.getLocations();
    expect('magical_boomerang' in locs).toBe(true);
    expect(locs['magical_boomerang'].map_position).toBe(45);
  });

  it('item_seen_overwrites_with_same_location — seeing the same item twice at same location does not duplicate', () => {
    tracker.itemSeen('bow', 10, 1);
    tracker.itemSeen('bow', 10, 2);
    const locs = tracker.getLocations();
    const bowKeys = Object.keys(locs).filter(k => k === 'bow');
    expect(bowKeys).toHaveLength(1);
  });

  it('item_obtained_marks_obtained — after itemObtained, getLocations shows obtained=true', () => {
    tracker.itemSeen('silver_arrows', 22, 50);
    tracker.itemObtained('silver_arrows', 60);
    const locs = tracker.getLocations();
    expect(locs['silver_arrows'].obtained).toBe(true);
  });

  it('item_not_obtained_stays_false — seen but not obtained item has obtained=false', () => {
    tracker.itemSeen('red_candle', 7, 30);
    const locs = tracker.getLocations();
    expect(locs['red_candle'].obtained).toBe(false);
  });

  it('multiple_items_tracked_independently', () => {
    tracker.itemSeen('bow', 5, 1);
    tracker.itemSeen('arrows', 12, 2);
    const locs = tracker.getLocations();
    expect(locs['bow'].map_position).toBe(5);
    expect(locs['arrows'].map_position).toBe(12);
  });

  it('item_obtained_without_prior_sighting — records with map_position=0', () => {
    tracker.itemObtained('raft', 99);
    const locs = tracker.getLocations();
    expect('raft' in locs).toBe(true);
    expect(locs['raft'].obtained).toBe(true);
    expect(locs['raft'].map_position).toBe(0);
  });

  it('item_seen_does_not_overwrite_obtained — obtaining item then seeing it again keeps obtained=true', () => {
    tracker.itemSeen('ladder', 33, 10);
    tracker.itemObtained('ladder', 20);
    // See it again — should not reset obtained
    tracker.itemSeen('ladder', 33, 30);
    const locs = tracker.getLocations();
    expect(locs['ladder'].obtained).toBe(true);
  });

  it('first_seen_frame_recorded — records the frame when item was first seen', () => {
    tracker.itemSeen('book', 8, 42);
    const locs = tracker.getLocations();
    expect(locs['book'].first_seen_frame).toBe(42);
  });

  it('getLocations_returns_copy — mutating returned object does not affect tracker', () => {
    tracker.itemSeen('bow', 5, 1);
    const locs1 = tracker.getLocations();
    locs1['bow'].map_position = 999;
    const locs2 = tracker.getLocations();
    expect(locs2['bow'].map_position).toBe(5);
  });
});
