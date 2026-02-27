import type {
  RaceCurrentResponse,
  RacetimeRace,
  RaceSetupProposal,
  EntrantMatch,
  AutoModeConfig,
} from './raceTypes';

const BASE = '/api/race';

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

export function getRaceCurrent() {
  return request<RaceCurrentResponse>('/current');
}

export function getDetectedRaces() {
  return request<RacetimeRace[]>('/detected');
}

export function setupRace(slug: string) {
  return request<RaceSetupProposal>('/setup', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  });
}

export function confirmSetup(overrides?: { entrantOverrides?: Array<{ racetimeUserId: string; profileId: string; slot: number }> }) {
  return request<{ status: string }>('/confirm-setup', {
    method: 'POST',
    body: JSON.stringify({ overrides }),
  });
}

export function refreshEntrants() {
  return request<{ entrants: import('./raceTypes').EntrantMatch[] }>('/refresh-entrants', {
    method: 'POST',
  });
}

export function goLive() {
  return request<{ status: string }>('/go-live', { method: 'POST' });
}

export function endRace() {
  return request<{ status: string }>('/end', { method: 'POST' });
}

export function getRaceEntrants(slug: string) {
  return request<EntrantMatch[]>(`/${slug}/entrants`);
}

export function getAutoMode() {
  return request<AutoModeConfig>('/auto-mode');
}

export function setAutoMode(config: Partial<AutoModeConfig>) {
  return request<AutoModeConfig>('/auto-mode', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

export function swapRunner(racerId: string, twitchChannel: string, newRacetimeUserId?: string) {
  return request<{ status: string }>('/swap-runner', {
    method: 'POST',
    body: JSON.stringify({ racerId, twitchChannel, newRacetimeUserId }),
  });
}

export function featureRacer(racerId: string | null) {
  return request<{ status: string }>('/feature', {
    method: 'POST',
    body: JSON.stringify({ racerId }),
  });
}

export function getFeaturedRacer() {
  return request<{ racerId: string | null }>('/featured');
}

export function goOffline() {
  return request<{ status: string }>('/go-offline', { method: 'POST' });
}

export function rebuildScene() {
  return request<{ status: string }>('/rebuild-scene', { method: 'POST' });
}

export function updateCropLive(racerId: string) {
  return request<{ status: string }>('/update-crop', {
    method: 'POST',
    body: JSON.stringify({ racerId }),
  });
}
