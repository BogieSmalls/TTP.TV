const BASE = '/api/crop-profiles';

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

export interface CropProfile {
  id: string;
  racer_profile_id: string;
  label: string;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  stream_width: number;
  stream_height: number;
  grid_offset_dx: number;
  grid_offset_dy: number;
  screenshot_source: string | null;
  is_default: number;
  confidence: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScreenshotInfo {
  filename: string;
  timestamp: number;
  width: number;
  height: number;
  url: string;
}

export interface ExtractionResult {
  extractionId: string;
  source: string;
  width: number;
  height: number;
  screenshots: ScreenshotInfo[];
}

export function getCropProfiles(racerId: string) {
  return request<CropProfile[]>(`?racerId=${encodeURIComponent(racerId)}`);
}

export function getCropProfile(id: string) {
  return request<CropProfile>(`/${id}`);
}

export function createCropProfile(data: Partial<CropProfile> & { racer_profile_id: string; label: string; landmarks?: LandmarkPosition[] }) {
  return request<{ id: string }>('', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateCropProfile(id: string, data: Partial<CropProfile>) {
  return request<{ status: string }>(`/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteCropProfile(id: string) {
  return request<{ status: string }>(`/${id}`, { method: 'DELETE' });
}

export function setDefaultCropProfile(id: string) {
  return request<{ status: string }>(`/${id}/set-default`, { method: 'POST' });
}

export function extractScreenshots(source: string, timestamps?: number[]) {
  return request<ExtractionResult>('/screenshot', {
    method: 'POST',
    body: JSON.stringify({ source, timestamps }),
  });
}

// ─── Landmarks & Auto-crop ───

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

export function getDefaultLandmarks() {
  return request<{ landmarks: LandmarkPosition[] | null }>('/landmarks');
}

export function autoCropFromExtraction(extractionId: string) {
  return request<AutoCropResult>('/auto-crop', {
    method: 'POST',
    body: JSON.stringify({ extractionId }),
  });
}
