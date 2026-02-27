const BASE = '/api/bulk-crop';

// ─── Types ───

export type OnboardingRacerStatus =
  | 'pending'
  | 'discovering'
  | 'vod_found'
  | 'vod_not_found'
  | 'extracting'
  | 'ready'
  | 'skipped'
  | 'completed'
  | 'error';

export interface ScreenshotInfo {
  filename: string;
  timestamp: number;
  width: number;
  height: number;
  url: string;
}

export interface OnboardingEntry {
  racerProfileId: string;
  displayName: string;
  twitchChannel: string;
  status: OnboardingRacerStatus;
  vodUrl: string | null;
  vodTitle: string | null;
  vodDurationSeconds: number | null;
  extractionId: string | null;
  screenshots: ScreenshotInfo[];
  error: string | null;
}

export interface BulkSessionStats {
  total: number;
  vodFound: number;
  vodNotFound: number;
  ready: number;
  completed: number;
  skipped: number;
  errors: number;
}

export interface BulkSession {
  id: string;
  status: string;
  racers: OnboardingEntry[];
  stats: BulkSessionStats;
  createdAt: string;
}

export interface LandmarkPosition {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AutoCropResult {
  crop: { x: number; y: number; w: number; h: number };
  gridOffset: { dx: number; dy: number };
  confidence: number;
  method: string;
  hudVerified: boolean;
}

// ─── API functions ───

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function initBulkSession(): Promise<BulkSession> {
  return request('/session', { method: 'POST' });
}

export function getBulkSession(): Promise<BulkSession | null> {
  return request('/session');
}

export function startDiscovery(): Promise<{ status: string }> {
  return request('/session/discover', { method: 'POST' });
}

export function startBulkExtraction(): Promise<{ status: string }> {
  return request('/session/extract-all', { method: 'POST' });
}

export function extractForRacer(racerProfileId: string): Promise<{ screenshots: ScreenshotInfo[] }> {
  return request(`/session/racers/${racerProfileId}/extract`, { method: 'POST' });
}

export function saveBulkCrop(
  racerProfileId: string,
  data: {
    x: number; y: number; w: number; h: number;
    streamWidth: number; streamHeight: number;
    screenshotSource?: string;
    landmarks?: LandmarkPosition[];
  },
): Promise<{ cropProfileId: string }> {
  return request(`/session/racers/${racerProfileId}/crop`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function skipRacer(racerProfileId: string): Promise<{ status: string }> {
  return request(`/session/racers/${racerProfileId}/skip`, { method: 'POST' });
}

export function setRacerVod(racerProfileId: string, vodUrl: string): Promise<{ status: string }> {
  return request(`/session/racers/${racerProfileId}/vod`, {
    method: 'POST',
    body: JSON.stringify({ vodUrl }),
  });
}

/** Get the most recently saved landmark positions from the DB, or hardcoded defaults */
export function getDefaultLandmarks(): Promise<LandmarkPosition[]> {
  return request('/landmarks');
}

/** Attempt auto-crop detection for a racer's screenshots */
export function autoCropForRacer(racerProfileId: string): Promise<AutoCropResult | null> {
  return request(`/session/racers/${racerProfileId}/auto-crop`, { method: 'POST' });
}
