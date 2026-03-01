import type { RawPixelState, RawGameState } from './types.js';
import { TILE_DEFS, MAX_TEMPLATES, TEMPLATE_NAMES } from './tileDefs.js';

const DIGITS = ['0','1','2','3','4','5','6','7','8','9'];
const MASTER_KEY_SCORE_THRESHOLD = 0.65;
const DARK_TILE_THRESHOLD = 0.3;
const ROOM_MATCH_THRESHOLD = 0.3; // minimum NCC score to accept a room match
const MINIMAP_DOT_SAT_THRESHOLD = 20; // min avg saturation to detect Link's dot
const ITEM_MIN_SCORE = 0.4;       // minimum NCC score to accept an item match

// Per-counter min digit confidence (matches Python hud_reader thresholds).
// "X" icon at rupee_0 NCC-matches digit "7" at ~0.3-0.5; real digits score 0.7+.
// Bomb digits on 4.5× streams score ~0.4-0.5 so need a lower threshold.
const RUPEE_MIN_SCORE = 0.5;
const KEY_MIN_SCORE = 0.5;
const BOMB_MIN_SCORE = 0.35;

const SWORD_LEVELS: Record<string, number> = {
  sword_wood: 1,
  sword_white: 2,
  sword_magical: 3,
};

// Shape twin pairs: items with identical shapes, disambiguated by tile color.
// Maps item name → [partner_name, expected_color].
// Color classes: 'blue' | 'red' | 'bright' | 'warm'
const SHAPE_TWINS: Record<string, [string, string]> = {
  blue_candle:       ['red_candle',        'blue'],
  red_candle:        ['blue_candle',       'red'],
  boomerang:         ['magical_boomerang', 'warm'],
  magical_boomerang: ['boomerang',         'blue'],
  potion_blue:       ['potion_red',        'blue'],
  potion_red:        ['potion_blue',       'red'],
  blue_ring:         ['red_ring',          'blue'],
  red_ring:          ['blue_ring',         'red'],
  sword_wood:        ['sword_white',       'warm'],
  sword_white:       ['sword_wood',        'bright'],
  arrow:             ['silver_arrow',      'warm'],
  silver_arrow:      ['arrow',             'bright'],
  wand:              ['recorder',          'blue'],
  recorder:          ['wand',              'warm'],
};
const TWIN_SCORE_TIE = 0.05; // max score difference to trigger color disambiguation

export class PixelInterpreter {
  private _diagCounter = 0;

  interpret(raw: RawPixelState): RawGameState {
    // Diagnostic: log NCC scores every 60 frames to diagnose mis-reads
    if (++this._diagCounter % 60 === 1) {
      const r0 = this._bestDigit(raw, 'rupee_0');
      const r1 = this._bestDigit(raw, 'rupee_1');
      const r2 = this._bestDigit(raw, 'rupee_2');
      const b0 = this._bestDigit(raw, 'bomb_0');
      const b1 = this._bestDigit(raw, 'bomb_1');
      const k0 = this._bestDigit(raw, 'key_0');
      const k1 = this._bestDigit(raw, 'key_1');
      const dl = this._bestDigit(raw, 'dungeon_lvl');
      const bi = this._bestTemplate(raw, 'b_item', '8x16');
      const sw = this._bestTemplate(raw, 'sword', '8x16');
      const s = (x: {digit?: string; name?: string; score: number}) =>
        `${x.digit ?? x.name}@${x.score.toFixed(3)}`;
      console.log(`[ncc-diag] rupee=${s(r0)}|${s(r1)}|${s(r2)} key=${s(k0)}|${s(k1)} bomb=${s(b0)}|${s(b1)} dng=${s(dl)} bItem=${bi ? s(bi) : 'null'} sword=${sw ? s(sw) : 'null'}`);
    }

    // Gate ALL HUD readings on digit NCC confidence — when subscreen scrolls over
    // the HUD area, digit scores drop and we freeze values via -1 sentinel.
    const hudVisible = this._hasConfidentDigits(raw, ['key_0', 'key_1', 'bomb_0', 'bomb_1']);
    const dungeonLevel = hudVisible ? this._readDungeonLevel(raw) : -1;
    const screenType = this._classifyScreen(raw, hudVisible, dungeonLevel);
    const hearts = hudVisible ? this._readHearts(raw) : { current: -1, max: -1 };
    return {
      screenType,
      dungeonLevel,
      rupees: hudVisible ? Math.min(this._readCounter(raw, ['rupee_0', 'rupee_1', 'rupee_2'], RUPEE_MIN_SCORE), 255) : -1,
      keys: hudVisible ? this._readCounter(raw, ['key_0', 'key_1'], KEY_MIN_SCORE) : -1,
      bombs: hudVisible ? this._readCounter(raw, ['bomb_0', 'bomb_1'], BOMB_MIN_SCORE) : -1,
      heartsCurrentRaw: hearts.current,
      heartsMaxRaw: hearts.max,
      bItem: hudVisible ? this._readItem(raw, 'b_item') : null,
      swordLevel: hudVisible ? this._readSwordLevel(raw) : 0,
      hasMasterKey: hudVisible ? this._checkMasterKey(raw) : false,
      mapPosition: this._bestRoom(raw),
      floorItems: raw.floorItems.map(fi => ({
        name: TEMPLATE_NAMES['drops_8x16']?.[fi.templateIdx] ?? 'unknown',
        x: fi.x,
        y: fi.y,
        score: fi.score,
      })),
      // Triforce detection disabled — needs flash-pattern animation detector (Python port)
      triforceCollected: 0,
    };
  }

  private _classifyScreen(raw: RawPixelState, hudVisible: boolean, dungeonLevel: number): RawGameState['screenType'] {
    if (raw.gameBrightness < 8) return 'transition';
    const lifeVisible = raw.redRatioAtLife > 16;
    if (lifeVisible || hudVisible) {
      // Gameplay screen — use dungeonLevel as definitive dungeon signal
      if (dungeonLevel > 0) return 'dungeon';
      if (raw.gameBrightness < 55) return 'cave';
      return 'overworld';
    }
    // No LIFE text and no HUD digits → subscreen or other non-gameplay
    return 'subscreen';
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

  /** Check if any tile in the set has a confident digit score (HUD is visible). */
  private _hasConfidentDigits(raw: RawPixelState, tileIds: string[]): boolean {
    for (const id of tileIds) {
      const { score } = this._bestDigit(raw, id);
      if (score >= BOMB_MIN_SCORE) return true; // use lowest threshold
    }
    return false;
  }

  private _readCounter(raw: RawPixelState, tileIds: string[], minScore = DARK_TILE_THRESHOLD): number {
    let value = 0;
    let hasDigit = false;
    for (const id of tileIds) {
      const { digit, score } = this._bestDigit(raw, id);
      if (score < minScore) continue; // below confidence threshold (dark, blank, or non-digit glyph)
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
    const tileActive = DIGITS.some((_, i) => (raw.hudScores[baseOffset + i] ?? 0) >= DARK_TILE_THRESHOLD);
    if (!tileActive) return false;
    const maxScore = DIGITS.reduce((m, _, ti) =>
      Math.max(m, raw.hudScores[baseOffset + ti] ?? 0), 0);
    // Tile is non-dark but no digit scores confidently → Master Key "A" glyph
    return maxScore < MASTER_KEY_SCORE_THRESHOLD;
  }

  private _bestRoom(raw: RawPixelState): number {
    if (!raw.roomScores || raw.roomScores.length === 0) return -1;

    const dot = this._findMinimapDot(raw);

    // Diagnostic: log minimap + room scores every 60 frames
    if (this._diagCounter % 60 === 1) {
      let bestIdx = 0, bestScore = -Infinity;
      for (let i = 0; i < raw.roomScores.length; i++) {
        if (raw.roomScores[i] > bestScore) { bestScore = raw.roomScores[i]; bestIdx = i; }
      }
      const nccCol = (bestIdx % 16) + 1, nccRow = Math.floor(bestIdx / 16) + 1;
      console.log(`[room-diag] ncc=C${nccCol}R${nccRow}@${bestScore.toFixed(3)} dot=${dot ? `C${dot.col}R${dot.row}` : 'none'}`);
    }

    if (dot) {
      // Accept only exact dot position — no ±1 fallback (eliminates neighbor
      // false positives during screen scrolls)
      const exactIdx = (dot.row - 1) * 16 + (dot.col - 1);
      const exactScore = raw.roomScores[exactIdx] ?? -1;
      return exactScore >= ROOM_MATCH_THRESHOLD ? exactIdx : -1;
    }

    // No minimap dot → no position update (reject transitions/subscreens)
    return -1;
  }

  private _bestTemplate(raw: RawPixelState, tileId: string, group: string): { name: string; score: number } | null {
    const tileIdx = TILE_DEFS.findIndex(t => t.id === tileId);
    if (tileIdx < 0) return null;
    const names = TEMPLATE_NAMES[group];
    if (!names || names.length === 0) return null;
    let best: { name: string; score: number } | null = null;
    for (let i = 0; i < names.length; i++) {
      const score = raw.hudScores[tileIdx * MAX_TEMPLATES + i] ?? 0;
      if (!best || score > best.score) best = { name: names[i], score };
    }
    return best;
  }

  /** Classify a tile's average RGB into a color category (matches Python _pick_by_color). */
  private _classifyTileColor(color: { r: number; g: number; b: number }): string {
    const { r, g, b } = color;
    if (r === 0 && g === 0 && b === 0) return 'warm'; // no data
    const brightness = (r + g + b) / 3;
    if (b > r + 15 && b > g) return 'blue';
    if (r > b + 15 && r > g) return 'red';
    if (brightness > 150) return 'bright';
    return 'warm';
  }

  /** Disambiguate shape-twin items using tile color data. */
  private _disambiguateItem(raw: RawPixelState, tileId: string, bestName: string, bestScore: number): string {
    const twin = SHAPE_TWINS[bestName];
    if (!twin) return bestName;
    const [partner, _expectedColor] = twin;
    // Check partner's score
    const tileIdx = TILE_DEFS.findIndex(t => t.id === tileId);
    if (tileIdx < 0) return bestName;
    const names = TEMPLATE_NAMES['8x16'];
    if (!names) return bestName;
    const partnerIdx = names.indexOf(partner);
    if (partnerIdx < 0) return bestName;
    const partnerScore = raw.hudScores[tileIdx * MAX_TEMPLATES + partnerIdx] ?? 0;
    // Only disambiguate when scores are close (shape twins score nearly identically)
    if (Math.abs(bestScore - partnerScore) >= TWIN_SCORE_TIE) return bestName;
    // Use tile color to pick the right twin
    const tileColor = raw.tileColors?.[tileIdx];
    if (!tileColor) return bestName;
    const colorClass = this._classifyTileColor(tileColor);
    const twinA = SHAPE_TWINS[bestName];
    const twinB = SHAPE_TWINS[partner];
    if (twinA && twinA[1] === colorClass) return bestName;
    if (twinB && twinB[1] === colorClass) return partner;
    return bestName; // fallback to shape winner
  }

  private _readItem(raw: RawPixelState, tileId: string): string | null {
    const best = this._bestTemplate(raw, tileId, '8x16');
    if (!best || best.score < ITEM_MIN_SCORE) return null;
    return this._disambiguateItem(raw, tileId, best.name, best.score);
  }

  private _readSwordLevel(raw: RawPixelState): number {
    const best = this._bestTemplate(raw, 'sword', '8x16');
    if (!best || best.score < ITEM_MIN_SCORE) return 0;
    const resolved = this._disambiguateItem(raw, 'sword', best.name, best.score);
    return SWORD_LEVELS[resolved] ?? 0;
  }

  /**
   * Read hearts using 3-color classification per tile:
   *   Full heart  = color present, little/no white  (colored fill covers the shape)
   *   Half heart  = both color AND white present     (left colored, right white)
   *   Empty heart = white present, no color          (white filled heart shape)
   *   Empty slot  = neither color nor white           (all black)
   */
  private _readHearts(raw: RawPixelState): { current: number; max: number } {
    if (!raw.heartTiles || raw.heartTiles.length < 16) return { current: 0, max: 0 };

    // Diagnostic: log heart tile values every 60 frames
    if (this._diagCounter % 60 === 1) {
      const vals = raw.heartTiles.map((t, i) =>
        `${i}:c=${t.colorRatio.toFixed(2)}/w=${t.whiteRatio.toFixed(2)}/b=${t.brightness.toFixed(0)}`);
      console.log(`[heart-diag] ${vals.join(' ')}`);
    }

    const COLOR_THRESH = 0.08;  // min colorRatio to count as "has color"
    const WHITE_THRESH = 0.08;  // min whiteRatio to count as "has white"

    const scanRow = (startIdx: number): { current: number; max: number } => {
      let current = 0;
      let max = 0;
      for (let i = 0; i < 8; i++) {
        const tile = raw.heartTiles![startIdx + i];
        const hasColor = tile.colorRatio >= COLOR_THRESH;
        const hasWhite = tile.whiteRatio >= WHITE_THRESH;
        if (hasColor && !hasWhite) {
          // Full heart: colored fill, no white
          current++;
          max++;
        } else if (hasColor && hasWhite) {
          // Half heart: both color and white present
          current += 0.5;
          max++;
        } else if (!hasColor && hasWhite) {
          // Empty container: white heart shape, no color fill
          max++;
        }
        // else: empty slot (all black) — no heart here
      }
      return { current, max };
    };

    const row1 = scanRow(0);   // tiles 0-7
    const row2 = scanRow(8);   // tiles 8-15

    // Combine both rows (row2 holds hearts 9-16)
    return { current: row1.current + row2.current, max: row1.max + row2.max };
  }

  /** Find Link's dot on the minimap via saturation (any tunic color vs gray background). */
  private _findMinimapDot(raw: RawPixelState): { col: number; row: number } | null {
    if (!raw.minimapCells || raw.minimapCells.length < 128) return null;
    let bestIdx = 0;
    let bestSat = -1;
    for (let i = 0; i < 128; i++) {
      if (raw.minimapCells[i] > bestSat) {
        bestSat = raw.minimapCells[i];
        bestIdx = i;
      }
    }
    if (bestSat < MINIMAP_DOT_SAT_THRESHOLD) return null;
    return { col: (bestIdx % 16) + 1, row: Math.floor(bestIdx / 16) + 1 };
  }
}
