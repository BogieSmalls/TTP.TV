import { describe, it, expect } from 'vitest';

// Test the aggregate computations as pure JS (mirrors the WGSL logic)

function nesToUv(nesX: number, nesY: number, calib: {
  cropX: number; cropY: number; scaleX: number; scaleY: number;
  gridDx: number; gridDy: number; videoWidth: number; videoHeight: number;
}) {
  return {
    u: (calib.cropX + (nesX + calib.gridDx) * calib.scaleX) / calib.videoWidth,
    v: (calib.cropY + (nesY + calib.gridDy) * calib.scaleY) / calib.videoHeight,
  };
}

function isRedPixel(r: number, g: number, b: number): boolean {
  return r > 0.196 && r > g * 2.0 && r > b * 2.0;
}

function isGoldPixel(r: number, g: number, b: number): boolean {
  return r > 0.588 && g > 0.314 && b < 0.275 && r > g;
}

describe('Aggregate shader math', () => {
  describe('nes_to_uv', () => {
    it('maps NES origin to calibration crop origin', () => {
      const calib = { cropX: 10, cropY: 20, scaleX: 3, scaleY: 4.5, gridDx: 0, gridDy: 0, videoWidth: 1920, videoHeight: 1080 };
      const uv = nesToUv(0, 0, calib);
      expect(uv.u).toBeCloseTo(10 / 1920, 6);
      expect(uv.v).toBeCloseTo(20 / 1080, 6);
    });

    it('applies grid offset', () => {
      const calib = { cropX: 0, cropY: 0, scaleX: 1, scaleY: 1, gridDx: 2, gridDy: 3, videoWidth: 256, videoHeight: 240 };
      const uv = nesToUv(0, 0, calib);
      expect(uv.u).toBeCloseTo(2 / 256, 6);
      expect(uv.v).toBeCloseTo(3 / 240, 6);
    });
  });

  describe('red pixel detection', () => {
    it('detects classic NES LIFE-text red', () => {
      // NES red: R=200, G=30, B=30 -> r=0.784, g=0.118, b=0.118
      expect(isRedPixel(0.784, 0.118, 0.118)).toBe(true);
    });

    it('rejects green pixel', () => {
      expect(isRedPixel(0.1, 0.8, 0.1)).toBe(false);
    });

    it('rejects dim red (below threshold)', () => {
      expect(isRedPixel(0.1, 0.04, 0.04)).toBe(false); // r=0.1 < 0.196
    });
  });

  describe('gold pixel detection', () => {
    it('detects NES gold/orange triforce pixel', () => {
      // Gold: R=220, G=140, B=50 -> r=0.863, g=0.549, b=0.196
      expect(isGoldPixel(0.863, 0.549, 0.196)).toBe(true);
    });

    it('rejects blue pixel', () => {
      expect(isGoldPixel(0.1, 0.2, 0.9)).toBe(false);
    });

    it('rejects white pixel', () => {
      expect(isGoldPixel(1.0, 1.0, 1.0)).toBe(false); // r not > g
    });
  });
});
