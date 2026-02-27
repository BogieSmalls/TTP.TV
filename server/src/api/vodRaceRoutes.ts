import { Router } from 'express';
import type { VodRaceOrchestrator } from '../race/VodRaceOrchestrator.js';
import type { ObsController } from '../obs/ObsController.js';
import { logger } from '../logger.js';

interface VodRaceRouteContext {
  vodRaceOrchestrator: VodRaceOrchestrator;
  obsController: ObsController;
}

export function createVodRaceRoutes(ctx: VodRaceRouteContext): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.json(ctx.vodRaceOrchestrator.getStatus());
  });

  router.post('/setup', async (req, res) => {
    const { racers, racetimeRoom, title } = req.body;
    if (!racers || !Array.isArray(racers) || racers.length < 2) {
      res.status(400).json({ error: 'racers array (2-4 entries) is required' });
      return;
    }
    try {
      const status = await ctx.vodRaceOrchestrator.setupVodRace({ racers, racetimeRoom, title });
      res.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/confirm', async (_req, res) => {
    try {
      const status = await ctx.vodRaceOrchestrator.confirmSetup();
      res.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/go-live', async (_req, res) => {
    try {
      const status = await ctx.vodRaceOrchestrator.goLive();
      res.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/end', async (_req, res) => {
    try {
      await ctx.vodRaceOrchestrator.endRace();
      res.json({ status: 'ended' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/rebuild-scene', async (_req, res) => {
    try {
      const status = await ctx.vodRaceOrchestrator.rebuildScene();
      res.json({ status: 'rebuilt', sceneName: status.sceneName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[vod-race] Rebuild scene failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  router.post('/mark-finished', (req, res) => {
    const { profileId, finishTimeSeconds } = req.body;
    if (!profileId || finishTimeSeconds == null) {
      res.status(400).json({ error: 'profileId and finishTimeSeconds are required' });
      return;
    }
    try {
      ctx.vodRaceOrchestrator.markFinished(profileId, finishTimeSeconds);
      res.json({ status: 'marked_finished' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/mark-forfeit', (req, res) => {
    const { profileId } = req.body;
    if (!profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    try {
      ctx.vodRaceOrchestrator.markForfeit(profileId);
      res.json({ status: 'marked_forfeit' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/go-offline', async (_req, res) => {
    try {
      // Stop streaming if active
      try {
        if (await ctx.obsController.isStreaming()) {
          await ctx.obsController.stopStreaming();
        }
      } catch { /* not streaming */ }

      // Create or switch to offline scene
      const offlineScene = 'TTP_Offline';
      const scenes = await ctx.obsController.getSceneList();
      if (!scenes.includes(offlineScene)) {
        await ctx.obsController.createScene(offlineScene);
      }
      await ctx.obsController.switchScene(offlineScene);

      res.json({ status: 'offline', scene: offlineScene });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[vod-race] Go offline failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
