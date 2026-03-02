import type { VisionWorkerManager } from './VisionWorkerManager.js';
import type { VisionPipelineController } from './VisionPipelineController.js';
import type { GameEvent, StableGameState, CalibrationUniform } from './types.js';

export interface AnalyzerStartOptions {
  racerId: string;
  vodUrl: string;
  playbackRate?: number;
  startOffset?: number;
  calibration?: CalibrationUniform;
  landmarks?: Array<{label:string;x:number;y:number;w:number;h:number}>;
}

export interface AnalyzerResult {
  racerId: string;
  vodUrl: string;
  duration: number;
  playbackRate: number;
  events: GameEvent[];
  stateSnapshots: Array<{
    vodTime: number;
    state: StableGameState;
    items: Record<string, boolean>;
  }>;
  summary: {
    deaths: number;
    triforceCount: number;
    dungeonsVisited: number[];
    gameComplete: boolean;
    totalFrames: number;
    frameSnapshotCount: number;
  };
}

type SessionState = 'idle' | 'running' | 'completed';

export class RaceAnalyzerSession {
  private state: SessionState = 'idle';
  private internalRacerId = '';
  private vodUrl = '';
  private playbackRate = 2;
  private events: GameEvent[] = [];
  private stateSnapshots: Array<{ vodTime: number; state: StableGameState; items: Record<string, boolean> }> = [];
  private frameSnapshots: Array<{ vodTime: number; jpeg: Buffer }> = [];
  private currentVodTime = 0;
  private lastSnapshotTime = -1;
  private lastFrameSnapshotTime = -Infinity;
  private frameCount = 0;
  private dungeonsVisited = new Set<number>();
  private result: AnalyzerResult | null = null;
  private onProgressCallback: ((progress: { racerId: string; vodTime: number; frameCount: number; eventsFound: number }) => void) | null = null;
  private onCompleteCallback: ((result: AnalyzerResult) => void) | null = null;

  constructor(
    private manager: VisionWorkerManager,
    private controller: VisionPipelineController,
  ) {}

  onProgress(cb: (progress: { racerId: string; vodTime: number; frameCount: number; eventsFound: number }) => void): void {
    this.onProgressCallback = cb;
  }

  onComplete(cb: (result: AnalyzerResult) => void): void {
    this.onCompleteCallback = cb;
  }

  async start(options: AnalyzerStartOptions): Promise<void> {
    if (this.state === 'running') throw new Error('Session already running');

    this.internalRacerId = `analyzer-${options.racerId}`;
    this.vodUrl = options.vodUrl;
    this.playbackRate = options.playbackRate ?? 2;
    this.events = [];
    this.stateSnapshots = [];
    this.frameSnapshots = [];
    this.currentVodTime = 0;
    this.lastSnapshotTime = -1;
    this.lastFrameSnapshotTime = -Infinity;
    this.frameCount = 0;
    this.dungeonsVisited.clear();
    this.result = null;
    this.state = 'running';

    await this.manager.addRacer({
      racerId: this.internalRacerId,
      streamUrl: options.vodUrl,
      calibration: options.calibration ?? {} as any,
      role: 'monitored',
      startOffset: options.startOffset,
      landmarks: options.landmarks,
    });
    this.controller.addRacer(this.internalRacerId);
    this.manager.startDebugStream(this.internalRacerId);

    // Set playback rate after a short delay to let the tab load
    setTimeout(() => {
      this.manager.setPlaybackRate(this.internalRacerId, this.playbackRate);
    }, 3000);
  }

  feedEvents(events: GameEvent[]): void {
    if (this.state !== 'running') return;
    this.events.push(...events);
    for (const e of events) {
      if (e.type === 'dungeon_first_visit' && e.data?.dungeon_level) {
        this.dungeonsVisited.add(e.data.dungeon_level as number);
      }
    }
  }

  feedState(stable: StableGameState, items: Record<string, boolean>, vodTime: number): void {
    if (this.state !== 'running') return;
    this.frameCount++;
    this.currentVodTime = vodTime;

    // Track dungeons from stable state
    if (stable.dungeonLevel > 0) {
      this.dungeonsVisited.add(stable.dungeonLevel);
    }

    // Snapshot every ~1 second of VOD time
    if (vodTime - this.lastSnapshotTime >= 1.0) {
      this.stateSnapshots.push({ vodTime, state: { ...stable }, items: { ...items } });
      this.lastSnapshotTime = vodTime;
    }

    // Emit progress every 60 frames
    if (this.frameCount % 60 === 0) {
      this.onProgressCallback?.({
        racerId: this.internalRacerId,
        vodTime,
        frameCount: this.frameCount,
        eventsFound: this.events.length,
      });
    }
  }

  feedFrame(jpeg: string): void {
    if (this.state !== 'running') return;
    // Store a frame snapshot every 5 seconds of VOD time
    if (this.currentVodTime - this.lastFrameSnapshotTime >= 5.0) {
      this.frameSnapshots.push({ vodTime: this.currentVodTime, jpeg: Buffer.from(jpeg, 'base64') });
      this.lastFrameSnapshotTime = this.currentVodTime;
    }
  }

  getFrameSnapshot(index: number): Buffer | null {
    return this.frameSnapshots[index]?.jpeg ?? null;
  }

  getFrameTimes(): number[] {
    return this.frameSnapshots.map(f => f.vodTime);
  }

  async stop(): Promise<AnalyzerResult | null> {
    if (this.state !== 'running') return this.result;
    return this._finalize();
  }

  async handleVodEnded(): Promise<void> {
    if (this.state !== 'running') return;
    await this._finalize();
  }

  private async _finalize(): Promise<AnalyzerResult> {
    this.manager.stopDebugStream(this.internalRacerId);
    this.controller.removeRacer(this.internalRacerId);
    await this.manager.removeRacer(this.internalRacerId);

    const lastSnapshot = this.stateSnapshots[this.stateSnapshots.length - 1];
    this.result = {
      racerId: this.internalRacerId.replace('analyzer-', ''),
      vodUrl: this.vodUrl,
      duration: lastSnapshot?.vodTime ?? 0,
      playbackRate: this.playbackRate,
      events: this.events,
      stateSnapshots: this.stateSnapshots,
      summary: {
        deaths: this.events.filter(e => e.type === 'death').length,
        triforceCount: lastSnapshot?.state.triforceCollected ?? 0,
        dungeonsVisited: [...this.dungeonsVisited].sort((a, b) => a - b),
        gameComplete: this.events.some(e => e.type === 'game_complete'),
        totalFrames: this.frameCount,
        frameSnapshotCount: this.frameSnapshots.length,
      },
    };

    this.state = 'completed';
    this.onCompleteCallback?.(this.result);
    return this.result;
  }

  getStatus(): { state: SessionState; eventsFound: number; frameCount: number; vodTime: number; frameSnapshotCount: number } {
    const lastSnapshot = this.stateSnapshots[this.stateSnapshots.length - 1];
    return {
      state: this.state,
      eventsFound: this.events.length,
      frameCount: this.frameCount,
      vodTime: lastSnapshot?.vodTime ?? 0,
      frameSnapshotCount: this.frameSnapshots.length,
    };
  }

  getResult(): AnalyzerResult | null {
    return this.result;
  }

  getInternalRacerId(): string {
    return this.internalRacerId;
  }
}
