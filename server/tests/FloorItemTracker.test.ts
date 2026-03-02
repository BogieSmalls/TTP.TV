import { describe, it, expect } from 'vitest';
import { FloorItemTracker } from '../src/vision/FloorItemTracker';

const item = (name = 'key') => [{ name, x: 128, y: 100, score: 0.92 }];

describe('FloorItemTracker', () => {
  it('requires 3 frames to confirm', () => {
    const t = new FloorItemTracker();
    expect(t.update(item()).confirmed).toHaveLength(0);
    expect(t.update(item()).confirmed).toHaveLength(0);
    expect(t.update(item()).confirmed).toHaveLength(1);
  });

  it('grace period suppresses on room entry', () => {
    const t = new FloorItemTracker();
    t.onRoomChange();
    expect(t.update(item()).confirmed).toHaveLength(0); // grace frame 1
    expect(t.update(item()).confirmed).toHaveLength(0); // grace frame 2
    expect(t.update(item()).confirmed).toHaveLength(0); // grace frame 3
    expect(t.update(item()).confirmed).toHaveLength(0); // post-grace, first confirm (still needs 3 more)
  });

  it('emits newlyConfirmed when item first reaches CONFIRM_FRAMES', () => {
    const t = new FloorItemTracker();
    const r1 = t.update(item('heart_drop')); // confirm 1
    expect(r1.newlyConfirmed).toHaveLength(0);
    const r2 = t.update(item('heart_drop')); // confirm 2
    expect(r2.newlyConfirmed).toHaveLength(0);
    const r3 = t.update(item('heart_drop')); // confirm 3 — threshold
    expect(r3.newlyConfirmed).toHaveLength(1);
    expect(r3.newlyConfirmed[0].name).toBe('heart_drop');
  });

  it('does not re-emit newlyConfirmed on subsequent frames', () => {
    const t = new FloorItemTracker();
    t.update(item('heart_drop'));
    t.update(item('heart_drop'));
    t.update(item('heart_drop')); // newly confirmed here
    const r = t.update(item('heart_drop')); // still confirmed but not new
    expect(r.confirmed).toHaveLength(1);
    expect(r.newlyConfirmed).toHaveLength(0);
  });

  it('emits obtained when confirmed item disappears for GONE_FRAMES', () => {
    const t = new FloorItemTracker();
    // Confirm item
    for (let i = 0; i < 4; i++) t.update(item('rupee_blue'));
    // Item disappears for 6 frames (GONE_FRAMES)
    for (let i = 0; i < 5; i++) t.update([]);
    const r = t.update([]);
    expect(r.obtained).toHaveLength(1);
    expect(r.obtained[0].name).toBe('rupee_blue');
  });

  it('does not emit newlyConfirmed during grace period', () => {
    const t = new FloorItemTracker();
    t.onRoomChange();
    const r1 = t.update(item('heart_drop'));
    const r2 = t.update(item('heart_drop'));
    const r3 = t.update(item('heart_drop'));
    expect(r1.newlyConfirmed).toHaveLength(0);
    expect(r2.newlyConfirmed).toHaveLength(0);
    expect(r3.newlyConfirmed).toHaveLength(0);
  });
});
