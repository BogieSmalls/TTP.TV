import { describe, it, expect, afterEach } from 'vitest';
import { VisionWorkerManager } from '../src/vision/VisionWorkerManager.js';

describe('VisionWorkerManager', () => {
  let mgr: VisionWorkerManager;
  afterEach(async () => { await mgr?.stop(); });

  it('starts and stops without error', async () => {
    mgr = new VisionWorkerManager();
    await mgr.start();
    await mgr.stop();
    expect(true).toBe(true);
  });
});
