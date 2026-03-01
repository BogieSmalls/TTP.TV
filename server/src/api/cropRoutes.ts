import { Router } from 'express';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  router.post('/auto-crop', async (req, res) => {
    const { extractionId } = req.body;
    if (!extractionId) {
      res.status(400).json({ error: 'extractionId is required' });
      return;
    }

    const projectRoot = resolve(import.meta.dirname, '../../..');
    const screenshotDir = resolve(projectRoot, 'data/crop-screenshots', extractionId);
    const visionDir = resolve(projectRoot, 'vision');
    const pythonPath = resolve(projectRoot, ctx.config.vision.pythonPath);

    try {
      // Find screenshot files in the extraction directory
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(screenshotDir);
      const jpgs = files.filter(f => f.endsWith('.jpg') || f.endsWith('.png')).sort();

      if (jpgs.length === 0) {
        res.status(400).json({ error: 'No screenshots found in extraction' });
        return;
      }

      // Pick middle 3-5 screenshots for auto-crop
      const count = Math.min(5, jpgs.length);
      const start = Math.max(0, Math.floor((jpgs.length - count) / 2));
      const selected = jpgs.slice(start, start + count);
      const inputs = selected.map(f => resolve(screenshotDir, f));

      const args = [
        resolve(visionDir, 'auto_crop.py'),
        '--inputs', ...inputs,
      ];

      const result = await new Promise<string>((resolveP, reject) => {
        const proc = spawn(pythonPath, args, {
          cwd: visionDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        proc.on('error', (err) => reject(err));
        proc.on('exit', (code) => {
          if (code !== 0) {
            logger.error(`[crop] Auto-crop failed: ${stderr}`);
            reject(new Error(stderr || `Process exited with code ${code}`));
          } else {
            resolveP(stdout);
          }
        });
      });

      const parsed = JSON.parse(result);
      res.json(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[crop] Auto-crop error: ${msg}`);
      res.status(500).json({ error: msg });
    }
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
  router.post('/screenshot', async (req, res) => {
    const { source, timestamps } = req.body;
    if (!source) {
      res.status(400).json({ error: 'source is required' });
      return;
    }

    const extractionId = randomUUID().slice(0, 12);
    const projectRoot = resolve(import.meta.dirname, '../../..');
    const outputDir = resolve(projectRoot, 'data/crop-screenshots', extractionId);
    const visionDir = resolve(projectRoot, 'vision');
    const pythonPath = resolve(projectRoot, ctx.config.vision.pythonPath);

    try {
      await mkdir(outputDir, { recursive: true });

      const args = [
        resolve(visionDir, 'extract_screenshot.py'),
        '--source', source,
        '--output-dir', outputDir,
      ];
      if (timestamps && Array.isArray(timestamps) && timestamps.length > 0) {
        args.push('--timestamps', timestamps.join(','));
      }
      if (ctx.config.twitch.turboToken) {
        args.push('--twitch-token', ctx.config.twitch.turboToken);
      }

      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn(pythonPath, args, {
          cwd: visionDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('error', (err) => reject(err));
        proc.on('exit', (code) => {
          if (code !== 0) {
            logger.error(`[crop] Screenshot extraction failed: ${stderr}`);
            reject(new Error(stderr || `Process exited with code ${code}`));
          } else {
            resolve(stdout);
          }
        });
      });

      const manifest = JSON.parse(result);
      // Prefix screenshot filenames with the URL path for serving
      manifest.extractionId = extractionId;
      manifest.screenshots = manifest.screenshots.map((s: any) => ({
        ...s,
        url: `/api/crop-profiles/screenshots/${extractionId}/${s.filename}`,
      }));

      res.json(manifest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[crop] Screenshot extraction error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
