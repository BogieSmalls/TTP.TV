import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { BulkCropOnboardingService } from '../vision/BulkCropOnboardingService.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import { logger } from '../logger.js';

// Hardcoded fallback landmark positions (NES pixels, 256×240 frame)
const DEFAULT_LANDMARKS = [
  { label: '-LIFE-', x: 176, y: 0, w: 80, h: 8 },
  { label: 'Hearts', x: 176, y: 24, w: 64, h: 16 },
  { label: 'Rupees', x: 96, y: 0, w: 32, h: 8 },
  { label: 'Keys', x: 96, y: 8, w: 24, h: 8 },
  { label: 'Bombs', x: 96, y: 16, w: 24, h: 8 },
  { label: 'B', x: 120, y: 0, w: 24, h: 24 },
  { label: 'A', x: 144, y: 0, w: 24, h: 24 },
  { label: 'Minimap', x: 16, y: 24, w: 64, h: 32 },
  { label: 'LVL', x: 0, y: 8, w: 80, h: 8 },
];

interface BulkCropRouteContext {
  bulkOnboardingService: BulkCropOnboardingService;
  cropProfileService: CropProfileService;
  io: SocketIOServer;
}

export function createBulkCropRoutes(ctx: BulkCropRouteContext): Router {
  const router = Router();

  // ─── Initialize session ───
  router.post('/session', async (_req, res) => {
    try {
      const session = await ctx.bulkOnboardingService.initSession();
      res.json(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Get session state ───
  router.get('/session', (_req, res) => {
    const session = ctx.bulkOnboardingService.getSession();
    if (!session) {
      res.json(null);
      return;
    }
    res.json(session);
  });

  // ─── Start VOD discovery (long-running, returns immediately) ───
  router.post('/session/discover', (_req, res) => {
    const session = ctx.bulkOnboardingService.getSession();
    if (!session) {
      res.status(400).json({ error: 'No active session — initialize first' });
      return;
    }

    // Start discovery in background
    ctx.bulkOnboardingService.discoverVods((entry, index, total) => {
      ctx.io.to('bulk-crop').emit('bulk-crop:discover-progress', {
        displayName: entry.displayName,
        twitchChannel: entry.twitchChannel,
        status: entry.status,
        vodTitle: entry.vodTitle,
        current: index + 1,
        total,
      });
      // Also send full session update
      ctx.io.to('bulk-crop').emit('bulk-crop:session-update', ctx.bulkOnboardingService.getSession());
    }).catch((err) => {
      logger.error(`[BulkCrop] Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    res.json({ status: 'discovering' });
  });

  // ─── Start bulk screenshot extraction (long-running) ───
  router.post('/session/extract-all', (_req, res) => {
    const session = ctx.bulkOnboardingService.getSession();
    if (!session) {
      res.status(400).json({ error: 'No active session' });
      return;
    }

    ctx.bulkOnboardingService.extractAllScreenshots((entry, index, total) => {
      ctx.io.to('bulk-crop').emit('bulk-crop:extract-progress', {
        displayName: entry.displayName,
        status: entry.status,
        current: index + 1,
        total,
      });
      ctx.io.to('bulk-crop').emit('bulk-crop:session-update', ctx.bulkOnboardingService.getSession());
    }).catch((err) => {
      logger.error(`[BulkCrop] Bulk extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    res.json({ status: 'extracting' });
  });

  // ─── Extract screenshots for one racer ───
  router.post('/session/racers/:id/extract', async (req, res) => {
    try {
      const screenshots = await ctx.bulkOnboardingService.extractScreenshots(req.params.id);
      ctx.io.to('bulk-crop').emit('bulk-crop:session-update', ctx.bulkOnboardingService.getSession());
      res.json({ screenshots });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Save crop for a racer ───
  router.post('/session/racers/:id/crop', async (req, res) => {
    const { x, y, w, h, streamWidth, streamHeight, screenshotSource, landmarks } = req.body;
    if (x == null || y == null || w == null || h == null) {
      res.status(400).json({ error: 'x, y, w, h are required' });
      return;
    }
    try {
      const cropProfileId = await ctx.bulkOnboardingService.saveCrop(
        req.params.id,
        { x, y, w, h, streamWidth: streamWidth ?? 1920, streamHeight: streamHeight ?? 1080 },
        screenshotSource,
        Array.isArray(landmarks) ? landmarks : undefined,
      );
      ctx.io.to('bulk-crop').emit('bulk-crop:session-update', ctx.bulkOnboardingService.getSession());
      res.json({ cropProfileId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Get latest landmark positions (DB-backed, fallback to hardcoded) ───
  router.get('/landmarks', async (_req, res) => {
    try {
      const landmarks = await ctx.cropProfileService.getLatestLandmarks();
      res.json(landmarks || DEFAULT_LANDMARKS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Auto-detect crop for a racer ───
  router.post('/session/racers/:id/auto-crop', async (req, res) => {
    try {
      const result = await ctx.bulkOnboardingService.autoCrop(req.params.id);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Skip a racer ───
  router.post('/session/racers/:id/skip', (req, res) => {
    try {
      ctx.bulkOnboardingService.skipRacer(req.params.id);
      ctx.io.to('bulk-crop').emit('bulk-crop:session-update', ctx.bulkOnboardingService.getSession());
      res.json({ status: 'skipped' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // ─── Manually set VOD URL for a racer ───
  router.post('/session/racers/:id/vod', async (req, res) => {
    const { vodUrl } = req.body;
    if (!vodUrl) {
      res.status(400).json({ error: 'vodUrl is required' });
      return;
    }
    try {
      await ctx.bulkOnboardingService.setVodUrl(req.params.id, vodUrl);
      ctx.io.to('bulk-crop').emit('bulk-crop:session-update', ctx.bulkOnboardingService.getSession());
      res.json({ status: 'vod_set' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  return router;
}
