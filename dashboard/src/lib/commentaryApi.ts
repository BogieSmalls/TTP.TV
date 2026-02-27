const BASE = '/api/commentary';

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

// ─── Types ───

export interface CommentaryStatus {
  enabled: boolean;
  isGenerating: boolean;
  config: CommentaryConfig;
  activePreset: {
    id: string;
    name: string;
    playByPlay: string;
    color: string;
  };
  conversationLength: number;
  recentConversation: ConversationLine[];
  racerSnapshots: Record<string, RacerSnapshot>;
  turnCount?: number;
}

export interface CommentaryConfig {
  model: string;
  periodicIntervalSec: number;
  cooldownSec: number;
  maxTokens: number;
  temperature: number;
  historySize: number;
  kbChunksPerQuery: number;
}

export interface ConversationLine {
  persona: 'play_by_play' | 'color';
  name: string;
  text: string;
  timestamp: number;
  generationMs?: number;
}

export interface RacerSnapshot {
  racerId: string;
  displayName: string;
  screenType?: string;
  hearts?: number;
  heartsMax?: number;
  swordLevel?: number;
  bItem?: string;
  triforceCount?: number;
  dungeonLevel?: number;
  hasMasterKey?: boolean;
  gannonNearby?: boolean;
}

export interface PresetSummary {
  id: string;
  name: string;
  description: string;
  playByPlay: { id: string; name: string };
  color: { id: string; name: string };
}

export interface FlavorEntry {
  id: string;
  text: string;
  tags: string[];
  context: string;
}

export interface CommentaryTextEvent {
  persona: 'play_by_play' | 'color';
  name: string;
  text: string;
  trigger: 'event' | 'periodic' | 'manual';
  eventType?: string;
  generationMs: number;
}

// ─── API Functions ───

export function getStatus() {
  return request<CommentaryStatus>('/status');
}

export function setEnabled(enabled: boolean) {
  return request<{ enabled: boolean }>('/enable', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export function updateConfig(config: Partial<CommentaryConfig>) {
  return request<{ config: CommentaryConfig }>('/config', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

export function manualTrigger(prompt?: string) {
  return request<{ status: string }>('/trigger', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

export function setRaceContext(ctx: { players?: string[]; flags?: string; tournament?: string }) {
  return request<{ raceContext: unknown }>('/race-context', {
    method: 'POST',
    body: JSON.stringify(ctx),
  });
}

export function clearState() {
  return request<{ status: string }>('/clear', { method: 'POST' });
}

export function getPresets() {
  return request<PresetSummary[]>('/presets');
}

export function setActivePreset(presetId: string) {
  return request<{ activePreset: string }>('/presets/active', {
    method: 'POST',
    body: JSON.stringify({ presetId }),
  });
}

export function getFlavorEntries() {
  return request<FlavorEntry[]>('/flavor');
}

export function addFlavorEntry(entry: FlavorEntry) {
  return request<FlavorEntry>('/flavor', {
    method: 'POST',
    body: JSON.stringify(entry),
  });
}

export function updateFlavorEntry(id: string, updates: Partial<FlavorEntry>) {
  return request<FlavorEntry>(`/flavor/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export function deleteFlavorEntry(id: string) {
  return request<{ status: string }>(`/flavor/${id}`, { method: 'DELETE' });
}
