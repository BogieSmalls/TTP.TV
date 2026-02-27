export interface StreamStatus {
  racerId: string;
  twitchChannel: string;
  streamKey: string;
  state: 'starting' | 'running' | 'reconnecting' | 'stopped' | 'error';
  startedAt?: Date;
  error?: string;
  restartCount: number;
}

export interface StreamConfig {
  racerId: string;
  twitchChannel: string;
  streamKey: string;
  quality?: string; // 'best', '720p60', '480p', etc.
  type?: 'live' | 'vod';
  vodUrl?: string;
  startOffsetSeconds?: number;
}
