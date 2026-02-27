import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

interface ExcitementEvent {
  racerId: string;
  score: number;
  reason: string;
  timestamp: number;
}

const EVENT_SCORES: Record<string, number> = {
  ganon_fight: 100,
  ganon_kill: 100,
  game_complete: 100,
  triforce: 60,        // pieces 1-5
  triforce_late: 90,   // pieces 6-8
  death: 40,
  dungeon_entry: 20,
  sword_upgrade: 30,
  staircase_item_acquired: 25,
  silver_arrows: 95,
};

const MIN_DWELL_MS = 15_000; // Minimum 15s on one racer before switching
const EXCITEMENT_DECAY_MS = 30_000; // Events older than 30s don't count
const FEATURE_THRESHOLD = 50; // Minimum excitement to trigger feature

export class AutoFeatureEngine extends EventEmitter {
  private enabled = false;
  private events: ExcitementEvent[] = [];
  private currentFeatured: string | null = null;
  private lastSwitchTime = 0;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.checkInterval = setInterval(() => this.evaluate(), 3000);
    logger.info('[AutoFeature] Enabled');
  }

  disable(): void {
    this.enabled = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.currentFeatured = null;
    logger.info('[AutoFeature] Disabled');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getCurrentFeatured(): string | null {
    return this.currentFeatured;
  }

  /** Called when a game event occurs. Tracks excitement per racer. */
  onGameEvent(racerId: string, eventType: string, triforceCount?: number): void {
    if (!this.enabled) return;

    let score = EVENT_SCORES[eventType] ?? 0;
    if (score === 0) return;

    // Boost late triforce
    if (eventType === 'triforce' && triforceCount && triforceCount >= 6) {
      score = EVENT_SCORES['triforce_late'];
    }

    this.events.push({ racerId, score, reason: eventType, timestamp: Date.now() });
  }

  /** Periodic evaluation: who's most exciting right now? */
  private evaluate(): void {
    if (!this.enabled) return;

    // Prune old events
    const cutoff = Date.now() - EXCITEMENT_DECAY_MS;
    this.events = this.events.filter(e => e.timestamp > cutoff);

    // Score per racer
    const scores = new Map<string, number>();
    for (const e of this.events) {
      scores.set(e.racerId, (scores.get(e.racerId) ?? 0) + e.score);
    }

    // Find highest scorer
    let bestRacer: string | null = null;
    let bestScore = 0;
    for (const [racerId, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestRacer = racerId;
      }
    }

    // Check thresholds
    if (bestScore < FEATURE_THRESHOLD) {
      // Return to equal layout if currently featuring someone
      if (this.currentFeatured !== null) {
        this.currentFeatured = null;
        this.emit('layoutChange', { layout: 'equal', featuredRacer: null });
        logger.info('[AutoFeature] Returning to equal layout');
      }
      return;
    }

    // Check dwell time
    if (bestRacer !== this.currentFeatured && (Date.now() - this.lastSwitchTime) < MIN_DWELL_MS) {
      return; // Too soon to switch
    }

    // Switch to featured racer
    if (bestRacer !== this.currentFeatured) {
      this.currentFeatured = bestRacer;
      this.lastSwitchTime = Date.now();
      this.emit('layoutChange', { layout: 'featured', featuredRacer: bestRacer });
      logger.info(`[AutoFeature] Featuring ${bestRacer} (score: ${bestScore})`);
    }
  }

  clear(): void {
    this.events = [];
    this.currentFeatured = null;
  }
}
