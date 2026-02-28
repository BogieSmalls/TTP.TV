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
});
