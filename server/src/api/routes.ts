import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Server as SocketIOServer } from 'socket.io';
import type { Kysely } from 'kysely';
import type { StreamManager } from '../stream/StreamManager.js';
import type { ObsController } from '../obs/ObsController.js';
import type { ObsLauncher } from '../obs/ObsLauncher.js';
import type { SceneBuilder } from '../obs/SceneBuilder.js';
import type { Config } from '../config.js';
import { getEditableConfig, writeConfigFile } from '../config.js';
import type { Database } from '../db/database.js';
import type { RaceOrchestrator } from '../race/RaceOrchestrator.js';
import type { RaceMonitor } from '../race/RaceMonitor.js';
import type { VisionManager } from '../vision/VisionManager.js';
import type { LearnSessionManager } from '../vision/LearnSessionManager.js';
import type { RacerPoolService } from '../race/RacerPoolService.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import type { BulkCropOnboardingService } from '../vision/BulkCropOnboardingService.js';
import type { TwitchApiClient } from '../twitch/TwitchApiClient.js';
import type { VodRaceOrchestrator } from '../race/VodRaceOrchestrator.js';
import type { VisionLogDb } from '../vision/VisionLogDb.js';
import type { KnowledgeBaseService } from '../knowledge/KnowledgeBaseService.js';
import type { VodIngestionService } from '../knowledge/VodIngestionService.js';
import type { RaceHistoryImporter } from '../knowledge/RaceHistoryImporter.js';
import type { CommentaryEngine } from '../commentary/CommentaryEngine.js';
import { createRaceRoutes } from './raceRoutes.js';
import { createLearnRoutes } from './learnRoutes.js';
import { createCropRoutes } from './cropRoutes.js';
import { createBulkCropRoutes } from './bulkCropRoutes.js';
import { createVodRaceRoutes } from './vodRaceRoutes.js';
import { createKnowledgeRoutes } from '../knowledge/knowledgeRoutes.js';
import { createCommentaryRoutes } from '../commentary/commentaryRoutes.js';
import { createTtsRoutes } from '../tts/ttsRoutes.js';
import { createScenePresetRoutes } from './scenePresetRoutes.js';
import { createScheduleRoutes } from './scheduleRoutes.js';
import { createPersonaRoutes } from './personaRoutes.js';
import { logger } from '../logger.js';

interface RouteContext {
  streamManager: StreamManager;
  obsController: ObsController;
  obsLauncher: ObsLauncher;
  sceneBuilder: SceneBuilder;
  db: Kysely<Database>;
  io: SocketIOServer;
  config: Config;
  raceOrchestrator: RaceOrchestrator;
  raceMonitor: RaceMonitor;
  visionManager: VisionManager;
  learnManager: LearnSessionManager;
  racerPool: RacerPoolService;
  cropProfileService: CropProfileService;
  bulkOnboardingService: BulkCropOnboardingService;
  twitchApi: TwitchApiClient;
  vodRaceOrchestrator: VodRaceOrchestrator;
  visionLogDb: VisionLogDb;
  knowledgeBase: KnowledgeBaseService;
  vodIngestion: VodIngestionService;
  historyImporter: RaceHistoryImporter;
  commentaryEngine: CommentaryEngine;
  ttsManager: import('../tts/TtsServiceManager.js').TtsServiceManager;
  seedMapState: import('../race/SeedMapState.js').SeedMapState;
  seedItemTracker: import('../race/SeedItemTracker.js').SeedItemTracker;
  replayOrchestrator: import('../race/ReplayOrchestrator.js').ReplayOrchestrator;
  autoFeature: import('../race/AutoFeatureEngine.js').AutoFeatureEngine;
  raceHistory: import('../race/RaceHistoryService.js').RaceHistoryService;
  racetimeApi: import('../race/RacetimeApi.js').RacetimeApi;
}

export function createApiRoutes(ctx: RouteContext): Router {
  const router = Router();

  // ─── System Status ───

  router.get('/status', async (_req, res) => {
    const streamStatuses: Record<string, any> = {};
    for (const [id, status] of ctx.streamManager.getStatus()) {
      streamStatuses[id] = status;
    }

    let obsConnected = false;
    let obsStreaming = false;
    try {
      obsConnected = ctx.obsController.isConnected();
      if (obsConnected) {
        obsStreaming = await ctx.obsController.isStreaming();
      }
    } catch { /* OBS not connected */ }

    res.json({
      server: 'running',
      obs: { connected: obsConnected, streaming: obsStreaming },
      streams: streamStatuses,
    });
  });

  router.get('/health', async (_req, res) => {
    const streamStatuses: Record<string, any> = {};
    for (const [id, status] of ctx.streamManager.getStatus()) {
      streamStatuses[id] = status;
    }

    let obsConnected = false;
    let obsStreaming = false;
    let obsScene = '';
    try {
      obsConnected = ctx.obsController.isConnected();
      if (obsConnected) {
        obsStreaming = await ctx.obsController.isStreaming();
        obsScene = await ctx.obsController.getCurrentScene();
      }
    } catch { /* OBS not connected */ }

    let kbStatus: any = { available: false };
    try {
      kbStatus = await ctx.knowledgeBase.isAvailable();
    } catch { /* knowledge base unavailable */ }

    const visionBridges = ctx.visionManager.getActiveBridges();

    res.json({
      server: 'running',
      obs: { connected: obsConnected, streaming: obsStreaming, scene: obsScene },
      streams: streamStatuses,
      vision: {
        activeBridges: visionBridges,
        bridgeCount: visionBridges.length,
      },
      commentary: {
        enabled: ctx.commentaryEngine.isEnabled(),
        generating: ctx.commentaryEngine.getIsGenerating(),
        turnCount: ctx.commentaryEngine.getTurnCount(),
      },
      knowledgeBase: kbStatus,
      tts: {
        enabled: ctx.config.tts.enabled,
      },
    });
  });

  // ─── Stream Management ───

  router.get('/streams', (_req, res) => {
    const statuses: Record<string, any> = {};
    for (const [id, status] of ctx.streamManager.getStatus()) {
      statuses[id] = status;
    }
    res.json(statuses);
  });

  router.post('/streams/:racerId/start', async (req, res) => {
    const { racerId } = req.params;
    const { twitchChannel, streamKey, quality } = req.body;

    if (!twitchChannel) {
      res.status(400).json({ error: 'twitchChannel is required' });
      return;
    }

    try {
      await ctx.streamManager.startRacer({
        racerId,
        twitchChannel,
        streamKey: streamKey || racerId,
        quality,
      });
      res.json({ status: 'started', racerId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/streams/:racerId/stop', async (req, res) => {
    const { racerId } = req.params;
    try {
      await ctx.streamManager.stopRacer(racerId);
      res.json({ status: 'stopped', racerId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/streams/stop-all', async (_req, res) => {
    await ctx.streamManager.stopAll();
    res.json({ status: 'all_stopped' });
  });

  // ─── OBS Control ───

  router.get('/obs/status', async (_req, res) => {
    try {
      const connected = ctx.obsController.isConnected();
      if (!connected) {
        res.json({ connected: false });
        return;
      }
      const streaming = await ctx.obsController.isStreaming();
      const scenes = await ctx.obsController.getSceneList();
      const currentScene = await ctx.obsController.getCurrentScene();
      res.json({ connected, streaming, scenes, currentScene });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ connected: false, error: msg });
    }
  });

  router.get('/obs/diagnostics', async (_req, res) => {
    try {
      const obs = (ctx.obsController as any).obs;
      const streamStatus = await obs.call('GetStreamStatus');
      const serviceSettings = await obs.call('GetStreamServiceSettings');
      let multitrackEnabled: string | null = null;
      try {
        const { parameterValue } = await obs.call('GetProfileParameter', {
          parameterCategory: 'Stream1',
          parameterName: 'EnableMultitrackVideo',
        });
        multitrackEnabled = parameterValue;
      } catch { /* not available */ }
      res.json({ streamStatus, serviceSettings, multitrackEnabled });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/obs/inputs', async (_req, res) => {
    try {
      const inputs = await ctx.obsController.getInputList();
      res.json(inputs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/connect', async (_req, res) => {
    try {
      await ctx.obsController.connect();
      res.json({ status: 'connected' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/scene', async (req, res) => {
    const { sceneName } = req.body;
    try {
      await ctx.obsController.switchScene(sceneName);
      res.json({ status: 'switched', sceneName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/build-scene', async (req, res) => {
    const { sceneName, racers } = req.body;
    try {
      await ctx.sceneBuilder.buildRaceScene(sceneName || `Race_${Date.now()}`, racers);
      res.json({ status: 'built', sceneName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/teardown-scene', async (req, res) => {
    const { sceneName } = req.body;
    try {
      await ctx.sceneBuilder.teardownScene(sceneName);
      res.json({ status: 'torn_down', sceneName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Remove all TTP-created scenes and inputs, leaving a clean "Scene" default
  router.post('/obs/cleanup', async (_req, res) => {
    try {
      const results = await ctx.sceneBuilder.cleanupAll();
      res.json(results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/remove-source', async (req, res) => {
    const { inputName } = req.body;
    try {
      await ctx.obsController.removeSource(inputName);
      res.json({ status: 'removed', inputName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/mute', async (req, res) => {
    const { inputName, muted } = req.body;
    try {
      await ctx.obsController.setInputMute(inputName, muted ?? true);
      res.json({ status: muted ? 'muted' : 'unmuted', inputName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/launch', async (_req, res) => {
    try {
      const launched = await ctx.obsLauncher.launch();
      if (!launched) {
        res.json({ status: 'already_running_or_no_path' });
        return;
      }
      // Wait for WebSocket connection
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          await ctx.obsController.connect();
          res.json({ status: 'launched_and_connected' });
          return;
        } catch { /* retry */ }
      }
      res.json({ status: 'launched_but_ws_pending' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/kill', async (_req, res) => {
    try {
      await ctx.obsLauncher.kill();
      res.json({ status: 'killed' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/obs/multitrack', async (_req, res) => {
    try {
      const enabled = await ctx.obsController.isMultitrackVideoEnabled();
      res.json({ enabled });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ enabled: false, error: msg });
    }
  });

  router.post('/obs/multitrack', async (req, res) => {
    const { enabled } = req.body;
    try {
      await ctx.obsController.setMultitrackVideo(!!enabled);
      res.json({ status: 'ok', enabled: !!enabled });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/configure-stream', async (req, res) => {
    const { streamKey, server } = req.body;
    const key = streamKey || ctx.config.twitch.streamKey;
    if (!key) {
      res.status(400).json({ error: 'No stream key available' });
      return;
    }
    try {
      await ctx.obsController.configureStreamService(key, server);
      res.json({ status: 'configured' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/start-streaming', async (_req, res) => {
    try {
      await ctx.obsController.startStreaming();
      res.json({ status: 'streaming' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/obs/stop-streaming', async (_req, res) => {
    try {
      await ctx.obsController.stopStreaming();
      res.json({ status: 'stopped' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Racer Profiles ───

  router.get('/profiles', async (_req, res) => {
    const profiles = await ctx.db.selectFrom('racer_profiles')
      .selectAll()
      .orderBy('display_name', 'asc')
      .execute();
    res.json(profiles);
  });

  router.get('/profiles/:id', async (req, res) => {
    const profile = await ctx.db.selectFrom('racer_profiles')
      .selectAll()
      .where('id', '=', req.params.id)
      .executeTakeFirst();

    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json(profile);
  });

  router.post('/profiles', async (req, res) => {
    const id = uuid();
    const {
      racetime_id, racetime_name, display_name, twitch_channel,
      crop_x, crop_y, crop_w, crop_h,
      stream_width, stream_height, preferred_color, notes,
    } = req.body;

    await ctx.db.insertInto('racer_profiles').values({
      id,
      racetime_id: racetime_id ?? null,
      racetime_name: racetime_name ?? null,
      display_name,
      twitch_channel,
      crop_x: crop_x ?? 0,
      crop_y: crop_y ?? 0,
      crop_w: crop_w ?? 1920,
      crop_h: crop_h ?? 1080,
      stream_width: stream_width ?? 1920,
      stream_height: stream_height ?? 1080,
      preferred_color: preferred_color ?? '#D4AF37',
      notes: notes ?? null,
    } as any).execute();

    logger.info(`Created racer profile: ${display_name} (${id})`);
    res.status(201).json({ id });
  });

  router.put('/profiles/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    delete updates.id; // prevent PK override
    delete updates.created_at;

    await ctx.db.updateTable('racer_profiles')
      .set(updates)
      .where('id', '=', id)
      .execute();

    res.json({ status: 'updated', id });
  });

  router.delete('/profiles/:id', async (req, res) => {
    await ctx.db.deleteFrom('racer_profiles')
      .where('id', '=', req.params.id)
      .execute();
    res.json({ status: 'deleted' });
  });

  // ─── Racer Pool (leaderboard sync) ───

  router.get('/pool', async (_req, res) => {
    try {
      const pool = await ctx.racerPool.getPool();
      res.json(pool);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/pool/sync', async (_req, res) => {
    try {
      const result = await ctx.racerPool.syncLeaderboard();
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/pool/import', async (req, res) => {
    const { racetimeId } = req.body;
    if (!racetimeId) {
      res.status(400).json({ error: 'racetimeId is required' });
      return;
    }
    try {
      const profileId = await ctx.racerPool.importRacer(racetimeId);
      res.json({ profileId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/pool/import-url', async (req, res) => {
    const { url } = req.body;
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    try {
      const result = await ctx.racerPool.importFromUrl(url);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ─── Vision State ───

  router.post('/vision/:racerId', (req, res) => {
    const { racerId } = req.params;
    const gameState = req.body;

    // Merge into cache and extract one-shot game events
    const { state: fullState, events } = ctx.visionManager.updateState(racerId, gameState);
    ctx.io.to('overlay').emit('vision:update', { racerId, ...fullState });
    ctx.io.to('vision').emit('vision:raw', { racerId, ...fullState });

    // Broadcast game events on a separate channel
    if (events.length > 0) {
      ctx.io.to('overlay').emit('vision:events', { racerId, events });
      ctx.io.to('vision').emit('vision:events', { racerId, events });
    }

    // Feed commentary engine with state + events
    ctx.commentaryEngine.onVisionUpdate(racerId, fullState as Record<string, unknown>, events);

    // Feed shared map state
    const screenType = fullState.screen_type as string;
    const mapPos = fullState.map_position as number | undefined;
    const dungeonLevel = fullState.dungeon_level as number | undefined;

    if (mapPos != null && (screenType === 'overworld' || screenType === 'dungeon' || screenType === 'cave')) {
      if (screenType === 'overworld') {
        const col = (mapPos % 16) + 1;
        const row = Math.floor(mapPos / 16) + 1;
        ctx.seedMapState.updatePosition(racerId, col, row, screenType);
      } else if (dungeonLevel && dungeonLevel > 0) {
        const col = (mapPos % 8) + 1;
        const row = Math.floor(mapPos / 8) + 1;
        ctx.seedMapState.updatePosition(racerId, col, row, screenType, dungeonLevel);
      }
    }

    // Pin dungeon markers from game events
    for (const evt of events) {
      if ((evt as any).event === 'dungeon_first_visit' && mapPos != null) {
        const dl = (evt as any).dungeon_level as number;
        const owPos = fullState.last_overworld_position as number | undefined;
        if (owPos != null) {
          const col = (owPos % 16) + 1;
          const row = Math.floor(owPos / 16) + 1;
          ctx.seedMapState.addDungeonMarker(racerId, col, row, dl);
        }
      }
    }

    // Feed auto-feature engine with game events
    for (const evt of events) {
      const triforceArr = fullState.triforce as boolean[] | undefined;
      const triforceCount = triforceArr ? triforceArr.filter(Boolean).length : undefined;
      ctx.autoFeature.onGameEvent(racerId, (evt as any).event, triforceCount);
    }

    // Feed seed item tracker
    ctx.seedItemTracker.processVisionUpdate(racerId, fullState as Record<string, unknown>);

    // Persist to SQLite vision log
    const raceId = ctx.raceOrchestrator.getActiveRace()?.raceDbId
      || ctx.vodRaceOrchestrator.getStatus().raceId
      || 'unknown';
    ctx.visionLogDb.insert(raceId, racerId, fullState as Record<string, unknown>);

    // Record key game events to race history
    if (raceId !== 'unknown') {
      for (const evt of events) {
        const evtType = (evt as any).event as string;
        const desc = (evt as any).description as string | undefined;
        ctx.raceHistory.recordEvent(raceId, racerId, evtType, desc ?? evtType).catch(() => {});
      }
    }

    res.status(204).send();
  });

  // Static routes must come before parameterized routes
  router.get('/vision/seed-items', (_req, res) => {
    res.json(ctx.seedItemTracker.getState());
  });

  router.get('/vision/:racerId', (req, res) => {
    const state = ctx.visionManager.getState(req.params.racerId);
    res.json({ racerId: req.params.racerId, state });
  });

  router.get('/vision', (_req, res) => {
    const bridges = ctx.visionManager.getActiveBridges();
    const states: Record<string, unknown> = {};
    for (const id of bridges) {
      states[id] = ctx.visionManager.getState(id);
    }
    res.json({ active: bridges, states });
  });

  router.post('/vision/:racerId/start', async (req, res) => {
    const { racerId } = req.params;
    const { profileId } = req.body;
    if (!profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    try {
      await ctx.visionManager.startVision(racerId, profileId);
      res.json({ status: 'started', racerId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/vision/:racerId/stop', async (req, res) => {
    const { racerId } = req.params;
    await ctx.visionManager.stopVision(racerId);
    res.json({ status: 'stopped', racerId });
  });

  // ─── Race Management (sub-router) ───

  const raceRouter = createRaceRoutes({
    orchestrator: ctx.raceOrchestrator,
    monitor: ctx.raceMonitor,
    sceneBuilder: ctx.sceneBuilder,
    cropProfileService: ctx.cropProfileService,
  });
  router.use('/race', raceRouter);

  // ─── Learn Mode (sub-router) ───

  const learnRouter = createLearnRoutes({
    learnManager: ctx.learnManager,
    db: ctx.db,
    io: ctx.io,
    config: ctx.config,
    cropProfileService: ctx.cropProfileService,
  });
  router.use('/learn', learnRouter);

  // ─── Crop Profiles (sub-router) ───

  const cropRouter = createCropRoutes({
    cropProfileService: ctx.cropProfileService,
    config: ctx.config,
  });
  router.use('/crop-profiles', cropRouter);

  // ─── Bulk Crop Onboarding (sub-router) ───

  const bulkCropRouter = createBulkCropRoutes({
    bulkOnboardingService: ctx.bulkOnboardingService,
    cropProfileService: ctx.cropProfileService,
    io: ctx.io,
  });
  router.use('/bulk-crop', bulkCropRouter);

  // ─── VOD Race (sub-router) ───

  const vodRaceRouter = createVodRaceRoutes({
    vodRaceOrchestrator: ctx.vodRaceOrchestrator,
    obsController: ctx.obsController,
  });
  router.use('/vod-race', vodRaceRouter);

  // ─── Knowledge Base (sub-router) ───

  const knowledgeRouter = createKnowledgeRoutes({
    knowledgeBase: ctx.knowledgeBase,
    vodIngestion: ctx.vodIngestion,
    historyImporter: ctx.historyImporter,
  });
  router.use('/knowledge', knowledgeRouter);

  // ─── Commentary (sub-router) ───

  const commentaryRouter = createCommentaryRoutes({
    commentaryEngine: ctx.commentaryEngine,
  });
  router.use('/commentary', commentaryRouter);

  // ─── TTS (sub-router) ───

  const ttsRouter = createTtsRoutes({
    ttsManager: ctx.ttsManager,
    config: ctx.config,
  });
  router.use('/tts', ttsRouter);

  // ─── Scene Presets (sub-router) ───

  const scenePresetRouter = createScenePresetRoutes({ db: ctx.db });
  router.use('/scene-presets', scenePresetRouter);

  // ─── Schedule (sub-router) ───

  const scheduleRouter = createScheduleRoutes({ db: ctx.db });
  router.use('/schedule', scheduleRouter);

  // ─── Personas + Voice Profiles (sub-router) ───

  const personaRouter = createPersonaRoutes({ db: ctx.db });
  router.use('/', personaRouter);

  // ─── Chat Highlight ───

  router.post('/commentary/feature-chat', (req, res) => {
    const { displayName, message } = req.body;
    if (!displayName || !message) {
      res.status(400).json({ error: 'displayName and message are required' });
      return;
    }
    ctx.io.to('overlay').emit('chat:highlight', { username: displayName, message });
    res.json({ ok: true });
  });

  // ─── Race Library (past races from racetime.gg) ───

  router.get('/races/history', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const data = await ctx.racetimeApi.getPastRaces(page);
      // Return only finished races with the fields the dashboard needs
      const races = data.races
        .filter(r => r.status.value === 'finished')
        .map(r => ({
          slug: r.name,
          url: `https://racetime.gg/${r.name}`,
          goal: r.goal.name,
          info: r.info,
          entrantCount: r.entrants_count,
          finishedCount: r.entrants_count_finished,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          recorded: r.recorded,
        }));
      res.json({ races, page, totalPages: data.num_pages, totalRaces: data.count });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[RaceLibrary] Failed to fetch race history', { err: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ─── Replay Routes ───

  router.post('/replay/resolve', async (req, res) => {
    const { racetimeUrl } = req.body;
    if (!racetimeUrl) {
      res.status(400).json({ error: 'racetimeUrl is required' });
      return;
    }
    try {
      const replay = await ctx.replayOrchestrator.resolveRace(racetimeUrl);
      res.json(replay);
    } catch (err) {
      logger.error('[Replay] Failed to resolve race', { err });
      res.status(500).json({ error: 'Failed to resolve race' });
    }
  });

  router.get('/replay/list', async (_req, res) => {
    try {
      const replays = await ctx.replayOrchestrator.listReplays();
      res.json(replays);
    } catch (err) {
      logger.error('[Replay] Failed to list replays', { err });
      res.status(500).json({ error: 'Failed to list replays' });
    }
  });

  router.get('/replay/:id', async (req, res) => {
    try {
      const replay = await ctx.replayOrchestrator.getReplay(req.params.id);
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' });
        return;
      }
      res.json(replay);
    } catch (err) {
      logger.error('[Replay] Failed to get replay', { err });
      res.status(500).json({ error: 'Failed to get replay' });
    }
  });

  router.post('/replay/:id/start', async (req, res) => {
    try {
      const replay = await ctx.replayOrchestrator.getReplay(req.params.id);
      if (!replay) {
        res.status(404).json({ error: 'Replay not found' });
        return;
      }

      // Build entrants for VodRaceOrchestrator
      // Caller provides profileId mappings in body: { profiles: { racetimeId: profileId } }
      const profiles: Record<string, string> = req.body?.profiles ?? {};
      const entrantsWithVods = replay.entrants.filter(e => e.vodUrl && profiles[e.racetimeId]);
      if (entrantsWithVods.length < 2) {
        res.status(400).json({ error: 'Not enough entrants with VODs and profile mappings (need at least 2)' });
        return;
      }

      const vodRacers = entrantsWithVods.slice(0, 4).map(e => ({
        profileId: profiles[e.racetimeId],
        vodUrl: e.vodUrl!,
        startOffsetSeconds: e.vodOffsetSeconds,
      }));

      await ctx.vodRaceOrchestrator.setupVodRace({
        racers: vodRacers,
        title: `Replay: ${replay.goal ?? replay.racetimeUrl}`,
      });
      await ctx.vodRaceOrchestrator.confirmSetup();
      await ctx.vodRaceOrchestrator.goLive();

      res.json({ status: 'started', entrantCount: vodRacers.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Replay] Failed to start replay: ${msg}`, { stack: err instanceof Error ? err.stack : undefined });
      res.status(500).json({ error: msg || 'Failed to start replay' });
    }
  });

  // ─── Config Management ───

  router.get('/config', (_req, res) => {
    res.json(getEditableConfig(ctx.config));
  });

  router.put('/config', (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== 'object') {
        res.status(400).json({ error: 'Request body must be a JSON object' });
        return;
      }
      // Prevent writing secrets via this endpoint
      const forbidden = ['mysql', 'twitch.streamKey', 'twitch.oauthToken', 'twitch.clientId',
        'twitch.clientSecret', 'twitch.turboToken', 'obs.password', 'racetime.clientId', 'racetime.clientSecret'];
      for (const key of forbidden) {
        const [section, field] = key.split('.');
        if (field) {
          if (updates[section] && (updates[section] as Record<string, unknown>)[field] !== undefined) {
            delete (updates[section] as Record<string, unknown>)[field];
          }
        } else {
          delete updates[section];
        }
      }
      const result = writeConfigFile(updates);
      logger.info('[Config] Configuration updated', { sections: Object.keys(updates) });
      res.json({ status: 'saved', ...result });
    } catch (err) {
      logger.error('[Config] Failed to write config', { err });
      res.status(500).json({ error: 'Failed to write configuration' });
    }
  });

  router.post('/restart', (_req, res) => {
    logger.info('[Config] Server restart requested via API');
    res.json({ status: 'restarting' });
    setTimeout(() => process.exit(0), 500);
  });

  // ─── Twitch Channel Management ───

  router.get('/twitch/channel', async (_req, res) => {
    try {
      if (!ctx.twitchApi.isConfigured()) {
        res.status(503).json({ error: 'Twitch API not configured' });
        return;
      }
      const info = await ctx.twitchApi.getChannelInfo();
      res.json(info);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.patch('/twitch/channel', async (req, res) => {
    try {
      if (!ctx.twitchApi.isConfigured()) {
        res.status(503).json({ error: 'Twitch API not configured' });
        return;
      }
      const { title, game_id, tags } = req.body;
      if (title === undefined && game_id === undefined && tags === undefined) {
        res.status(400).json({ error: 'At least one of title, game_id, or tags is required' });
        return;
      }
      await ctx.twitchApi.updateChannelInfo({ title, game_id, tags });
      // Return updated info
      const info = await ctx.twitchApi.getChannelInfo();
      res.json(info);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/twitch/categories', async (req, res) => {
    try {
      if (!ctx.twitchApi.isConfigured()) {
        res.status(503).json({ error: 'Twitch API not configured' });
        return;
      }
      const query = req.query.q as string;
      if (!query) {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }
      const categories = await ctx.twitchApi.searchCategories(query);
      res.json(categories);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
