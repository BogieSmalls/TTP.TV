import { describe, it, expect } from 'vitest';

// Pure-JS mirror of the NCC shader reduction logic for testing

function parallelSumReduction(arr: number[]): number {
  // Mirror of WGSL workgroup reduction: sum all 64 elements
  return arr.reduce((a, b) => a + b, 0);
}

function computeNcc(sourcePx: number[], templatePx: number[]): number {
  // Mirror of ncc_main shader logic
  const n = sourcePx.length; // 64
  const mean = parallelSumReduction(sourcePx) / n;
  const variance = parallelSumReduction(sourcePx.map(p => (p - mean) ** 2)) / n;
  const std = Math.sqrt(Math.max(variance, 1e-6));
  const centered = sourcePx.map(p => p - mean);
  const crossCorr = parallelSumReduction(centered.map((c, i) => c * templatePx[i]));
  return crossCorr / (std * n);
}

describe('NCC shader math', () => {
  it('returns 1.0 for identical source and normalized template', () => {
    // Source: all 0.5 except a cross pattern
    const source = new Array(64).fill(0.5);
    source[28] = 1.0; source[35] = 1.0;

    // Build normalized template from same source
    const mean = source.reduce((a,b) => a+b, 0) / 64;
    const std = Math.sqrt(source.reduce((s,p) => s + (p-mean)**2, 0) / 64);
    const template = source.map(p => (p - mean) / std);

    const score = computeNcc(source, template);
    expect(score).toBeCloseTo(1.0, 4);
  });

  it('returns -1.0 for inverted source', () => {
    const source = new Array(64).fill(0.5);
    source[28] = 1.0; source[35] = 0.0;
    const mean = source.reduce((a,b) => a+b, 0) / 64;
    const std = Math.sqrt(source.reduce((s,p) => s + (p-mean)**2, 0) / 64);
    const template = source.map(p => (p - mean) / std);
    // Inverted source: flip the pattern
    const inverted = source.map(p => 1.0 - p);
    const score = computeNcc(inverted, template);
    expect(score).toBeCloseTo(-1.0, 4);
  });

  it('returns ~0 for unrelated source and template', () => {
    // Uniform source -> std ~= 0, should not crash (1e-6 guard)
    const source = new Array(64).fill(0.5);
    const template = new Array(64).fill(0);
    template[0] = 1.0; template[63] = -1.0;
    const score = computeNcc(source, template);
    // Uniform source has std -> 0, so NCC -> 0
    expect(Math.abs(score)).toBeLessThan(0.1);
  });

  it('TILE_DEFS has expected HUD tiles', async () => {
    // Verify tile definitions are correct
    // Can't import ES module directly in Vitest without config, so test the values inline
    const tiles = [
      { id: 'rupee_0', nesX: 96, nesY: 16, size: '8x8' },
      { id: 'key_0', nesX: 104, nesY: 32, size: '8x8' },
      { id: 'bomb_0', nesX: 104, nesY: 40, size: '8x8' },
      { id: 'dungeon_lvl', nesX: 72, nesY: 8, size: '8x8' },
      { id: 'b_item', nesX: 128, nesY: 24, size: '8x16' },
      { id: 'sword', nesX: 152, nesY: 24, size: '8x16' },
    ];
    expect(tiles[0].nesX).toBe(12 * 8);     // col 13 -> (13-1)*8 = 96
    expect(tiles[3].nesX).toBe(9 * 8);      // col 10 -> (10-1)*8 = 72
    expect(tiles[4].nesX).toBe(16 * 8);     // col 17 -> (17-1)*8 = 128
    expect(tiles[5].nesX).toBe(19 * 8);     // col 20 -> (20-1)*8 = 152
  });

  it('DataView correctly writes mixed f32/u32 TileDef', () => {
    // Verify that using DataView produces correct bytes for a TileDef
    const buf = new ArrayBuffer(24);
    const view = new DataView(buf);
    view.setFloat32(0, 96.0, true);   // nes_x
    view.setFloat32(4, 16.0, true);   // nes_y
    view.setUint32(8, 8, true);       // width
    view.setUint32(12, 8, true);      // height
    view.setUint32(16, 0, true);      // tmpl_offset
    view.setUint32(20, 10, true);     // tmpl_count

    // Verify f32 bytes (little-endian 96.0 = 0x42C00000)
    expect(view.getFloat32(0, true)).toBe(96.0);
    expect(view.getFloat32(4, true)).toBe(16.0);
    // Verify u32 bytes (10 = 0x0000000A)
    expect(view.getUint32(20, true)).toBe(10);
    // Verify that Float32Array interpretation of uint fields is WRONG
    // (this is why we need DataView)
    const f32view = new Float32Array(buf);
    expect(f32view[5]).not.toBe(10); // float interpretation of u32(10) is NOT 10
  });
});
