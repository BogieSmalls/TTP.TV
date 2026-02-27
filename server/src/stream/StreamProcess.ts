import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type { StreamConfig, StreamStatus } from './types.js';

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_BASE_MS = 2000;

export class StreamProcess extends EventEmitter {
  private streamlinkProc: ChildProcess | null = null;
  private ffmpegProc: ChildProcess | null = null;
  private status: StreamStatus;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    private streamConfig: StreamConfig,
    private rtmpPort: number,
    private twitchOauthToken?: string,
    private ffmpegPath = 'ffmpeg',
    private streamlinkPath = 'streamlink',
  ) {
    super();
    this.status = {
      racerId: streamConfig.racerId,
      twitchChannel: streamConfig.twitchChannel,
      streamKey: streamConfig.streamKey,
      state: 'stopped',
      restartCount: 0,
    };
  }

  async start(): Promise<void> {
    if (this.status.state === 'running' || this.status.state === 'starting') {
      logger.warn(`Stream already ${this.status.state} for ${this.streamConfig.racerId}`);
      return;
    }

    this.stopping = false;
    this.updateState('starting');

    try {
      await this.launchPipeline();
      this.updateState('running');
      this.status.startedAt = new Date();
      this.status.restartCount = 0;
      logger.info(`Stream started for ${this.streamConfig.racerId}`, {
        twitch: this.streamConfig.twitchChannel,
        key: this.streamConfig.streamKey,
      });
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

    await this.killProcesses();
    this.updateState('stopped');
    logger.info(`Stream stopped for ${this.streamConfig.racerId}`);
  }

  getStatus(): StreamStatus {
    return { ...this.status };
  }

  getConfig(): StreamConfig {
    return { ...this.streamConfig };
  }

  private async launchPipeline(): Promise<void> {
    const quality = this.streamConfig.quality ?? 'best';
    // Handle both bare channel names and full URLs from racetime.gg
    const channel = this.streamConfig.twitchChannel.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '');
    const twitchUrl = `twitch.tv/${channel}`;
    const rtmpTarget = `rtmp://127.0.0.1:${this.rtmpPort}/live/${this.streamConfig.streamKey}`;

    // Streamlink: pull Twitch HLS, output raw to stdout
    const streamlinkArgs = [
      twitchUrl,
      quality,
      '-O',                        // output to stdout
      '--twitch-low-latency',
      '--hls-live-edge', '2',
    ];

    // Twitch Turbo/subscriber token — skips pre-roll ads entirely
    if (this.twitchOauthToken) {
      streamlinkArgs.push('--twitch-api-header', `Authorization=OAuth ${this.twitchOauthToken}`);
    }

    this.streamlinkProc = spawn(this.streamlinkPath, streamlinkArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.streamlinkProc.on('error', (err) => {
      logger.error(`[stream:${this.streamConfig.racerId}] streamlink spawn error: ${err.message}`);
    });

    // ffmpeg: remux stdin to local RTMP (no re-encoding)
    this.ffmpegProc = spawn(this.ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', 'pipe:0',
      '-c', 'copy',               // no re-encoding
      '-f', 'flv',
      rtmpTarget,
    ], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });

    this.ffmpegProc.on('error', (err) => {
      logger.error(`[stream:${this.streamConfig.racerId}] ffmpeg spawn error: ${err.message}`);
    });

    // Pipe streamlink stdout → ffmpeg stdin
    if (this.streamlinkProc.stdout && this.ffmpegProc.stdin) {
      this.ffmpegProc.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
          logger.warn(`[stream:${this.streamConfig.racerId}] ffmpeg stdin EPIPE`);
        } else {
          logger.error(`[stream:${this.streamConfig.racerId}] ffmpeg stdin error: ${err.message}`);
        }
      });
      this.streamlinkProc.stdout.pipe(this.ffmpegProc.stdin);
    }

    // Log stderr from both processes
    this.streamlinkProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[streamlink:${this.streamConfig.racerId}] ${msg}`);
    });

    this.ffmpegProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.debug(`[ffmpeg:${this.streamConfig.racerId}] ${msg}`);
    });

    // Handle process exits
    this.streamlinkProc.on('exit', (code) => {
      if (!this.stopping) {
        logger.warn(`Streamlink exited for ${this.streamConfig.racerId}`, { code });
        this.handleProcessExit();
      }
    });

    this.ffmpegProc.on('exit', (code) => {
      if (!this.stopping) {
        logger.warn(`ffmpeg exited for ${this.streamConfig.racerId}`, { code });
        this.handleProcessExit();
      }
    });

    // Wait briefly to ensure processes didn't immediately crash
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 2000);

      const onEarlyExit = (code: number | null) => {
        clearTimeout(timeout);
        reject(new Error(`Process exited early with code ${code}`));
      };

      const onSpawnError = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };

      this.streamlinkProc?.once('exit', onEarlyExit);
      this.ffmpegProc?.once('exit', onEarlyExit);
      this.streamlinkProc?.once('error', onSpawnError);
      this.ffmpegProc?.once('error', onSpawnError);

      // Remove early exit listeners after the wait
      setTimeout(() => {
        this.streamlinkProc?.removeListener('exit', onEarlyExit);
        this.ffmpegProc?.removeListener('exit', onEarlyExit);
        this.streamlinkProc?.removeListener('error', onSpawnError);
        this.ffmpegProc?.removeListener('error', onSpawnError);
      }, 2000);
    });
  }

  private handleProcessExit(): void {
    if (this.stopping) return;

    if (this.status.restartCount >= MAX_RESTART_ATTEMPTS) {
      logger.error(`Max restart attempts reached for ${this.streamConfig.racerId}`);
      this.updateState('error', 'Max restart attempts reached');
      return;
    }

    const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, this.status.restartCount);
    this.status.restartCount++;
    this.updateState('reconnecting');

    logger.info(`Restarting stream for ${this.streamConfig.racerId} in ${delay}ms`, {
      attempt: this.status.restartCount,
    });

    this.restartTimer = setTimeout(async () => {
      try {
        await this.killProcesses();
        await this.launchPipeline();
        this.updateState('running');
        logger.info(`Stream restarted for ${this.streamConfig.racerId}`);
      } catch (err) {
        logger.error(`Failed to restart stream for ${this.streamConfig.racerId}`, { err });
        this.handleProcessExit();
      }
    }, delay);
  }

  private async killProcesses(): Promise<void> {
    const kills: Promise<void>[] = [];

    if (this.streamlinkProc && !this.streamlinkProc.killed) {
      kills.push(this.killProcess(this.streamlinkProc, 'streamlink'));
    }
    if (this.ffmpegProc && !this.ffmpegProc.killed) {
      kills.push(this.killProcess(this.ffmpegProc, 'ffmpeg'));
    }

    await Promise.allSettled(kills);
    this.streamlinkProc = null;
    this.ffmpegProc = null;
  }

  private killProcess(proc: ChildProcess, name: string): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(`Force killing ${name} for ${this.streamConfig.racerId}`);
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

  private updateState(state: StreamStatus['state'], error?: string): void {
    this.status.state = state;
    this.status.error = error;
    this.emit('stateChange', this.getStatus());
  }
}
