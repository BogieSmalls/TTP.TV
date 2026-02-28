import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type { InputSource } from './FrameExtractor.js';
import type { Config } from '../config.js';

const MAX_RESTARTS = 5;
const RESTART_BACKOFF_BASE_MS = 2000;

export interface VisionBridgeOptions {
  racerId: string;
  streamKey?: string;
  source?: InputSource;
  cropRegion: { x: number; y: number; w: number; h: number };
  streamWidth: number;
  streamHeight: number;
  gridOffsetDx?: number;
  gridOffsetDy?: number;
  landmarks?: string;  // JSON string of landmark positions
  cropProfileId?: string;
}

/**
 * Manages the full ffmpeg -> Python vision pipeline for a single racer.
 * Python pipeline disabled — WebGPU pipeline active.
 * Handles crash recovery with exponential backoff (retained for future use).
 */
export class VisionBridge extends EventEmitter {
  private running = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private options: VisionBridgeOptions,
    private _config: Config,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.running = true;
    this.restartCount = 0;
    await this.launchPipeline();
    logger.info(`[vision:${this.options.racerId}] Pipeline started`);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    logger.info(`[vision:${this.options.racerId}] Pipeline stopped`);
  }

  private async launchPipeline(): Promise<void> {
    // Python vision pipeline disabled — WebGPU pipeline active
    console.warn('Python vision pipeline disabled — WebGPU pipeline active');
    logger.warn(`[vision:${this.options.racerId}] Python vision pipeline disabled — WebGPU pipeline active`);
    // No-op: VisionBridge.launchPipeline() is retired. Vision runs via WebGPU worker.
  }

  private handleCrash(component: string, code: number | null): void {
    if (!this.running) return;

    this.restartCount++;
    if (this.restartCount > MAX_RESTARTS) {
      logger.error(`[vision:${this.options.racerId}] Max restarts exceeded for ${component}`);
      this.emit('error', new Error(`Max vision restarts exceeded for ${component}`));
      return;
    }

    const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartCount - 1);
    logger.warn(
      `[vision:${this.options.racerId}] ${component} crashed (code ${code}), restarting in ${delay}ms (attempt ${this.restartCount}/${MAX_RESTARTS})`,
    );

    this.restartTimer = setTimeout(async () => {
      if (!this.running) return;

      try {
        await this.launchPipeline();
        logger.info(`[vision:${this.options.racerId}] Pipeline restarted`);
      } catch (err) {
        logger.error(`[vision:${this.options.racerId}] Failed to restart`, { err });
        this.handleCrash('pipeline', null);
      }
    }, delay);
  }
}
