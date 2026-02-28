export const MAX_TEMPLATES = 32;

export interface TileDef {
  id: string;
  nesX: number;
  nesY: number;
  size: '8x8' | '8x16';
  templateGroup: string;
}

export const TILE_DEFS: TileDef[] = [
  // Rupees: 3 tiles at cols 12-14, row 2
  { id: 'rupee_0', nesX: 12*8, nesY: 2*8, size: '8x8', templateGroup: '8x8' },
  { id: 'rupee_1', nesX: 13*8, nesY: 2*8, size: '8x8', templateGroup: '8x8' },
  { id: 'rupee_2', nesX: 14*8, nesY: 2*8, size: '8x8', templateGroup: '8x8' },

  // Keys: cols 13-14, row 4
  { id: 'key_0', nesX: 13*8, nesY: 4*8, size: '8x8', templateGroup: '8x8' },
  { id: 'key_1', nesX: 14*8, nesY: 4*8, size: '8x8', templateGroup: '8x8' },

  // Bombs: cols 13-14, row 5
  { id: 'bomb_0', nesX: 13*8, nesY: 5*8, size: '8x8', templateGroup: '8x8' },
  { id: 'bomb_1', nesX: 14*8, nesY: 5*8, size: '8x8', templateGroup: '8x8' },

  // Dungeon level: col 8, row 1
  { id: 'dungeon_lvl', nesX: 8*8, nesY: 1*8, size: '8x8', templateGroup: '8x8' },

  // B item: col 16-17, rows 3-4 (8×16 sprite)
  { id: 'b_item', nesX: 16*8, nesY: 3*8, size: '8x16', templateGroup: '8x16' },

  // Sword (A item area, right half): col 20, rows 3-4
  { id: 'sword', nesX: 20*8+4, nesY: 3*8, size: '8x16', templateGroup: '8x16' },
];

// Template name registry — populated at server startup from templateServer response
// Used by PixelInterpreter to map template index → name
export const TEMPLATE_NAMES: Record<string, string[]> = {
  '8x8': [],
  '8x16': [],
  drops_8x16: [],
  enemies_32x32: [],
};
