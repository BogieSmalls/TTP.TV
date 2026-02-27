import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import type { Kysely } from 'kysely';
import type { Server as SocketIOServer } from 'socket.io';
import type { Database } from '../db/database.js';
import type { StreamManager } from '../stream/StreamManager.js';
import type { ObsController } from '../obs/ObsController.js';
import type { SceneBuilder } from '../obs/SceneBuilder.js';
import type { CropProfileService } from '../vision/CropProfileService.js';
import type { VisionManager } from '../vision/VisionManager.js';
import { detectSourceType } from '../stream/vodResolver.js';
import { logger } from '../logger.js';

export type VodRaceState = 'idle' | 'setup' | 'ready' | 'live' | 'finished';

export interface VodRacerConfig {
  profileId: string;
  vodUrl: string;
  startOffsetSeconds: number;
}

export interface VodRaceConfig {
  racers: VodRacerConfig[];
  racetimeRoom?: string;
  title?: string;
}

export interface VodRaceStatus {
  state: VodRaceState;
  raceId: string | null;
  title: string | null;
  racers: Array<{
    profileId: string;
    displayName: string;
    vodUrl: string;
    startOffsetSeconds: number;
    slot: number;
    streamKey: string;
    hasCrop: boolean;
  }>;
  layoutType: string | null;
  sceneName: string | null;
}

export class VodRaceOrchestrator extends EventEmitter {
  private state: VodRaceState = 'idle';
  private raceId: string | null = null;
  private title: string | null = null;
  private racers: VodRaceStatus['racers'] = [];
  private layoutType: string | null = null;
  private sceneName: string | null = null;

  constructor(
    private db: Kysely<Database>,
    private streamManager: StreamManager,
    private obsController: ObsController,
    private sceneBuilder: SceneBuilder,
    private cropProfileService: CropProfileService,
    private visionManager: VisionManager,
    private io: SocketIOServer,
  ) {
    super();
  }

  getStatus(): VodRaceStatus {
    return {
      state: this.state,
      raceId: this.raceId,
      title: this.title,
      racers: this.racers,
      layoutType: this.layoutType,
      sceneName: this.sceneName,
    };
  }

  async setupVodRace(config: VodRaceConfig): Promise<VodRaceStatus> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot setup: current state is ${this.state}`);
    }

    if (config.racers.length < 2 || config.racers.length > 4) {
      throw new Error('VOD race requires 2-4 racers');
    }

    // Validate racers have crop profiles
    const racerDetails: VodRaceStatus['racers'] = [];
    for (let i = 0; i < config.racers.length; i++) {
      const r = config.racers[i];
      const profile = await this.db.selectFrom('racer_profiles')
        .selectAll()
        .where('id', '=', r.profileId)
        .executeTakeFirst();

      if (!profile) {
        throw new Error(`Profile ${r.profileId} not found`);
      }

      const cropData = await this.cropProfileService.getDefaultForRacer(r.profileId);
      const hasCrop = cropData.cropProfileId !== null;

      racerDetails.push({
        profileId: r.profileId,
        displayName: profile.display_name,
        vodUrl: r.vodUrl,
        startOffsetSeconds: r.startOffsetSeconds,
        slot: i,
        streamKey: `vod_${profile.display_name.toLowerCase().replace(/\s+/g, '_')}_${i}`,
        hasCrop,
      });
    }

    // Create DB race record
    const raceId = uuid();
    const layoutMap: Record<number, string> = { 2: 'two_player', 3: 'three_player', 4: 'four_player' };
    const layoutType = layoutMap[config.racers.length] || 'two_player';

    await this.db.insertInto('races').values({
      id: raceId,
      racetime_slug: config.racetimeRoom ?? null,
      racetime_url: config.racetimeRoom ? `https://racetime.gg/${config.racetimeRoom}` : null,
      racer_count: config.racers.length,
      status: 'pending',
      layout_type: layoutType as any,
      source_type: 'vod',
      notes: config.title ?? null,
    } as any).execute();

    // Store VOD entrant details
    for (const r of racerDetails) {
      await this.db.insertInto('vod_race_entrants').values({
        race_id: raceId,
        racer_id: r.profileId,
        vod_url: r.vodUrl,
        vod_source_type: detectSourceType(r.vodUrl),
        start_offset_seconds: r.startOffsetSeconds,
      } as any).execute();

      await this.db.insertInto('race_entrants').values({
        race_id: raceId,
        racer_id: r.profileId,
        slot: r.slot,
        status: 'racing',
      } as any).execute();
    }

    this.raceId = raceId;
    this.title = config.title ?? null;
    this.racers = racerDetails;
    this.layoutType = layoutType;
    this.sceneName = `VODRace_${Date.now()}`;
    this.setState('setup');

    return this.getStatus();
  }

  async confirmSetup(): Promise<VodRaceStatus> {
    if (this.state !== 'setup') {
      throw new Error(`Cannot confirm: current state is ${this.state}`);
    }

    // Start VOD streams
    for (const racer of this.racers) {
      await this.streamManager.startVodRacer({
        racerId: racer.profileId,
        vodUrl: racer.vodUrl,
        streamKey: racer.streamKey,
        startOffsetSeconds: racer.startOffsetSeconds,
      });
    }

    // Build OBS scene — convert crop data to OBS format
    const sceneRacers = [];
    for (const racer of this.racers) {
      const cropData = await this.cropProfileService.getDefaultForRacer(racer.profileId);
      sceneRacers.push({
        id: racer.profileId,
        displayName: racer.displayName,
        streamKey: racer.streamKey,
        profile: {
          cropTop: cropData.y,
          cropLeft: cropData.x,
          cropRight: Math.max(0, cropData.streamWidth - cropData.x - cropData.w),
          cropBottom: Math.max(0, cropData.streamHeight - cropData.y - cropData.h),
          streamWidth: cropData.streamWidth,
          streamHeight: cropData.streamHeight,
        },
      });
    }

    await this.sceneBuilder.buildRaceScene(this.sceneName!, sceneRacers);

    this.setState('ready');
    return this.getStatus();
  }

  async goLive(): Promise<VodRaceStatus> {
    if (this.state !== 'ready') {
      throw new Error(`Cannot go live: current state is ${this.state}`);
    }

    // Start OBS streaming
    await this.obsController.startStreaming();

    // Auto-feature the racer in slot 0 (unmute their audio for the stream)
    if (this.racers.length > 0) {
      try {
        await this.sceneBuilder.featureRacer(this.racers[0].profileId);
      } catch (err) {
        logger.warn('[vod-race] Failed to auto-feature slot 0 racer', { err });
      }
    }

    // Start vision pipelines
    for (const racer of this.racers) {
      try {
        await this.visionManager.startVision(racer.profileId, racer.profileId);
      } catch (err) {
        logger.warn(`[vod-race] Vision start failed for ${racer.displayName}`, { err });
      }
    }

    // Update DB
    if (this.raceId) {
      await this.db.updateTable('races')
        .set({ status: 'live', started_at: new Date() })
        .where('id', '=', this.raceId)
        .execute();
    }

    this.setState('live');
    this.emit('raceGoLive');
    return this.getStatus();
  }

  markFinished(profileId: string, finishTimeSeconds: number): void {
    const racer = this.racers.find(r => r.profileId === profileId);
    if (!racer) throw new Error(`Racer ${profileId} not found`);

    const h = Math.floor(finishTimeSeconds / 3600);
    const m = Math.floor((finishTimeSeconds % 3600) / 60);
    const s = Math.floor(finishTimeSeconds % 60);
    const finishTime = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;

    this.emit('entrantUpdate', { racerId: profileId, status: 'finished', finishTime });
    logger.info(`[vod-race] ${racer.displayName} finished at ${finishTime}`);
  }

  markForfeit(profileId: string): void {
    const racer = this.racers.find(r => r.profileId === profileId);
    if (!racer) throw new Error(`Racer ${profileId} not found`);

    this.emit('entrantUpdate', { racerId: profileId, status: 'forfeit' });
    logger.info(`[vod-race] ${racer.displayName} forfeited`);
  }

  /**
   * Rebuild OBS scene with latest crop data (no stream restart).
   */
  async rebuildScene(): Promise<VodRaceStatus> {
    if (this.state === 'idle') {
      throw new Error('No active VOD race');
    }

    if (!this.sceneName) {
      throw new Error('No scene name — race may not be confirmed yet');
    }

    const sceneRacers = [];
    for (const racer of this.racers) {
      const cropData = await this.cropProfileService.getDefaultForRacer(racer.profileId);
      sceneRacers.push({
        id: racer.profileId,
        displayName: racer.displayName,
        streamKey: racer.streamKey,
        profile: {
          cropTop: cropData.y,
          cropLeft: cropData.x,
          cropRight: Math.max(0, cropData.streamWidth - cropData.x - cropData.w),
          cropBottom: Math.max(0, cropData.streamHeight - cropData.y - cropData.h),
          streamWidth: cropData.streamWidth,
          streamHeight: cropData.streamHeight,
        },
      });
    }

    await this.sceneBuilder.buildRaceScene(this.sceneName, sceneRacers);
    logger.info(`[vod-race] Scene rebuilt: ${this.sceneName}`);
    return this.getStatus();
  }

  async endRace(): Promise<void> {
    // Stop vision
    for (const racer of this.racers) {
      await this.visionManager.stopVision(racer.profileId);
    }

    // Stop streams
    await this.streamManager.stopAll();

    // Teardown OBS scene
    if (this.sceneName) {
      try {
        await this.sceneBuilder.teardownScene(this.sceneName);
      } catch (err) {
        logger.warn(`[vod-race] Scene teardown failed`, { err });
      }
    }

    // Stop OBS streaming
    try {
      await this.obsController.stopStreaming();
    } catch {
      // May not be streaming
    }

    // Update DB
    if (this.raceId) {
      await this.db.updateTable('races')
        .set({ status: 'finished', ended_at: new Date() })
        .where('id', '=', this.raceId)
        .execute();
    }

    this.setState('finished');

    // Reset state
    this.raceId = null;
    this.title = null;
    this.racers = [];
    this.layoutType = null;
    this.sceneName = null;
    this.setState('idle');
  }

  private setState(state: VodRaceState): void {
    this.state = state;
    this.io.emit('vod-race:stateChange', this.getStatus());
    this.emit('stateChange', state);
  }
}
