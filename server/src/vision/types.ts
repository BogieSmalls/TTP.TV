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

export type RacerRole = 'monitored' | 'featured';

export interface RacerConfig {
  racerId: string;
  streamUrl: string;        // HLS .m3u8 URL
  calibration: CalibrationUniform;
  role: RacerRole;
}
