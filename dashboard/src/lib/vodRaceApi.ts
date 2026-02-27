const BASE = '/api/vod-race';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface VodRacerSetup {
  profileId: string;
  vodUrl: string;
  startOffsetSeconds: number;
}

export interface VodRaceConfig {
  racers: VodRacerSetup[];
  racetimeRoom?: string;
  title?: string;
}

export interface VodRaceRacer {
  profileId: string;
  displayName: string;
  vodUrl: string;
  startOffsetSeconds: number;
  slot: number;
  streamKey: string;
  hasCrop: boolean;
}

export interface VodRaceStatus {
  state: 'idle' | 'setup' | 'ready' | 'live' | 'finished';
  raceId: string | null;
  title: string | null;
  racers: VodRaceRacer[];
  layoutType: string | null;
  sceneName: string | null;
}

export function getVodRaceStatus() {
  return request<VodRaceStatus>('/status');
}

export function setupVodRace(config: VodRaceConfig) {
  return request<VodRaceStatus>('/setup', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

export function confirmVodRace() {
  return request<VodRaceStatus>('/confirm', { method: 'POST' });
}

export function goLiveVodRace() {
  return request<VodRaceStatus>('/go-live', { method: 'POST' });
}

export function endVodRace() {
  return request<{ status: string }>('/end', { method: 'POST' });
}

export function rebuildVodRaceScene() {
  return request<{ status: string; sceneName: string }>('/rebuild-scene', { method: 'POST' });
}

export function goOfflineVodRace() {
  return request<{ status: string; scene: string }>('/go-offline', { method: 'POST' });
}
