import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { logger } from '../logger.js';
import { FrameExtractor, type InputSource } from './FrameExtractor.js';
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
 * Handles crash recovery with exponential backoff.
 */
export class VisionBridge extends EventEmitter {
  private frameExtractor: FrameExtractor | null = null;
  private pythonProc: ChildProcess | null = null;
  private running = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private options: VisionBridgeOptions,
    private config: Config,
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

    await this.killAll();
    logger.info(`[vision:${this.options.racerId}] Pipeline stopped`);
  }

  private async launchPipeline(): Promise<void> {
    // 1. Start frame extractor (ffmpeg reading from source)
    const source: InputSource = this.options.source
      ?? { type: 'rtmp', streamKey: this.options.streamKey ?? this.options.racerId };

    this.frameExtractor = new FrameExtractor({
      racerId: this.options.racerId,
      source,
      fps: this.config.vision.fps,
      width: this.options.streamWidth,
      height: this.options.streamHeight,
    }, this.config);

    const frameStream = this.frameExtractor.start();

    // 2. Start Python vision engine
    const visionDir = resolve(import.meta.dirname, '../../../vision');
    const templateDir = resolve(visionDir, 'templates');
    const crop = this.options.cropRegion;

    const gridDx = this.options.gridOffsetDx ?? 0;
    const gridDy = this.options.gridOffsetDy ?? 0;

    const projectRoot = resolve(import.meta.dirname, '../../../');
    const pythonPath = resolve(projectRoot, this.config.vision.pythonPath);

    const pythonArgs = [
      resolve(visionDir, 'vision_engine.py'),
      '--racer', this.options.racerId,
      '--crop', `${crop.x},${crop.y},${crop.w},${crop.h}`,
      '--server', `http://127.0.0.1:${this.config.server.port}`,
      '--width', String(this.options.streamWidth),
      '--height', String(this.options.streamHeight),
      '--templates', templateDir,
      '--grid-offset', `${gridDx},${gridDy}`,
    ];

    if (this.options.landmarks) {
      pythonArgs.push('--landmarks', this.options.landmarks);
    }

    if (this.options.cropProfileId) {
      pythonArgs.push('--crop-profile-id', this.options.cropProfileId);
    }

    this.pythonProc = spawn(pythonPath, pythonArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      cwd: visionDir,
    });

    // Catch spawn errors (e.g. ENOENT when python venv doesn't exist)
    // Without this handler the error event crashes the entire Node process
    this.pythonProc.on('error', (err) => {
      logger.error(`[vision:${this.options.racerId}] Python spawn error: ${err.message}`);
      if (this.running) {
        this.handleCrash('python', null);
      }
    });

    // 3. Pipe ffmpeg stdout -> Python stdin
    if (frameStream && this.pythonProc.stdin) {
      // Handle EPIPE when Python dies — without this, the unhandled error crashes Node
      this.pythonProc.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
          logger.warn(`[vision:${this.options.racerId}] Python stdin EPIPE (process died)`);
        } else {
          logger.error(`[vision:${this.options.racerId}] Python stdin error: ${err.message}`);
        }
      });
      frameStream.pipe(this.pythonProc.stdin);
    }

    // 4. Log Python stderr (metrics + errors)
    this.pythonProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[vision:${this.options.racerId}] ${msg}`);
    });

    // 5. Handle crashes with restart
    this.pythonProc.on('exit', (code) => {
      if (this.running) {
        this.handleCrash('python', code);
      }
    });

    this.frameExtractor.on('exit', (code: number | null) => {
      if (this.running) {
        this.handleCrash('ffmpeg', code);
      }
    });
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
        await this.killAll();
        await this.launchPipeline();
        logger.info(`[vision:${this.options.racerId}] Pipeline restarted`);
      } catch (err) {
        logger.error(`[vision:${this.options.racerId}] Failed to restart`, { err });
        this.handleCrash('pipeline', null);
      }
    }, delay);
  }

  private async killAll(): Promise<void> {
    const kills: Promise<void>[] = [];

    // Kill Python first (consumer), then ffmpeg (producer)
    if (this.pythonProc && !this.pythonProc.killed) {
      kills.push(this.killProcess(this.pythonProc, 'python'));
    }
    if (this.frameExtractor) {
      kills.push(this.frameExtractor.stop());
    }

    await Promise.allSettled(kills);
    this.pythonProc = null;
    this.frameExtractor = null;
  }

  private killProcess(proc: ChildProcess, name: string): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(`[vision:${this.options.racerId}] Force killing ${name}`);
        proc.kill('SIGKILL');
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }
}
