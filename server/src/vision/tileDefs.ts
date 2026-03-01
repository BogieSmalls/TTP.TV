export const MAX_TEMPLATES = 32;

export interface TileDef {
  id: string;
  nesX: number;
  nesY: number;
  size: '8x8' | '8x16';
  templateGroup: string;
}

// Canonical NES positions derived from tileGrid.js.
// LIFE row is at NES y=16 (same row as rupees). All row offsets relative to LIFE.
// See server/src/public/vision-tab/tileGrid.js for the canonical layout.
export const TILE_DEFS: TileDef[] = [
  // Rupees: cols 13-15 (1-indexed), LIFE row (+0) -> nesY = 16
  { id: 'rupee_0', nesX: 96,  nesY: 16, size: '8x8', templateGroup: '8x8' },
  { id: 'rupee_1', nesX: 104, nesY: 16, size: '8x8', templateGroup: '8x8' },
  { id: 'rupee_2', nesX: 112, nesY: 16, size: '8x8', templateGroup: '8x8' },

  // Keys: cols 14-15 (1-indexed), LIFE row +2 -> nesY = 32
  { id: 'key_0', nesX: 104, nesY: 32, size: '8x8', templateGroup: '8x8' },
  { id: 'key_1', nesX: 112, nesY: 32, size: '8x8', templateGroup: '8x8' },

  // Bombs: cols 14-15 (1-indexed), LIFE row +3 -> nesY = 40
  { id: 'bomb_0', nesX: 104, nesY: 40, size: '8x8', templateGroup: '8x8' },
  { id: 'bomb_1', nesX: 112, nesY: 40, size: '8x8', templateGroup: '8x8' },

  // Dungeon level: col 9 (1-indexed), LIFE row -1 -> nesY = 8
  { id: 'dungeon_lvl', nesX: 64, nesY: 8, size: '8x8', templateGroup: '8x8' },

  // B item: col 17 (1-indexed), LIFE row +1 -> nesY = 24 (8x16 sprite)
  { id: 'b_item', nesX: 128, nesY: 24, size: '8x16', templateGroup: '8x16' },

  // Sword (A item): col 20 (1-indexed), LIFE row +1 -> nesY = 24 (8x16 sprite)
  { id: 'sword', nesX: 152, nesY: 24, size: '8x16', templateGroup: '8x16' },
];

// Template name registry — populated at server startup from templateServer response
export const TEMPLATE_NAMES: Record<string, string[]> = {
  '8x8': [],
  '8x16': [],
  drops_8x16: [],
  enemies_32x32: [],
};
