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

describe('VisionWorkerManager debug frame callback', () => {
  it('fires onDebugFrame when a debugFrame WS message arrives', () => {
    const mgr = new VisionWorkerManager();
    const frames: Array<{ racerId: string; jpeg: string }> = [];
    mgr.onDebugFrame((racerId, jpeg) => frames.push({ racerId, jpeg }));

    // Simulate a tab WebSocket registering and sending a debugFrame message
    const fakeWs = {
      readyState: WebSocket.OPEN,
      addEventListener: (event: string, handler: (e: any) => void) => {
        if (event === 'message') {
          handler({ data: JSON.stringify({ type: 'debugFrame', racerId: 'r1', jpeg: 'abc123' }) });
        }
      },
    };
    // Must have a tab entry for registerTabWebSocket to process
    (mgr as any).tabs.set('r1', { page: null, ws: null });
    mgr.registerTabWebSocket('r1', fakeWs as any);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ racerId: 'r1', jpeg: 'abc123' });
  });
});
