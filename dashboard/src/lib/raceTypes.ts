// Client-side types mirroring server/src/race/types.ts

export interface RacetimeUser {
  id: string;
  full_name: string;
  name: string;
  discriminator: string;
  twitch_name: string | null;
  twitch_channel: string | null;
}

export interface RacetimeEntrant {
  user: RacetimeUser;
  status: { value: string; verbose_value: string };
  finish_time: string | null;
  finished_at: string | null;
  place: number | null;
  place_ordinal: string | null;
  stream_live: boolean;
}

export interface RacetimeRace {
  name: string;
  status: { value: string; verbose_value: string };
  url: string;
  goal: { name: string };
  info: string;
  entrants_count: number;
  entrants_count_finished: number;
  opened_at: string;
  started_at: string | null;
  ended_at: string | null;
  entrants: RacetimeEntrant[];
}

export type OrchestratorState =
  | 'idle'
  | 'detected'
  | 'setup'
  | 'ready'
  | 'live'
  | 'monitoring'
  | 'finished';

export interface EntrantMatch {
  entrant: RacetimeEntrant;
  profileId: string | null;
  profileDisplayName: string | null;
  matchMethod: 'racetime_id' | 'twitch_channel' | 'manual' | 'auto_created' | null;
  twitchChannel: string | null;
  slot: number;
  hasCropProfile: boolean;
}

export interface ActiveRaceState {
  orchestratorState: OrchestratorState;
  raceSlug: string;
  raceUrl: string;
  racetimeStatus: string;
  goal: string;
  info: string;
  entrants: EntrantMatch[];
  layoutType: string;
  sceneName: string;
  startedAt: string | null;
  endedAt: string | null;
  clockOffsetMs: number;
  raceDbId: string | null;
}

export interface RaceSetupProposal {
  raceSlug: string;
  raceUrl: string;
  goal: string;
  entrants: EntrantMatch[];
  layoutType: string;
  sceneName: string;
  startedAt: string | null;
}

export interface RaceCurrentResponse {
  state: OrchestratorState;
  activeRace: ActiveRaceState | null;
}

export interface EntrantUpdatePayload {
  racerId: string;
  racetimeUserId: string;
  displayName: string;
  status: 'racing' | 'finished' | 'forfeit' | 'dq';
  finishTime: string | null;
  finishPlace: number | null;
  placeOrdinal: string | null;
  slot: number;
}

export interface TimerPayload {
  startedAt: string;
  clockOffsetMs: number;
}

export interface AutoModeConfig {
  enabled: boolean;
  delayAfterDetectionMs: number;
  delayAfterSetupMs: number;
  delayAfterConfirmMs: number;
  delayAfterFinishMs: number;
  requireAllProfilesMatched: boolean;
}
