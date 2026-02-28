import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

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
  detector_stats: Record<string, unknown>;
  anomalies: { frame: number; timestamp: number; detector: string; description: string; severity: string }[];
  flicker_events: { timestamp: number; sequence: string; duration: number }[];
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
    event: 'death' | 'up_a_warp' | 'triforce_inferred' | 'game_complete' | 'heart_container' | 'ganon_fight' | 'ganon_kill';
    description: string;
    dungeon_level: number;
  }>;
  triforce_inferred?: boolean[];
}

export type LearnAnnotationType =
  | 'correction' | 'note' | 'bookmark' | 'error'
  | 'item_pickup' | 'item_obtained' | 'item_seen_missed'
  | 'dungeon_enter' | 'dungeon_exit'
  | 'location' | 'strategy' | 'door_repair' | 'death' | 'game_event';

export interface LearnAnnotation {
  id: string;
  timestamp: Date;
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

export interface LearnSession {
  id: string;
  source: string;
  profileId?: string;
  status: 'starting' | 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: Date;
  completedAt?: Date;
  lastProgressAt?: Date;
  progress: LearnProgress;
  cropResult?: CropResult;
  report?: LearnReport;
  error?: string;
  annotations: LearnAnnotation[];
  metadata?: SessionMetadata;
}

const MAX_CONCURRENT_SESSIONS = 2;

/**
 * Manages learn mode sessions — spawns Python learn_mode.py processes,
 * tracks progress, and stores results.
 */
export class LearnSessionManager extends EventEmitter {
  private sessions = new Map<string, LearnSession>();
  private processes = new Map<string, ChildProcess>();
  private watchdogTimer?: ReturnType<typeof setInterval>;

  constructor(private config: Config) {
    super();
    // Prevent unhandled 'error' events from crashing the process
    this.on('error', (evt: { sessionId: string; error: string }) => {
      logger.error(`[learn] Session ${evt.sessionId} error: ${evt.error}`);
    });

    // Watchdog: kill sessions with no progress for 5 minutes
    this.watchdogTimer = setInterval(() => this.checkStaleSessions(), 60_000);
  }

  private checkStaleSeconds = 300; // 5 minutes

  private checkStaleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status !== 'running' && session.status !== 'starting') continue;
      const lastActivity = session.lastProgressAt ?? session.startedAt;
      const staleSec = (now - lastActivity.getTime()) / 1000;
      if (staleSec > this.checkStaleSeconds) {
        logger.warn(`[learn:${id}] Session stale (no progress for ${Math.round(staleSec)}s), killing`);
        session.status = 'error';
        session.error = `Session stalled — no progress for ${Math.round(staleSec / 60)} minutes`;
        session.completedAt = new Date();
        const proc = this.processes.get(id);
        if (proc && !proc.killed) {
          proc.kill('SIGTERM');
        }
        this.processes.delete(id);
        this.emit('error', { sessionId: id, error: session.error });
      }
    }
  }

  async startSession(opts: {
    source: string;
    profileId?: string;
    cropRegion?: { x: number; y: number; w: number; h: number };
    fps?: number;
    startTime?: string;
    endTime?: string;
    snapshotInterval?: number;
    maxSnapshots?: number;
    anyRoads?: string;  // comma-separated room positions, e.g. "14,18,74,100"
  }): Promise<string> {
    // Check concurrent session limit
    const running = Array.from(this.sessions.values()).filter(
      (s) => s.status === 'starting' || s.status === 'running',
    );
    if (running.length >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Max concurrent learn sessions reached (${MAX_CONCURRENT_SESSIONS})`);
    }

    const id = randomUUID().slice(0, 8);
    const session: LearnSession = {
      id,
      source: opts.source,
      profileId: opts.profileId,
      status: 'starting',
      startedAt: new Date(),
      progress: { framesProcessed: 0, totalEstimated: 0, percentComplete: 0 },
      annotations: [],
    };

    this.sessions.set(id, session);

    try {
      // Python vision pipeline disabled — WebGPU pipeline active
      console.warn('Python vision pipeline disabled — WebGPU pipeline active');
      logger.warn(`[learn:${id}] Python vision pipeline disabled — WebGPU pipeline active. learn_mode.py will not be spawned.`);
      session.status = 'error';
      session.error = 'Python vision pipeline disabled — WebGPU pipeline active';
      this.emit('error', { sessionId: id, error: session.error });
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      throw err;
    }

    return id;
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Cancel if still running
    if (session.status === 'running' || session.status === 'starting') {
      this.cancelSession(sessionId);
    }

    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    logger.info(`[learn:${sessionId}] Session deleted`);
    return true;
  }

  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const proc = this.processes.get(sessionId);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }

    session.status = 'cancelled';
    session.completedAt = new Date();
    this.processes.delete(sessionId);
    logger.info(`[learn:${sessionId}] Session cancelled`);
  }

  updateProgress(sessionId: string, progress: LearnProgress): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.progress = progress;
    session.lastProgressAt = new Date();
    if (progress.cropResult) {
      session.cropResult = progress.cropResult;
    }
  }

  completeSession(sessionId: string, report: LearnReport): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'completed';
    session.completedAt = new Date();
    session.report = report;
    if (report.crop) {
      session.cropResult = report.crop as unknown as CropResult;
    }
    logger.info(`[learn:${sessionId}] Session completed: ${report.total_frames} frames`);
  }

  getSession(sessionId: string): LearnSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getAllSessions(): LearnSession[] {
    return Array.from(this.sessions.values());
  }

  addAnnotation(sessionId: string, annotation: Omit<LearnAnnotation, 'id' | 'timestamp'>): LearnAnnotation | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const entry: LearnAnnotation = {
      id: randomUUID().slice(0, 8),
      timestamp: new Date(),
      ...annotation,
    };
    session.annotations.push(entry);
    logger.info(`[learn:${sessionId}] Annotation added: ${annotation.type} — ${annotation.note}`);
    return entry;
  }

  getAnnotations(sessionId: string): LearnAnnotation[] {
    return this.sessions.get(sessionId)?.annotations ?? [];
  }

  deleteAnnotation(sessionId: string, annotationId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const idx = session.annotations.findIndex(a => a.id === annotationId);
    if (idx === -1) return false;

    session.annotations.splice(idx, 1);
    return true;
  }

  updateAnnotation(sessionId: string, annotationId: string, updates: Partial<Omit<LearnAnnotation, 'id' | 'timestamp'>>): LearnAnnotation | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const annotation = session.annotations.find(a => a.id === annotationId);
    if (!annotation) return null;

    Object.assign(annotation, updates);
    logger.info(`[learn:${sessionId}] Annotation updated: ${annotationId}`);
    return annotation;
  }

  updateMetadata(sessionId: string, metadata: Partial<SessionMetadata>): SessionMetadata | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.metadata = { ...session.metadata, ...metadata };
    logger.info(`[learn:${sessionId}] Metadata updated`);
    return session.metadata;
  }
}
