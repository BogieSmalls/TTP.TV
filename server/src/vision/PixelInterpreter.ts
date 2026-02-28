import type { RawPixelState, RawGameState } from './types.js';
import { TILE_DEFS, MAX_TEMPLATES, TEMPLATE_NAMES } from './tileDefs.js';

const DIGITS = ['0','1','2','3','4','5','6','7','8','9'];
const MASTER_KEY_SCORE_THRESHOLD = 0.65;
const DARK_TILE_THRESHOLD = 0.3;

export class PixelInterpreter {
  interpret(raw: RawPixelState): RawGameState {
    return {
      screenType: this._classifyScreen(raw),
      dungeonLevel: this._readDungeonLevel(raw),
      rupees: Math.min(this._readCounter(raw, ['rupee_0', 'rupee_1', 'rupee_2']), 255),
      keys: this._readCounter(raw, ['key_0', 'key_1']),
      bombs: this._readCounter(raw, ['bomb_0', 'bomb_1']),
      heartsCurrentRaw: 0,  // hearts read from pixel aggregates — not yet in pipeline
      heartsMaxRaw: 0,
      bItem: this._readItem(raw, 'b_item'),
      swordLevel: this._readSwordLevel(raw),
      hasMasterKey: this._checkMasterKey(raw),
      mapPosition: 0,  // from room matching — Task 13
      floorItems: raw.floorItems.map(fi => ({
        name: TEMPLATE_NAMES['drops_8x16']?.[fi.templateIdx] ?? 'unknown',
        x: fi.x,
        y: fi.y,
        score: fi.score,
      })),
      triforceCollected: raw.goldPixelCount > 15 ? 1 : 0,
    };
  }

  private _classifyScreen(raw: RawPixelState): RawGameState['screenType'] {
    if (raw.gameBrightness < 8) return 'transition';
    if (raw.redRatioAtLife > 16) {
      // LIFE text present → gameplay screen
      if (raw.gameBrightness < 35) return 'dungeon';
      if (raw.gameBrightness < 55) return 'cave';
      return 'overworld';
    }
    if (raw.gameBrightness < 30) return 'subscreen';
    return 'unknown';
  }

  private _bestDigit(raw: RawPixelState, tileId: string): { digit: string; score: number } {
    const tileIdx = TILE_DEFS.findIndex(t => t.id === tileId);
    if (tileIdx < 0) return { digit: '0', score: 0 };
    let best = { digit: '0', score: -Infinity };
    DIGITS.forEach((d, tmplIdx) => {
      const score = raw.hudScores[tileIdx * MAX_TEMPLATES + tmplIdx] ?? 0;
      if (score > best.score) best = { digit: d, score };
    });
    return best;
  }

  private _readCounter(raw: RawPixelState, tileIds: string[]): number {
    let value = 0;
    let hasDigit = false;
    for (const id of tileIds) {
      const { digit, score } = this._bestDigit(raw, id);
      if (score < DARK_TILE_THRESHOLD) continue; // dark tile = no digit
      value = value * 10 + parseInt(digit, 10);
      hasDigit = true;
    }
    return hasDigit ? value : 0;
  }

  private _readDungeonLevel(raw: RawPixelState): number {
    const { digit, score } = this._bestDigit(raw, 'dungeon_lvl');
    return score > 0.5 ? parseInt(digit, 10) : 0;
  }

  private _checkMasterKey(raw: RawPixelState): boolean {
    const tileIdx = TILE_DEFS.findIndex(t => t.id === 'key_0');
    if (tileIdx < 0) return false;
    // Check if tile is "active" (any score is non-zero)
    const baseOffset = tileIdx * MAX_TEMPLATES;
    const tileActive = DIGITS.some((_, i) => (raw.hudScores[baseOffset + i] ?? 0) > 0);
    if (!tileActive) return false;
    const maxScore = DIGITS.reduce((m, _, ti) =>
      Math.max(m, raw.hudScores[baseOffset + ti] ?? 0), 0);
    // Tile is non-dark but no digit scores confidently → Master Key "A" glyph
    return maxScore < MASTER_KEY_SCORE_THRESHOLD;
  }

  private _readItem(raw: RawPixelState, tileId: string): string | null {
    // Placeholder — item template matching implemented when template names populated
    return null;
  }

  private _readSwordLevel(raw: RawPixelState): number {
    // Placeholder — sword detection implemented with item templates
    return 0;
  }
}
