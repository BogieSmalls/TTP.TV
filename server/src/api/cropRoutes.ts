import { Router } from 'express';
import type { Config } from '../config.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import { logger } from '../logger.js';

interface CropRouteContext {
  cropProfileService: CropProfileService;
  config: Config;
}

export function createCropRoutes(ctx: CropRouteContext): Router {
  const router = Router();

  // ─── List crop profiles for a racer ───
  router.get('/', async (req, res) => {
    const racerId = req.query.racerId as string;
    if (!racerId) {
      res.status(400).json({ error: 'racerId query parameter is required' });
      return;
    }
    try {
      const profiles = await ctx.cropProfileService.getByRacerId(racerId);
      res.json(profiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Get latest landmarks ───
  router.get('/landmarks', async (_req, res) => {
    try {
      const landmarks = await ctx.cropProfileService.getLatestLandmarks();
      res.json({ landmarks });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Get single crop profile ───
  router.get('/:id', async (req, res) => {
    try {
      const profile = await ctx.cropProfileService.getById(req.params.id);
      if (!profile) {
        res.status(404).json({ error: 'Crop profile not found' });
        return;
      }
      res.json(profile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Auto-crop from extraction screenshots ───
  // Python vision pipeline disabled — WebGPU pipeline active
  router.post('/auto-crop', (_req, res) => {
    console.warn('Python vision pipeline disabled — WebGPU pipeline active');
    logger.warn('[crop] /auto-crop: Python vision pipeline disabled — auto_crop.py will not be spawned.');
    res.status(503).json({ error: 'Python vision pipeline disabled — WebGPU pipeline active' });
  });

  // ─── Create crop profile ───
  router.post('/', async (req, res) => {
    const { racer_profile_id, label, crop_x, crop_y, crop_w, crop_h,
            stream_width, stream_height, grid_offset_dx, grid_offset_dy,
            screenshot_source, is_default, confidence, landmarks, notes } = req.body;

    if (!racer_profile_id || !label) {
      res.status(400).json({ error: 'racer_profile_id and label are required' });
      return;
    }

    try {
      const id = await ctx.cropProfileService.create({
        racer_profile_id,
        label,
        crop_x: crop_x ?? 0,
        crop_y: crop_y ?? 0,
        crop_w: crop_w ?? 1920,
        crop_h: crop_h ?? 1080,
        stream_width: stream_width ?? 1920,
        stream_height: stream_height ?? 1080,
        grid_offset_dx: grid_offset_dx ?? 0,
        grid_offset_dy: grid_offset_dy ?? 0,
        screenshot_source,
        is_default: is_default ?? false,
        confidence,
        landmarks,
        notes,
      });
      res.status(201).json({ id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Update crop profile ───
  router.put('/:id', async (req, res) => {
    const updates = req.body;
    delete updates.id;
    delete updates.created_at;
    // Convert landmarks array to JSON string for the database column
    if (updates.landmarks !== undefined) {
      updates.landmarks_json = updates.landmarks ? JSON.stringify(updates.landmarks) : null;
      delete updates.landmarks;
    }
    try {
      await ctx.cropProfileService.update(req.params.id, updates);
      res.json({ status: 'updated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Delete crop profile ───
  router.delete('/:id', async (req, res) => {
    try {
      await ctx.cropProfileService.delete(req.params.id);
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Set as default ───
  router.post('/:id/set-default', async (req, res) => {
    try {
      await ctx.cropProfileService.setDefault(req.params.id);
      res.json({ status: 'default_set' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Extract screenshots from a video source ───
  // Python vision pipeline disabled — WebGPU pipeline active
  router.post('/screenshot', (_req, res) => {
    console.warn('Python vision pipeline disabled — WebGPU pipeline active');
    logger.warn('[crop] /screenshot: Python vision pipeline disabled — extract_screenshot.py will not be spawned.');
    res.status(503).json({ error: 'Python vision pipeline disabled — WebGPU pipeline active' });
  });

  return router;
}
