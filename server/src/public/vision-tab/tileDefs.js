import { computeTilePositions, DEFAULT_LIFE_NES_X, DEFAULT_LIFE_NES_Y } from './tileGrid.js';

// -- HUD tile definitions -------------------------------------------------------
// Each entry: { id, nesX, nesY, size, templateGroup }
// nesX/nesY: top-left of tile in canonical NES coords (before grid offset).
// Grid offset (gridDx, gridDy) is applied by the shader via the calibration uniform.
//
// DEFAULT positions are computed from the canonical tile grid (tileGrid.js).
// When crop-profile landmarks are available, use applyLandmarks() to
// recompute from actual stream positions.

const defaults = computeTilePositions(DEFAULT_LIFE_NES_Y);

export const TILE_DEFS = [
  { id: 'rupee_0', ...defaults.rupee_0, templateGroup: '8x8' },
  { id: 'rupee_1', ...defaults.rupee_1, templateGroup: '8x8' },
  { id: 'rupee_2', ...defaults.rupee_2, templateGroup: '8x8' },
  { id: 'key_0',   ...defaults.key_0,   templateGroup: '8x8' },
  { id: 'key_1',   ...defaults.key_1,   templateGroup: '8x8' },
  { id: 'bomb_0',  ...defaults.bomb_0,  templateGroup: '8x8' },
  { id: 'bomb_1',  ...defaults.bomb_1,  templateGroup: '8x8' },
  { id: 'dungeon_lvl', ...defaults.dungeon_lvl, templateGroup: '8x8' },
  { id: 'b_item',  ...defaults.b_item,  templateGroup: '8x16' },
  { id: 'sword',   ...defaults.sword,   templateGroup: '8x16' },
];

// Max templates per tile (must match shader constant MAX_TEMPLATES)
export const MAX_TEMPLATES = 32;

/**
 * Recompute tile positions from crop-profile landmarks.
 * Landmarks are in canonical NES coords (0-255, 0-239) within the crop region.
 * The shader adds gridDx/gridDy, so we subtract them here to avoid double-counting.
 * Returns a new TILE_DEFS-shaped array and the LIFE position for the aggregate shader.
 */
export function applyLandmarks(landmarks, gridDx, gridDy) {
  const lm = {};
  for (const l of landmarks) lm[l.label] = l;

  // Clone defaults
  const defs = TILE_DEFS.map(d => ({ ...d }));

  // Helper: set tile position from landmark, using right-aligned digit columns
  function digitX(regionLm, digitIdx) {
    return regionLm.x + regionLm.w - (digitIdx + 1) * 8 - gridDx;
  }
  function lmY(regionLm) {
    return regionLm.y - gridDy;
  }

  // Rupees (3 digits, right-aligned in "Rupees" landmark)
  if (lm['Rupees']) {
    const r = lm['Rupees'];
    const set = (id, dIdx) => {
      const d = defs.find(t => t.id === id);
      if (d) { d.nesX = digitX(r, dIdx); d.nesY = lmY(r); }
    };
    set('rupee_2', 0); // ones (rightmost)
    set('rupee_1', 1); // tens
    set('rupee_0', 2); // hundreds
  }

  // Keys (2 digits, right-aligned in "Keys" landmark)
  if (lm['Keys']) {
    const k = lm['Keys'];
    const set = (id, dIdx) => {
      const d = defs.find(t => t.id === id);
      if (d) { d.nesX = digitX(k, dIdx); d.nesY = lmY(k); }
    };
    set('key_1', 0);
    set('key_0', 1);
  }

  // Bombs (2 digits, right-aligned in "Bombs" landmark)
  if (lm['Bombs']) {
    const b = lm['Bombs'];
    const set = (id, dIdx) => {
      const d = defs.find(t => t.id === id);
      if (d) { d.nesX = digitX(b, dIdx); d.nesY = lmY(b); }
    };
    set('bomb_1', 0);
    set('bomb_0', 1);
  }

  // Dungeon level -- digit "X" in "LEVEL-X " is second-to-last tile (col 9, trailing space at col 10)
  if (lm['LVL']) {
    const lvl = lm['LVL'];
    const d = defs.find(t => t.id === 'dungeon_lvl');
    if (d) {
      d.nesX = lvl.x + lvl.w - 16 - gridDx;
      d.nesY = lvl.y - gridDy;
    }
  }

  // B item -- icon is centered in the B box, one row below the "B" label
  if (lm['B']) {
    const b = lm['B'];
    const d = defs.find(t => t.id === 'b_item');
    if (d) {
      d.nesX = Math.round(b.x + (b.w - 8) / 2) - gridDx;
      d.nesY = b.y + 8 - gridDy;
    }
  }

  // Sword/A item -- icon is centered in the A box, one row below the "A" label
  if (lm['A']) {
    const a = lm['A'];
    const d = defs.find(t => t.id === 'sword');
    if (d) {
      d.nesX = Math.round(a.x + (a.w - 8) / 2) - gridDx;
      d.nesY = a.y + 8 - gridDy;
    }
  }

  // LIFE position for aggregate shader (used by red_pass)
  let lifeNesX = DEFAULT_LIFE_NES_X - gridDx;
  let lifeNesY = DEFAULT_LIFE_NES_Y - gridDy;
  if (lm['-LIFE-']) {
    lifeNesX = lm['-LIFE-'].x - gridDx;
    lifeNesY = lm['-LIFE-'].y - gridDy;
  }

  return { defs, lifeNesX, lifeNesY };
}
