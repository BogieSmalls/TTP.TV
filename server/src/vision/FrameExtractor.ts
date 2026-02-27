import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

export type InputSource =
  | { type: 'rtmp'; streamKey: string }
  | { type: 'vod'; url: string }
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
 * Supports RTMP streams, Twitch VODs (via streamlink), local files, and direct URLs.
 * Returns a stdout Readable stream for piping into the Python vision engine.
 */
export class FrameExtractor extends EventEmitter {
  private ffmpegProc: ChildProcess | null = null;
  private streamlinkProc: ChildProcess | null = null;
  private rtmpPort: number;

  private twitchToken: string;

  private ffmpegPath: string;
  private streamlinkPath: string;

  constructor(
    private options: FrameExtractorOptions,
    config: Config,
  ) {
    super();
    this.rtmpPort = config.rtmp.port;
    this.twitchToken = config.twitch.turboToken || config.twitch.oauthToken || '';
    this.ffmpegPath = config.tools.ffmpegPath;
    this.streamlinkPath = config.tools.streamlinkPath;
  }

  /**
   * Start ffmpeg frame extraction. Returns the stdout stream (raw BGR24 frames).
   */
  start(): Readable {
    const { source } = this.options;

    let ffmpegInput: string;
    let ffmpegStdinSource: Readable | null = null;

    switch (source.type) {
      case 'rtmp':
        ffmpegInput = `rtmp://127.0.0.1:${this.rtmpPort}/live/${source.streamKey}`;
        break;

      case 'file':
        ffmpegInput = source.path;
        break;

      case 'url':
        ffmpegInput = source.url;
        break;

      case 'vod': {
        // Spawn streamlink to download the VOD, pipe into ffmpeg
        ffmpegInput = 'pipe:0';
        const slArgs = [source.url, 'best', '-O'];
        if (this.twitchToken) {
          slArgs.push('--twitch-api-header', `Authorization=OAuth ${this.twitchToken}`);
        }
        this.streamlinkProc = spawn(this.streamlinkPath, slArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        this.streamlinkProc.on('error', (err) => {
          logger.error(`[vision-streamlink:${this.options.racerId}] spawn error: ${err.message}`);
          this.emit('exit', null);
        });

        this.streamlinkProc.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) logger.debug(`[vision-streamlink:${this.options.racerId}] ${msg}`);
        });

        this.streamlinkProc.on('exit', (code) => {
          logger.info(`[vision-streamlink:${this.options.racerId}] exited with code ${code}`);
        });

        ffmpegStdinSource = this.streamlinkProc.stdout!;
        break;
      }
    }

    this.ffmpegProc = spawn(this.ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', ffmpegInput,
      '-vf', `fps=${this.options.fps}`,
      '-pix_fmt', 'bgr24',
      '-vcodec', 'rawvideo',
      '-f', 'rawvideo',
      'pipe:1',
    ], {
      stdio: [ffmpegStdinSource ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Pipe streamlink stdout into ffmpeg stdin for VOD sources
    if (ffmpegStdinSource && this.ffmpegProc.stdin) {
      this.ffmpegProc.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
          logger.warn(`[vision-ffmpeg:${this.options.racerId}] ffmpeg stdin EPIPE`);
        } else {
          logger.error(`[vision-ffmpeg:${this.options.racerId}] ffmpeg stdin error: ${err.message}`);
        }
      });
      ffmpegStdinSource.pipe(this.ffmpegProc.stdin);
    }

    this.ffmpegProc.on('error', (err) => {
      logger.error(`[vision-ffmpeg:${this.options.racerId}] spawn error: ${err.message}`);
      this.emit('exit', null);
    });

    this.ffmpegProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.debug(`[vision-ffmpeg:${this.options.racerId}] ${msg}`);
    });

    this.ffmpegProc.on('exit', (code) => {
      logger.info(`[vision-ffmpeg:${this.options.racerId}] exited with code ${code}`);
      // For non-live sources, a clean exit (code 0) means the video ended normally
      if (code === 0 && this.options.source.type !== 'rtmp') {
        this.emit('finished');
      }
      this.emit('exit', code);
    });

    return this.ffmpegProc.stdout!;
  }

  async stop(): Promise<void> {
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
        logger.warn(`[vision-ffmpeg:${this.options.racerId}] force killing ${name}`);
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
