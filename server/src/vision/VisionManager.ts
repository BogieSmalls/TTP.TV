import type { Config } from '../config.js';
import { VisionBridge, type VisionBridgeOptions } from './VisionBridge.js';
import type { CropProfileService } from './CropProfileService.js';
import { logger } from '../logger.js';

interface CachedVisionState {
  [key: string]: unknown;
  lastUpdated: number;
}

interface VerificationState {
  startTime: number;
  gameplayCount: number;
  totalUpdates: number;
  promoted: boolean;
  flaggedBad: boolean;
}

const VERIFICATION_WINDOW_MS = 30_000; // 30 seconds
const MIN_GAMEPLAY_RATIO = 0.3; // at least 30% gameplay frames to promote

/**
 * Manages all VisionBridge instances and provides state caching.
 */
export class VisionManager {
  private bridges = new Map<string, VisionBridge>();
  private stateCache = new Map<string, CachedVisionState>();
  private verification = new Map<string, VerificationState>();

  constructor(
    private config: Config,
    private cropProfileService: CropProfileService,
  ) {}

  /**
   * Start vision pipeline for a racer.
   */
  async startVision(racerId: string, profileId: string): Promise<void> {
    if (this.bridges.has(racerId)) {
      logger.warn(`[VisionManager] Vision already running for ${racerId}`);
      return;
    }

    // Load crop settings from crop profile service (with fallback to inline fields)
    const cropData = await this.cropProfileService.getDefaultForRacer(profileId);

    const options: VisionBridgeOptions = {
      racerId,
      streamKey: racerId,
      cropRegion: {
        x: cropData.x,
        y: cropData.y,
        w: cropData.w,
        h: cropData.h,
      },
      streamWidth: cropData.streamWidth,
      streamHeight: cropData.streamHeight,
      gridOffsetDx: cropData.gridOffsetDx,
      gridOffsetDy: cropData.gridOffsetDy,
      landmarks: cropData.landmarks ? JSON.stringify(cropData.landmarks) : undefined,
      cropProfileId: cropData.cropProfileId ?? undefined,
    };

    const bridge = new VisionBridge(options, this.config);

    bridge.on('error', (err: Error) => {
      logger.error(`[VisionManager] Vision error for ${racerId}: ${err.message}`);
    });

    this.bridges.set(racerId, bridge);

    try {
      await bridge.start();
    } catch (err) {
      this.bridges.delete(racerId);
      throw err;
    }

    logger.info(`[VisionManager] Vision started for ${racerId}`);
  }

  /**
   * Start vision pipeline for a racer sourced from a VOD URL (via streamlink).
   */
  async startVisionVod(racerId: string, vodUrl: string, profileId: string, startTime?: string): Promise<void> {
    if (this.bridges.has(racerId)) {
      logger.warn(`[VisionManager] Vision already running for ${racerId}`);
      return;
    }

    const cropData = await this.cropProfileService.getDefaultForRacer(profileId);

    const options: VisionBridgeOptions = {
      racerId,
      source: { type: 'vod', url: vodUrl, startTime },
      cropRegion: {
        x: cropData.x,
        y: cropData.y,
        w: cropData.w,
        h: cropData.h,
      },
      streamWidth: cropData.streamWidth,
      streamHeight: cropData.streamHeight,
      gridOffsetDx: cropData.gridOffsetDx,
      gridOffsetDy: cropData.gridOffsetDy,
      landmarks: cropData.landmarks ? JSON.stringify(cropData.landmarks) : undefined,
      cropProfileId: cropData.cropProfileId ?? undefined,
    };

    const bridge = new VisionBridge(options, this.config);

    bridge.on('error', (err: Error) => {
      logger.error(`[VisionManager] VOD vision error for ${racerId}: ${err.message}`);
    });

    this.bridges.set(racerId, bridge);

    try {
      await bridge.start();
    } catch (err) {
      this.bridges.delete(racerId);
      throw err;
    }

    logger.info(`[VisionManager] VOD vision started for ${racerId}: ${vodUrl}`);
  }

  /**
   * Stop vision pipeline for a racer.
   */
  async stopVision(racerId: string): Promise<void> {
    const bridge = this.bridges.get(racerId);
    if (bridge) {
      await bridge.stop();
      this.bridges.delete(racerId);
      this.stateCache.delete(racerId);
      this.verification.delete(racerId);
      logger.info(`[VisionManager] Vision stopped for ${racerId}`);
    }
  }

  /**
   * Stop all vision pipelines.
   */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.bridges.keys()).map((id) => this.stopVision(id));
    await Promise.allSettled(stops);
  }

  /**
   * Merge incoming partial state into the cache and return the full merged state
   * plus any one-shot game events extracted from the payload.
   * Called by the API route when Python POSTs a state update.
   */
  updateState(racerId: string, partialState: Record<string, unknown>): {
    state: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
  } {
    // Extract game_events before merging (one-shot, not cached)
    const gameEvents = (partialState.game_events as Array<Record<string, unknown>>) ?? [];
    const stateOnly = { ...partialState };
    delete stateOnly.game_events;

    const existing = this.stateCache.get(racerId) || { lastUpdated: 0 };
    const merged = { ...existing, ...stateOnly, lastUpdated: Date.now() };
    this.stateCache.set(racerId, merged);

    // Auto-crop verification: track gameplay detection rate during initial window
    this._updateVerification(racerId, stateOnly);

    return { state: merged, events: gameEvents };
  }

  /**
   * Track gameplay detection rate during the verification window.
   * If screen_type is consistently gameplay, promote confidence.
   * If HUD is never detected after 30s, flag as bad crop.
   */
  private _updateVerification(racerId: string, state: Record<string, unknown>): void {
    let v = this.verification.get(racerId);
    if (!v) {
      v = { startTime: Date.now(), gameplayCount: 0, totalUpdates: 0, promoted: false, flaggedBad: false };
      this.verification.set(racerId, v);
    }

    if (v.promoted || v.flaggedBad) return; // already decided

    v.totalUpdates++;
    const screenType = state.screen_type as string | undefined;
    if (screenType === 'overworld' || screenType === 'dungeon' || screenType === 'cave') {
      v.gameplayCount++;
    }

    const elapsed = Date.now() - v.startTime;
    if (elapsed >= VERIFICATION_WINDOW_MS && v.totalUpdates >= 10) {
      const ratio = v.gameplayCount / v.totalUpdates;
      if (ratio >= MIN_GAMEPLAY_RATIO) {
        v.promoted = true;
        logger.info(`[VisionManager] Crop verified for ${racerId}: ${(ratio * 100).toFixed(0)}% gameplay (${v.gameplayCount}/${v.totalUpdates})`);
      } else {
        v.flaggedBad = true;
        logger.warn(`[VisionManager] Bad crop suspected for ${racerId}: ${(ratio * 100).toFixed(0)}% gameplay (${v.gameplayCount}/${v.totalUpdates}) — may need recalibration`);
      }
    }
  }

  /**
   * Get the verification status for a racer's crop.
   */
  getVerificationStatus(racerId: string): { promoted: boolean; flaggedBad: boolean; ratio: number } | null {
    const v = this.verification.get(racerId);
    if (!v) return null;
    return {
      promoted: v.promoted,
      flaggedBad: v.flaggedBad,
      ratio: v.totalUpdates > 0 ? v.gameplayCount / v.totalUpdates : 0,
    };
  }

  /**
   * Reset the cached state for a racer (clears stale data without stopping the bridge).
   */
  resetState(racerId: string): void {
    this.stateCache.delete(racerId);
    this.verification.delete(racerId);
    logger.info(`[VisionManager] State reset for ${racerId}`);
  }

  /**
   * Get the last known vision state for a racer.
   */
  getState(racerId: string): CachedVisionState | null {
    return this.stateCache.get(racerId) || null;
  }

  /**
   * Get status of all active vision bridges.
   */
  getActiveBridges(): string[] {
    return Array.from(this.bridges.keys());
  }
}
