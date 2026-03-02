import { VisionWorkerManager } from './VisionWorkerManager.js';
import { PixelInterpreter } from './PixelInterpreter.js';
import { StateStabilizer } from './StateStabilizer.js';
import { EventInferencer } from './EventInferencer.js';
import { PlayerItemTracker } from './PlayerItemTracker.js';
import { RaceItemTracker } from './RaceItemTracker.js';
import { FloorItemTracker } from './FloorItemTracker.js';
import { MinimapReader } from './MinimapReader.js';
import { TriforceTracker } from './TriforceTracker.js';
import { WarpDeathTracker } from './WarpDeathTracker.js';
import type { RawPixelState, RawGameState, GameEvent, PendingFieldInfo, WebGPUStateUpdate } from './types.js';

interface RacerPipeline {
  interpreter: PixelInterpreter;
  stabilizer: StateStabilizer;
  inferencer: EventInferencer;
  playerItems: PlayerItemTracker;
  raceItems: RaceItemTracker;
  floorItems: FloorItemTracker;
  minimap: MinimapReader;
  triforce: TriforceTracker;
  warpDeath: WarpDeathTracker;
  isZ1R: boolean;
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

  addRacer(racerId: string, isZ1R = true): void {
    this.pipelines.set(racerId, {
      interpreter: new PixelInterpreter(),
      stabilizer: new StateStabilizer(),
      inferencer: new EventInferencer(racerId),
      playerItems: new PlayerItemTracker(),
      raceItems: new RaceItemTracker(),
      floorItems: new FloorItemTracker(),
      minimap: new MinimapReader(),
      triforce: new TriforceTracker(racerId),
      warpDeath: new WarpDeathTracker(racerId),
      isZ1R,
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

    // Z1R SWAP: all subscreens are SWAP subscreens
    if (rawState.screenType === 'subscreen' && pipeline.isZ1R) {
      rawState.screenType = 'subscreen_swap';
    }

    const stableState = pipeline.stabilizer.update(rawState);
    const events = pipeline.inferencer.update(stableState, raw.timestamp, raw.frameNumber);

    // Triforce tracking (gold flash + dungeon exit)
    pipeline.triforce.feedGoldPixels(raw.goldPixelCount);
    pipeline.triforce.update(stableState, raw.timestamp, raw.frameNumber, events);

    // Warp/death tracking
    pipeline.warpDeath.update(stableState, raw.timestamp, raw.frameNumber, events,
      pipeline.triforce.isGameCompleted);

    // Register dungeon entrance positions for warp detection
    if (stableState.screenType === 'dungeon' && stableState.dungeonLevel > 0) {
      pipeline.warpDeath.registerDungeonEntrance(stableState.dungeonLevel, stableState.mapPosition);
    }

    // Floor item drop/pickup events
    if (stableState.mapPosition !== pipeline.prevMapPosition
        || stableState.dungeonLevel !== pipeline.prevDungeonLevel) {
      pipeline.floorItems.onRoomChange();
    }
    const floorResult = pipeline.floorItems.update(rawState.floorItems);
    for (const item of floorResult.newlyConfirmed) {
      events.push({
        type: 'item_drop', racerId: raw.racerId, timestamp: raw.timestamp,
        frameNumber: raw.frameNumber, priority: 'low',
        description: `Floor item: ${item.name}`, data: { name: item.name, x: item.x, y: item.y },
      });
    }
    for (const item of floorResult.obtained) {
      events.push({
        type: 'item_pickup', racerId: raw.racerId, timestamp: raw.timestamp,
        frameNumber: raw.frameNumber, priority: 'low',
        description: `Picked up ${item.name}`, data: { name: item.name, x: item.x, y: item.y },
      });
    }

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

    // Update sword level from stable state
    pipeline.playerItems.updateSwordLevel(stableState.swordLevel);

    // Cache stable state for REST endpoint
    this.manager.cacheState(raw.racerId, stableState);

    this.onStateUpdateCallback?.({
      racerId: raw.racerId,
      raw: rawState,
      stable: stableState,
      pending: pipeline.stabilizer.getPendingFields(),
      timestamp: raw.timestamp,
      frameCount: raw.frameNumber,
      items: pipeline.playerItems.getItems(),
      swordLevel: pipeline.playerItems.sword_level,
      arrowsLevel: pipeline.playerItems.arrows_level,
      triforcePieces: pipeline.triforce.triforceState,
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
