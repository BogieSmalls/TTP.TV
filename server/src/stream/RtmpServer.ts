import NodeMediaServer from 'node-media-server';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

export class RtmpServer {
  private nms: NodeMediaServer | null = null;
  private activeStreams = new Map<string, { ip: string; connectedAt: Date }>();

  constructor(private config: Config) {}

  start(): void {
    const nmsConfig = {
      rtmp: {
        port: this.config.rtmp.port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
      http: this.config.mediaServer.http,
      trans: this.config.mediaServer.trans,
      logType: 1, // errors only
    };

    this.nms = new NodeMediaServer(nmsConfig as any);

    // node-media-server v4 emits a session object (not id/path/args like v2)
    this.nms.on('prePublish', (session) => {
      const streamPath = session.streamPath ?? '';
      const streamKey = streamPath.split('/').pop() || '';
      logger.info(`RTMP stream publishing: ${streamKey}`, { streamPath });
      this.activeStreams.set(streamKey, {
        ip: session.ip ?? 'local',
        connectedAt: new Date(),
      });
    });

    this.nms.on('donePublish', (session) => {
      const streamPath = session.streamPath ?? '';
      const streamKey = streamPath.split('/').pop() || '';
      logger.info(`RTMP stream ended: ${streamKey}`, { streamPath });
      this.activeStreams.delete(streamKey);
    });

    this.nms.run();
    logger.info(`RTMP server started on port ${this.config.rtmp.port}`);
    logger.info(`HLS output available at http://localhost:${this.config.mediaServer.http.port}/live/<key>/index.m3u8`);
  }

  stop(): void {
    if (this.nms) {
      this.nms.stop();
      this.nms = null;
      this.activeStreams.clear();
      logger.info('RTMP server stopped');
    }
  }

  isStreamActive(streamKey: string): boolean {
    return this.activeStreams.has(streamKey);
  }

  getActiveStreams(): Map<string, { ip: string; connectedAt: Date }> {
    return new Map(this.activeStreams);
  }

  getRtmpUrl(streamKey: string): string {
    return `rtmp://127.0.0.1:${this.config.rtmp.port}/live/${streamKey}`;
  }
}
