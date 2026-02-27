declare module 'node-media-server' {
  import { EventEmitter } from 'node:events';

  interface NmsConfig {
    rtmp?: {
      port?: number;
      chunk_size?: number;
      gop_cache?: boolean;
      ping?: number;
      ping_timeout?: number;
    };
    http?: {
      port?: number;
      allow_origin?: string;
    };
    logType?: number;
  }

  // v4 API: events emit a session object (not id, streamPath, args)
  interface NmsSession {
    id: string;
    ip: string;
    streamPath: string;
    [key: string]: unknown;
  }

  class NodeMediaServer extends EventEmitter {
    constructor(config: NmsConfig);
    run(): void;
    stop(): void;
    on(event: 'prePublish', listener: (session: NmsSession) => void): this;
    on(event: 'postPublish', listener: (session: NmsSession) => void): this;
    on(event: 'donePublish', listener: (session: NmsSession) => void): this;
    on(event: 'prePlay', listener: (session: NmsSession) => void): this;
    on(event: 'postPlay', listener: (session: NmsSession) => void): this;
    on(event: 'donePlay', listener: (session: NmsSession) => void): this;
  }

  export = NodeMediaServer;
}
