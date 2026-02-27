import { EventEmitter } from 'node:events';
import { StreamProcess } from './StreamProcess.js';
import { VodStreamProcess } from './VodStreamProcess.js';
import { RtmpServer } from './RtmpServer.js';
import { resolveVodUrl } from './vodResolver.js';
import { logger } from '../logger.js';
import type { Config } from '../config.js';
import type { StreamConfig, StreamStatus } from './types.js';

export class StreamManager extends EventEmitter {
  private streams = new Map<string, StreamProcess | VodStreamProcess>();
  private rtmpServer: RtmpServer;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private healthFailures = new Map<string, number>();

  constructor(private config: Config) {
    super();
    this.rtmpServer = new RtmpServer(config);
  }

  start(): void {
    this.rtmpServer.start();

    // Health check every 5 seconds
    this.healthCheckInterval = setInterval(() => this.healthCheck(), 5000);
    logger.info('StreamManager started');
  }

  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.rtmpServer.stop();
    logger.info('StreamManager stopped');
  }

  async startRacer(streamConfig: StreamConfig): Promise<void> {
    const { racerId } = streamConfig;

    if (this.streams.has(racerId)) {
      logger.warn(`Stream already exists for racer ${racerId}, stopping first`);
      await this.stopRacer(racerId);
    }

    const process = new StreamProcess(
      streamConfig,
      this.config.rtmp.port,
      this.config.twitch.turboToken || this.config.twitch.oauthToken,
      this.config.tools.ffmpegPath,
      this.config.tools.streamlinkPath,
    );

    process.on('stateChange', (status: StreamStatus) => {
      this.emit('streamStateChange', status);
    });

    this.streams.set(racerId, process);
    await process.start();
  }

  async startVodRacer(config: {
    racerId: string;
    vodUrl: string;
    streamKey: string;
    startOffsetSeconds?: number;
  }): Promise<void> {
    const { racerId } = config;

    if (this.streams.has(racerId)) {
      logger.warn(`Stream already exists for racer ${racerId}, stopping first`);
      await this.stopRacer(racerId);
    }

    // Resolve VOD URL to direct stream URL
    const resolved = await resolveVodUrl(config.vodUrl, this.config.twitch.turboToken);
    logger.info(`[vod] Resolved ${config.vodUrl} → ${resolved.sourceType} (duration: ${resolved.duration ?? 'unknown'})`);

    const process = new VodStreamProcess({
      racerId,
      streamKey: config.streamKey,
      directUrl: resolved.directUrl,
      startOffsetSeconds: config.startOffsetSeconds ?? 0,
      rtmpPort: this.config.rtmp.port,
      ffmpegPath: this.config.tools.ffmpegPath,
    });

    process.on('stateChange', (status: StreamStatus) => {
      this.emit('streamStateChange', status);
    });

    process.on('finished', () => {
      logger.info(`[vod] VOD playback finished for ${racerId}`);
      this.emit('vodFinished', { racerId });
    });

    this.streams.set(racerId, process);
    await process.start();
  }

  async stopRacer(racerId: string): Promise<void> {
    const process = this.streams.get(racerId);
    if (!process) {
      logger.warn(`No stream found for racer ${racerId}`);
      return;
    }

    await process.stop();
    this.streams.delete(racerId);
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.streams.keys()).map((id) =>
      this.stopRacer(id),
    );
    await Promise.allSettled(stopPromises);
    logger.info('All streams stopped');
  }

  getStatus(): Map<string, StreamStatus> {
    const statuses = new Map<string, StreamStatus>();
    for (const [id, process] of this.streams) {
      statuses.set(id, process.getStatus());
    }
    return statuses;
  }

  getRacerStatus(racerId: string): StreamStatus | undefined {
    return this.streams.get(racerId)?.getStatus();
  }

  isRtmpStreamActive(streamKey: string): boolean {
    return this.rtmpServer.isStreamActive(streamKey);
  }

  getRtmpUrl(streamKey: string): string {
    return this.rtmpServer.getRtmpUrl(streamKey);
  }

  private healthCheck(): void {
    for (const [racerId, process] of this.streams) {
      const status = process.getStatus();
      const rtmpActive = this.rtmpServer.isStreamActive(status.streamKey);
      const failKey = `health_fail_${racerId}`;

      if (status.state === 'running' && !rtmpActive) {
        const failures = (this.healthFailures.get(failKey) ?? 0) + 1;
        this.healthFailures.set(failKey, failures);

        logger.warn(`RTMP stream not active for ${racerId} (${failures} consecutive failures)`);

        // After 3 consecutive failures (15s of no data), trigger restart
        if (failures >= 3) {
          logger.warn(`Stream stall detected for ${racerId}, triggering restart`);
          this.healthFailures.set(failKey, 0);
          this.restartRacer(racerId).catch((err) => {
            logger.error(`Health-triggered restart failed for ${racerId}`, { err });
          });
        }
      } else {
        this.healthFailures.delete(failKey);
      }

      this.emit('streamHealth', {
        racerId,
        state: status.state,
        rtmpActive,
        restartCount: status.restartCount,
      });
    }
  }

  private async restartRacer(racerId: string): Promise<void> {
    const process = this.streams.get(racerId);
    if (!process) return;

    // Only restart live StreamProcess instances (VOD streams handle their own restart)
    if (!(process instanceof StreamProcess)) return;

    const config = process.getConfig();
    logger.info(`Restarting stream for ${racerId} (health recovery)`);

    await process.stop();

    const newProcess = new StreamProcess(
      config,
      this.config.rtmp.port,
      this.config.twitch.turboToken || this.config.twitch.oauthToken,
      this.config.tools.ffmpegPath,
      this.config.tools.streamlinkPath,
    );
    newProcess.on('stateChange', (s: StreamStatus) => {
      this.emit('streamStateChange', s);
    });

    this.streams.set(racerId, newProcess);
    await newProcess.start();
  }
}
