export interface RawPixelState {
  racerId: string;
  timestamp: number;
  frameNumber: number;
  // Pass 1: HUD tile NCC scores [tileIdx * MAX_TEMPLATES + templateIdx]
  hudScores: number[];
  // Pass 2: room correlation scores [0..127]
  roomScores: number[];
  // Pass 3: floor item hits [{ templateIdx, score, x, y }]
  floorItems: Array<{ templateIdx: number; score: number; x: number; y: number }>;
  // Pass 4: aggregates
  gameBrightness: number;
  redRatioAtLife: number;
  goldPixelCount: number;
}

export interface CalibrationUniform {
  cropX: number;
  cropY: number;
  scaleX: number;  // cropW / 256
  scaleY: number;  // cropH / 240
  gridDx: number;
  gridDy: number;
  videoWidth: number;
  videoHeight: number;
}

export interface RawGameState {
  screenType: 'overworld' | 'dungeon' | 'cave' | 'subscreen' | 'death' | 'title' | 'transition' | 'unknown';
  dungeonLevel: number;
  rupees: number;
  keys: number;
  bombs: number;
  heartsCurrentRaw: number;
  heartsMaxRaw: number;
  bItem: string | null;
  swordLevel: number;
  hasMasterKey: boolean;
  mapPosition: number;
  floorItems: Array<{ name: string; x: number; y: number; score: number }>;
  triforceCollected: number;  // count of gold pixel clusters
}

export type GameEventType =
  | 'death' | 'up_a_warp' | 'triforce_inferred' | 'game_complete'
  | 'heart_container' | 'ganon_fight' | 'ganon_kill'
  | 'dungeon_first_visit' | 'sword_upgrade' | 'b_item_change'
  | 'subscreen_open' | 'item_drop' | 'item_pickup';

export interface GameEvent {
  type: GameEventType;
  racerId: string;
  timestamp: number;
  frameNumber: number;
  priority: 'high' | 'medium' | 'low';
  description: string;
  data?: Record<string, unknown>;
}

export interface PendingFieldInfo {
  field: string;
  stableValue: unknown;
  pendingValue: unknown;
  count: number;
  threshold: number;
}

export type RacerRole = 'monitored' | 'featured';

export interface RacerConfig {
  racerId: string;
  streamUrl: string;        // HLS .m3u8 URL
  calibration: CalibrationUniform;
  role: RacerRole;
}
