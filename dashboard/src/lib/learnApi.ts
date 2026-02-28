const BASE = '/api/learn';

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

export interface CropResult {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  aspect_ratio: number;
  source_width: number;
  source_height: number;
  hud_verified: boolean;
}

export interface LearnProgress {
  framesProcessed: number;
  totalEstimated: number;
  percentComplete: number;
  currentScreenType?: string;
  cropResult?: CropResult;
}

export type LearnAnnotationType =
  | 'correction' | 'note' | 'bookmark' | 'error'
  | 'item_pickup' | 'item_obtained' | 'item_seen_missed'
  | 'dungeon_enter' | 'dungeon_exit'
  | 'location' | 'strategy' | 'door_repair' | 'death' | 'game_event';

export interface LearnAnnotation {
  id: string;
  timestamp: string;
  frameNumber?: number;
  videoTimestamp?: number;
  snapshotFilename?: string;
  type: LearnAnnotationType;
  field?: string;
  expectedValue?: string;
  detectedValue?: string;
  note: string;
  metadata?: Record<string, string>;
}

export interface SessionMetadata {
  flagset?: string;
  seed?: string;
  playerName?: string;
  notes?: string;
}

export interface LearnSnapshot {
  filename: string;
  reason: 'transition' | 'interval';
  frame: number;
  videoTimestamp: number;
  screenType: string;
  dungeonLevel: number;
  hasMasterKey: boolean;
  gannonNearby: boolean;
  mapPosition: number;
  swordLevel: number;
  bItem: string;
  extra: string;
  positionConfidence?: 'high' | 'medium' | 'low';
  // HUD counters — collected by Python, now surfaced to the dashboard
  heartsCurrent?: number;
  heartsMax?: number;
  rupees?: number;
  keys?: number;
  bombs?: number;
  bombMax?: number;
}

export interface LearnReport {
  session_id: string;
  source: string;
  crop: CropResult;
  total_frames: number;
  processing_time_s: number;
  video_duration_s: number;
  speedup_factor: number;
  screen_type_counts: Record<string, number>;
  area_time_s?: Record<string, number>;
  screen_transitions: [number, string, string][];
  detector_stats: Record<string, { name: string; value_changes: number; values_seen: Record<string, number> }>;
  anomalies: { frame: number; timestamp: number; detector: string; description: string; severity: string }[];
  flicker_events: { timestamp: number; sequence: string; duration: number }[];
  snapshots: LearnSnapshot[];
  total_anomaly_count: number;
  calibration?: {
    offset_col: number;
    offset_row: number;
    offset_col_dungeon: number;
    pixel_dx: number;
    pixel_dy: number;
    confidence: number;
    samples: number;
    applied: boolean;
    refined?: number;
    refined_checked?: number;
    minimap_corrections?: number;
    image_corrections?: number;
  };
  game_events?: Array<{
    frame: number;
    event: 'death' | 'up_a_warp' | 'triforce_inferred' | 'game_complete' | 'heart_container' | 'ganon_fight' | 'ganon_kill' | 'dungeon_first_visit' | 'sword_upgrade' | 'b_item_change' | 'subscreen_open';
    description: string;
    dungeon_level: number;
  }>;
  triforce_inferred?: boolean[];
}

export interface LearnSession {
  id: string;
  source: string;
  profileId?: string;
  status: 'starting' | 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  progress: LearnProgress;
  cropResult?: CropResult;
  report?: LearnReport;
  error?: string;
  annotations: LearnAnnotation[];
  metadata?: SessionMetadata;
}

// ─── API Functions ───

export function getSessions() {
  return request<LearnSession[]>('/sessions');
}

export function getSession(id: string) {
  return request<LearnSession>(`/sessions/${id}`);
}

export function startSession(source: string, opts?: { profileId?: string; fps?: number; startTime?: string; endTime?: string; snapshotInterval?: number; cropRegion?: { x: number; y: number; w: number; h: number }; anyRoads?: string }) {
  return request<{ sessionId: string }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ source, ...opts }),
  });
}

export function cancelSession(id: string) {
  return request<{ status: string }>(`/sessions/${id}/cancel`, { method: 'POST' });
}

export function deleteSession(id: string) {
  return request<{ status: string }>(`/sessions/${id}`, { method: 'DELETE' });
}

export function saveCrop(sessionId: string, profileId?: string) {
  return request<{ status: string; profileId: string; crop: CropResult }>(`/sessions/${sessionId}/save-crop`, {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  });
}

export function getAnnotations(sessionId: string) {
  return request<LearnAnnotation[]>(`/sessions/${sessionId}/annotations`);
}

export function addAnnotation(sessionId: string, annotation: {
  type: LearnAnnotationType;
  note: string;
  field?: string;
  expectedValue?: string;
  detectedValue?: string;
  frameNumber?: number;
  videoTimestamp?: number;
  snapshotFilename?: string;
  metadata?: Record<string, string>;
}) {
  return request<LearnAnnotation>(`/sessions/${sessionId}/annotations`, {
    method: 'POST',
    body: JSON.stringify(annotation),
  });
}

export function updateAnnotation(sessionId: string, annotationId: string, updates: Partial<Omit<LearnAnnotation, 'id' | 'timestamp'>>) {
  return request<LearnAnnotation>(`/sessions/${sessionId}/annotations/${annotationId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export function deleteAnnotation(sessionId: string, annotationId: string) {
  return request<{ status: string }>(`/sessions/${sessionId}/annotations/${annotationId}`, {
    method: 'DELETE',
  });
}

export function updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>) {
  return request<{ status: string; metadata: SessionMetadata }>(`/sessions/${sessionId}/metadata`, {
    method: 'PUT',
    body: JSON.stringify(metadata),
  });
}

export interface BatchResult {
  queued: number;
  sessionIds: string[];
}

export function startBatchSessions(urls: string[], opts?: { fps?: number; snapshotInterval?: number }) {
  return request<BatchResult>('/batch', {
    method: 'POST',
    body: JSON.stringify({ urls, ...opts }),
  });
}
