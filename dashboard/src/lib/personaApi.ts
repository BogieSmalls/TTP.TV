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

// ─── Personas ───

export interface Persona {
  id: string;
  name: string;
  role: string;
  system_prompt: string | null;
  personality: string | null;
  voice_id: string | null;
  is_active: number;
  created_at: string;
}

export function listPersonas() {
  return request<Persona[]>('/personas');
}

export function createPersona(data: {
  name: string;
  role?: string;
  system_prompt?: string;
  personality?: string;
  voice_id?: string;
}) {
  return request<{ id: string }>('/personas', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updatePersona(id: string, data: Partial<{
  name: string;
  role: string;
  system_prompt: string;
  personality: string;
  voice_id: string;
  is_active: number;
}>) {
  return request<{ status: string }>(`/personas/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deletePersona(id: string) {
  return request<{ status: string }>(`/personas/${id}`, {
    method: 'DELETE',
  });
}

// ─── Voice Profiles ───

export interface VoiceProfile {
  id: string;
  name: string;
  type: string;
  kokoro_voice_id: string | null;
  clip_count: number;
  quality_score: number | null;
  is_builtin: boolean;
  created_at: string | null;
}

export function listVoices() {
  return request<VoiceProfile[]>('/voices');
}

export function createVoice(data: {
  name: string;
  type?: string;
  kokoro_voice_id?: string;
}) {
  return request<{ id: string }>('/voices', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateVoice(id: string, data: Partial<{
  name: string;
  type: string;
  kokoro_voice_id: string;
  clip_count: number;
  quality_score: number;
}>) {
  return request<{ status: string }>(`/voices/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteVoice(id: string) {
  return request<{ status: string }>(`/voices/${id}`, {
    method: 'DELETE',
  });
}

export function testVoice(id: string, text?: string) {
  return request<{ status: string; voiceId: string; text: string }>(`/voices/${id}/test`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}
