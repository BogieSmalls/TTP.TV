import { describe, it, expect } from 'vitest';
import { StreakTracker, StateStabilizer } from '../src/vision/StateStabilizer';

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

  it('neverDecrease option: hearts_max never decreases', () => {
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

describe('StateStabilizer.getPendingFields()', () => {
  // Use 'unknown' to match the StreakTracker initial value — no accumulation needed.
  const baseRaw = {
    screenType: 'unknown' as const,
    heartsCurrentRaw: 3,
    heartsMaxRaw: 3,
    rupees: 0,
    keys: 0,
    bombs: 0,
    dungeonLevel: 0,
    bItem: null,
    swordLevel: 0,
    hasMasterKey: false,
    mapPosition: 0,
    floorItems: [],
    triforceCollected: 0,
  };

  it('returns empty array when nothing is accumulating', () => {
    const s = new StateStabilizer();
    s.update(baseRaw);
    // After second identical update, all pending values match current — nothing accumulating
    s.update(baseRaw);
    expect(s.getPendingFields()).toEqual([]);
  });

  it('reports a field accumulating toward its threshold', () => {
    const s = new StateStabilizer();
    s.update(baseRaw);                                          // establishes stable heartsCurrent=3
    s.update({ ...baseRaw, heartsCurrentRaw: 2 });              // 1/3 frames toward 2
    const pending = s.getPendingFields();
    const hc = pending.find(p => p.field === 'heartsCurrent');
    expect(hc).toBeDefined();
    expect(hc!.stableValue).toBe(3);
    expect(hc!.pendingValue).toBe(2);
    expect(hc!.count).toBe(1);
    expect(hc!.threshold).toBe(3);
  });

  it('does not report a field once it has confirmed', () => {
    const s = new StateStabilizer();
    s.update(baseRaw);
    s.update({ ...baseRaw, heartsCurrentRaw: 2 });
    s.update({ ...baseRaw, heartsCurrentRaw: 2 });
    s.update({ ...baseRaw, heartsCurrentRaw: 2 }); // threshold=3 reached
    expect(s.getPendingFields().find(p => p.field === 'heartsCurrent')).toBeUndefined();
  });
});
