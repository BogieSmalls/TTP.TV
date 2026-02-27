import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type { StreamStatus } from './types.js';

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 2000;

export interface VodStreamConfig {
  racerId: string;
  streamKey: string;
  directUrl: string;
  startOffsetSeconds: number;
  rtmpPort: number;
  ffmpegPath?: string;
}

export class VodStreamProcess extends EventEmitter {
  private ffmpegProc: ChildProcess | null = null;
  private status: StreamStatus;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private currentOffset: number;

  constructor(private config: VodStreamConfig) {
    super();
    this.currentOffset = config.startOffsetSeconds;
    this.status = {
      racerId: config.racerId,
      twitchChannel: 'vod',
      streamKey: config.streamKey,
      state: 'stopped',
      restartCount: 0,
    };
  }

  async start(): Promise<void> {
    if (this.status.state === 'running' || this.status.state === 'starting') return;
    this.stopping = false;
    this.updateState('starting');

    try {
      await this.launchFfmpeg();
      this.updateState('running');
      this.status.startedAt = new Date();
      this.status.restartCount = 0;
      logger.info(`[vod-stream] Started for ${this.config.racerId} at offset ${this.currentOffset}s`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateState('error', msg);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.killFfmpeg();
    this.updateState('stopped');
    logger.info(`[vod-stream] Stopped for ${this.config.racerId}`);
  }

  async seek(offsetSeconds: number): Promise<void> {
    this.currentOffset = offsetSeconds;
    logger.info(`[vod-stream] Seeking ${this.config.racerId} to ${offsetSeconds}s`);
    await this.killFfmpeg();
    await this.launchFfmpeg();
    this.updateState('running');
  }

  getStatus(): StreamStatus {
    return { ...this.status };
  }

  private async launchFfmpeg(): Promise<void> {
    const rtmpTarget = `rtmp://127.0.0.1:${this.config.rtmpPort}/live/${this.config.streamKey}`;

    this.ffmpegProc = spawn(this.config.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel', 'warning',
      '-ss', String(this.currentOffset),
      '-i', this.config.directUrl,
      '-c', 'copy',
      '-f', 'flv',
      rtmpTarget,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    this.ffmpegProc.on('error', (err) => {
      logger.error(`[vod-stream:${this.config.racerId}] ffmpeg spawn error: ${err.message}`);
    });

    this.ffmpegProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.debug(`[vod-ffmpeg:${this.config.racerId}] ${msg}`);
    });

    this.ffmpegProc.on('exit', (code) => {
      if (this.stopping) return;

      if (code === 0) {
        // Natural exit = VOD finished
        logger.info(`[vod-stream] VOD finished for ${this.config.racerId}`);
        this.updateState('stopped');
        this.emit('finished');
        return;
      }

      // Error exit — try to restart
      this.handleErrorExit(code);
    });

    // Wait briefly to ensure no immediate crash
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 1500);
      const onExit = (code: number | null) => {
        clearTimeout(timeout);
        reject(new Error(`ffmpeg exited immediately with code ${code}`));
      };
      const onError = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };
      this.ffmpegProc?.once('exit', onExit);
      this.ffmpegProc?.once('error', onError);
      setTimeout(() => {
        this.ffmpegProc?.removeListener('exit', onExit);
        this.ffmpegProc?.removeListener('error', onError);
      }, 1500);
    });
  }

  private handleErrorExit(code: number | null): void {
    if (this.stopping) return;
    if (this.status.restartCount >= MAX_RESTART_ATTEMPTS) {
      logger.error(`[vod-stream] Max restarts for ${this.config.racerId}`);
      this.updateState('error', 'Max restart attempts reached');
      return;
    }

    const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, this.status.restartCount);
    this.status.restartCount++;
    this.updateState('reconnecting');

    logger.info(`[vod-stream] Restarting ${this.config.racerId} in ${delay}ms (exit code ${code})`);
    this.restartTimer = setTimeout(async () => {
      try {
        await this.killFfmpeg();
        await this.launchFfmpeg();
        this.updateState('running');
      } catch {
        this.handleErrorExit(code);
      }
    }, delay);
  }

  private async killFfmpeg(): Promise<void> {
    if (!this.ffmpegProc || this.ffmpegProc.killed) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.ffmpegProc?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.ffmpegProc!.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ffmpegProc!.kill('SIGTERM');
    });
  }

  private updateState(state: StreamStatus['state'], error?: string): void {
    this.status.state = state;
    this.status.error = error;
    this.emit('stateChange', this.getStatus());
  }
}
