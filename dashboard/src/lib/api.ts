const BASE = '/api';

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

// ─── Status ───

export interface SystemStatus {
  server: string;
  obs: { connected: boolean; streaming: boolean };
  streams: Record<string, StreamStatus>;
}

export interface StreamStatus {
  racerId: string;
  twitchChannel: string;
  streamKey: string;
  state: 'starting' | 'running' | 'error' | 'stopped';
  startedAt?: string;
  error?: string;
  restartCount: number;
}

export function getStatus() {
  return request<SystemStatus>('/status');
}

// ─── Health ───

export interface SystemHealth {
  server: string;
  obs: { connected: boolean; streaming: boolean; scene: string };
  streams: Record<string, StreamStatus>;
  vision: { activeBridges: string[]; bridgeCount: number };
  commentary: { enabled: boolean; generating: boolean; turnCount: number };
  knowledgeBase: { available: boolean; [key: string]: unknown };
  tts: { enabled: boolean };
}

export function getHealth() {
  return request<SystemHealth>('/health');
}

// ─── Streams ───

export function getStreams() {
  return request<Record<string, StreamStatus>>('/streams');
}

export function startStream(racerId: string, twitchChannel: string, streamKey?: string) {
  return request<{ status: string; racerId: string }>(`/streams/${racerId}/start`, {
    method: 'POST',
    body: JSON.stringify({ twitchChannel, streamKey }),
  });
}

export function stopStream(racerId: string) {
  return request<{ status: string }>(`/streams/${racerId}/stop`, { method: 'POST' });
}

export function stopAllStreams() {
  return request<{ status: string }>('/streams/stop-all', { method: 'POST' });
}

// ─── OBS ───

export interface ObsStatus {
  connected: boolean;
  streaming?: boolean;
  scenes?: string[];
  currentScene?: string;
  error?: string;
}

export function getObsStatus() {
  return request<ObsStatus>('/obs/status');
}

export function connectObs() {
  return request<{ status: string }>('/obs/connect', { method: 'POST' });
}

export function launchObs() {
  return request<{ status: string }>('/obs/launch', { method: 'POST' });
}

export function killObs() {
  return request<{ status: string }>('/obs/kill', { method: 'POST' });
}

export function switchScene(sceneName: string) {
  return request<{ status: string }>('/obs/scene', {
    method: 'POST',
    body: JSON.stringify({ sceneName }),
  });
}

export function buildScene(sceneName: string, racers: RacerSetup[]) {
  return request<{ status: string }>('/obs/build-scene', {
    method: 'POST',
    body: JSON.stringify({ sceneName, racers }),
  });
}

export function startStreaming() {
  return request<{ status: string }>('/obs/start-streaming', { method: 'POST' });
}

export function stopStreaming() {
  return request<{ status: string }>('/obs/stop-streaming', { method: 'POST' });
}

export function getMultitrackVideo() {
  return request<{ enabled: boolean }>('/obs/multitrack');
}

export function setMultitrackVideo(enabled: boolean) {
  return request<{ status: string; enabled: boolean }>('/obs/multitrack', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

// ─── Profiles ───

export interface RacerProfile {
  id: string;
  racetime_id: string | null;
  racetime_name: string | null;
  display_name: string;
  twitch_channel: string;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  stream_width: number;
  stream_height: number;
  preferred_color: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RacerSetup {
  racerId: string;
  displayName: string;
  twitchChannel: string;
  streamKey: string;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  streamWidth: number;
  streamHeight: number;
}

export function getProfiles() {
  return request<RacerProfile[]>('/profiles');
}

export function getProfile(id: string) {
  return request<RacerProfile>(`/profiles/${id}`);
}

export function createProfile(data: Partial<RacerProfile>) {
  return request<{ id: string }>('/profiles', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateProfile(id: string, data: Partial<RacerProfile>) {
  return request<{ status: string }>(`/profiles/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteProfile(id: string) {
  return request<{ status: string }>(`/profiles/${id}`, { method: 'DELETE' });
}

// ─── Racer Pool ───

export interface PoolEntry {
  racetime_id: string;
  name: string;
  discriminator: string;
  full_name: string;
  twitch_name: string | null;
  twitch_channel: string | null;
  leaderboard_place: number | null;
  leaderboard_score: number | null;
  best_time: string | null;
  times_raced: number | null;
  last_synced_at: string;
  profile_id: string | null;
  imported: boolean;
}

export function getPool() {
  return request<PoolEntry[]>('/pool');
}

export function syncPool() {
  return request<{ synced: number; total: number }>('/pool/sync', { method: 'POST' });
}

export function importRacer(racetimeId: string) {
  return request<{ profileId: string }>('/pool/import', {
    method: 'POST',
    body: JSON.stringify({ racetimeId }),
  });
}

export function importFromUrl(url: string) {
  return request<{ profileId: string; displayName: string }>('/pool/import-url', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

// ─── Knowledge Base ───

export interface KnowledgeStatus {
  available: boolean;
  chromaConnected: boolean;
  ollamaConnected: boolean;
  collectionSize: number;
}

export function getKnowledgeStatus() {
  return request<KnowledgeStatus>('/knowledge/status');
}

export function ingestVod(vodUrl: string, title?: string) {
  return request<{ status: string; vodUrl: string }>('/knowledge/ingest-vod', {
    method: 'POST',
    body: JSON.stringify({ vodUrl, title }),
  });
}

export function importRaceHistory(pages?: number) {
  return request<{ racesImported: number; racersUpdated: number }>('/knowledge/import-history', {
    method: 'POST',
    body: JSON.stringify({ pages }),
  });
}

// ─── Replay ───

export interface ReplayEntrant {
  racetimeId: string;
  displayName: string;
  twitchChannel: string | null;
  vodUrl: string | null;
  vodOffsetSeconds: number;
  finishTime: string | null;
  place: number | null;
}

export interface ReplayData {
  id: string;
  racetimeUrl: string;
  raceStart: string;
  raceEnd: string | null;
  goal: string | null;
  seed: string | null;
  entrants: ReplayEntrant[];
}

export interface ReplayListItem {
  id: string;
  racetimeUrl: string;
  raceStart: string;
  goal: string | null;
}

export function resolveReplay(racetimeUrl: string) {
  return request<ReplayData>('/replay/resolve', {
    method: 'POST',
    body: JSON.stringify({ racetimeUrl }),
  });
}

export function listReplays() {
  return request<ReplayListItem[]>('/replay/list');
}

export function getReplay(id: string) {
  return request<ReplayData>(`/replay/${id}`);
}

export function startReplay(id: string, profiles: Record<string, string>) {
  return request<{ status: string; entrantCount: number }>(`/replay/${id}/start`, {
    method: 'POST',
    body: JSON.stringify({ profiles }),
  });
}

// ─── Race Library ───

export interface RaceHistorySummary {
  slug: string;
  url: string;
  goal: string;
  info: string;
  entrantCount: number;
  finishedCount: number;
  startedAt: string | null;
  endedAt: string | null;
  recorded: boolean;
}

export interface RaceHistoryPage {
  races: RaceHistorySummary[];
  page: number;
  totalPages: number;
  totalRaces: number;
}

export function getRaceHistory(page = 1) {
  return request<RaceHistoryPage>(`/races/history?page=${page}`);
}

// ─── Detected Races (live from race monitor) ───

export interface DetectedRace {
  name: string;
  status: { value: string; verbose_value: string };
  goal: { name: string };
  info: string;
  entrants_count: number;
  entrants_count_finished: number;
  started_at: string | null;
  opened_at: string;
  entrants: Array<{
    user: { name: string; twitch_name: string | null };
    status: { value: string };
    finish_time: string | null;
    place: number | null;
    stream_live: boolean;
  }>;
}

export function getDetectedRaces() {
  return request<DetectedRace[]>('/race/detected');
}

export function featureChatMessage(displayName: string, message: string) {
  return request<{ ok: boolean }>('/commentary/feature-chat', {
    method: 'POST',
    body: JSON.stringify({ displayName, message }),
  });
}

// ─── Twitch Channel Management ───

export interface TwitchChannelInfo {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  game_name: string;
  game_id: string;
  broadcaster_language: string;
  title: string;
  tags: string[];
}

export interface TwitchCategory {
  id: string;
  name: string;
  box_art_url: string;
}

export function getChannelInfo() {
  return request<TwitchChannelInfo>('/twitch/channel');
}

export function updateChannelInfo(updates: { title?: string; game_id?: string; tags?: string[] }) {
  return request<TwitchChannelInfo>('/twitch/channel', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function searchCategories(query: string) {
  return request<TwitchCategory[]>(`/twitch/categories?q=${encodeURIComponent(query)}`);
}

