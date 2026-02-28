import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer } from 'ws';
import { resolve, dirname, delimiter } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { StreamManager } from './stream/StreamManager.js';
import { ObsController } from './obs/ObsController.js';
import { ObsLauncher } from './obs/ObsLauncher.js';
import { SceneBuilder } from './obs/SceneBuilder.js';
import { initDatabase, runMigrations, closeDatabase } from './db/database.js';
import { createApiRoutes } from './api/routes.js';
import { RaceMonitor } from './race/RaceMonitor.js';
import { RaceOrchestrator } from './race/RaceOrchestrator.js';
import { VisionManager } from './vision/VisionManager.js';
import { LearnSessionManager } from './vision/LearnSessionManager.js';
import { RacerPoolService } from './race/RacerPoolService.js';
import { CropProfileService } from './vision/CropProfileService.js';
import { TwitchApiClient } from './twitch/TwitchApiClient.js';
import { BulkCropOnboardingService } from './vision/BulkCropOnboardingService.js';
import { VodRaceOrchestrator } from './race/VodRaceOrchestrator.js';
import { VisionLogDb } from './vision/VisionLogDb.js';
import { KnowledgeBaseService } from './knowledge/KnowledgeBaseService.js';
import { CommentaryEngine } from './commentary/CommentaryEngine.js';
import { TtsServiceManager } from './tts/TtsServiceManager.js';
import { TwitchChatClient } from './twitch/TwitchChatClient.js';
import { ChatBuffer } from './twitch/ChatBuffer.js';
import { SeedMapState } from './race/SeedMapState.js';
import { AutoFeatureEngine } from './race/AutoFeatureEngine.js';
import { RaceHistoryService } from './race/RaceHistoryService.js';
import { SeedItemTracker } from './race/SeedItemTracker.js';
import { ReplayOrchestrator } from './race/ReplayOrchestrator.js';
import { VodIngestionService } from './knowledge/VodIngestionService.js';
import { RaceHistoryImporter } from './knowledge/RaceHistoryImporter.js';
import { VisionWorkerManager } from './vision/VisionWorkerManager.js';

async function main() {
  // ─── Augment PATH with tool directories ───
  // NSSM service runs with system PATH which may not include user-installed tools.
  // Add the directories of configured ffmpeg/streamlink so all child processes find them.
  const toolDirs = [
    dirname(config.tools.ffmpegPath),
    dirname(config.tools.streamlinkPath),
  ].filter((d) => d !== '.' && d.length > 1);
  if (toolDirs.length) {
    process.env.PATH = [...toolDirs, process.env.PATH ?? ''].join(delimiter);
  }

  logger.info('Starting TTP Restream Server...');

  // ─── Database ───
  await runMigrations(config);
  const db = initDatabase(config);
  const raceHistory = new RaceHistoryService(db);

  // ─── Stream Manager ───
  const streamManager = new StreamManager(config);
  streamManager.start();

  // ─── OBS Launcher + Controller ───
  const obsLauncher = new ObsLauncher(config);
  const obsController = new ObsController(config);
  const sceneBuilder = new SceneBuilder(obsController, config);

  // Try to connect to OBS (user starts OBS separately in their desktop session)
  try {
    await obsController.connect();
  } catch {
    logger.info('OBS not reachable — waiting for user to start OBS (will auto-reconnect)');
    obsController.scheduleReconnect();
  }

  // Configure Twitch stream key after connecting
  // (can't rely on 'connected' event listener — it's registered later)
  if (obsController.isConnected() && config.twitch.streamKey) {
    try {
      await obsController.configureStreamService(config.twitch.streamKey);
      logger.info('Auto-configured Twitch stream key in OBS');
    } catch (err) {
      logger.warn('Failed to auto-configure stream service', { err });
    }
  }

  // ─── Express + Socket.IO ───
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });

  app.use(express.json({ limit: '50mb' }));

  // ─── Crop Profile Service ───
  const cropProfileService = new CropProfileService(db);

  // ─── Vision Manager + Log DB ───
  const visionManager = new VisionManager(config, cropProfileService);
  const visionLogDb = new VisionLogDb(resolve(import.meta.dirname, '../../data/vision-log.db'));

  // ─── Vision Worker Manager (WebGPU browser-side pipeline) ───
  const visionWorkerManager = new VisionWorkerManager();
  visionWorkerManager.start().catch(err => logger.error('VisionWorkerManager start failed', { err }));

  // ─── Learn Session Manager ───
  const learnManager = new LearnSessionManager(config);

  // ─── Race Monitor + Orchestrator ───
  const raceMonitor = new RaceMonitor(config);
  const raceOrchestrator = new RaceOrchestrator(
    raceMonitor, streamManager, obsController, sceneBuilder, db, io, config, visionManager, cropProfileService,
  );

  // ─── Racer Pool Service ───
  const racerPool = new RacerPoolService(db, raceMonitor.racetimeApi);

  // ─── Twitch API Client + Bulk Crop Onboarding ───
  const twitchApi = new TwitchApiClient(config);
  const bulkOnboardingService = new BulkCropOnboardingService(db, twitchApi, cropProfileService, config);

  // ─── Replay Orchestrator ───
  const replayOrchestrator = new ReplayOrchestrator(raceMonitor.racetimeApi, twitchApi, db);

  // ─── Knowledge Base ───
  const knowledgeBase = new KnowledgeBaseService(config);
  const vodIngestion = new VodIngestionService(config, knowledgeBase);
  const historyImporter = new RaceHistoryImporter(raceMonitor.racetimeApi, db, config.racetime.category);

  // Forward VOD ingestion progress to dashboard
  vodIngestion.on('progress', (progress) => {
    io.to('dashboard').emit('knowledge:ingestionProgress', progress);
  });

  // ─── TTS Service ───
  const ttsManager = new TtsServiceManager(config);
  if (config.tts.enabled) {
    await ttsManager.start();
  }

  // ─── Commentary Engine ───
  const commentaryEngine = new CommentaryEngine(config, io, knowledgeBase, ttsManager);

  // ─── Seed Map State ───
  const seedMapState = new SeedMapState();
  seedMapState.on('positionUpdate', (state) => {
    io.to('overlay').emit('map:state', state);
  });
  seedMapState.on('markerUpdate', (state) => {
    io.to('overlay').emit('map:state', state);
  });

  // ─── Seed Item Tracker ───
  const seedItemTracker = new SeedItemTracker();
  seedItemTracker.on('discovery', (data) => {
    io.to('overlay').emit('seed:itemDiscovery', data);
  });

  // ─── Auto-Feature Engine ───
  const autoFeature = new AutoFeatureEngine();

  autoFeature.on('layoutChange', async ({ layout, featuredRacer }: { layout: string; featuredRacer: string | null }) => {
    try {
      if (layout === 'featured' && featuredRacer) {
        await sceneBuilder.rebuildWithFeatured(featuredRacer);
        io.to('overlay').emit('layout:change', { layout: 'featured', featuredRacer });
      } else {
        await sceneBuilder.rebuildEqual();
        io.to('overlay').emit('layout:change', { layout: 'equal', featuredRacer: null });
      }
    } catch (err) {
      logger.warn('[AutoFeature] Scene rebuild failed', { err });
    }
  });

  // ─── Twitch Chat ───
  let twitchChat: TwitchChatClient | null = null;
  const chatBuffer = new ChatBuffer(config.twitch.chatBufferSize);

  if (config.twitch.chatEnabled && config.twitch.channel) {
    twitchChat = new TwitchChatClient(config.twitch.channel, config.twitch.oauthToken || undefined);
    commentaryEngine.setChatBuffer(chatBuffer);

    twitchChat.on('message', (msg) => {
      if (chatBuffer.addMessage(msg)) {
        io.to('overlay').emit('chat:message', msg);
        io.to('commentary').emit('chat:message', msg);
      }
    });

    twitchChat.connect().catch((err) => {
      logger.error(`[TwitchChat] Failed to connect: ${err}`);
    });
  }

  // ─── Commentary ↔ Race Auto-sync ───

  // When race goes live, auto-populate commentary with race context
  raceOrchestrator.on('raceGoLive', async () => {
    seedMapState.clear();
    seedItemTracker.clear();
    autoFeature.clear();
    const race = raceOrchestrator.getActiveRace();
    if (!race) return;

    // Build player stats from racer pool
    const pool = await racerPool.getPool();
    const playerStats: Record<string, { leaderboardPlace?: number; leaderboardScore?: number; bestTime?: string; timesRaced?: number }> = {};
    for (const ent of race.entrants) {
      const poolEntry = pool.find(p => p.racetime_id === ent.entrant.user.id);
      if (poolEntry) {
        playerStats[ent.entrant.user.id] = {
          leaderboardPlace: poolEntry.leaderboard_place ?? undefined,
          leaderboardScore: poolEntry.leaderboard_score ?? undefined,
          bestTime: poolEntry.best_time ?? undefined,
          timesRaced: poolEntry.times_raced ?? undefined,
        };
      }
    }

    // Map both racetime user IDs and profile IDs to display names
    // (vision sends profile IDs, racetime uses user IDs)
    const playerNames: Record<string, string> = {};
    const players: string[] = [];
    for (const ent of race.entrants) {
      const name = ent.profileDisplayName || ent.entrant.user.name;
      playerNames[ent.entrant.user.id] = name;
      if (ent.profileId) {
        playerNames[ent.profileId] = name;
        players.push(ent.profileId);
      } else {
        players.push(ent.entrant.user.id);
      }
    }

    commentaryEngine.setRaceContext({
      players,
      playerNames,
      flags: race.info || undefined,
      tournament: race.goal || undefined,
      goal: race.goal,
      raceUrl: race.raceUrl,
      raceStartedAt: race.startedAt ?? undefined,
      playerStats,
    });

    logger.info('[Commentary] Auto-synced race context from orchestrator');
  });

  // Keep commentary standings in sync with race
  raceOrchestrator.on('entrantUpdate', () => {
    const race = raceOrchestrator.getActiveRace();
    if (!race) return;
    const standings = race.entrants
      .filter(e => e.slot >= 0)
      .map(e => ({
        racerId: e.entrant.user.id,
        displayName: e.entrant.user.name,
        status: e.entrant.status.value === 'done' ? 'finished' as const
          : e.entrant.status.value === 'dnf' ? 'forfeit' as const
          : 'racing' as const,
        place: e.entrant.place ?? undefined,
        finishTime: e.entrant.finish_time ?? undefined,
      }));
    commentaryEngine.setRaceContext({ standings });
  });

  raceOrchestrator.on('stateChange', (newState: string) => {
    if (newState === 'finished') {
      commentaryEngine.generateRaceSummary();
    }
  });

  // ─── VOD Race Orchestrator ───
  const vodRaceOrchestrator = new VodRaceOrchestrator(
    db, streamManager, obsController, sceneBuilder, cropProfileService, visionManager, io,
  );

  // ─── VOD Race ↔ Commentary Auto-sync ───
  const vodStandings = new Map<string, { status: string; finishTime?: string }>();
  let vodRaceStartedAt: string | null = null;

  vodRaceOrchestrator.on('raceGoLive', () => {
    vodStandings.clear();
    seedMapState.clear();
    seedItemTracker.clear();
    autoFeature.clear();
    vodRaceStartedAt = new Date().toISOString();
    const status = vodRaceOrchestrator.getStatus();
    const players: string[] = [];
    const playerNames: Record<string, string> = {};
    for (const r of status.racers) {
      players.push(r.profileId);
      playerNames[r.profileId] = r.displayName;
      vodStandings.set(r.profileId, { status: 'racing' });
    }
    commentaryEngine.setRaceContext({
      players,
      playerNames,
      tournament: status.title ?? undefined,
      goal: status.title ?? undefined,
      raceStartedAt: vodRaceStartedAt,
    });

    // Emit timer to overlay so the race clock starts
    const timerData = { startedAt: vodRaceStartedAt, clockOffsetMs: 0 };
    io.to('overlay').emit('race:timer', timerData);
    io.to('dashboard').emit('race:timer', timerData);

    // Auto-enable commentary for VOD races
    commentaryEngine.enable();

    logger.info('[Commentary] Auto-synced VOD race context and enabled commentary');
  });

  vodRaceOrchestrator.on('entrantUpdate', (update: { racerId: string; status: string; finishTime?: string }) => {
    vodStandings.set(update.racerId, { status: update.status, finishTime: update.finishTime });
    const status = vodRaceOrchestrator.getStatus();
    const standings = status.racers.map(r => {
      const st = vodStandings.get(r.profileId) ?? { status: 'racing' };
      return {
        racerId: r.profileId,
        displayName: r.displayName,
        status: st.status as 'racing' | 'finished' | 'forfeit',
        finishTime: st.finishTime,
      };
    });
    commentaryEngine.setRaceContext({ standings });
  });

  // Serve vision-tab static files (browser-side WebGPU pipeline)
  app.use('/vision-tab', express.static(resolve(import.meta.dirname, '../public/vision-tab')));

  // Serve TTS audio files
  app.use('/tts', express.static(ttsManager.getAudioDir()));

  // Serve overlay static files
  const overlayDistPath = resolve(import.meta.dirname, '../../overlay/dist');
  const overlayDevPath = resolve(import.meta.dirname, '../../overlay/src');
  app.use('/overlay', express.static(overlayDistPath));
  app.use('/overlay', express.static(overlayDevPath)); // fallback to src in dev

  // Serve dashboard static files (production)
  const dashboardDistPath = resolve(import.meta.dirname, '../../dashboard/dist');
  app.use('/dashboard', express.static(dashboardDistPath));

  // Serve learn session snapshots
  const snapshotsPath = resolve(import.meta.dirname, '../../data/learn-snapshots');
  app.use('/api/learn/snapshots', express.static(snapshotsPath));

  // Serve crop profile screenshots
  const cropScreenshotsPath = resolve(import.meta.dirname, '../../data/crop-screenshots');
  app.use('/api/crop-profiles/screenshots', express.static(cropScreenshotsPath));

  // Serve item sprite assets for overlay
  const itemSpritesPath = resolve(import.meta.dirname, '../../vision/templates/items');
  app.use('/overlay/sprites/items', express.static(itemSpritesPath));

  // Serve overworld room tiles for map position review
  const roomTilesPath = resolve(import.meta.dirname, '../../content/overworld_rooms');
  app.use('/api/learn/rooms', express.static(roomTilesPath));

  // API routes
  const apiRouter = createApiRoutes({
    streamManager,
    obsController,
    obsLauncher,
    sceneBuilder,
    db,
    io,
    config,
    raceOrchestrator,
    raceMonitor,
    visionManager,
    learnManager,
    racerPool,
    cropProfileService,
    bulkOnboardingService,
    twitchApi,
    vodRaceOrchestrator,
    visionLogDb,
    knowledgeBase,
    vodIngestion,
    historyImporter,
    commentaryEngine,
    ttsManager,
    seedMapState,
    seedItemTracker,
    replayOrchestrator,
    autoFeature,
    raceHistory,
    racetimeApi: raceMonitor.racetimeApi,
  });
  app.use('/api', apiRouter);

  // SPA fallback for dashboard (Express 5 uses named splat params)
  app.get('/dashboard/{*path}', (_req, res) => {
    res.sendFile(resolve(dashboardDistPath, 'index.html'));
  });

  // ─── Socket.IO Channels ───
  io.on('connection', (socket) => {
    logger.debug(`Socket connected: ${socket.id}`);

    socket.on('join', (channel: string) => {
      socket.join(channel);
      logger.debug(`Socket ${socket.id} joined channel: ${channel}`);

      // Send initial state when overlay connects
      if (channel === 'overlay') {
        // Send current seed item tracker state
        const seedState = seedItemTracker.getState();
        if (Object.values(seedState).some(v => v !== null)) {
          socket.emit('seed:itemState', seedState);
        }
        const race = raceOrchestrator.getActiveRace();
        if (race) {
          const racers = race.entrants
            .filter((e) => e.slot >= 0)
            .sort((a, b) => a.slot - b.slot)
            .map((e) => ({
              racerId: e.entrant.user.id,
              displayName: e.entrant.user.name,
              slot: e.slot,
              status: e.entrant.status.value === 'in_progress' ? 'racing' as const
                : e.entrant.status.value === 'done' ? 'finished' as const
                : e.entrant.status.value === 'dnf' ? 'forfeit' as const
                : 'racing' as const,
              finishTime: e.entrant.finish_time ?? undefined,
              finishPlace: e.entrant.place ?? undefined,
            }));
          socket.emit('overlay:state', {
            raceActive: race.orchestratorState === 'live' || race.racetimeStatus === 'in_progress',
            raceStartedAt: race.startedAt ?? undefined,
            clockOffsetMs: race.clockOffsetMs,
            racers,
          });
        } else {
          // Fallback: VOD race
          const vodStatus = vodRaceOrchestrator.getStatus();
          if (vodStatus.state === 'live') {
            socket.emit('overlay:state', {
              raceActive: true,
              raceStartedAt: vodRaceStartedAt ?? undefined,
              clockOffsetMs: 0,
              racers: vodStatus.racers.map(r => {
                const st = vodStandings.get(r.profileId) ?? { status: 'racing' };
                return {
                  racerId: r.profileId,
                  displayName: r.displayName,
                  slot: r.slot,
                  status: st.status as 'racing' | 'finished' | 'forfeit',
                  finishTime: st.finishTime,
                };
              }),
            });
          }
        }
      }
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });

  // Forward stream state changes to dashboard and overlay
  streamManager.on('streamStateChange', (status) => {
    io.to('dashboard').emit('stream:stateChange', status);
    io.to('overlay').emit('stream:stateChange', status);
  });

  // Forward stream health data to dashboard
  streamManager.on('streamHealth', (health) => {
    io.to('dashboard').emit('stream:health', health);
  });

  // Auto-rebuild scene when crop profiles change during a live race
  cropProfileService.on('cropUpdated', async (profileId: string) => {
    const activeRace = raceOrchestrator.getActiveRace();
    const vodStatus = vodRaceOrchestrator.getStatus();
    if (activeRace?.orchestratorState === 'live') {
      try {
        await sceneBuilder.rebuildEqual();
        logger.info(`[AutoRebuild] Scene rebuilt after crop update for ${profileId}`);
      } catch (err) {
        logger.warn('[AutoRebuild] Failed', { err });
      }
    } else if (vodStatus.state === 'live') {
      try {
        await vodRaceOrchestrator.rebuildScene();
        logger.info(`[AutoRebuild] VOD scene rebuilt after crop update for ${profileId}`);
      } catch (err) {
        logger.warn('[AutoRebuild] Failed', { err });
      }
    }
  });

  // When OBS connects, auto-configure Twitch stream key
  obsController.on('connected', async () => {
    io.to('dashboard').emit('obs:connected');
    if (config.twitch.streamKey) {
      try {
        await obsController.configureStreamService(config.twitch.streamKey);
        logger.info('Auto-configured Twitch stream key in OBS');
      } catch (err) {
        logger.warn('Failed to auto-configure stream service', { err });
      }
    }
  });
  obsController.on('disconnected', () => {
    io.to('dashboard').emit('obs:disconnected');
  });

  // ─── Vision Tab WebSocket Endpoint ───
  const visionWss = new WebSocketServer({ server: httpServer, path: '/vision-tab-ws' });
  visionWss.on('connection', (tabWs, req) => {
    const url = new URL(req.url!, `http://localhost`);
    const racerId = url.searchParams.get('racerId');
    // ws package type vs Node.js 22 built-in global WebSocket — structurally identical at runtime
    if (racerId) visionWorkerManager.registerTabWebSocket(racerId, tabWs as unknown as WebSocket);
  });

  // ─── Start HTTP Server ───
  httpServer.listen(config.server.port, () => {
    logger.info(`TTP Server listening on http://localhost:${config.server.port}`);
    logger.info(`Overlay URL: http://localhost:${config.server.port}/overlay`);
    logger.info(`Dashboard URL: http://localhost:${config.server.port}/dashboard`);
    logger.info(`API URL: http://localhost:${config.server.port}/api`);

    // Start race monitoring after server is ready
    raceMonitor.start();
  });

  // ─── Graceful Shutdown ───
  const shutdown = async () => {
    logger.info('Shutting down...');
    raceMonitor.stop();
    commentaryEngine.stop();
    if (twitchChat) await twitchChat.disconnect();
    await ttsManager.stop();
    // Cancel any running learn sessions
    for (const s of learnManager.getAllSessions()) {
      if (s.status === 'running' || s.status === 'starting') {
        learnManager.cancelSession(s.id);
      }
    }
    await visionManager.stopAll();
    await streamManager.stopAll();
    streamManager.stop();
    await obsController.disconnect();
    await obsLauncher.kill();
    visionLogDb.close();
    await closeDatabase();
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Fatal error', { err });
  process.exit(1);
});
