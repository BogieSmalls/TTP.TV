import { describe, it, expect, vi } from 'vitest';
import { VisionPipelineController } from '../src/vision/VisionPipelineController.js';
import type { VisionWorkerManager } from '../src/vision/VisionWorkerManager.js';

function mockManager() {
  let cb: ((state: any) => void) | null = null;
  return {
    onRawState: vi.fn((c) => { cb = c; }),
    cacheState: vi.fn(),
    fireRaw: (s: any) => cb?.(s),
  } as unknown as VisionWorkerManager & { fireRaw: (s: any) => void };
}

const minRaw = {
  racerId: 'r1', frameNumber: 1, timestamp: 0,
  hudScores: [], roomScores: [], floorItems: [],
  gameBrightness: 30, redRatioAtLife: 0.8, goldPixelCount: 0,
};

describe('VisionPipelineController.onStateUpdate()', () => {
  it('fires with racerId, raw, stable, pending on each processed frame', () => {
    const mgr = mockManager();
    const ctrl = new VisionPipelineController(mgr as any);
    ctrl.addRacer('r1');
    const updates: any[] = [];
    ctrl.onStateUpdate((u) => updates.push(u));
    mgr.fireRaw(minRaw);
    expect(updates).toHaveLength(1);
    expect(updates[0].racerId).toBe('r1');
    expect(updates[0].stable).toBeDefined();
    expect(updates[0].pending).toBeInstanceOf(Array);
  });
});
