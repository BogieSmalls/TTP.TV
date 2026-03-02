import { VisionWorkerManager } from './VisionWorkerManager.js';
import { PixelInterpreter } from './PixelInterpreter.js';
import { StateStabilizer } from './StateStabilizer.js';
import { EventInferencer } from './EventInferencer.js';
import { PlayerItemTracker } from './PlayerItemTracker.js';
import { RaceItemTracker } from './RaceItemTracker.js';
import { FloorItemTracker } from './FloorItemTracker.js';
import { MinimapReader } from './MinimapReader.js';
import type { RawPixelState, RawGameState, GameEvent, PendingFieldInfo, WebGPUStateUpdate } from './types.js';

interface RacerPipeline {
  interpreter: PixelInterpreter;
  stabilizer: StateStabilizer;
  inferencer: EventInferencer;
  playerItems: PlayerItemTracker;
  raceItems: RaceItemTracker;
  floorItems: FloorItemTracker;
  minimap: MinimapReader;
  prevMapPosition: number;
  prevDungeonLevel: number;
}

export class VisionPipelineController {
  private pipelines = new Map<string, RacerPipeline>();
  private onEventsCallback: ((racerId: string, events: GameEvent[]) => void) | null = null;
  private onStateUpdateCallback: ((update: WebGPUStateUpdate) => void) | null = null;

  constructor(private manager: VisionWorkerManager) {
    manager.onRawState((raw) => this._processRaw(raw));
  }

  onGameEvents(cb: (racerId: string, events: GameEvent[]) => void): void {
    this.onEventsCallback = cb;
  }

  onStateUpdate(cb: (update: WebGPUStateUpdate) => void): void {
    this.onStateUpdateCallback = cb;
  }

  addRacer(racerId: string): void {
    this.pipelines.set(racerId, {
      interpreter: new PixelInterpreter(),
      stabilizer: new StateStabilizer(),
      inferencer: new EventInferencer(racerId),
      playerItems: new PlayerItemTracker(),
      raceItems: new RaceItemTracker(),
      floorItems: new FloorItemTracker(),
      minimap: new MinimapReader(),
      prevMapPosition: -1,
      prevDungeonLevel: 0,
    });
  }

  removeRacer(racerId: string): void {
    this.pipelines.delete(racerId);
  }

  private _processRaw(raw: RawPixelState): void {
    const pipeline = this.pipelines.get(raw.racerId);
    if (!pipeline) {
      console.warn(`[VisionPipeline] No pipeline for racer "${raw.racerId}" (known: ${[...this.pipelines.keys()].join(',')})`);
      return;
    }

    const rawState = pipeline.interpreter.interpret(raw);
    const stableState = pipeline.stabilizer.update(rawState);
    const events = pipeline.inferencer.update(stableState, raw.timestamp, raw.frameNumber);

    // Update player item tracker on b_item changes
    for (const event of events) {
      if (event.type === 'b_item_change') {
        pipeline.playerItems.updateFromBItem(stableState.bItem);
      }
    }

    // Detect dungeon room transitions and trigger viewport capture (first visit only)
    if (stableState.dungeonLevel > 0
        && stableState.mapPosition >= 0
        && (stableState.mapPosition !== pipeline.prevMapPosition
            || stableState.dungeonLevel !== pipeline.prevDungeonLevel)
        && !this.manager.hasRoomSnapshot(raw.racerId, stableState.dungeonLevel, stableState.mapPosition)) {
      this.manager.sendToTab(raw.racerId, {
        type: 'captureViewport',
        dungeonLevel: stableState.dungeonLevel,
        mapPosition: stableState.mapPosition,
      });
    }
    pipeline.prevMapPosition = stableState.mapPosition;
    pipeline.prevDungeonLevel = stableState.dungeonLevel;

    // Cache stable state for REST endpoint
    this.manager.cacheState(raw.racerId, stableState);

    this.onStateUpdateCallback?.({
      racerId: raw.racerId,
      raw: rawState,
      stable: stableState,
      pending: pipeline.stabilizer.getPendingFields(),
      timestamp: raw.timestamp,
      frameCount: raw.frameNumber,
      diag: {
        brightness: raw.gameBrightness,
        redAtLife: raw.redRatioAtLife,
        goldPixels: raw.goldPixelCount,
      },
    });

    if (events.length > 0) {
      this.onEventsCallback?.(raw.racerId, events);
    }
  }
}
