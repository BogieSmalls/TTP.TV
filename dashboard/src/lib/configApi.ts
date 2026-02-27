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
  return res.json();
}

export interface EditableConfig {
  server: { port: number };
  rtmp: { port: number; httpPort: number };
  obs: { url: string; execPath: string };
  twitch: {
    channel: string;
    chatEnabled: boolean;
    chatBufferSize: number;
    streamKey: string; // masked
  };
  racetime: { category: string; pollIntervalMs: number; goalFilter: string };
  vision: { fps: number; confidence: { digit: number; item: number; heart: number } };
  canvas: { width: number; height: number };
  knowledgeBase: {
    chromaUrl: string;
    chromaCollection: string;
    ollamaUrl: string;
    embeddingModel: string;
  };
  commentary: {
    model: string;
    ollamaUrl: string;
    periodicIntervalSec: number;
    cooldownSec: number;
    maxTokens: number;
    temperature: number;
    historySize: number;
    kbChunksPerQuery: number;
  };
  tts: {
    enabled: boolean;
    serviceUrl: string;
    defaultVoice: string;
    speed: number;
    voices: { play_by_play: string; color: string };
  };
  tools: { ffmpegPath: string; streamlinkPath: string };
}

export function getConfig() {
  return request<EditableConfig>('/config');
}

export function updateConfig(updates: Record<string, unknown>) {
  return request<{ status: string; restartRequired: boolean }>('/config', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export function restartServer() {
  return request<{ status: string }>('/restart', { method: 'POST' });
}
