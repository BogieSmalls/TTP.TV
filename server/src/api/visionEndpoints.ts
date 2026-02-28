import { Router } from 'express';
import { VisionWorkerManager } from '../vision/VisionWorkerManager.js';

export function createVisionRoutes(mgr: VisionWorkerManager): Router {
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

  return router;
}
