import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { RaceAnalyzerSession } from '../vision/RaceAnalyzerSession.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import type { CalibrationUniform } from '../vision/types.js';
import type { Database } from '../db/database.js';
import { logger } from '../logger.js';

/**
 * Resolve a racerId (UUID, twitch channel, or display name) to the racer_profile UUID.
 */
async function resolveRacerProfileId(db: Kysely<Database>, racerId: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(racerId)) {
    return racerId;
  }
  const byTwitch = await db.selectFrom('racer_profiles')
    .select('id').where('twitch_channel', '=', racerId.toLowerCase()).executeTakeFirst();
  if (byTwitch) return byTwitch.id;
  const byName = await db.selectFrom('racer_profiles')
    .select('id').where('display_name', '=', racerId).executeTakeFirst();
  if (byName) return byName.id;
  const byRacetime = await db.selectFrom('racer_profiles')
    .select('id').where('racetime_name', '=', racerId).executeTakeFirst();
  if (byRacetime) return byRacetime.id;
  return racerId;
}

export function createAnalyzerRoutes(
  session: RaceAnalyzerSession,
  cropProfileService?: CropProfileService,
  db?: Kysely<Database>,
): Router {
  const router = Router();

  router.post('/start', async (req, res) => {
    const { racerId, vodUrl, playbackRate, startOffset } = req.body;
    if (!racerId || !vodUrl) {
      res.status(400).json({ error: 'racerId and vodUrl are required' });
      return;
    }
    try {
      // Look up crop profile for this racer to get calibration
      let calibration: CalibrationUniform | undefined;
      let landmarks: Array<{label:string;x:number;y:number;w:number;h:number}> | undefined;
      if (cropProfileService && db) {
        const profileId = await resolveRacerProfileId(db, racerId);
        const cropData = await cropProfileService.getDefaultForRacer(profileId);
        if (cropData.w > 0 && cropData.h > 0) {
          calibration = {
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
          }
          logger.info(`[analyzer] Built calibration from crop profile for ${racerId}: cropX=${calibration.cropX} cropY=${calibration.cropY} scaleX=${calibration.scaleX.toFixed(2)} scaleY=${calibration.scaleY.toFixed(2)}`);
        } else {
          logger.warn(`[analyzer] No crop profile found for ${racerId} — using empty calibration`);
        }
      }

      await session.start({
        racerId,
        vodUrl,
        playbackRate: playbackRate ?? 2,
        startOffset,
        calibration,
        landmarks,
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

  router.get('/frames', (_req, res) => {
    const times = session.getFrameTimes();
    res.json({ count: times.length, times });
  });

  router.get('/frame/:index', (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index)) {
      res.status(400).json({ error: 'Invalid index' });
      return;
    }
    const jpeg = session.getFrameSnapshot(index);
    if (!jpeg) {
      res.status(404).json({ error: 'Frame not found' });
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(jpeg);
  });

  return router;
}
