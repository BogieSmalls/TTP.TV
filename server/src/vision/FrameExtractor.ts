import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

export type InputSource =
  | { type: 'rtmp'; streamKey: string }
  | { type: 'vod'; url: string; startTime?: string }
  | { type: 'file'; path: string }
  | { type: 'url'; url: string };

export interface FrameExtractorOptions {
  racerId: string;
  source: InputSource;
  fps: number;
  width: number;
  height: number;
}

/**
 * Spawns ffmpeg to extract raw BGR24 frames from a video source.
 * Python pipeline disabled — WebGPU pipeline active. This class is retained
 * for type-compatibility but does not spawn any processes.
 */
export class FrameExtractor extends EventEmitter {
  constructor(
    private options: FrameExtractorOptions,
    private _config: Config,
  ) {
    super();
  }

  /**
   * Start frame extraction.
   * Python pipeline disabled — WebGPU pipeline active. Returns null.
   */
  start(): Readable | null {
    console.warn('Python vision pipeline disabled — WebGPU pipeline active');
    logger.warn(`[vision-ffmpeg:${this.options.racerId}] Python vision pipeline disabled — WebGPU pipeline active. FrameExtractor.start() is a no-op.`);
    return null;
  }

  async stop(): Promise<void> {
    // Python pipeline disabled — nothing to stop
  }
}
