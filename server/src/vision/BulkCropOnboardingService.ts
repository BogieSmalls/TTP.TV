import { v4 as uuid } from 'uuid';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { Config } from '../config.js';
import type { TwitchApiClient, TwitchVideo } from '../twitch/TwitchApiClient.js';
import { parseTwitchDuration } from '../twitch/TwitchApiClient.js';
import type { CropProfileService, LandmarkPosition } from './CropProfileService.js';
import { logger } from '../logger.js';

// ─── Types ───

export type OnboardingRacerStatus =
  | 'pending'
  | 'discovering'
  | 'vod_found'
  | 'vod_not_found'
  | 'extracting'
  | 'ready'
  | 'skipped'
  | 'completed'
  | 'error';

export interface ScreenshotInfo {
  filename: string;
  timestamp: number;
  width: number;
  height: number;
  url: string;
}

export interface OnboardingEntry {
  racerProfileId: string;
  displayName: string;
  twitchChannel: string;
  status: OnboardingRacerStatus;
  vodUrl: string | null;
  vodTitle: string | null;
  vodDurationSeconds: number | null;
  extractionId: string | null;
  screenshots: ScreenshotInfo[];
  error: string | null;
}

export interface BulkSessionStats {
  total: number;
  vodFound: number;
  vodNotFound: number;
  ready: number;
  completed: number;
  skipped: number;
  errors: number;
}

export interface BulkSession {
  id: string;
  status: 'idle' | 'discovering' | 'extracting' | 'ready' | 'completed';
  racers: OnboardingEntry[];
  stats: BulkSessionStats;
  createdAt: string;
}

export type ProgressCallback = (entry: OnboardingEntry, index: number, total: number) => void;

// ─── Service ───

export class BulkCropOnboardingService {
  private session: BulkSession | null = null;

  constructor(
    private db: Kysely<Database>,
    private twitchApi: TwitchApiClient,
    private cropProfileService: CropProfileService,
    private config: Config,
  ) {}

  /** Get current session */
  getSession(): BulkSession | null {
    return this.session;
  }

  /**
   * Initialize a bulk onboarding session.
   * Finds all racer_profiles that have NO crop_profiles rows.
   */
  async initSession(): Promise<BulkSession> {
    // Find racers without crop profiles using a LEFT JOIN
    const racersWithoutCrops = await this.db
      .selectFrom('racer_profiles as rp')
      .leftJoin('crop_profiles as cp', 'cp.racer_profile_id', 'rp.id')
      .select([
        'rp.id',
        'rp.display_name',
        'rp.twitch_channel',
      ])
      .where('cp.id', 'is', null)
      .where('rp.twitch_channel', 'is not', null)
      .orderBy('rp.display_name', 'asc')
      .execute();

    const racers: OnboardingEntry[] = racersWithoutCrops
      .filter((r) => r.twitch_channel) // extra safety
      .map((r) => ({
        racerProfileId: r.id,
        displayName: r.display_name,
        twitchChannel: r.twitch_channel!,
        status: 'pending' as const,
        vodUrl: null,
        vodTitle: null,
        vodDurationSeconds: null,
        extractionId: null,
        screenshots: [],
        error: null,
      }));

    this.session = {
      id: uuid(),
      status: 'idle',
      racers,
      stats: this.computeStats(racers),
      createdAt: new Date().toISOString(),
    };

    logger.info(`[BulkCrop] Session initialized: ${racers.length} racers need crop profiles`);
    return this.session;
  }

  /**
   * Batch discover VODs for all pending racers.
   */
  async discoverVods(onProgress?: ProgressCallback): Promise<void> {
    if (!this.session) throw new Error('No active session');
    if (!this.twitchApi.isConfigured()) {
      throw new Error('Twitch API credentials not configured');
    }

    this.session.status = 'discovering';
    const racers = this.session.racers.filter((r) => r.status === 'pending');

    for (let i = 0; i < racers.length; i++) {
      const entry = racers[i];
      entry.status = 'discovering';

      try {
        const vod = await this.twitchApi.findZeldaVod(entry.twitchChannel);

        if (vod) {
          entry.status = 'vod_found';
          entry.vodUrl = vod.url;
          entry.vodTitle = vod.title;
          entry.vodDurationSeconds = parseTwitchDuration(vod.duration);
        } else {
          entry.status = 'vod_not_found';
        }
      } catch (err) {
        entry.status = 'error';
        entry.error = err instanceof Error ? err.message : String(err);
        logger.warn(`[BulkCrop] VOD discovery failed for ${entry.displayName}: ${entry.error}`);
      }

      this.session.stats = this.computeStats(this.session.racers);
      onProgress?.(entry, i, racers.length);

      // Rate limit: small delay between API calls
      if (i < racers.length - 1) {
        await sleep(150);
      }
    }

    this.session.status = 'ready';
    this.session.stats = this.computeStats(this.session.racers);
    logger.info(`[BulkCrop] VOD discovery complete: ${this.session.stats.vodFound} found, ${this.session.stats.vodNotFound} not found`);
  }

  /**
   * Extract screenshots for a single racer.
   */
  async extractScreenshots(racerProfileId: string): Promise<ScreenshotInfo[]> {
    if (!this.session) throw new Error('No active session');

    const entry = this.session.racers.find((r) => r.racerProfileId === racerProfileId);
    if (!entry) throw new Error(`Racer ${racerProfileId} not in session`);
    if (!entry.vodUrl) throw new Error(`No VOD URL for ${entry.displayName}`);

    entry.status = 'extracting';
    entry.error = null;

    try {
      // Calculate timestamps at 10% intervals across the VOD
      const duration = entry.vodDurationSeconds || 3600;
      const timestamps = calculateBulkTimestamps(duration);

      const extractionId = randomUUID().slice(0, 12);
      const projectRoot = resolve(import.meta.dirname, '../../..');
      const outputDir = resolve(projectRoot, 'data/crop-screenshots', extractionId);
      const visionDir = resolve(projectRoot, 'vision');
      const pythonPath = resolve(projectRoot, this.config.vision.pythonPath);

      await mkdir(outputDir, { recursive: true });

      const args = [
        resolve(visionDir, 'extract_screenshot.py'),
        '--source', entry.vodUrl,
        '--output-dir', outputDir,
        '--timestamps', timestamps.join(','),
      ];

      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn(pythonPath, args, {
          cwd: visionDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => {
          const msg = d.toString();
          stderr += msg;
          // Log progress lines from Python
          for (const line of msg.split('\n').filter(Boolean)) {
            logger.debug(`[BulkCrop:${entry.displayName}] ${line}`);
          }
        });

        proc.on('error', (err) => reject(err));
        proc.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(stderr || `Process exited with code ${code}`));
          } else {
            resolve(stdout);
          }
        });
      });

      const manifest = JSON.parse(result);
      const screenshots: ScreenshotInfo[] = (manifest.screenshots || []).map((s: any) => ({
        filename: s.filename,
        timestamp: s.timestamp,
        width: s.width,
        height: s.height,
        url: `/api/crop-profiles/screenshots/${extractionId}/${s.filename}`,
      }));

      entry.extractionId = extractionId;
      entry.screenshots = screenshots;
      entry.status = 'ready';
      this.session.stats = this.computeStats(this.session.racers);

      logger.info(`[BulkCrop] Extracted ${screenshots.length} screenshots for ${entry.displayName}`);
      return screenshots;
    } catch (err) {
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      this.session.stats = this.computeStats(this.session.racers);
      logger.error(`[BulkCrop] Screenshot extraction failed for ${entry.displayName}: ${entry.error}`);
      throw err;
    }
  }

  /**
   * Extract screenshots for all racers with VODs (sequential).
   */
  async extractAllScreenshots(onProgress?: ProgressCallback): Promise<void> {
    if (!this.session) throw new Error('No active session');

    this.session.status = 'extracting';
    const racers = this.session.racers.filter((r) => r.status === 'vod_found');

    for (let i = 0; i < racers.length; i++) {
      const entry = racers[i];
      try {
        await this.extractScreenshots(entry.racerProfileId);
      } catch {
        // Error already logged and stored on entry
      }
      onProgress?.(entry, i, racers.length);
    }

    this.session.status = 'ready';
    this.session.stats = this.computeStats(this.session.racers);
  }

  /**
   * Save crop definition for a racer and mark as completed.
   */
  async saveCrop(
    racerProfileId: string,
    cropData: { x: number; y: number; w: number; h: number; streamWidth: number; streamHeight: number },
    screenshotSource?: string,
    landmarks?: LandmarkPosition[],
  ): Promise<string> {
    if (!this.session) throw new Error('No active session');

    const entry = this.session.racers.find((r) => r.racerProfileId === racerProfileId);
    if (!entry) throw new Error(`Racer ${racerProfileId} not in session`);

    const cropProfileId = await this.cropProfileService.create({
      racer_profile_id: racerProfileId,
      label: 'Bulk Onboarded',
      crop_x: cropData.x,
      crop_y: cropData.y,
      crop_w: cropData.w,
      crop_h: cropData.h,
      stream_width: cropData.streamWidth,
      stream_height: cropData.streamHeight,
      is_default: true,
      screenshot_source: screenshotSource,
      landmarks,
      notes: `Bulk onboarded ${new Date().toISOString().split('T')[0]}`,
    });

    entry.status = 'completed';
    this.session.stats = this.computeStats(this.session.racers);

    logger.info(`[BulkCrop] Saved crop for ${entry.displayName}: ${cropData.x},${cropData.y},${cropData.w},${cropData.h}`);
    return cropProfileId;
  }

  /** Skip a racer */
  skipRacer(racerProfileId: string): void {
    if (!this.session) throw new Error('No active session');

    const entry = this.session.racers.find((r) => r.racerProfileId === racerProfileId);
    if (!entry) throw new Error(`Racer ${racerProfileId} not in session`);

    entry.status = 'skipped';
    this.session.stats = this.computeStats(this.session.racers);
  }

  /** Manually set a VOD URL for a racer (override discovery) */
  async setVodUrl(racerProfileId: string, vodUrl: string): Promise<void> {
    if (!this.session) throw new Error('No active session');

    const entry = this.session.racers.find((r) => r.racerProfileId === racerProfileId);
    if (!entry) throw new Error(`Racer ${racerProfileId} not in session`);

    entry.vodUrl = vodUrl;
    entry.vodTitle = '(manual)';
    entry.status = 'vod_found';
    entry.error = null;
    this.session.stats = this.computeStats(this.session.racers);
  }

  /**
   * Attempt auto-detection of the NES gameplay crop from extracted screenshots.
   */
  async autoCrop(racerProfileId: string): Promise<{
    crop: { x: number; y: number; w: number; h: number };
    gridOffset: { dx: number; dy: number };
    confidence: number;
    method: string;
    hudVerified: boolean;
  } | null> {
    if (!this.session) throw new Error('No active session');

    const entry = this.session.racers.find((r) => r.racerProfileId === racerProfileId);
    if (!entry) throw new Error(`Racer ${racerProfileId} not in session`);
    if (!entry.extractionId) throw new Error(`No screenshots extracted for ${entry.displayName}`);

    const projectRoot = resolve(import.meta.dirname, '../../..');
    const screenshotDir = resolve(projectRoot, 'data/crop-screenshots', entry.extractionId);
    const visionDir = resolve(projectRoot, 'vision');
    const pythonPath = resolve(projectRoot, this.config.vision.pythonPath);

    // Find screenshot files on disk (pick middle ones, skip first/last)
    const files = (await readdir(screenshotDir))
      .filter(f => f.endsWith('.jpg') || f.endsWith('.png'))
      .sort();

    if (files.length === 0) throw new Error(`No screenshot files found for ${entry.displayName}`);

    // Pick 3-5 from the middle to avoid title screens
    const start = Math.max(1, Math.floor(files.length * 0.2));
    const end = Math.min(files.length - 1, Math.ceil(files.length * 0.8));
    const selected = files.slice(start, end + 1).slice(0, 5);
    const inputPaths = selected.map(f => resolve(screenshotDir, f));

    const args = [
      resolve(visionDir, 'detector', 'auto_crop.py'),
      '--inputs', inputPaths.join(','),
    ];

    try {
      const result = await new Promise<string>((resolveP, reject) => {
        const proc = spawn(pythonPath, args, {
          cwd: visionDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });

        let stdout = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.on('error', (err) => reject(err));
        proc.on('exit', (code) => {
          if (code !== 0) reject(new Error(`auto_crop exited with code ${code}`));
          else resolveP(stdout.trim());
        });
      });

      const parsed = JSON.parse(result);
      if (!parsed.crop) return null;

      logger.info(`[BulkCrop] Auto-crop for ${entry.displayName}: ${parsed.method} (confidence: ${parsed.confidence})`);
      return {
        crop: parsed.crop,
        gridOffset: parsed.grid_offset || { dx: 0, dy: 0 },
        confidence: parsed.confidence || 0,
        method: parsed.method || 'unknown',
        hudVerified: parsed.hud_verified || false,
      };
    } catch (err) {
      logger.warn(`[BulkCrop] Auto-crop failed for ${entry.displayName}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── Helpers ───

  private computeStats(racers: OnboardingEntry[]): BulkSessionStats {
    return {
      total: racers.length,
      vodFound: racers.filter((r) => ['vod_found', 'extracting', 'ready'].includes(r.status)).length,
      vodNotFound: racers.filter((r) => r.status === 'vod_not_found').length,
      ready: racers.filter((r) => r.status === 'ready').length,
      completed: racers.filter((r) => r.status === 'completed').length,
      skipped: racers.filter((r) => r.status === 'skipped').length,
      errors: racers.filter((r) => r.status === 'error').length,
    };
  }
}

// ─── Utilities ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Calculate screenshot timestamps at 10% intervals across a VOD.
 * Returns timestamps at 5%, 15%, 25%, ..., 95% to avoid start/end artifacts.
 */
function calculateBulkTimestamps(durationSeconds: number): number[] {
  const timestamps: number[] = [];
  for (let pct = 0.05; pct <= 0.95; pct += 0.10) {
    timestamps.push(Math.round(durationSeconds * pct));
  }
  return timestamps;
}
