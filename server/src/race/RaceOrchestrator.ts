import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Kysely } from 'kysely';
import type { Server as SocketIOServer } from 'socket.io';
import type { Database } from '../db/database.js';
import type { Config } from '../config.js';
import type { StreamManager } from '../stream/StreamManager.js';
import type { ObsController } from '../obs/ObsController.js';
import type { SceneBuilder } from '../obs/SceneBuilder.js';
import type { RacerSetup } from '../obs/types.js';
import type { VisionManager } from '../vision/VisionManager.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import { RaceMonitor } from './RaceMonitor.js';
import { ProfileMatchService } from './ProfileMatchService.js';
import type {
  OrchestratorState,
  RacetimeRace,
  RacetimeEntrant,
  EntrantMatch,
  ActiveRaceState,
  RaceSetupProposal,
  AutoModeConfig,
} from './types.js';
import { logger } from '../logger.js';

export class RaceOrchestrator extends EventEmitter {
  private state: OrchestratorState = 'idle';
  private activeRace: ActiveRaceState | null = null;
  private detectedRaces: RacetimeRace[] = [];
  private profileMatcher: ProfileMatchService;
  private autoMode: AutoModeConfig = {
    enabled: false,
    delayAfterDetectionMs: 5000,
    delayAfterSetupMs: 10000,
    delayAfterConfirmMs: 5000,
    delayAfterFinishMs: 30000,
    requireAllProfilesMatched: true,
  };
  private autoTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private monitor: RaceMonitor,
    private streamManager: StreamManager,
    private obsController: ObsController,
    private sceneBuilder: SceneBuilder,
    private db: Kysely<Database>,
    private io: SocketIOServer,
    private config: Config,
    private visionManager: VisionManager,
    private cropProfileService: CropProfileService,
  ) {
    super();
    this.profileMatcher = new ProfileMatchService(db);
    this.wireMonitorEvents();
  }

  // ─── Public API ───

  getState(): OrchestratorState {
    return this.state;
  }

  getActiveRace(): ActiveRaceState | null {
    return this.activeRace;
  }

  getDetectedRaces(): RacetimeRace[] {
    return this.detectedRaces;
  }

  getProfileMatcher(): ProfileMatchService {
    return this.profileMatcher;
  }

  setAutoMode(config: Partial<AutoModeConfig>): void {
    Object.assign(this.autoMode, config);
    logger.info(`Auto-mode ${this.autoMode.enabled ? 'ENABLED' : 'DISABLED'}`, this.autoMode);
    this.io.to('dashboard').emit('race:autoModeChange', this.autoMode);
  }

  getAutoMode(): AutoModeConfig {
    return { ...this.autoMode };
  }

  /**
   * Set up a race from a detected racetime.gg slug.
   */
  async setupRace(raceSlug: string): Promise<RaceSetupProposal> {
    // Use already-detected race data if available, otherwise fetch
    let race = this.detectedRaces.find((r) => r.name === raceSlug) ?? null;
    if (!race) {
      logger.info(`Race ${raceSlug} not in detected list, fetching from racetime.gg...`);
      race = await this.monitor.racetimeApi.getRaceDetail(raceSlug);
    } else {
      logger.info(`Using cached race data for ${raceSlug}`);
    }

    // Filter to active entrants (ready, not_ready, in_progress, done — not declined/invited)
    const activeEntrants = race.entrants.filter(
      (e) => !['requested', 'invited', 'declined'].includes(e.status.value),
    );

    // Match entrants to profiles
    const matches = await this.profileMatcher.matchEntrants(activeEntrants);

    // Auto-create profiles for unmatched entrants that have Twitch channels
    // This allows the operator to crop them immediately in Race Control
    for (const match of matches) {
      if (!match.profileId && match.twitchChannel) {
        const id = await this.profileMatcher.createFromEntrant(match.entrant);
        match.profileId = id;
        match.profileDisplayName = match.entrant.user.name;
        match.matchMethod = 'auto_created';
        logger.info(`Auto-created profile for ${match.entrant.user.name} at setup time`);
      }
    }

    // Determine layout
    const count = matches.length;
    let layoutType: 'two_player' | 'three_player' | 'four_player';
    if (count <= 2) layoutType = 'two_player';
    else if (count === 3) layoutType = 'three_player';
    else layoutType = 'four_player';

    const sceneName = `TTP_${raceSlug.split('/').pop() ?? Date.now()}`;

    // Create race in DB
    const raceDbId = uuid();
    await this.db.insertInto('races').values({
      id: raceDbId,
      racetime_slug: raceSlug,
      racetime_url: `https://racetime.gg/${raceSlug}`,
      started_at: race.started_at ? new Date(race.started_at) : null,
      racer_count: count,
      status: 'pending',
      layout_type: layoutType,
    } as any).execute();

    // Build active race state
    this.activeRace = {
      orchestratorState: 'setup',
      raceSlug,
      raceUrl: `https://racetime.gg/${raceSlug}`,
      racetimeStatus: race.status.value,
      goal: race.goal.name,
      info: race.info,
      entrants: matches,
      layoutType,
      sceneName,
      startedAt: race.started_at,
      endedAt: null,
      clockOffsetMs: this.monitor.racetimeApi.clockOffsetMs,
      raceDbId,
    };

    const proposal: RaceSetupProposal = {
      raceSlug,
      raceUrl: `https://racetime.gg/${raceSlug}`,
      goal: race.goal.name,
      entrants: matches,
      layoutType,
      sceneName,
      startedAt: race.started_at,
    };

    this.setState('setup');

    logger.info(`Race setup: ${raceSlug}`, {
      entrants: matches.map((m) => ({
        name: m.entrant.user.name,
        matched: m.matchMethod,
        twitch: m.twitchChannel,
      })),
      layout: layoutType,
    });

    // Auto-mode: schedule confirm setup
    if (this.autoMode.enabled) {
      if (this.autoMode.requireAllProfilesMatched) {
        const unmatched = matches.filter((m) => m.matchMethod === null && m.twitchChannel);
        if (unmatched.length > 0) {
          logger.warn('Auto-mode: unmatched profiles detected, pausing for manual intervention');
          this.io.to('dashboard').emit('race:autoModePaused', {
            reason: 'unmatched_profiles',
            entrants: unmatched.map((e) => e.entrant.user.name),
          });
        } else {
          this.scheduleAutoAction(this.autoMode.delayAfterSetupMs, async () => {
            if (this.state !== 'setup') return;
            try {
              await this.confirmSetup();
            } catch (err) {
              logger.error('Auto-mode confirm failed', { error: err instanceof Error ? err.message : String(err) });
            }
          });
        }
      } else {
        this.scheduleAutoAction(this.autoMode.delayAfterSetupMs, async () => {
          if (this.state !== 'setup') return;
          try {
            await this.confirmSetup();
          } catch (err) {
            logger.error('Auto-mode confirm failed', { error: err instanceof Error ? err.message : String(err) });
          }
        });
      }
    }

    return proposal;
  }

  /**
   * Re-fetch entrants from racetime.gg and update the active race.
   * Useful when entrants join after initial setup.
   */
  async refreshEntrants(): Promise<EntrantMatch[]> {
    if (!this.activeRace) {
      throw new Error('No active race to refresh');
    }
    if (this.state !== 'setup') {
      throw new Error(`Cannot refresh entrants in state: ${this.state}`);
    }

    const race = await this.monitor.racetimeApi.getRaceDetail(this.activeRace.raceSlug);
    const activeEntrants = race.entrants.filter(
      (e) => !['requested', 'invited', 'declined'].includes(e.status.value),
    );

    const matches = await this.profileMatcher.matchEntrants(activeEntrants);

    // Auto-create profiles for unmatched entrants with Twitch channels
    for (const match of matches) {
      if (!match.profileId && match.twitchChannel) {
        const id = await this.profileMatcher.createFromEntrant(match.entrant);
        match.profileId = id;
        match.profileDisplayName = match.entrant.user.name;
        match.matchMethod = 'auto_created';
        logger.info(`Auto-created profile for ${match.entrant.user.name} during refresh`);
      }
    }

    this.activeRace.entrants = matches;
    this.io.to('dashboard').emit('race:stateChange', { state: this.state });
    logger.info(`Refreshed entrants: ${matches.length} active`);
    return matches;
  }

  /**
   * Confirm setup — start streams for all entrants and build OBS scene.
   */
  async confirmSetup(overrides?: {
    entrantOverrides?: Array<{ racetimeUserId: string; profileId: string; slot: number }>;
  }): Promise<void> {
    if (!this.activeRace) {
      throw new Error('No active race to confirm');
    }
    if (this.state !== 'setup') {
      throw new Error(`Cannot confirm setup in state: ${this.state}`);
    }

    const race = this.activeRace;

    // Apply any manual overrides
    if (overrides?.entrantOverrides) {
      const selectedIds = new Set(overrides.entrantOverrides.map((ov) => ov.racetimeUserId));
      for (const ov of overrides.entrantOverrides) {
        const match = race.entrants.find((m) => m.entrant.user.id === ov.racetimeUserId);
        if (match) {
          if (ov.profileId) match.profileId = ov.profileId;
          match.slot = ov.slot;
          match.matchMethod = 'manual';
        }
      }
      // Push non-selected entrants to high slot numbers so they sort after the picks
      let nextSlot = overrides.entrantOverrides.length;
      for (const match of race.entrants) {
        if (!selectedIds.has(match.entrant.user.id)) {
          match.slot = nextSlot++;
        }
      }
      // Sort by slot so that manually assigned slots 0..N-1 come first
      race.entrants.sort((a, b) => a.slot - b.slot);
    }

    // Determine max display slots from layout
    const maxSlots = race.layoutType === 'two_player' ? 2
      : race.layoutType === 'three_player' ? 3 : 4;

    // Displayed entrants = first N with Twitch channels (fits the layout)
    const displayedEntrants = race.entrants
      .filter((m) => m.twitchChannel)
      .slice(0, maxSlots);

    // Auto-create profiles for displayed entrants that have Twitch channels
    for (const match of displayedEntrants) {
      if (!match.profileId && match.twitchChannel) {
        const id = await this.profileMatcher.createFromEntrant(match.entrant);
        match.profileId = id;
        match.profileDisplayName = match.entrant.user.name;
        match.matchMethod = 'auto_created';
      }
    }

    // Start streams only for displayed entrants
    const streamPromises = displayedEntrants.map(async (match) => {
      const racerId = match.profileId || match.entrant.user.id;
      const streamKey = racerId;
      try {
        await this.streamManager.startRacer({
          racerId,
          twitchChannel: match.twitchChannel!,
          streamKey,
        });
        logger.info(`Started stream for ${match.entrant.user.name} (${match.twitchChannel})`);
      } catch (err) {
        logger.error(`Failed to start stream for ${match.entrant.user.name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    await Promise.allSettled(streamPromises);

    // Wait briefly for streams to establish
    await new Promise((r) => setTimeout(r, 3000));

    // Build the OBS scene (only displayed entrants)
    const racerSetups: RacerSetup[] = displayedEntrants.map((match) => {
        const racerId = match.profileId || match.entrant.user.id;
        return {
          id: racerId,
          streamKey: racerId,
          displayName: match.profileDisplayName || match.entrant.user.name,
          profile: {
            cropTop: 0,
            cropBottom: 0,
            cropLeft: 0,
            cropRight: 0,
            streamWidth: 1920,
            streamHeight: 1080,
          },
        };
      });

    // Load crop settings from crop profiles (with fallback to inline fields)
    for (const setup of racerSetups) {
      try {
        const cropData = await this.cropProfileService.getDefaultForRacer(setup.id);
        // Convert crop x/y/w/h to OBS cropTop/Bottom/Left/Right
        // OBS crop = pixels to remove from each edge
        setup.profile = {
          cropTop: cropData.y,
          cropLeft: cropData.x,
          cropRight: Math.max(0, cropData.streamWidth - cropData.x - cropData.w),
          cropBottom: Math.max(0, cropData.streamHeight - cropData.y - cropData.h),
          streamWidth: cropData.streamWidth,
          streamHeight: cropData.streamHeight,
        };
      } catch { /* use defaults */ }
    }

    if (racerSetups.length > 0) {
      await this.sceneBuilder.buildRaceScene(race.sceneName, racerSetups);
    }

    this.setState('ready');
    logger.info(`Race setup confirmed: ${race.raceSlug} — ${racerSetups.length} streams, scene built`);

    // Auto-mode: wait for readiness (2+ runners online + seed rolled) then go live
    if (this.autoMode.enabled) {
      this.waitForAutoGoLiveReadiness();
    }
  }

  /**
   * Go live — start OBS streaming to Twitch.
   */
  async goLive(): Promise<void> {
    if (!this.activeRace) {
      throw new Error('No active race');
    }
    if (this.state !== 'ready') {
      throw new Error(`Cannot go live in state: ${this.state}`);
    }

    if (!this.obsController.isConnected()) {
      throw new Error('OBS is not connected');
    }

    // Auto-crop any racers that don't have crop profiles yet
    await this.autoCropUncropped();

    await this.obsController.startStreaming();

    // Auto-feature the racer in slot 0 (unmute their audio for the stream)
    const slot0Entrant = this.activeRace.entrants.find((m) => m.slot === 0);
    if (slot0Entrant) {
      const slot0Id = slot0Entrant.profileId || slot0Entrant.entrant.user.id;
      try {
        await this.sceneBuilder.featureRacer(slot0Id);
      } catch (err) {
        logger.warn('Failed to auto-feature slot 0 racer', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Create race_entrants rows
    for (const match of this.activeRace.entrants) {
      if (match.profileId) {
        try {
          await this.db.insertInto('race_entrants').values({
            race_id: this.activeRace.raceDbId!,
            racer_id: match.profileId,
            slot: match.slot,
            status: 'racing',
          } as any).execute();
        } catch (err) {
          logger.warn(`Failed to insert race_entrant for ${match.entrant.user.name}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Update race status
    await this.db.updateTable('races')
      .set({ status: 'live' as const })
      .where('id', '=', this.activeRace.raceDbId!)
      .execute();

    // Start vision pipeline only for displayed entrants (those with assigned slots in the layout)
    const maxSlots = this.activeRace.layoutType === 'two_player' ? 2
      : this.activeRace.layoutType === 'three_player' ? 3 : 4;
    const displayedEntrants = this.activeRace.entrants
      .filter((m) => m.twitchChannel && m.slot < maxSlots);
    for (const match of displayedEntrants) {
      if (match.profileId) {
        const racerId = match.profileId;
        try {
          await this.visionManager.startVision(racerId, match.profileId);
        } catch (err) {
          logger.warn(`Failed to start vision for ${match.entrant.user.name}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // If race is already in_progress, go straight to monitoring
    if (this.activeRace.racetimeStatus === 'in_progress') {
      this.setState('monitoring');
      this.emitTimerSync();
    } else {
      this.setState('live');
    }

    // Emit EventEmitter event for commentary auto-sync
    this.emit('raceGoLive');

    logger.info(`Race is LIVE: ${this.activeRace.raceSlug}`);
  }

  /**
   * Swap a runner mid-race — full entrant substitution.
   * Stops old stream, starts new one, updates OBS label + crop, updates entrant record.
   * If newRacetimeUserId is provided, looks up the bench entrant and copies their identity.
   */
  async swapRunner(racerId: string, newTwitchChannel: string, newRacetimeUserId?: string): Promise<void> {
    if (!this.activeRace) throw new Error('No active race');
    if (this.state !== 'ready' && this.state !== 'live' && this.state !== 'monitoring') {
      throw new Error(`Cannot swap runners in state: ${this.state}`);
    }

    const match = this.activeRace.entrants.find(
      (m) => m.profileId === racerId || m.entrant.user.id === racerId,
    );
    if (!match) throw new Error(`Racer ${racerId} not found in active race`);

    const effectiveId = match.profileId || match.entrant.user.id;
    const oldName = match.entrant.user.name;
    logger.info(`Swapping runner: ${oldName} -> ${newTwitchChannel}`);

    // Stop vision for this racer
    try { await this.visionManager.stopVision(effectiveId); } catch { /* ignore */ }

    // Stop old stream
    try { await this.streamManager.stopRacer(effectiveId); } catch { /* ignore */ }

    // If swapping in a bench entrant, update the match record with their identity
    let newEntrant: EntrantMatch | undefined;
    if (newRacetimeUserId) {
      newEntrant = this.activeRace.entrants.find(
        (m) => m.entrant.user.id === newRacetimeUserId,
      );
      if (newEntrant) {
        // Swap entrant identity fields between display and bench slots.
        // Do NOT swap slot numbers — each object keeps its position in the array;
        // only the racer identity/profile/twitch data moves.
        const swapFields = ['entrant', 'profileId', 'profileDisplayName', 'matchMethod', 'twitchChannel', 'hasCropProfile'] as const;
        for (const field of swapFields) {
          const tmp = (match as any)[field];
          (match as any)[field] = (newEntrant as any)[field];
          (newEntrant as any)[field] = tmp;
        }
      }
    } else {
      // Fallback: just update the Twitch channel (raw channel swap)
      match.twitchChannel = newTwitchChannel;
    }

    // Start new stream with same stream key (OBS source stays connected)
    const newEffectiveId = match.profileId || match.entrant.user.id;
    await this.streamManager.startRacer({
      racerId: effectiveId, // Keep same RTMP key so OBS doesn't need rebuild
      twitchChannel: newTwitchChannel,
      streamKey: effectiveId,
    });

    // Wait for new stream to establish
    await new Promise((r) => setTimeout(r, 5000));

    // Update OBS label text + crop via SceneBuilder
    const newDisplayName = match.profileDisplayName || match.entrant.user.name;
    try {
      const labelSources = (this.sceneBuilder as any).lastBuildLabels as Map<string, string>;
      const labelName = labelSources?.get(effectiveId);
      if (labelName) {
        await this.obsController.setInputSettings(labelName, { text: newDisplayName });
        logger.info(`Updated OBS label: ${labelName} -> "${newDisplayName}"`);
      }

      // Apply new racer's crop profile
      if (match.profileId) {
        try {
          const cropData = await this.cropProfileService.getDefaultForRacer(match.profileId);
          const maxSlots = this.activeRace.layoutType === 'two_player' ? 2
            : this.activeRace.layoutType === 'three_player' ? 3 : 4;
          const newProfile = {
            cropTop: cropData.y,
            cropLeft: cropData.x,
            cropRight: Math.max(0, cropData.streamWidth - cropData.x - cropData.w),
            cropBottom: Math.max(0, cropData.streamHeight - cropData.y - cropData.h),
            streamWidth: cropData.streamWidth,
            streamHeight: cropData.streamHeight,
          };
          await this.sceneBuilder.updateRacerCrop(
            this.activeRace.sceneName,
            effectiveId, // Use old ID since that's what SceneBuilder tracks
            match.slot,
            newProfile,
            maxSlots,
          );
        } catch (err) {
          logger.warn(`Could not apply crop for swapped runner`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn(`Failed to update OBS after swap`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Restart vision if profile exists
    if (match.profileId) {
      try {
        await this.visionManager.startVision(newEffectiveId, match.profileId);
      } catch (err) {
        logger.warn(`Failed to restart vision after swap for ${newEffectiveId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info(`Runner swapped: ${oldName} -> ${newDisplayName} (${newTwitchChannel})`);
    this.io.to('dashboard').emit('race:runnerSwapped', { racerId: effectiveId, newTwitchChannel, newDisplayName });
  }

  /**
   * End the race — stop streaming, teardown, cleanup.
   */
  async endRace(): Promise<void> {
    // Clear any pending auto-mode timers
    for (const t of this.autoTimers) clearTimeout(t);
    this.autoTimers = [];

    logger.info(`Ending race${this.activeRace ? `: ${this.activeRace.raceSlug}` : ''}`);

    // Stop OBS streaming
    try {
      if (this.obsController.isConnected() && await this.obsController.isStreaming()) {
        await this.obsController.stopStreaming();
      }
    } catch (err) {
      logger.warn('Failed to stop OBS streaming', { error: err instanceof Error ? err.message : String(err) });
    }

    // Stop vision pipelines
    try {
      await this.visionManager.stopAll();
    } catch (err) {
      logger.warn('Failed to stop vision pipelines', { error: err instanceof Error ? err.message : String(err) });
    }

    // Teardown scene
    if (this.activeRace) {
      try {
        await this.sceneBuilder.teardownScene(this.activeRace.sceneName);
      } catch (err) {
        logger.warn('Failed to teardown scene', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Stop all streams
    await this.streamManager.stopAll();

    // Update DB
    if (this.activeRace?.raceDbId) {
      try {
        await this.db.updateTable('races')
          .set({
            status: 'finished' as const,
            ended_at: new Date(),
          })
          .where('id', '=', this.activeRace.raceDbId)
          .execute();

        // Update entrant results from latest racetime data
        for (const match of this.activeRace.entrants) {
          if (match.profileId) {
            const entrant = match.entrant;
            const dbStatus = this.mapEntrantStatus(entrant.status.value);
            try {
              await this.db.updateTable('race_entrants')
                .set({
                  status: dbStatus,
                  finish_time: entrant.finish_time,
                  finish_place: entrant.place,
                })
                .where('race_id', '=', this.activeRace.raceDbId!)
                .where('racer_id', '=', match.profileId)
                .execute();
            } catch { /* ignore */ }
          }
        }
      } catch (err) {
        logger.warn('Failed to update race DB on end', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.activeRace = null;
    this.setState('idle');
  }

  // ─── Private: Monitor Event Handlers ───

  private wireMonitorEvents(): void {
    this.monitor.on('raceDetected', (race: RacetimeRace) => this.onRaceDetected(race));
    this.monitor.on('raceUpdate', (race: RacetimeRace) => this.onRaceUpdate(race));
    this.monitor.on('raceStarted', (race: RacetimeRace) => this.onRaceStarted(race));
    this.monitor.on('entrantUpdate', (slug: string, entrant: RacetimeEntrant) => this.onEntrantUpdate(slug, entrant));
    this.monitor.on('raceFinished', (race: RacetimeRace) => this.onRaceFinished(race));
  }

  private onRaceDetected(race: RacetimeRace): void {
    // Don't add duplicates
    if (!this.detectedRaces.find((r) => r.name === race.name)) {
      this.detectedRaces.push(race);
    }
    this.io.to('dashboard').emit('race:detected', race);

    // Auto-transition to 'detected' if idle
    if (this.state === 'idle') {
      this.setState('detected');
    }

    // Auto-mode: schedule race setup (only for races matching the goal filter)
    const autoGoal = (this.config.racetime as any).goalFilter ?? 'TTP Season 4';
    const isAutoEligible = race.goal?.name === autoGoal;

    if (this.autoMode.enabled && this.state === 'detected' && isAutoEligible) {
      this.scheduleAutoAction(this.autoMode.delayAfterDetectionMs, async () => {
        if (this.state !== 'detected') return;
        // Only auto-select races matching the goal filter
        const eligibleRaces = this.getDetectedRaces().filter(
          (r) => r.goal?.name === autoGoal,
        );
        if (eligibleRaces.length === 1) {
          try {
            await this.setupRace(eligibleRaces[0].name);
          } catch (err) {
            logger.error('Auto-mode setup failed', { error: err instanceof Error ? err.message : String(err) });
          }
        } else if (eligibleRaces.length > 1) {
          logger.warn('Auto-mode: multiple eligible races detected, awaiting manual selection');
          this.io.to('dashboard').emit('race:autoModePaused', {
            reason: 'multiple_races',
            races: eligibleRaces.map((r) => r.name),
          });
        }
      });
    }
  }

  private onRaceUpdate(race: RacetimeRace): void {
    // Update in detected list
    const idx = this.detectedRaces.findIndex((r) => r.name === race.name);
    if (idx >= 0) {
      this.detectedRaces[idx] = race;
    }

    // Update active race state if this is the active race
    if (this.activeRace && this.activeRace.raceSlug === race.name) {
      this.activeRace.racetimeStatus = race.status.value;
      this.activeRace.info = race.info;
      this.activeRace.startedAt = race.started_at;
      this.activeRace.clockOffsetMs = this.monitor.racetimeApi.clockOffsetMs;

      if (race.ended_at) {
        this.activeRace.endedAt = race.ended_at;
      }
    }
  }

  private onRaceStarted(race: RacetimeRace): void {
    if (this.activeRace && this.activeRace.raceSlug === race.name) {
      this.activeRace.startedAt = race.started_at;
      this.activeRace.clockOffsetMs = this.monitor.racetimeApi.clockOffsetMs;

      if (this.state === 'live') {
        this.setState('monitoring');
      }

      this.emitTimerSync();
    }
  }

  private onEntrantUpdate(slug: string, entrant: RacetimeEntrant): void {
    if (!this.activeRace || this.activeRace.raceSlug !== slug) return;

    // Find the matching entrant
    const match = this.activeRace.entrants.find(
      (m) => m.entrant.user.id === entrant.user.id,
    );
    if (!match) return;

    // Update the entrant data
    match.entrant = entrant;

    const dbStatus = this.mapEntrantStatus(entrant.status.value);

    // Update DB
    if (match.profileId && this.activeRace.raceDbId) {
      this.db.updateTable('race_entrants')
        .set({
          status: dbStatus,
          finish_time: entrant.finish_time,
          finish_place: entrant.place,
        })
        .where('race_id', '=', this.activeRace.raceDbId)
        .where('racer_id', '=', match.profileId)
        .execute()
        .catch(() => { /* ignore */ });
    }

    // Emit to dashboard + overlay
    const update = {
      racerId: match.profileId || entrant.user.id,
      racetimeUserId: entrant.user.id,
      displayName: match.profileDisplayName || entrant.user.name,
      status: dbStatus,
      finishTime: entrant.finish_time,
      finishPlace: entrant.place,
      placeOrdinal: entrant.place_ordinal,
      slot: match.slot,
    };

    this.io.to('dashboard').emit('race:entrantUpdate', update);
    this.io.to('overlay').emit('race:entrantUpdate', update);

    // Emit EventEmitter event for commentary standings sync
    this.emit('entrantUpdate');
  }

  private onRaceFinished(race: RacetimeRace): void {
    if (this.activeRace && this.activeRace.raceSlug === race.name) {
      this.activeRace.endedAt = race.ended_at || new Date().toISOString();

      if (this.state === 'monitoring') {
        this.setState('finished');
        logger.info(`Race finished: ${race.name}`);

        // Auto-mode: schedule end race with configured delay
        if (this.autoMode.enabled) {
          this.scheduleAutoAction(this.autoMode.delayAfterFinishMs, async () => {
            if (this.state !== 'finished') return;
            try {
              await this.endRace();
            } catch (err) {
              logger.error('Auto-mode end failed', { error: err instanceof Error ? err.message : String(err) });
            }
          });
        }

        // Always auto-end 90s after race concludes (stop stream, tear down)
        // If auto-mode or manual endRace() fires first, this is a no-op
        // since endRace() transitions to idle and clears timers.
        this.scheduleAutoAction(90_000, async () => {
          if (this.state !== 'finished') return;
          try {
            logger.info('Auto-ending race after 90s cooldown');
            await this.endRace();
          } catch (err) {
            logger.error('Auto-end after finish failed', { error: err instanceof Error ? err.message : String(err) });
          }
        });
      }
    }

    // Remove from detected list
    this.detectedRaces = this.detectedRaces.filter((r) => r.name !== race.name);
  }

  // ─── Private: Auto-Mode ───

  private scheduleAutoAction(delayMs: number, action: () => Promise<void>): void {
    const timer = setTimeout(() => {
      const idx = this.autoTimers.indexOf(timer);
      if (idx >= 0) this.autoTimers.splice(idx, 1);
      action();
    }, delayMs);
    this.autoTimers.push(timer);
    logger.info(`Auto-mode: action scheduled in ${delayMs}ms`);
  }

  // ─── Private: Auto-Crop ───

  /**
   * Capture a single frame from a local RTMP stream via ffmpeg.
   * Returns the output file path, or null on failure.
   */
  private async captureStreamFrame(streamKey: string): Promise<string | null> {
    const projectRoot = resolve(import.meta.dirname, '../../..');
    const outputDir = resolve(projectRoot, 'data/crop-screenshots/auto');
    await mkdir(outputDir, { recursive: true });

    const outputPath = resolve(outputDir, `${streamKey}_${Date.now()}.jpg`);
    const rtmpUrl = `rtmp://localhost:${this.config.rtmp.port}/live/${streamKey}`;

    return new Promise<string | null>((res) => {
      const proc = spawn(this.config.tools.ffmpegPath, [
        '-hide_banner', '-loglevel', 'warning',
        '-rtmp_live', 'live',
        '-i', rtmpUrl,
        '-vframes', '1',
        '-q:v', '2',
        outputPath,
        '-y',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timeout = setTimeout(() => {
        proc.kill();
        logger.warn(`[auto-crop] ffmpeg capture timed out for ${streamKey}`);
        res(null);
      }, 15000);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.warn(`[auto-crop] ffmpeg spawn error for ${streamKey}`, { error: err.message });
        res(null);
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          res(outputPath);
        } else {
          logger.warn(`[auto-crop] ffmpeg capture failed for ${streamKey}: ${stderr.slice(0, 200)}`);
          res(null);
        }
      });
    });
  }

  /**
   * Run auto_crop.py on a screenshot and return detected crop coordinates.
   */
  private async runAutoCropDetection(imagePath: string): Promise<{
    crop_x: number; crop_y: number; crop_w: number; crop_h: number;
    stream_width: number; stream_height: number; confidence: number;
  } | null> {
    const projectRoot = resolve(import.meta.dirname, '../../..');
    const visionDir = resolve(projectRoot, 'vision');
    const pythonPath = resolve(projectRoot, this.config.vision.pythonPath);

    return new Promise((res) => {
      const proc = spawn(pythonPath, [
        resolve(visionDir, 'auto_crop.py'),
        '--inputs', imagePath,
      ], { cwd: visionDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timeout = setTimeout(() => {
        proc.kill();
        logger.warn('[auto-crop] auto_crop.py timed out');
        res(null);
      }, 30000);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.warn('[auto-crop] auto_crop.py spawn error', { error: err.message });
        res(null);
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          logger.warn(`[auto-crop] auto_crop.py failed: ${stderr.slice(0, 200)}`);
          res(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error || parsed.confidence === 0) {
            logger.warn(`[auto-crop] Detection returned no useful result`);
            res(null);
            return;
          }
          res(parsed);
        } catch {
          logger.warn('[auto-crop] Failed to parse auto_crop.py output');
          res(null);
        }
      });
    });
  }

  /**
   * Auto-crop all displayed entrants that don't have crop profiles.
   * Captures a frame from each RTMP stream, detects game area, creates crop profile,
   * and updates the OBS scene. Failures are non-blocking.
   */
  private async autoCropUncropped(): Promise<void> {
    if (!this.activeRace) return;

    const maxSlots = this.activeRace.layoutType === 'two_player' ? 2
      : this.activeRace.layoutType === 'three_player' ? 3 : 4;

    const displayedEntrants = this.activeRace.entrants
      .filter((m) => m.twitchChannel && m.slot < maxSlots);

    const uncropped = displayedEntrants.filter((m) => !m.hasCropProfile && m.profileId);

    if (uncropped.length === 0) {
      logger.info('[auto-crop] All displayed racers have crop profiles');
      return;
    }

    logger.info(`[auto-crop] Attempting auto-crop for ${uncropped.length} racer(s) without crop profiles`);

    for (const match of uncropped) {
      const racerId = match.profileId!;
      const streamKey = racerId;
      const name = match.profileDisplayName || match.entrant.user.name;

      try {
        // Check stream is active
        if (!this.streamManager.isRtmpStreamActive(streamKey)) {
          logger.warn(`[auto-crop] RTMP stream not active for ${name}, skipping`);
          continue;
        }

        // Capture frame
        const framePath = await this.captureStreamFrame(streamKey);
        if (!framePath) {
          logger.warn(`[auto-crop] Could not capture frame for ${name}, skipping`);
          continue;
        }

        // Detect crop
        const detection = await this.runAutoCropDetection(framePath);
        if (!detection) {
          logger.warn(`[auto-crop] Detection failed for ${name}, skipping`);
          continue;
        }

        logger.info(`[auto-crop] Detected crop for ${name}: ${detection.crop_w}x${detection.crop_h} at (${detection.crop_x},${detection.crop_y}) conf=${detection.confidence}`);

        // Create crop profile
        await this.cropProfileService.create({
          racer_profile_id: racerId,
          label: 'Auto-detected (go-live)',
          crop_x: detection.crop_x,
          crop_y: detection.crop_y,
          crop_w: detection.crop_w,
          crop_h: detection.crop_h,
          stream_width: detection.stream_width,
          stream_height: detection.stream_height,
          is_default: true,
          confidence: detection.confidence,
          notes: 'Auto-detected during go-live from RTMP stream frame',
        });

        // Update OBS scene with new crop
        const newProfile = {
          cropTop: detection.crop_y,
          cropLeft: detection.crop_x,
          cropRight: Math.max(0, detection.stream_width - detection.crop_x - detection.crop_w),
          cropBottom: Math.max(0, detection.stream_height - detection.crop_y - detection.crop_h),
          streamWidth: detection.stream_width,
          streamHeight: detection.stream_height,
        };
        await this.sceneBuilder.updateRacerCrop(
          this.activeRace.sceneName,
          racerId,
          match.slot,
          newProfile,
          maxSlots,
        );

        match.hasCropProfile = true;
        logger.info(`[auto-crop] Successfully auto-cropped ${name}`);
      } catch (err) {
        logger.warn(`[auto-crop] Failed for ${name}, continuing with full frame`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ─── Private: Auto-Mode Readiness ───

  /**
   * Poll until at least 2 runners have active RTMP streams and the race seed
   * has been rolled (info field non-empty), then schedule go-live.
   */
  private waitForAutoGoLiveReadiness(): void {
    if (!this.activeRace) return;

    const POLL_INTERVAL_MS = 3000;
    const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
    const startTime = Date.now();

    logger.info('[auto-mode] Waiting for readiness: 2+ runners online + seed rolled');

    const checkReadiness = () => {
      // Abort if state has changed
      if (this.state !== 'ready' || !this.activeRace) {
        logger.info('[auto-mode] State changed, aborting readiness wait');
        return;
      }

      const maxSlots = this.activeRace.layoutType === 'two_player' ? 2
        : this.activeRace.layoutType === 'three_player' ? 3 : 4;
      const displayedEntrants = this.activeRace.entrants
        .filter((m) => m.twitchChannel && m.slot < maxSlots);

      // Check how many RTMP streams are active
      const onlineCount = displayedEntrants.filter((m) => {
        const streamKey = m.profileId || m.entrant.user.id;
        return this.streamManager.isRtmpStreamActive(streamKey);
      }).length;

      // Check if seed has been rolled (info field non-empty)
      const seedRolled = (this.activeRace.info ?? '').trim().length > 0;

      const elapsed = Date.now() - startTime;

      if (onlineCount >= 2 && seedRolled) {
        logger.info(`[auto-mode] Readiness met: ${onlineCount} runners online, seed rolled. Scheduling go-live.`);
        this.scheduleAutoAction(this.autoMode.delayAfterConfirmMs, async () => {
          if (this.state !== 'ready') return;
          try {
            await this.goLive();
          } catch (err) {
            logger.error('Auto-mode go-live failed', { error: err instanceof Error ? err.message : String(err) });
          }
        });
        return;
      }

      // Timeout: proceed anyway with a warning
      if (elapsed >= MAX_WAIT_MS) {
        logger.warn(`[auto-mode] Readiness timeout after ${Math.round(elapsed / 1000)}s (${onlineCount} runners online, seed ${seedRolled ? 'rolled' : 'not rolled'}). Proceeding anyway.`);
        this.scheduleAutoAction(this.autoMode.delayAfterConfirmMs, async () => {
          if (this.state !== 'ready') return;
          try {
            await this.goLive();
          } catch (err) {
            logger.error('Auto-mode go-live failed', { error: err instanceof Error ? err.message : String(err) });
          }
        });
        return;
      }

      // Log status periodically (every 15s)
      if (Math.floor(elapsed / 15000) !== Math.floor((elapsed - POLL_INTERVAL_MS) / 15000)) {
        logger.info(`[auto-mode] Waiting: ${onlineCount}/2 runners online, seed ${seedRolled ? 'rolled' : 'not rolled'} (${Math.round(elapsed / 1000)}s elapsed)`);
      }

      // Schedule next check
      const timer = setTimeout(checkReadiness, POLL_INTERVAL_MS);
      this.autoTimers.push(timer);
    };

    // Start first check after a short delay
    const timer = setTimeout(checkReadiness, POLL_INTERVAL_MS);
    this.autoTimers.push(timer);
  }

  // ─── Private: Utilities ───

  private mapEntrantStatus(racetimeStatus: string): 'racing' | 'finished' | 'forfeit' | 'dq' {
    switch (racetimeStatus) {
      case 'done': return 'finished';
      case 'dnf': return 'forfeit';
      case 'dq': return 'dq';
      default: return 'racing';
    }
  }

  private emitTimerSync(): void {
    if (!this.activeRace?.startedAt) return;

    const timerData = {
      startedAt: this.activeRace.startedAt,
      clockOffsetMs: this.activeRace.clockOffsetMs,
    };

    this.io.to('overlay').emit('race:timer', timerData);
    this.io.to('dashboard').emit('race:timer', timerData);
  }

  private setState(newState: OrchestratorState): void {
    const prev = this.state;
    this.state = newState;

    if (this.activeRace) {
      this.activeRace.orchestratorState = newState;
    }

    const payload = {
      previous: prev,
      current: newState,
      race: this.activeRace,
    };

    this.io.to('dashboard').emit('race:stateChange', payload);
    this.io.to('overlay').emit('race:stateChange', payload);
    this.emit('stateChange', newState);

    logger.info(`Orchestrator: ${prev} → ${newState}`);

    // Ensure OBS is streaming when entering a live state (handles server restarts mid-race)
    if ((newState === 'monitoring' || newState === 'live') && this.obsController.isConnected()) {
      this.obsController.isStreaming().then((streaming) => {
        if (!streaming) {
          logger.info('OBS not streaming in live state — auto-starting stream');
          this.obsController.startStreaming().catch((err) => {
            logger.warn('Failed to auto-start OBS streaming', { error: err instanceof Error ? err.message : String(err) });
          });
        }
      }).catch(() => { /* ignore status check errors */ });
    }
  }
}
