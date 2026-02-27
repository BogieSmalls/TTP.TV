const BASE = '/api/tts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`TTS API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ─── Types ───

export interface TtsStatus {
  healthy: boolean;
  enabled: boolean;
  defaultVoice: string;
  speed: number;
  voices: {
    play_by_play: string;
    color: string;
  };
}

export interface TtsVoicesResponse {
  voices: string[];
}

export interface TtsTestResponse {
  audioUrl: string;
}

// ─── API Functions ───

export function getTtsStatus(): Promise<TtsStatus> {
  return request<TtsStatus>('/status');
}

export function getTtsVoices(): Promise<TtsVoicesResponse> {
  return request<TtsVoicesResponse>('/voices');
}

export function testTts(text?: string, voice?: string, speed?: number): Promise<TtsTestResponse> {
  return request<TtsTestResponse>('/test', {
    method: 'POST',
    body: JSON.stringify({ text, voice, speed }),
  });
}
