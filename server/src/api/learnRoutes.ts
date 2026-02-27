import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { Kysely } from 'kysely';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { LearnSessionManager } from '../vision/LearnSessionManager.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import { logger } from '../logger.js';

interface LearnRouteContext {
  learnManager: LearnSessionManager;
  db: Kysely<Database>;
  io: SocketIOServer;
  config: Config;
  cropProfileService: CropProfileService;
}

export function createLearnRoutes(ctx: LearnRouteContext): Router {
  const router = Router();

  // ─── Start new learn session ───
  router.post('/sessions', async (req, res) => {
    const { source, profileId, cropRegion, fps, startTime, endTime, snapshotInterval, maxSnapshots, anyRoads } = req.body;
    if (!source) {
      res.status(400).json({ error: 'source is required' });
      return;
    }
    try {
      const id = await ctx.learnManager.startSession({ source, profileId, cropRegion, fps, startTime, endTime, snapshotInterval, maxSnapshots, anyRoads });
      ctx.io.to('learn').emit('learn:started', { sessionId: id, source });
      res.status(201).json({ sessionId: id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Learn session start failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ─── List all sessions ───
  router.get('/sessions', (_req, res) => {
    const sessions = ctx.learnManager.getAllSessions();
    res.json(sessions);
  });

  // ─── Get single session ───
  router.get('/sessions/:id', (req, res) => {
    const session = ctx.learnManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  // ─── Delete session ───
  router.delete('/sessions/:id', async (req, res) => {
    const deleted = ctx.learnManager.deleteSession(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Clean up snapshot files
    const snapshotsDir = resolve(import.meta.dirname, '../../../data/learn-snapshots', req.params.id);
    try {
      await rm(snapshotsDir, { recursive: true, force: true });
    } catch {
      // Snapshots dir may not exist — that's fine
    }

    ctx.io.to('learn').emit('learn:deleted', { sessionId: req.params.id });
    res.json({ status: 'deleted' });
  });

  // ─── Cancel running session ───
  router.post('/sessions/:id/cancel', (req, res) => {
    const session = ctx.learnManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    ctx.learnManager.cancelSession(req.params.id);
    ctx.io.to('learn').emit('learn:cancelled', { sessionId: req.params.id });
    res.json({ status: 'cancelled' });
  });

  // ─── Progress callback (from Python) ───
  router.post('/sessions/:id/progress', (req, res) => {
    const { id } = req.params;
    const progress = req.body;

    ctx.learnManager.updateProgress(id, progress);
    ctx.io.to('learn').emit('learn:progress', { sessionId: id, ...progress });

    res.status(204).send();
  });

  // ─── Report callback (from Python) ───
  router.post('/sessions/:id/report', (req, res) => {
    const { id } = req.params;
    const report = req.body;

    ctx.learnManager.completeSession(id, report);

    // Auto-annotate meaningful events from the report
    autoAnnotateFromReport(ctx, id, report);

    ctx.io.to('learn').emit('learn:complete', { sessionId: id });

    logger.info(`[learn:${id}] Report received: ${report.total_frames} frames`);
    res.status(204).send();
  });

  // ─── Save crop to racer profile ───
  router.post('/sessions/:id/save-crop', async (req, res) => {
    const session = ctx.learnManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const profileId = req.body.profileId || session.profileId;
    if (!profileId) {
      res.status(400).json({ error: 'profileId is required (in body or session)' });
      return;
    }

    const crop = session.cropResult;
    if (!crop) {
      res.status(400).json({ error: 'No crop result available for this session' });
      return;
    }

    try {
      // Update inline fields on racer_profiles for backward compatibility
      await ctx.db.updateTable('racer_profiles')
        .set({
          crop_x: crop.x,
          crop_y: crop.y,
          crop_w: crop.w,
          crop_h: crop.h,
          stream_width: crop.source_width,
          stream_height: crop.source_height,
        })
        .where('id', '=', profileId)
        .execute();

      // Also create/update a crop_profile entry
      await ctx.cropProfileService.create({
        racer_profile_id: profileId,
        label: 'Auto-detected',
        crop_x: crop.x,
        crop_y: crop.y,
        crop_w: crop.w,
        crop_h: crop.h,
        stream_width: crop.source_width,
        stream_height: crop.source_height,
        is_default: true,
        notes: `Auto-detected from learn session ${req.params.id}`,
      });

      logger.info(`[learn] Saved crop to profile ${profileId}: ${crop.x},${crop.y},${crop.w},${crop.h}`);
      res.json({ status: 'saved', profileId, crop });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Session Metadata ───

  router.put('/sessions/:id/metadata', (req, res) => {
    const result = ctx.learnManager.updateMetadata(req.params.id, req.body);
    if (!result) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ status: 'updated', metadata: result });
  });

  // ─── Annotations (interactive training/feedback) ───

  router.get('/sessions/:id/annotations', (req, res) => {
    const annotations = ctx.learnManager.getAnnotations(req.params.id);
    res.json(annotations);
  });

  router.post('/sessions/:id/annotations', (req, res) => {
    const { type, field, expectedValue, detectedValue, note, frameNumber, videoTimestamp, snapshotFilename, metadata } = req.body;
    if (!type) {
      res.status(400).json({ error: 'type is required' });
      return;
    }
    // Note is required unless metadata provides structured data
    if (!note && !metadata) {
      res.status(400).json({ error: 'note or metadata is required' });
      return;
    }

    const annotation = ctx.learnManager.addAnnotation(req.params.id, {
      type,
      field,
      expectedValue,
      detectedValue,
      note: note || '',
      frameNumber,
      videoTimestamp,
      snapshotFilename,
      metadata,
    });

    if (!annotation) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    ctx.io.to('learn').emit('learn:annotation', { sessionId: req.params.id, annotation });
    res.status(201).json(annotation);
  });

  router.put('/sessions/:id/annotations/:annotationId', (req, res) => {
    const annotation = ctx.learnManager.updateAnnotation(req.params.id, req.params.annotationId, req.body);
    if (!annotation) {
      res.status(404).json({ error: 'Annotation or session not found' });
      return;
    }
    ctx.io.to('learn').emit('learn:annotation', { sessionId: req.params.id, annotation });
    res.json(annotation);
  });

  router.delete('/sessions/:id/annotations/:annotationId', (req, res) => {
    const deleted = ctx.learnManager.deleteAnnotation(req.params.id, req.params.annotationId);
    if (!deleted) {
      res.status(404).json({ error: 'Annotation or session not found' });
      return;
    }
    res.json({ status: 'deleted' });
  });

  // ─── Quick auto-crop (no full session) ───
  router.post('/auto-crop', async (req, res) => {
    const { source, profileId } = req.body;
    if (!source) {
      res.status(400).json({ error: 'source is required' });
      return;
    }

    try {
      // Start a quick learn session with just 1 fps to auto-detect crop fast
      const id = await ctx.learnManager.startSession({ source, profileId, fps: 1 });
      res.status(201).json({ sessionId: id, message: 'Auto-crop session started — check progress' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

// ─── Auto-annotate from report data ───

function autoAnnotateFromReport(
  ctx: LearnRouteContext,
  sessionId: string,
  report: {
    screen_transitions?: [number, string, string][];
    detector_stats?: Record<string, { name: string; value_changes: number; values_seen: Record<string, number> }>;
    video_duration_s?: number;
    total_frames?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshots?: any[];
  },
) {
  const transitions = report.screen_transitions ?? [];
  let autoCount = 0;

  // Track dungeon visits from transitions
  // When we go from non-dungeon → dungeon, that's an enter
  // When we go from dungeon → non-dungeon, that's an exit
  const dungeonTypes = new Set(['dungeon']);
  const nonGameScreens = new Set(['title', 'unknown', 'subscreen']);
  let inDungeon = false;
  let dungeonEnterTime = 0;

  for (const t of transitions) {
    const [timestamp, fromType, toType] = t;

    // Dungeon enter: non-dungeon → dungeon
    if (!dungeonTypes.has(fromType) && dungeonTypes.has(toType) && !nonGameScreens.has(fromType)) {
      inDungeon = true;
      dungeonEnterTime = timestamp;
      ctx.learnManager.addAnnotation(sessionId, {
        type: 'game_event',
        note: `Entered dungeon area (from ${fromType})`,
        videoTimestamp: timestamp,
        metadata: { auto: 'true', event: 'dungeon_enter', from: fromType },
      });
      autoCount++;
    }

    // Dungeon exit: dungeon → overworld/cave (not subscreen, which is just pausing)
    if (dungeonTypes.has(fromType) && !dungeonTypes.has(toType) && !nonGameScreens.has(toType) && inDungeon) {
      const duration = timestamp - dungeonEnterTime;
      ctx.learnManager.addAnnotation(sessionId, {
        type: 'game_event',
        note: `Left dungeon area → ${toType} (spent ${Math.round(duration)}s)`,
        videoTimestamp: timestamp,
        metadata: { auto: 'true', event: 'dungeon_exit', to: toType, duration: String(Math.round(duration)) },
      });
      inDungeon = false;
      autoCount++;
    }

    // Cave enter/exit
    if (fromType === 'overworld' && toType === 'cave') {
      ctx.learnManager.addAnnotation(sessionId, {
        type: 'game_event',
        note: 'Entered cave',
        videoTimestamp: timestamp,
        metadata: { auto: 'true', event: 'cave_enter' },
      });
      autoCount++;
    }
    if (fromType === 'cave' && toType === 'overworld') {
      ctx.learnManager.addAnnotation(sessionId, {
        type: 'game_event',
        note: 'Exited cave → overworld',
        videoTimestamp: timestamp,
        metadata: { auto: 'true', event: 'cave_exit' },
      });
      autoCount++;
    }
  }

  // Annotate total session summary
  if (report.video_duration_s && report.total_frames) {
    ctx.learnManager.addAnnotation(sessionId, {
      type: 'note',
      note: `Auto-analysis: ${report.total_frames} frames over ${Math.round(report.video_duration_s)}s, ${transitions.length} transitions`,
      videoTimestamp: 0,
      metadata: { auto: 'true', event: 'summary' },
    });
    autoCount++;
  }

  if (autoCount > 0) {
    logger.info(`[learn:${sessionId}] Auto-annotated ${autoCount} events from report`);
  }
}
