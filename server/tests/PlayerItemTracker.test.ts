import { describe, it, expect, beforeEach } from 'vitest';
import { PlayerItemTracker } from '../src/vision/PlayerItemTracker.js';

describe('PlayerItemTracker', () => {
  let tracker: PlayerItemTracker;

  beforeEach(() => {
    tracker = new PlayerItemTracker();
  });

  // ── B-item slot updates ──────────────────────────────────────────────────

  it('arrows in B-slot implies bow', () => {
    tracker.updateFromBItem('arrows');
    expect(tracker.getItems()['bow']).toBe(true);
    expect(tracker.arrows_level).toBeGreaterThanOrEqual(1);
  });

  it('B-item change sets the item to true', () => {
    tracker.updateFromBItem('blue_candle');
    expect(tracker.getItems()['blue_candle']).toBe(true);
  });

  it('null B-item is a no-op', () => {
    tracker.updateFromBItem(null);
    expect(Object.keys(tracker.getItems())).toHaveLength(0);
  });

  // ── Upgrade chains ──────────────────────────────────────────────────────

  it('red_candle clears blue_candle', () => {
    tracker.updateFromBItem('blue_candle');
    tracker.updateFromBItem('red_candle');
    const items = tracker.getItems();
    expect(items['red_candle']).toBe(true);
    expect(items['blue_candle']).toBe(false);
  });

  it('red_ring clears blue_ring', () => {
    tracker.updateItemObtained('blue_ring');
    tracker.updateItemObtained('red_ring');
    const items = tracker.getItems();
    expect(items['red_ring']).toBe(true);
    expect(items['blue_ring']).toBe(false);
  });

  it('magical_boomerang clears boomerang', () => {
    tracker.updateItemObtained('boomerang');
    tracker.updateItemObtained('magical_boomerang');
    const items = tracker.getItems();
    expect(items['magical_boomerang']).toBe(true);
    expect(items['boomerang']).toBe(false);
  });

  // ── Level fields never decrease ─────────────────────────────────────────

  it('sword_level never decreases', () => {
    tracker.updateSwordLevel(3);
    tracker.updateSwordLevel(1);
    expect(tracker.sword_level).toBe(3);
  });

  it('arrows_level never decreases', () => {
    tracker.updateArrowsLevel(2);
    tracker.updateArrowsLevel(1);
    expect(tracker.arrows_level).toBe(2);
  });

  it('updateArrowsLevel does NOT set bow', () => {
    tracker.updateArrowsLevel(2);
    expect(tracker.getItems()['bow'] ?? false).toBe(false);
  });

  it('arrows in B-slot sets arrows_level to at least 1', () => {
    tracker.updateFromBItem('arrows');
    expect(tracker.arrows_level).toBeGreaterThanOrEqual(1);
    expect(tracker.getItems()['bow']).toBe(true);
  });

  // ── Subscreen merge ─────────────────────────────────────────────────────

  it('subscreen merge: True overrides existing False', () => {
    tracker.mergeSubscreen({ bow: true, blue_candle: false });
    expect(tracker.getItems()['bow']).toBe(true);
  });

  it('subscreen merge: False does not clear a known True', () => {
    tracker.updateItemObtained('blue_candle');
    tracker.mergeSubscreen({ blue_candle: false });
    expect(tracker.getItems()['blue_candle']).toBe(true);
  });

  it('subscreen merge: False accepted when item was not previously True', () => {
    tracker.mergeSubscreen({ bow: false });
    expect(tracker.getItems()['bow']).toBe(false);
  });

  // ── updateItemObtained ───────────────────────────────────────────────────

  it('updateItemObtained sets item to true', () => {
    tracker.updateItemObtained('raft');
    expect(tracker.getItems()['raft']).toBe(true);
  });

  it('upgrade via updateItemObtained also applies upgrade chain', () => {
    tracker.updateItemObtained('boomerang');
    tracker.updateItemObtained('magical_boomerang');
    expect(tracker.getItems()['magical_boomerang']).toBe(true);
    expect(tracker.getItems()['boomerang']).toBe(false);
  });

  // ── getItems returns copy ────────────────────────────────────────────────

  it('getItems returns a snapshot (not a live reference)', () => {
    tracker.updateItemObtained('raft');
    const snap1 = tracker.getItems();
    tracker.updateItemObtained('book');
    const snap2 = tracker.getItems();
    expect(snap1).not.toHaveProperty('book');
    expect(snap2).toHaveProperty('book');
  });

  // ── Initial state ────────────────────────────────────────────────────────

  it('starts with empty inventory and zero levels', () => {
    expect(Object.keys(tracker.getItems())).toHaveLength(0);
    expect(tracker.sword_level).toBe(0);
    expect(tracker.arrows_level).toBe(0);
  });
});
