import { Router } from 'express';
import type { Kysely } from 'kysely';
import { VisionWorkerManager } from '../vision/VisionWorkerManager.js';
import type { VisionPipelineController } from '../vision/VisionPipelineController.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import type { CalibrationUniform } from '../vision/types.js';
import type { Database } from '../db/database.js';
import { logger } from '../logger.js';

/**
 * Resolve a racerId (UUID, twitch channel, or display name) to the racer_profile UUID.
 * Returns the original racerId if it already looks like a UUID or no match is found.
 */
async function resolveRacerProfileId(db: Kysely<Database>, racerId: string): Promise<string> {
  // Already a UUID? Return as-is.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(racerId)) {
    return racerId;
  }
  // Try twitch_channel (case-insensitive)
  const byTwitch = await db.selectFrom('racer_profiles')
    .select('id')
    .where('twitch_channel', '=', racerId.toLowerCase())
    .executeTakeFirst();
  if (byTwitch) return byTwitch.id;

  // Try display_name (case-insensitive)
  const byName = await db.selectFrom('racer_profiles')
    .select('id')
    .where('display_name', '=', racerId)
    .executeTakeFirst();
  if (byName) return byName.id;

  // Try racetime_name (e.g. "Bogie")
  const byRacetime = await db.selectFrom('racer_profiles')
    .select('id')
    .where('racetime_name', '=', racerId)
    .executeTakeFirst();
  if (byRacetime) return byRacetime.id;

  return racerId;
}

export function createVisionRoutes(mgr: VisionWorkerManager, controller: VisionPipelineController, cropProfileService?: CropProfileService, db?: Kysely<Database>): Router {
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
    const { streamUrl, calibration, role, startOffset } = req.body as { streamUrl?: string; calibration?: object; role?: 'monitored' | 'featured'; startOffset?: number };
    if (!streamUrl) { res.status(400).json({ error: 'streamUrl required' }); return; }
    try {
      // Build calibration from crop profile if not explicitly provided
      let calib = calibration as CalibrationUniform | undefined;
      let landmarks: Array<{label:string;x:number;y:number;w:number;h:number}> | undefined;
      if ((!calib || !calib.scaleX) && cropProfileService && db) {
        const profileId = await resolveRacerProfileId(db, racerId);
        const cropData = await cropProfileService.getDefaultForRacer(profileId);
        if (cropData.w > 0 && cropData.h > 0 && cropData.cropProfileId) {
          calib = {
            cropX: cropData.x,
            cropY: cropData.y,
            scaleX: cropData.w / 256,
            scaleY: cropData.h / 240,
            gridDx: cropData.gridOffsetDx,
            gridDy: cropData.gridOffsetDy,
            videoWidth: cropData.streamWidth,
            videoHeight: cropData.streamHeight,
          };
          if (cropData.landmarks && cropData.landmarks.length > 0) {
            landmarks = cropData.landmarks;
            logger.info(`[vision] Loaded ${landmarks.length} landmarks for ${racerId}`);
          }
          logger.info(`[vision] Built calibration from crop profile for ${racerId}: cropX=${calib.cropX} cropY=${calib.cropY} scaleX=${calib.scaleX.toFixed(2)} scaleY=${calib.scaleY.toFixed(2)}`);
        }
      }
      await mgr.addRacer({ racerId, streamUrl, calibration: calib ?? {} as any, role: role ?? 'monitored', startOffset, landmarks });
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

  // List all racers with active WebGPU tabs
  router.get('/racers', (_req, res) => {
    res.json({ racerIds: mgr.getActiveRacerIds() });
  });

  return router;
}
