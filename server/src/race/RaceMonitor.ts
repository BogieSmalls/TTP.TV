import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type { Config } from '../config.js';
import { RacetimeApi, RateLimitError } from './RacetimeApi.js';
import type {
  RacetimeRace,
  RacetimeEntrant,
  RacetimeWsMessage,
} from './types.js';
import { sanitizeRace, sanitizeEntrant } from './types.js';

interface TrackedRace {
  ws: WebSocket | null;
  lastStatus: string;
  lastEntrantStates: Map<string, string>;
  race: RacetimeRace;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  pingTimer: ReturnType<typeof setInterval> | null;
}

export class RaceMonitor extends EventEmitter {
  private api: RacetimeApi;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trackedRaces = new Map<string, TrackedRace>();
  private seenSlugs = new Set<string>();
  private pollIntervalMs: number;
  private config: Config;

  constructor(config: Config) {
    super();
    this.config = config;
    this.api = new RacetimeApi(config);
    this.pollIntervalMs = config.racetime.pollIntervalMs;
  }

  get racetimeApi(): RacetimeApi {
    return this.api;
  }

  start(): void {
    logger.info(`RaceMonitor started — polling every ${this.pollIntervalMs / 1000}s, category: ${this.config.racetime.category}`);
    // Poll immediately, then on interval
    this.poll().catch((err) => {
      logger.warn('Initial race poll failed', { error: err instanceof Error ? err.message : String(err) });
    });
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        logger.warn('Race poll failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const slug of this.trackedRaces.keys()) {
      this.closeWebSocket(slug);
    }
    this.trackedRaces.clear();
    logger.info('RaceMonitor stopped');
  }

  getTrackedRaces(): RacetimeRace[] {
    return Array.from(this.trackedRaces.values()).map((t) => t.race);
  }

  private async poll(): Promise<void> {
    try {
      const data = await this.api.getCategoryData();
      // Detect ALL races in the z1r category (auto-mode gating is in the orchestrator)
      const ttpRaces = data.current_races;

      // Track new races
      for (const race of ttpRaces) {
        if (!this.seenSlugs.has(race.name)) {
          this.seenSlugs.add(race.name);
          await this.onNewRace(race);
        } else {
          // Update stored race data from poll (lightweight, no entrant details)
          const tracked = this.trackedRaces.get(race.name);
          if (tracked) {
            tracked.race = { ...tracked.race, ...race, entrants: tracked.race.entrants };
          }
        }
      }

      // Clean up races no longer in current_races
      const currentSlugs = new Set(ttpRaces.map((r) => r.name));
      for (const slug of this.trackedRaces.keys()) {
        if (!currentSlugs.has(slug)) {
          const tracked = this.trackedRaces.get(slug)!;
          const status = tracked.race.status.value;
          if (status === 'finished' || status === 'cancelled') {
            logger.info(`Race ${slug} no longer current (${status}), cleaning up`);
            this.closeWebSocket(slug);
            this.trackedRaces.delete(slug);
          }
        }
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        logger.warn('racetime.gg rate limited, will retry next poll');
      } else {
        throw err;
      }
    }
  }

  private async onNewRace(race: RacetimeRace): Promise<void> {
    // Fetch full detail to get entrants + websocket_url
    let detail: RacetimeRace;
    try {
      detail = await this.api.getRaceDetail(race.name);
    } catch (err) {
      logger.warn(`Failed to fetch race detail for ${race.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    logger.info(`TTP race detected: ${detail.name}`, {
      status: detail.status.value,
      goal: detail.goal.name,
      entrants: detail.entrants.map((e) => e.user.name),
    });

    const tracked: TrackedRace = {
      ws: null,
      lastStatus: detail.status.value,
      lastEntrantStates: new Map(
        detail.entrants.map((e) => [e.user.id, e.status.value]),
      ),
      race: detail,
      reconnectTimer: null,
      reconnectAttempts: 0,
      pingTimer: null,
    };
    this.trackedRaces.set(detail.name, tracked);

    this.emit('raceDetected', detail);

    // Open WebSocket for live updates
    if (detail.status.value !== 'finished' && detail.status.value !== 'cancelled') {
      this.openWebSocket(detail.name, detail.websocket_url);
    }
  }

  private openWebSocket(slug: string, wsUrl: string): void {
    const tracked = this.trackedRaces.get(slug);
    if (!tracked) return;

    // Close existing if any
    if (tracked.ws) {
      try { tracked.ws.close(); } catch { /* ignore */ }
    }

    // racetime.gg returns relative WebSocket URLs — prepend the host
    const fullWsUrl = wsUrl.startsWith('wss://') || wsUrl.startsWith('ws://')
      ? wsUrl
      : `wss://racetime.gg${wsUrl}`;

    logger.info(`Opening WebSocket for race ${slug}: ${fullWsUrl}`);

    try {
      const ws = new WebSocket(fullWsUrl);
      tracked.ws = ws;

      ws.addEventListener('open', () => {
        logger.info(`WebSocket connected for race ${slug}`);
        tracked.reconnectAttempts = 0;

        // Send periodic pings
        tracked.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
          }
        }, 30000);
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as RacetimeWsMessage;
          this.handleWsMessage(slug, msg);
        } catch (err) {
          logger.debug(`Failed to parse WebSocket message for ${slug}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      ws.addEventListener('close', () => {
        if (tracked.pingTimer) {
          clearInterval(tracked.pingTimer);
          tracked.pingTimer = null;
        }
        tracked.ws = null;

        const race = tracked.race;
        if (race.status.value === 'finished' || race.status.value === 'cancelled') {
          logger.info(`WebSocket closed for finished race ${slug}`);
          return;
        }

        // Reconnect with backoff
        const delay = Math.min(2000 * Math.pow(2, tracked.reconnectAttempts), 30000);
        tracked.reconnectAttempts++;
        logger.warn(`WebSocket closed for ${slug}, reconnecting in ${delay}ms (attempt ${tracked.reconnectAttempts})`);

        tracked.reconnectTimer = setTimeout(() => {
          if (this.trackedRaces.has(slug)) {
            this.openWebSocket(slug, race.websocket_url);
          }
        }, delay);
      });

      ws.addEventListener('error', (err) => {
        logger.warn(`WebSocket error for ${slug}`, {
          error: String(err),
        });
      });
    } catch (err) {
      logger.error(`Failed to create WebSocket for ${slug}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleWsMessage(slug: string, msg: RacetimeWsMessage): void {
    const tracked = this.trackedRaces.get(slug);
    if (!tracked) return;

    if (msg.type === 'pong') return;

    if (msg.type === 'race.data') {
      const race = sanitizeRace(msg.race);
      const prevStatus = tracked.lastStatus;
      const newStatus = race.status.value;

      // Update stored race data
      tracked.race = race;
      tracked.lastStatus = newStatus;

      // Emit general update
      this.emit('raceUpdate', race);

      // Check for status transitions
      if (prevStatus !== newStatus) {
        logger.info(`Race ${slug} status: ${prevStatus} → ${newStatus}`);

        if (newStatus === 'in_progress' && prevStatus !== 'in_progress') {
          this.emit('raceStarted', race);
        }

        if (newStatus === 'finished' || newStatus === 'cancelled') {
          this.emit('raceFinished', race);
        }
      }

      // Check for individual entrant changes
      for (const entrant of race.entrants) {
        const prevEntrantStatus = tracked.lastEntrantStates.get(entrant.user.id);
        const newEntrantStatus = entrant.status.value;

        if (prevEntrantStatus !== newEntrantStatus) {
          logger.info(`Race ${slug} entrant ${entrant.user.name}: ${prevEntrantStatus ?? 'new'} → ${newEntrantStatus}`);
          tracked.lastEntrantStates.set(entrant.user.id, newEntrantStatus);
          this.emit('entrantUpdate', slug, sanitizeEntrant(entrant));
        }
      }
    }
  }

  private closeWebSocket(slug: string): void {
    const tracked = this.trackedRaces.get(slug);
    if (!tracked) return;

    if (tracked.pingTimer) {
      clearInterval(tracked.pingTimer);
      tracked.pingTimer = null;
    }
    if (tracked.reconnectTimer) {
      clearTimeout(tracked.reconnectTimer);
      tracked.reconnectTimer = null;
    }
    if (tracked.ws) {
      try { tracked.ws.close(); } catch { /* ignore */ }
      tracked.ws = null;
    }
  }
}
