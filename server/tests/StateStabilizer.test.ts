import { describe, it, expect } from 'vitest';
import { StreakTracker } from '../src/vision/StateStabilizer';

describe('StreakTracker', () => {
  it('requires N consecutive frames to accept change', () => {
    const t = new StreakTracker(3, 0);
    expect(t.update(1)).toBe(0); // only 1 frame
    expect(t.update(1)).toBe(0); // 2 frames
    expect(t.update(1)).toBe(1); // 3 consecutive → accepted
  });

  it('resets count on interruption', () => {
    const t = new StreakTracker(3, 0);
    t.update(1); t.update(1);
    t.update(0); // interrupt
    t.update(1); t.update(1);
    expect(t.update(1)).toBe(1); // needs 3 fresh consecutive
  });

  it('falling edge also requires N consecutive', () => {
    const t = new StreakTracker(3, 5);
    // Stable at 5
    expect(t.update(0)).toBe(5); // 1 frame of 0
    expect(t.update(0)).toBe(5); // 2 frames
    expect(t.update(0)).toBe(0); // 3 consecutive → falls
  });

  it('hearts_max never decreases', () => {
    const t = new StreakTracker(3, 3, { neverDecrease: true });
    t.update(3); t.update(3); t.update(3); // stable at 3
    expect(t.update(2)).toBe(3); // rejected — would decrease
    expect(t.update(2)).toBe(3);
    expect(t.update(2)).toBe(3); // still rejected
    expect(t.update(4)).toBe(3);
    expect(t.update(4)).toBe(3);
    expect(t.update(4)).toBe(4); // increase allowed
  });
});
