import { CalibrationUniform } from './types.js';

// NES reference coordinates (canonical 256×240 frame)
const LIFE_NES_Y = 40;           // top of LIFE text in NES pixels (row 5 × 8px)
const B_ITEM_NES_X = 16 * 8;    // col 16 × 8px = 128 NES pixels
const A_ITEM_NES_X = 20 * 8;    // col 20 × 8px = 160 NES pixels
const NES_B_A_GAP = A_ITEM_NES_X - B_ITEM_NES_X; // 32 NES pixels
const GAMEPLAY_NES_Y = 64;       // HUD/gameplay boundary in NES pixels

interface CalibrationSources {
  lifeGlyphHeight: number;     // height of LIFE text glyph in stream pixels
  lifeTopY: number;            // y of top of LIFE glyph in stream pixels
  gameplayBoundaryY: number;   // y of first non-black gameplay row in stream pixels
  bItemLeftX: number;          // x of B-item left border in stream pixels
  aItemLeftX: number;          // x of A-item left border in stream pixels
  cropX: number;               // x offset of NES region in stream (0 for full-width)
  videoWidth: number;
  videoHeight: number;
}

export function computeCalibrationUniform(src: CalibrationSources): CalibrationUniform {
  // Scale from two independent measurements, averaged
  const scaleYFromGlyph = src.lifeGlyphHeight / 8;
  const scaleYFromBoundary = (src.gameplayBoundaryY - src.lifeTopY) / (GAMEPLAY_NES_Y - LIFE_NES_Y);
  const scaleY = (scaleYFromGlyph + scaleYFromBoundary) / 2;

  const bAGapPx = src.aItemLeftX - src.bItemLeftX;
  const scaleX = bAGapPx / NES_B_A_GAP;

  // cropY: where the NES frame's y=0 maps to in stream pixels
  const cropY = src.lifeTopY - LIFE_NES_Y * scaleY;

  return {
    cropX: src.cropX,
    cropY,
    scaleX,
    scaleY,
    gridDx: 0,  // refined by grid search in the browser tab
    gridDy: 0,
    videoWidth: src.videoWidth,
    videoHeight: src.videoHeight,
  };
}
