import { describe, it, expect } from 'vitest';
import { VisionWorkerManager } from '../src/vision/VisionWorkerManager';

describe('VisionWorkerManager pool', () => {
  it('tracks monitored vs featured racers independently', async () => {
    const mgr = new VisionWorkerManager({} as any, {} as any);
    mgr.setFeatured(['bogie', 'eatmysteel']);
    expect(mgr.isFeatured('bogie')).toBe(true);
    expect(mgr.isFeatured('zfg')).toBe(false);
    expect(mgr.getFeaturedIds()).toContain('bogie');
    expect(mgr.getFeaturedIds()).not.toContain('zfg');
  });

  it('getMonitoredCount returns tab count', async () => {
    const mgr = new VisionWorkerManager({} as any, {} as any);
    expect(mgr.getMonitoredCount()).toBe(0);
  });
});
