// ─── racetime.gg API Response Types ───

export interface RacetimeUser {
  id: string;
  full_name: string;       // "UserName#1234"
  name: string;             // "UserName"
  discriminator: string;    // "1234"
  url: string;
  flair: string;
  twitch_name: string | null;
  twitch_channel: string | null;
  can_moderate: boolean;
}

export interface RacetimeGoal {
  name: string;
  custom: boolean;
}

export interface RacetimeEntrantStatus {
  value: 'requested' | 'invited' | 'declined' | 'ready' | 'not_ready' | 'in_progress' | 'done' | 'dnf' | 'dq';
  verbose_value: string;
  help_text: string;
}

export interface RacetimeEntrant {
  user: RacetimeUser;
  status: RacetimeEntrantStatus;
  finish_time: string | null;    // ISO 8601 duration e.g. "PT1H23M45S"
  finished_at: string | null;    // ISO 8601 datetime
  place: number | null;
  place_ordinal: string | null;  // "1st", "2nd", etc.
  score: number | null;
  score_change: number | null;
  comment: string | null;
  has_comment: boolean;
  stream_live: boolean;
  stream_override: boolean;
}

export interface RacetimeRaceStatus {
  value: 'open' | 'invitational' | 'pending' | 'in_progress' | 'finished' | 'cancelled';
  verbose_value: string;
  help_text: string;
}

export interface RacetimeRace {
  name: string;              // slug like "z1r/artful-moon-9292"
  status: RacetimeRaceStatus;
  url: string;
  data_url: string;
  goal: RacetimeGoal;
  info: string;
  entrants_count: number;
  entrants_count_finished: number;
  entrants_count_inactive: number;
  opened_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancelled_at: string | null;
  unlisted: boolean;
  time_limit: string;
  streaming_required: boolean;
  auto_start: boolean;
  opened_by: RacetimeUser | null;
  monitors: RacetimeUser[];
  recordable: boolean;
  recorded: boolean;
  websocket_url: string;
  websocket_bot_url: string;
  websocket_oauth_url: string;
  entrants: RacetimeEntrant[];
}

export interface RacetimeCategoryData {
  name: string;
  short_name: string;
  slug: string;
  url: string;
  data_url: string;
  image: string;
  info: string;
  streaming_required: boolean;
  owners: RacetimeUser[];
  moderators: RacetimeUser[];
  goals: string[];
  current_races: RacetimeRace[];
}

// ─── racetime.gg Leaderboard Types ───

export interface RacetimeLeaderboardEntry {
  user: RacetimeUser;
  place: number;
  place_ordinal: string;
  score: number;
  best_time: string | null;
  times_raced: number;
}

export interface RacetimeLeaderboardData {
  leaderboards: Array<{
    goal: string;
    rankings: RacetimeLeaderboardEntry[];
  }>;
}

// ─── racetime.gg Past Races (paginated) ───

export interface RacetimePastRaceSummary {
  name: string;        // slug e.g. "z1r/hyper-bombupgrade-6370"
  url: string;
  status: { value: string; verbose_value: string };
  goal: RacetimeGoal;
  info: string;        // seed + flags text
  entrants_count: number;
  entrants_count_finished: number;
  entrants_count_inactive: number;
  opened_at: string;
  started_at: string | null;
  ended_at: string | null;
  recordable: boolean;
  recorded: boolean;
}

export interface RacetimePastRacesPage {
  count: number;       // total races across all pages
  num_pages: number;
  races: RacetimePastRaceSummary[];
}

// ─── racetime.gg WebSocket Message Types ───

export interface RacetimeWsRaceData {
  type: 'race.data';
  race: RacetimeRace;
}

export interface RacetimeWsChatMessage {
  type: 'chat.message';
  message: {
    id: string;
    user: RacetimeUser | null;
    bot: string | null;
    posted_at: string;
    message: string;
    message_plain: string;
    highlight: boolean;
    is_bot: boolean;
    is_system: boolean;
    is_monitor: boolean;
  };
}

export interface RacetimeWsPong {
  type: 'pong';
}

export type RacetimeWsMessage = RacetimeWsRaceData | RacetimeWsChatMessage | RacetimeWsPong;

// ─── Sanitizers (strip raw API objects to only typed fields) ───

export function sanitizeUser(raw: RacetimeUser): RacetimeUser {
  return {
    id: raw.id,
    full_name: raw.full_name,
    name: raw.name,
    discriminator: raw.discriminator,
    url: raw.url,
    flair: raw.flair,
    twitch_name: raw.twitch_name,
    twitch_channel: raw.twitch_channel,
    can_moderate: raw.can_moderate,
  };
}

export function sanitizeEntrant(raw: RacetimeEntrant): RacetimeEntrant {
  return {
    user: sanitizeUser(raw.user),
    status: { value: raw.status.value, verbose_value: raw.status.verbose_value, help_text: raw.status.help_text },
    finish_time: raw.finish_time,
    finished_at: raw.finished_at,
    place: raw.place,
    place_ordinal: raw.place_ordinal,
    score: raw.score,
    score_change: raw.score_change,
    comment: raw.comment,
    has_comment: raw.has_comment,
    stream_live: raw.stream_live,
    stream_override: raw.stream_override,
  };
}

export function sanitizeRace(raw: RacetimeRace): RacetimeRace {
  return {
    name: raw.name,
    status: { value: raw.status.value, verbose_value: raw.status.verbose_value, help_text: raw.status.help_text },
    url: raw.url,
    data_url: raw.data_url,
    goal: { name: raw.goal.name, custom: raw.goal.custom },
    info: raw.info,
    entrants_count: raw.entrants_count,
    entrants_count_finished: raw.entrants_count_finished,
    entrants_count_inactive: raw.entrants_count_inactive,
    opened_at: raw.opened_at,
    started_at: raw.started_at,
    ended_at: raw.ended_at,
    cancelled_at: raw.cancelled_at,
    unlisted: raw.unlisted,
    time_limit: raw.time_limit,
    streaming_required: raw.streaming_required,
    auto_start: raw.auto_start,
    opened_by: raw.opened_by ? sanitizeUser(raw.opened_by) : null,
    monitors: (raw.monitors ?? []).map(sanitizeUser),
    recordable: raw.recordable,
    recorded: raw.recorded,
    websocket_url: raw.websocket_url,
    websocket_bot_url: raw.websocket_bot_url,
    websocket_oauth_url: raw.websocket_oauth_url,
    entrants: (raw.entrants ?? []).map(sanitizeEntrant),
  };
}

// ─── Helpers ───

/**
 * Extract just the channel name from a Twitch URL or bare channel name.
 * "https://www.twitch.tv/customshield" → "customshield"
 * "customshield" → "customshield"
 */
export function extractTwitchChannel(urlOrName: string | null): string | null {
  if (!urlOrName) return null;
  try {
    const url = new URL(urlOrName);
    return url.pathname.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  } catch {
    return urlOrName.toLowerCase();
  }
}

// ─── Orchestrator State Machine ───

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

export interface RaceSetupProposal {
  raceSlug: string;
  raceUrl: string;
  goal: string;
  entrants: EntrantMatch[];
  layoutType: 'two_player' | 'three_player' | 'four_player';
  sceneName: string;
  startedAt: string | null;
}

export interface AutoModeConfig {
  enabled: boolean;
  delayAfterDetectionMs: number;
  delayAfterSetupMs: number;
  delayAfterConfirmMs: number;
  delayAfterFinishMs: number;
  requireAllProfilesMatched: boolean;
}

export interface ActiveRaceState {
  orchestratorState: OrchestratorState;
  raceSlug: string;
  raceUrl: string;
  racetimeStatus: RacetimeRaceStatus['value'];
  goal: string;
  info: string;
  entrants: EntrantMatch[];
  layoutType: 'two_player' | 'three_player' | 'four_player';
  sceneName: string;
  startedAt: string | null;
  endedAt: string | null;
  clockOffsetMs: number;
  raceDbId: string | null;
}
