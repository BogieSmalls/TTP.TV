import { Router } from 'express';
import { VisionWorkerManager } from '../vision/VisionWorkerManager.js';
import type { VisionPipelineController } from '../vision/VisionPipelineController.js';

export function createVisionRoutes(mgr: VisionWorkerManager, controller: VisionPipelineController): Router {
  const router = Router();

  // Latest JPEG frame from a racer's tab
  router.get('/:racerId/frame', (req, res) => {
    const { racerId } = req.params;
    mgr.sendToTab(racerId, { type: 'requestPreview' });
    const frame = mgr.getLatestFrame(racerId);
    if (!frame) {
      res.status(404).json({ error: 'no frame' });
      return;
    }
    res.set('Content-Type', 'image/jpeg').send(frame);
  });

  // Annotated debug frame
  router.get('/:racerId/debug', (req, res) => {
    mgr.sendToTab(req.params.racerId, { type: 'requestDebug' });
    const frame = mgr.getLatestDebugFrame(req.params.racerId);
    if (!frame) {
      res.status(404).json({ error: 'no debug frame' });
      return;
    }
    res.set('Content-Type', 'image/jpeg').send(frame);
  });

  // Current StableGameState
  router.get('/:racerId/state', (req, res) => {
    const state = mgr.getLatestState(req.params.racerId);
    if (!state) {
      res.status(404).json({ error: 'no state' });
      return;
    }
    res.json(state);
  });

  // Launch a browser tab and register the racer's per-racer pipeline
  router.post('/:racerId/start', async (req, res) => {
    const { racerId } = req.params;
    const { streamUrl, calibration, role } = req.body as { streamUrl?: string; calibration?: object; role?: 'monitored' | 'featured' };
    if (!streamUrl) { res.status(400).json({ error: 'streamUrl required' }); return; }
    try {
      await mgr.addRacer({ racerId, streamUrl, calibration: calibration ?? {} as any, role: role ?? 'monitored' });
      controller.addRacer(racerId);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Tear down a racer's tab and remove their pipeline
  router.delete('/:racerId', async (req, res) => {
    const { racerId } = req.params;
    await mgr.removeRacer(racerId);
    controller.removeRacer(racerId);
    res.json({ ok: true });
  });

  return router;
}
