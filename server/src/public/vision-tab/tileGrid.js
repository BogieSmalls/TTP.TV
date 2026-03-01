// tileGrid.js — Canonical NES Zelda 1 tile grid (32 cols x 30 rows, 8x8 px each)
//
// Coordinate conventions:
//   1-indexed [col, row]: [1,1] = top-left, [32,30] = bottom-right
//   LIFE-relative row offsets: 0 = LIFE row, negative = above, positive = below
//   NES pixel = (col - 1) * 8, (row - 1) * 8  (before grid offset)
//
// The LIFE text position is the primary calibration anchor. All other HUD
// elements are at fixed offsets from LIFE. Column positions are absolute
// (they don't shift per stream). Only vertical position varies.
//
// NOTE: nesY coordinates in tile defs are in the "tile-def coordinate system"
// which has an inherent ~8px offset from actual NES frame coordinates.
// Landmarks are in actual NES frame coordinates. The grid offset (gridDx/gridDy)
// bridges the gap. When landmarks are available, they override these defaults.
//
// Reference image: content/grid_layout.png

// -- Canonical HUD Layout -------------------------------------------------------
// Row offsets relative to LIFE row (row offset 0)
export const HUD_LAYOUT = {
  // Row -1: LEVEL-X text
  LEVEL_TEXT:    { cols: [3, 10], rowOffset: -1, desc: '"LEVEL-X " dungeon indicator' },

  // Row 0: Rupees, B/A labels, LIFE text, minimap top
  RUPEES:        { cols: [12, 15], rowOffset: 0, desc: '[icon, x/100s, 10s/1s, 1s/blank]' },
  LIFE_TEXT:     { cols: [22, 27], rowOffset: 0, desc: '"-LIFE-" or "-ROAR-" red text' },

  // Rows 0-3: Minimap, B-item box, A-item box
  MINIMAP:       { cols: [3, 10], rowOffsets: [0, 3], desc: '8x4 tiles (64x32 px)' },
  B_ITEM_BOX:    { cols: [16, 18], rowOffsets: [0, 3], desc: 'label [17,+0], icon [17,+1 to +2]' },
  A_ITEM_BOX:    { cols: [19, 21], rowOffsets: [0, 3], desc: 'label [20,+0], icon [20,+1 to +2]' },

  // Row +1: B/A item icons (within their boxes)
  B_ITEM_ICON:   { col: 17, rowOffset: 1, desc: 'B-item sprite (8x16, rows +1 to +2)' },
  A_ITEM_ICON:   { col: 20, rowOffset: 1, desc: 'Sword/A-item sprite (8x16, rows +1 to +2)' },

  // Row +2: Keys, hearts row 2
  KEYS:          { cols: [12, 15], rowOffset: 2, desc: '[icon, X, digit(s)/A, digit/blank]' },
  HEARTS_ROW2:   { cols: [23, 30], rowOffset: 2, desc: 'Hearts 9-16' },

  // Row +3: Bombs, hearts row 1
  BOMBS:         { cols: [12, 15], rowOffset: 3, desc: '[icon, X, digit(s), digit/blank]' },
  HEARTS_ROW1:   { cols: [23, 30], rowOffset: 3, desc: 'Hearts 1-8' },

  // Row +4: blank buffer
  // Row +5 to +26: game viewport [1,9]-[32,30] = 32x22 tiles (256x176 px)
  VIEWPORT_START_OFFSET: 5,
};

// Minimap room dimensions within the 64x32 px minimap area
export const MINIMAP = {
  overworld: { roomCols: 16, roomRows: 8, pxPerRoomX: 4, pxPerRoomY: 4 },
  dungeon:   { roomCols: 8,  roomRows: 8, pxPerRoomX: 8, pxPerRoomY: 4 },
};

// Safe area: always visible regardless of stream cropping
export const SAFE_AREA = { cols: [3, 30], rows: [3, 29] };

// Game area starts at this NES Y offset from LIFE row
export const GAME_AREA_ROW_OFFSET = 5;  // LIFE row + 5 rows = viewport start

// -- NES Coordinate Helpers ------------------------------------------------------

/** Convert 1-indexed column to NES pixel X (before grid offset). */
export function colToNesX(col) {
  return (col - 1) * 8;
}

/** Convert LIFE-relative row offset to NES pixel Y. */
export function rowOffsetToNesY(lifeNesY, rowOffset) {
  return lifeNesY + rowOffset * 8;
}

/** Default LIFE NES position in tile-def coordinate system. */
export const DEFAULT_LIFE_NES_X = 176;  // 0-indexed col 22 = left edge of "-LIFE-"
export const DEFAULT_LIFE_NES_Y = 16;   // same row as rupees (nesY=16 in tile-def coords)

/**
 * Compute NES pixel positions for all HUD tiles given a LIFE anchor.
 * Returns positions in the same format as TILE_DEFS (nesX, nesY before grid offset).
 *
 * Digit columns use the rightmost tile(s) within each counter region:
 *   Rupees: cols 13-15 (3 digits: hundreds, tens, ones)
 *   Keys:   cols 14-15 (2 digits: tens, ones -- or "A" for master key)
 *   Bombs:  cols 14-15 (2 digits: tens, ones)
 *   Level:  col 10 (last character of "LEVEL-X ")
 */
export function computeTilePositions(lifeNesY = DEFAULT_LIFE_NES_Y) {
  const y = (offset) => rowOffsetToNesY(lifeNesY, offset);
  return {
    // Rupees: 3 digit tiles (cols 13, 14, 15 in 1-indexed) — same row as LIFE
    rupee_0: { nesX: colToNesX(13), nesY: y(0), size: '8x8' },  // x/hundreds
    rupee_1: { nesX: colToNesX(14), nesY: y(0), size: '8x8' },  // tens/ones
    rupee_2: { nesX: colToNesX(15), nesY: y(0), size: '8x8' },  // ones/blank

    // Keys: 2 digit tiles (cols 14, 15) — 2 rows below LIFE
    key_0:   { nesX: colToNesX(14), nesY: y(2), size: '8x8' },
    key_1:   { nesX: colToNesX(15), nesY: y(2), size: '8x8' },

    // Bombs: 2 digit tiles (cols 14, 15) — 3 rows below LIFE
    bomb_0:  { nesX: colToNesX(14), nesY: y(3), size: '8x8' },
    bomb_1:  { nesX: colToNesX(15), nesY: y(3), size: '8x8' },

    // Dungeon level: last digit of "LEVEL-X " (col 10) — 1 row above LIFE
    dungeon_lvl: { nesX: colToNesX(10), nesY: y(-1), size: '8x8' },

    // B-item icon (col 17, 1 row below LIFE, 8x16 sprite)
    b_item:  { nesX: colToNesX(17), nesY: y(1), size: '8x16' },

    // Sword/A-item icon (col 20, right half of A-box area, 8x16 sprite)
    sword:   { nesX: colToNesX(20), nesY: y(1), size: '8x16' },
  };
}
