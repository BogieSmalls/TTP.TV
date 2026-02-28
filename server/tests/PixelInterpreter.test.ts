import { describe, it, expect } from 'vitest';
import { PixelInterpreter } from '../src/vision/PixelInterpreter.js';
import { TILE_DEFS, MAX_TEMPLATES } from '../src/vision/tileDefs.js';

const DARK_TILE_THRESHOLD = 0.3;
import type { RawPixelState } from '../src/vision/types.js';

function makeRaw(overrides: Partial<RawPixelState> = {}): RawPixelState {
  return {
    racerId: 'test',
    timestamp: 0,
    frameNumber: 1,
    hudScores: new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0),
    roomScores: new Array(128).fill(0),
    floorItems: [],
    gameBrightness: 80,
    redRatioAtLife: 20,
    goldPixelCount: 0,
    ...overrides,
  };
}

describe('PixelInterpreter', () => {
  const interp = new PixelInterpreter();

  describe('_classifyScreen', () => {
    it('classifies as gameplay when redRatioAtLife > 16', () => {
      const raw = interp.interpret(makeRaw({ redRatioAtLife: 20, gameBrightness: 80 }));
      expect(['overworld', 'dungeon', 'cave']).toContain(raw.screenType);
    });

    it('classifies bright gameplay as overworld', () => {
      const raw = interp.interpret(makeRaw({ redRatioAtLife: 20, gameBrightness: 80 }));
      expect(raw.screenType).toBe('overworld');
    });

    it('classifies dark gameplay as dungeon', () => {
      const raw = interp.interpret(makeRaw({ redRatioAtLife: 20, gameBrightness: 25 }));
      expect(raw.screenType).toBe('dungeon');
    });

    it('classifies medium gameplay as cave', () => {
      const raw = interp.interpret(makeRaw({ redRatioAtLife: 20, gameBrightness: 42 }));
      expect(raw.screenType).toBe('cave');
    });

    it('classifies as transition when brightness < 8', () => {
      const raw = interp.interpret(makeRaw({ gameBrightness: 5, redRatioAtLife: 0 }));
      expect(raw.screenType).toBe('transition');
    });

    it('classifies dark non-gameplay as subscreen', () => {
      const raw = interp.interpret(makeRaw({ gameBrightness: 20, redRatioAtLife: 0 }));
      expect(raw.screenType).toBe('subscreen');
    });
  });

  describe('_readCounter', () => {
    it('reads a 2-digit number from tile scores', () => {
      // rupee_0 = tile 0, rupee_1 = tile 1, rupee_2 = tile 2
      // Set tile 1 best as '5' (tmplIdx=5 score=0.8) and tile 2 best as '3' (tmplIdx=3 score=0.8)
      const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
      const r1 = 1; const r2 = 2; // rupee_1, rupee_2 tile indices
      hudScores[r1 * MAX_TEMPLATES + 5] = 0.8; // digit '5'
      hudScores[r2 * MAX_TEMPLATES + 3] = 0.8; // digit '3'
      const raw = interp.interpret(makeRaw({ hudScores }));
      expect(raw.rupees).toBe(53); // tile 0 skipped (score 0 < 0.3), tiles 1+2 → 53
    });

    it('returns 0 when all scores below threshold', () => {
      const raw = interp.interpret(makeRaw());
      expect(raw.rupees).toBe(0);
    });
  });

  describe('_checkMasterKey', () => {
    it('detects master key when key tile is active but max score below threshold', () => {
      const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
      const key0idx = TILE_DEFS.findIndex(t => t.id === 'key_0');
      // Active tile but all digit scores = 0.5 (below MASTER_KEY_SCORE_THRESHOLD=0.65)
      for (let i = 0; i < 10; i++) hudScores[key0idx * MAX_TEMPLATES + i] = 0.5;
      const raw = interp.interpret(makeRaw({ hudScores }));
      expect(raw.hasMasterKey).toBe(true);
    });

    it('does NOT detect master key when key tile is dark (all scores below threshold)', () => {
      // All scores = 0.1 (below DARK_TILE_THRESHOLD = 0.3) → tile inactive → no master key
      const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0.1);
      const raw = interp.interpret(makeRaw({ hudScores }));
      expect(raw.hasMasterKey).toBe(false);
    });

    it('does NOT detect master key when a digit scores confidently', () => {
      const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
      const key0idx = TILE_DEFS.findIndex(t => t.id === 'key_0');
      hudScores[key0idx * MAX_TEMPLATES + 3] = 0.85; // digit '3' at 0.85 → confident
      const raw = interp.interpret(makeRaw({ hudScores }));
      expect(raw.hasMasterKey).toBe(false);
    });
  });

  it('caps rupees at 255', () => {
    const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
    // rupee_0=idx0, rupee_1=idx1, rupee_2=idx2, digit '9'=tmpl 9
    hudScores[0 * MAX_TEMPLATES + 9] = 0.8;
    hudScores[1 * MAX_TEMPLATES + 9] = 0.8;
    hudScores[2 * MAX_TEMPLATES + 9] = 0.8; // 999 → capped to 255
    const raw = interp.interpret(makeRaw({ hudScores }));
    expect(raw.rupees).toBe(255);
  });

  it('reads dungeon level from dungeon_lvl tile', () => {
    const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
    const lvlIdx = TILE_DEFS.findIndex(t => t.id === 'dungeon_lvl');
    hudScores[lvlIdx * MAX_TEMPLATES + 5] = 0.8; // digit '5'
    const raw = interp.interpret(makeRaw({ hudScores }));
    expect(raw.dungeonLevel).toBe(5);
  });

  it('returns 0 dungeonLevel when score below threshold', () => {
    const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
    const lvlIdx = TILE_DEFS.findIndex(t => t.id === 'dungeon_lvl');
    hudScores[lvlIdx * MAX_TEMPLATES + 5] = 0.4; // below 0.5 threshold
    const raw = interp.interpret(makeRaw({ hudScores }));
    expect(raw.dungeonLevel).toBe(0);
  });

  it('sets triforceCollected=1 when goldPixelCount > 15', () => {
    const raw = interp.interpret(makeRaw({ goldPixelCount: 16 }));
    expect(raw.triforceCollected).toBe(1);
  });

  it('sets triforceCollected=0 when goldPixelCount <= 15', () => {
    const raw = interp.interpret(makeRaw({ goldPixelCount: 15 }));
    expect(raw.triforceCollected).toBe(0);
  });

  it('passes through floorItems from raw state', () => {
    const floorItems = [{ templateIdx: 0, score: 0.9, x: 10, y: 20 }];
    const raw = interp.interpret(makeRaw({ floorItems }));
    expect(raw.floorItems).toHaveLength(1);
    expect(raw.floorItems[0].x).toBe(10);
    expect(raw.floorItems[0].score).toBe(0.9);
  });
});
