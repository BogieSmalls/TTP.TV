import { describe, it, expect } from 'vitest';
import { computeCalibrationUniform } from '../src/vision/inBrowserCalibrationMath.js';

describe('computeCalibrationUniform', () => {
  it('derives scaleY from LIFE text glyph height', () => {
    // LIFE glyph is 8 NES pixels tall; at 3× scale it is 24 pixels
    const result = computeCalibrationUniform({
      lifeGlyphHeight: 24,           // 8 * 3 = 24 stream pixels
      lifeTopY: 120,                 // stream pixel y of LIFE text top
      gameplayBoundaryY: 192,        // stream pixel y of HUD/gameplay boundary (64 NES px below 0)
      bItemLeftX: 128,               // stream pixel x of B-item left border
      aItemLeftX: 160,               // stream pixel x of A-item left border
      cropX: 0,
      videoWidth: 1280, videoHeight: 720,
    });
    // scaleY = avg(24/8, (192-120)/(64-40)) = avg(3.0, 72/24) = avg(3.0, 3.0) = 3.0
    expect(result.scaleY).toBeCloseTo(3.0, 2);
    // scaleX = (160-128) / (160-128) = 32/32 = 1.0 — wait, NES B=128, A=160, gap=32
    // At 3× scale: stream gap = 32*3 = 96. But test uses bItemLeftX=128, aItemLeftX=160 → gap=32
    // This means scale=1.0 for this particular test input — that's fine
    expect(result.scaleX).toBeCloseTo(1.0, 2);
    expect(result.cropY).toBeDefined();
    expect(typeof result.cropY).toBe('number');
  });

  it('computes cropY as lifeTopY minus LIFE_NES_Y * scaleY', () => {
    const result = computeCalibrationUniform({
      lifeGlyphHeight: 24, lifeTopY: 120, gameplayBoundaryY: 192,
      bItemLeftX: 256, aItemLeftX: 352,  // gap=96 at scaleX=3
      cropX: 10, videoWidth: 1280, videoHeight: 720,
    });
    // scaleY = 3.0, cropY = 120 - 40 * 3.0 = 120 - 120 = 0
    expect(result.cropY).toBeCloseTo(0, 1);
    expect(result.cropX).toBe(10);
  });

  it('preserves negative cropY when LIFE text is above stream top', () => {
    const result = computeCalibrationUniform({
      lifeGlyphHeight: 24, lifeTopY: 5,
      gameplayBoundaryY: 77, bItemLeftX: 128, aItemLeftX: 160,
      cropX: 0, videoWidth: 1280, videoHeight: 720,
    });
    // scaleY = avg(24/8, (77-5)/(64-40)) = avg(3.0, 72/24) = avg(3.0, 3.0) = 3.0
    // cropY = 5 - 40 * 3.0 = 5 - 120 = -115
    expect(result.cropY).toBeLessThan(0);
  });

  it('returns gridDx=0, gridDy=0 (grid offset refined separately)', () => {
    const result = computeCalibrationUniform({
      lifeGlyphHeight: 24, lifeTopY: 120, gameplayBoundaryY: 192,
      bItemLeftX: 128, aItemLeftX: 160,
      cropX: 0, videoWidth: 1280, videoHeight: 720,
    });
    expect(result.gridDx).toBe(0);
    expect(result.gridDy).toBe(0);
  });
});
