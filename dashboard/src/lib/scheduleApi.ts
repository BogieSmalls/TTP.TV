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

export interface ScheduleBlock {
  id: string;
  type: string;
  source_url: string | null;
  title: string | null;
  scene_preset_id: string | null;
  commentary_enabled: number;
  commentary_persona_ids: string | null;
  scheduled_at: string;
  duration_minutes: number | null;
  auto_broadcast: number;
  status: string;
  created_at: string;
}

export function listScheduleBlocks(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return request<ScheduleBlock[]>(`/schedule${qs ? `?${qs}` : ''}`);
}

export function getScheduleBlock(id: string) {
  return request<ScheduleBlock>(`/schedule/${id}`);
}

export function createScheduleBlock(data: {
  type?: string;
  source_url?: string;
  title?: string;
  scene_preset_id?: string;
  commentary_enabled?: number;
  commentary_persona_ids?: string[];
  scheduled_at: string;
  duration_minutes?: number;
  auto_broadcast?: number;
}) {
  return request<{ id: string }>('/schedule', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateScheduleBlock(id: string, data: Partial<{
  type: string;
  source_url: string;
  title: string;
  scene_preset_id: string;
  commentary_enabled: number;
  commentary_persona_ids: string[];
  scheduled_at: string;
  duration_minutes: number;
  auto_broadcast: number;
  status: string;
}>) {
  return request<{ status: string }>(`/schedule/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteScheduleBlock(id: string) {
  return request<{ status: string }>(`/schedule/${id}`, {
    method: 'DELETE',
  });
}

export function goLiveScheduleBlock(id: string) {
  return request<{ status: string }>(`/schedule/${id}/go-live`, {
    method: 'POST',
  });
}
