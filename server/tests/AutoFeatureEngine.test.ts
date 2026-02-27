import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoFeatureEngine } from '../src/race/AutoFeatureEngine.js';

describe('AutoFeatureEngine', () => {
  let engine: AutoFeatureEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new AutoFeatureEngine();
    engine.enable();
  });

  afterEach(() => {
    engine.disable();
    vi.useRealTimers();
  });

  it('does not feature anyone below threshold', () => {
    engine.onGameEvent('r1', 'dungeon_entry'); // 20 points, below 50 threshold
    vi.advanceTimersByTime(3000); // trigger evaluate
    expect(engine.getCurrentFeatured()).toBeNull();
  });

  it('features racer on high-excitement event', () => {
    const handler = vi.fn();
    engine.on('layoutChange', handler);
    engine.onGameEvent('r1', 'ganon_fight'); // 100 points
    vi.advanceTimersByTime(3000);
    expect(engine.getCurrentFeatured()).toBe('r1');
    expect(handler).toHaveBeenCalledWith({ layout: 'featured', featuredRacer: 'r1' });
  });

  it('respects minimum dwell time', () => {
    engine.onGameEvent('r1', 'ganon_fight');
    vi.advanceTimersByTime(3000); // features r1

    // r2 gets two high events to outscore r1
    engine.onGameEvent('r2', 'ganon_fight');
    engine.onGameEvent('r2', 'ganon_kill');
    vi.advanceTimersByTime(3000); // too soon to switch (only 3s since last switch)
    expect(engine.getCurrentFeatured()).toBe('r1'); // still r1

    vi.advanceTimersByTime(15000); // past dwell time, evaluate fires
    expect(engine.getCurrentFeatured()).toBe('r2');
  });

  it('returns to equal layout when excitement decays', () => {
    engine.onGameEvent('r1', 'ganon_fight');
    vi.advanceTimersByTime(3000); // features r1
    expect(engine.getCurrentFeatured()).toBe('r1');

    vi.advanceTimersByTime(30000); // events decay
    vi.advanceTimersByTime(3000); // evaluate
    expect(engine.getCurrentFeatured()).toBeNull();
  });

  it('clear resets state', () => {
    engine.onGameEvent('r1', 'ganon_fight');
    vi.advanceTimersByTime(3000);
    engine.clear();
    expect(engine.getCurrentFeatured()).toBeNull();
  });
});
