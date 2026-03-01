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
  // Per-tile average RGB for color disambiguation (indexed by tile def order)
  tileColors?: Array<{ r: number; g: number; b: number }>;
  // Heart tile color composition (16 tiles: 8 per row × 2 rows)
  // colorRatio = fraction of colored (non-black, non-white) pixels — heart fill
  // whiteRatio = fraction of white/near-white pixels — heart outline
  heartTiles?: Array<{ colorRatio: number; whiteRatio: number; brightness: number }>;
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

export interface StableGameState {
  screenType: string;
  dungeonLevel: number;
  rupees: number;
  keys: number;
  bombs: number;
  heartsCurrentStable: number;
  heartsMaxStable: number;
  bItem: string | null;
  swordLevel: number;
  hasMasterKey: boolean;
  mapPosition: number;
  floorItems: Array<{ name: string; x: number; y: number; score: number }>;
  triforceCollected: number;
}

export interface PendingFieldInfo {
  field: string;
  stableValue: unknown;
  pendingValue: unknown;
  count: number;
  threshold: number;
}

export interface WebGPUStateUpdate {
  racerId: string;
  raw: RawGameState;
  stable: StableGameState;
  pending: PendingFieldInfo[];
  timestamp: number;    // server-side ms epoch when frame was processed
  frameCount: number;   // cumulative frame count from the tab
  // Raw aggregate values for diagnostics
  diag?: { brightness: number; redAtLife: number; goldPixels: number };
}

export type RacerRole = 'monitored' | 'featured';

export interface LandmarkPosition {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RacerConfig {
  racerId: string;
  streamUrl: string;        // HLS .m3u8 URL
  calibration: CalibrationUniform;
  role: RacerRole;
  startOffset?: number;     // seconds — seek to this time after video loads (VOD use)
  landmarks?: LandmarkPosition[];
}
