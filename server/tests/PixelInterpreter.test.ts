import { describe, it, expect } from 'vitest';
import { PixelInterpreter } from '../src/vision/PixelInterpreter.js';
import { TILE_DEFS, MAX_TEMPLATES } from '../src/vision/tileDefs.js';

const DARK_TILE_THRESHOLD = 0.3;
import type { RawPixelState } from '../src/vision/types.js';

const KEY0_IDX = TILE_DEFS.findIndex(t => t.id === 'key_0');

/** HUD scores array with key_0 confidence set so hudVisible=true. */
function hudVisibleScores(): number[] {
  const scores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
  scores[KEY0_IDX * MAX_TEMPLATES + 0] = 0.7;
  return scores;
}

/** Build a RawPixelState. Default has hudVisible=true (key_0 scores above threshold). */
function makeRaw(overrides: Partial<RawPixelState> = {}): RawPixelState {
  return {
    racerId: 'test',
    timestamp: 0,
    frameNumber: 1,
    hudScores: hudVisibleScores(),
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

    it('classifies dark gameplay as dungeon when dungeonLevel > 0', () => {
      // Dungeon classification requires dungeonLevel > 0 (from dungeon_lvl tile score)
      const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
      const key0Idx = TILE_DEFS.findIndex(t => t.id === 'key_0');
      hudScores[key0Idx * MAX_TEMPLATES + 0] = 0.7;
      const lvlIdx = TILE_DEFS.findIndex(t => t.id === 'dungeon_lvl');
      hudScores[lvlIdx * MAX_TEMPLATES + 3] = 0.8; // digit '3'
      const raw = interp.interpret(makeRaw({ redRatioAtLife: 20, gameBrightness: 25, hudScores }));
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
      // Subscreen: no LIFE text, no confident HUD digits → hudVisible false
      const hudScores = new Array(TILE_DEFS.length * MAX_TEMPLATES).fill(0);
      const raw = interp.interpret(makeRaw({ gameBrightness: 20, redRatioAtLife: 0, hudScores }));
      expect(raw.screenType).toBe('subscreen');
    });
  });

  describe('_readCounter', () => {
    it('reads a 2-digit number from tile scores', () => {
      const hudScores = hudVisibleScores();
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
      const hudScores = hudVisibleScores();
      // Active tile but all digit scores = 0.5 (below MASTER_KEY_SCORE_THRESHOLD=0.65)
      // This overwrites key_0's default 0.7 from hudVisibleScores — but 0.5 still passes
      // _hasConfidentDigits threshold (BOMB_MIN_SCORE=0.35), so hudVisible stays true.
      for (let i = 0; i < 10; i++) hudScores[KEY0_IDX * MAX_TEMPLATES + i] = 0.5;
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
      const hudScores = hudVisibleScores();
      hudScores[KEY0_IDX * MAX_TEMPLATES + 3] = 0.85; // digit '3' at 0.85 → confident
      const raw = interp.interpret(makeRaw({ hudScores }));
      expect(raw.hasMasterKey).toBe(false);
    });
  });

  it('caps rupees at 255', () => {
    const hudScores = hudVisibleScores();
    hudScores[0 * MAX_TEMPLATES + 9] = 0.8; // rupee_0 digit '9'
    hudScores[1 * MAX_TEMPLATES + 9] = 0.8; // rupee_1 digit '9'
    hudScores[2 * MAX_TEMPLATES + 9] = 0.8; // rupee_2 digit '9' → 999 capped to 255
    const raw = interp.interpret(makeRaw({ hudScores }));
    expect(raw.rupees).toBe(255);
  });

  it('reads dungeon level from dungeon_lvl tile', () => {
    const hudScores = hudVisibleScores();
    const lvlIdx = TILE_DEFS.findIndex(t => t.id === 'dungeon_lvl');
    hudScores[lvlIdx * MAX_TEMPLATES + 5] = 0.8; // digit '5'
    const raw = interp.interpret(makeRaw({ hudScores }));
    expect(raw.dungeonLevel).toBe(5);
  });

  it('returns 0 dungeonLevel when score below threshold', () => {
    const hudScores = hudVisibleScores();
    const lvlIdx = TILE_DEFS.findIndex(t => t.id === 'dungeon_lvl');
    hudScores[lvlIdx * MAX_TEMPLATES + 5] = 0.4; // below 0.5 threshold
    const raw = interp.interpret(makeRaw({ hudScores }));
    expect(raw.dungeonLevel).toBe(0);
  });

  // triforceCollected is always 0 in PixelInterpreter — detection moved to TriforceTracker
  // which tracks gold flash patterns at the pipeline level.
  it('sets triforceCollected=0 (detection deferred to TriforceTracker)', () => {
    const raw = interp.interpret(makeRaw({ goldPixelCount: 16 }));
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
