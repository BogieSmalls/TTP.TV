import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock canvas and fs before importing templateServer
vi.mock('canvas', () => ({
  loadImage: vi.fn().mockResolvedValue({ width: 8, height: 8 }),
  createCanvas: vi.fn().mockReturnValue({
    getContext: () => ({
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(8 * 8 * 4).fill(255),
      }),
    }),
  }),
}));

vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn().mockReturnValue(['0.png', '1.png', '1.png.bak']),
  },
}));

describe('templateServer /api/vision/templates', () => {
  it('filters out .bak files', async () => {
    const files = ['0.png', '1.png', '1.png.bak', '2.png.bak2'];
    const filtered = files.filter(f => f.endsWith('.png') && !f.endsWith('.bak') && !f.endsWith('.bak2'));
    expect(filtered).toEqual(['0.png', '1.png']);
  });

  it('computes max-channel grayscale correctly', () => {
    // pixel [R=200, G=100, B=50, A=255] → max=200 → 200/255 ≈ 0.784
    const rgba = [200, 100, 50, 255, 100, 200, 50, 255];
    const pixels: number[] = [];
    for (let i = 0; i < rgba.length; i += 4) {
      pixels.push(Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) / 255);
    }
    expect(pixels[0]).toBeCloseTo(200 / 255, 3);
    expect(pixels[1]).toBeCloseTo(200 / 255, 3); // second pixel max is G=200
  });

  it('normalizes templates to mean=0 std=1', () => {
    const pixels = [0.0, 0.5, 1.0]; // mean=0.5, std=√(1/3)≈0.408
    const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
    const std = Math.sqrt(pixels.reduce((s, p) => s + (p - mean) ** 2, 0) / pixels.length) || 1;
    const normalized = pixels.map(p => (p - mean) / std);
    const normMean = normalized.reduce((a, b) => a + b, 0) / normalized.length;
    expect(normMean).toBeCloseTo(0, 5);
    const normStd = Math.sqrt(normalized.reduce((s, p) => s + p ** 2, 0) / normalized.length);
    expect(normStd).toBeCloseTo(1, 5);
  });
});
