import { Router } from 'express';
import type { RaceOrchestrator } from '../race/RaceOrchestrator.js';
import type { RaceMonitor } from '../race/RaceMonitor.js';
import type { SceneBuilder } from '../obs/SceneBuilder.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import { logger } from '../logger.js';

interface RaceRouteContext {
  orchestrator: RaceOrchestrator;
  monitor: RaceMonitor;
  sceneBuilder: SceneBuilder;
  cropProfileService: CropProfileService;
}

export function createRaceRoutes(ctx: RaceRouteContext): Router {
  const router = Router();

  // Current orchestrator state + active race info
  router.get('/current', async (_req, res) => {
    const activeRace = ctx.orchestrator.getActiveRace();

    // Refresh hasCropProfile dynamically (it may have changed since setup)
    if (activeRace) {
      for (const match of activeRace.entrants) {
        if (match.profileId) {
          const crops = await ctx.cropProfileService.getByRacerId(match.profileId);
          match.hasCropProfile = crops.length > 0;
        }
      }
    }

    res.json({
      state: ctx.orchestrator.getState(),
      activeRace,
    });
  });

  // Detected TTP races
  router.get('/detected', (_req, res) => {
    res.json(ctx.orchestrator.getDetectedRaces());
  });

  // Set up a race from a racetime.gg slug
  router.post('/setup', async (req, res) => {
    const { slug } = req.body;
    if (!slug) {
      res.status(400).json({ error: 'slug is required' });
      return;
    }
    try {
      const proposal = await ctx.orchestrator.setupRace(slug);
      res.json(proposal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Race setup failed', { error: msg, slug });
      res.status(500).json({ error: msg });
    }
  });

  // Refresh entrants — re-fetch from racetime.gg (during setup)
  router.post('/refresh-entrants', async (_req, res) => {
    try {
      const matches = await ctx.orchestrator.refreshEntrants();
      res.json({ entrants: matches });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Refresh entrants failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Confirm setup — start streams + build scene
  router.post('/confirm-setup', async (req, res) => {
    const { overrides } = req.body;
    try {
      await ctx.orchestrator.confirmSetup(overrides);
      res.json({ status: 'ready' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Confirm setup failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Go live — start OBS streaming
  router.post('/go-live', async (_req, res) => {
    try {
      await ctx.orchestrator.goLive();
      res.json({ status: 'live' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Go live failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Switch race — end current race and set up a new one
  router.post('/switch', async (req, res) => {
    const { slug } = req.body;
    if (!slug) {
      res.status(400).json({ error: 'slug is required' });
      return;
    }
    try {
      // End current race if active
      const currentState = ctx.orchestrator.getState();
      if (currentState !== 'idle' && currentState !== 'detected') {
        logger.info(`Switching race: ending current (state: ${currentState})`);
        await ctx.orchestrator.endRace();
      }

      // Setup new race (auto-creates profiles for unmatched entrants)
      const proposal = await ctx.orchestrator.setupRace(slug);
      res.json(proposal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Switch race failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Go offline — stop streaming and switch to an offline scene
  router.post('/go-offline', async (_req, res) => {
    try {
      const obs = ctx.sceneBuilder['obs'] as import('../obs/ObsController.js').ObsController;

      // Stop streaming if active
      try {
        if (await obs.isStreaming()) {
          await obs.stopStreaming();
        }
      } catch { /* not streaming */ }

      // Create or switch to offline scene
      const offlineScene = 'TTP_Offline';
      const scenes = await obs.getSceneList();
      if (!scenes.includes(offlineScene)) {
        await obs.createScene(offlineScene);
      }
      await obs.switchScene(offlineScene);

      res.json({ status: 'offline', scene: offlineScene });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Go offline failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Rebuild the OBS scene for the active race with fresh crop data (no full re-setup)
  router.post('/rebuild-scene', async (_req, res) => {
    const activeRace = ctx.orchestrator.getActiveRace();
    if (!activeRace) {
      res.status(400).json({ error: 'No active race' });
      return;
    }

    try {
      const maxSlots = activeRace.layoutType === 'two_player' ? 2
        : activeRace.layoutType === 'three_player' ? 3 : 4;
      const displayedEntrants = activeRace.entrants
        .filter((m) => m.twitchChannel)
        .slice(0, maxSlots);

      // Build fresh RacerSetup array with latest crop data
      const racerSetups = [];
      for (const match of displayedEntrants) {
        const racerId = match.profileId || match.entrant.user.id;
        const setup: import('../obs/types.js').RacerSetup = {
          id: racerId,
          streamKey: racerId,
          displayName: match.profileDisplayName || match.entrant.user.name,
          profile: {
            cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
            streamWidth: 1920, streamHeight: 1080,
          },
        };

        try {
          const cropData = await ctx.cropProfileService.getDefaultForRacer(racerId);
          setup.profile = {
            cropTop: cropData.y,
            cropLeft: cropData.x,
            cropRight: Math.max(0, cropData.streamWidth - cropData.x - cropData.w),
            cropBottom: Math.max(0, cropData.streamHeight - cropData.y - cropData.h),
            streamWidth: cropData.streamWidth,
            streamHeight: cropData.streamHeight,
          };
        } catch { /* use defaults */ }

        racerSetups.push(setup);
      }

      await ctx.sceneBuilder.buildRaceScene(activeRace.sceneName, racerSetups);
      res.json({ status: 'rebuilt', sceneName: activeRace.sceneName, racers: racerSetups.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Rebuild scene failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // End race — stop everything
  router.post('/end', async (_req, res) => {
    try {
      await ctx.orchestrator.endRace();
      res.json({ status: 'ended' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('End race failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ─── Auto-Mode ───

  router.get('/auto-mode', (_req, res) => {
    res.json(ctx.orchestrator.getAutoMode());
  });

  router.post('/auto-mode', (req, res) => {
    ctx.orchestrator.setAutoMode(req.body);
    res.json(ctx.orchestrator.getAutoMode());
  });

  // ─── Swap Runner ───

  router.post('/swap-runner', async (req, res) => {
    const { racerId, twitchChannel, newRacetimeUserId } = req.body;
    if (!racerId || !twitchChannel) {
      res.status(400).json({ error: 'racerId and twitchChannel are required' });
      return;
    }
    try {
      await ctx.orchestrator.swapRunner(racerId, twitchChannel, newRacetimeUserId);
      res.json({ status: 'swapped', racerId, twitchChannel });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Runner swap failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ─── Featured Racer Audio ───

  // Feature a racer (unmute their audio, mute all others)
  router.post('/feature', async (req, res) => {
    const { racerId } = req.body;
    try {
      await ctx.sceneBuilder.featureRacer(racerId ?? null);
      res.json({ status: 'featured', racerId: racerId ?? null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Feature racer failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Get currently featured racer
  router.get('/featured', (_req, res) => {
    res.json({ racerId: ctx.sceneBuilder.getFeaturedRacer() });
  });

  // Live-update a racer's crop on the current scene (no scene rebuild needed)
  router.post('/update-crop', async (req, res) => {
    const { racerId } = req.body;
    if (!racerId) {
      res.status(400).json({ error: 'racerId is required' });
      return;
    }

    const activeRace = ctx.orchestrator.getActiveRace();
    if (!activeRace) {
      res.status(400).json({ error: 'No active race' });
      return;
    }

    const match = activeRace.entrants.find(
      (m) => m.profileId === racerId || m.entrant.user.id === racerId,
    );
    if (!match) {
      res.status(404).json({ error: `Racer ${racerId} not in active race` });
      return;
    }

    try {
      // Fetch fresh crop data
      const cropData = await ctx.cropProfileService.getDefaultForRacer(match.profileId || racerId);
      const newProfile = {
        cropTop: cropData.y,
        cropLeft: cropData.x,
        cropRight: Math.max(0, cropData.streamWidth - cropData.x - cropData.w),
        cropBottom: Math.max(0, cropData.streamHeight - cropData.y - cropData.h),
        streamWidth: cropData.streamWidth,
        streamHeight: cropData.streamHeight,
      };

      const racerCount = activeRace.layoutType === 'two_player' ? 2
        : activeRace.layoutType === 'three_player' ? 3 : 4;

      await ctx.sceneBuilder.updateRacerCrop(
        activeRace.sceneName,
        match.profileId || racerId,
        match.slot,
        newProfile,
        racerCount,
      );

      res.json({ status: 'updated', racerId, crop: newProfile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Live crop update failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Entrant list with profile matches for a specific race slug
  router.get('/:slug/entrants', async (req, res) => {
    try {
      const fullSlug = `${ctx.monitor['config'].racetime.category}/${req.params.slug}`;
      const race = await ctx.monitor.racetimeApi.getRaceDetail(fullSlug);
      const matches = await ctx.orchestrator.getProfileMatcher().matchEntrants(race.entrants);
      res.json(matches);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Auto-create profile for an unmatched entrant
  router.post('/auto-create-profile', async (req, res) => {
    const { entrant } = req.body;
    if (!entrant) {
      res.status(400).json({ error: 'entrant is required' });
      return;
    }
    try {
      const id = await ctx.orchestrator.getProfileMatcher().createFromEntrant(entrant);
      res.status(201).json({ id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
