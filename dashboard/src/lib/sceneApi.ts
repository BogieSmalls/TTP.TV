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

export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  locked: boolean;
  visible: boolean;
  config?: Record<string, unknown>;
}

export interface ScenePreset {
  id: string;
  name: string;
  description: string | null;
  racer_count: number;
  elements: SceneElement[] | string;
  background: Record<string, unknown> | string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export function listScenePresets() {
  return request<ScenePreset[]>('/scene-presets');
}

export function getScenePreset(id: string) {
  return request<ScenePreset>(`/scene-presets/${id}`);
}

export function createScenePreset(data: {
  name: string;
  description?: string;
  racer_count?: number;
  elements?: SceneElement[];
  background?: Record<string, unknown>;
}) {
  return request<{ id: string }>('/scene-presets', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateScenePreset(id: string, data: Partial<{
  name: string;
  description: string;
  racer_count: number;
  elements: SceneElement[];
  background: Record<string, unknown>;
}>) {
  return request<{ status: string }>(`/scene-presets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteScenePreset(id: string) {
  return request<{ status: string }>(`/scene-presets/${id}`, {
    method: 'DELETE',
  });
}
