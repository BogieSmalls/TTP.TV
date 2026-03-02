import { Router } from 'express';
import type { RaceAnalyzerSession } from '../vision/RaceAnalyzerSession.js';

export function createAnalyzerRoutes(session: RaceAnalyzerSession): Router {
  const router = Router();

  router.post('/start', async (req, res) => {
    const { racerId, vodUrl, playbackRate, startOffset } = req.body;
    if (!racerId || !vodUrl) {
      res.status(400).json({ error: 'racerId and vodUrl are required' });
      return;
    }
    try {
      await session.start({
        racerId,
        vodUrl,
        playbackRate: playbackRate ?? 2,
        startOffset,
      });
      res.json({ status: 'started', racerId });
    } catch (err: unknown) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/stop', async (_req, res) => {
    const result = await session.stop();
    res.json({ status: 'stopped', result });
  });

  router.get('/status', (_req, res) => {
    res.json(session.getStatus());
  });

  router.get('/result', (_req, res) => {
    const result = session.getResult();
    if (!result) {
      res.status(404).json({ error: 'No result available' });
      return;
    }
    res.json(result);
  });

  return router;
}
