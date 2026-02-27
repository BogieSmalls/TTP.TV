import type { LearnAnnotationType } from '../../lib/learnApi';

export const SCREEN_TYPE_COLORS: Record<string, string> = {
  overworld: '#22c55e',
  dungeon: '#ef4444',
  cave: '#92400e',
  subscreen: '#3b82f6',
  title: '#eab308',
  unknown: '#6b7280',
};

export const ZELDA_ITEMS = [
  'wooden_sword', 'white_sword', 'magical_sword',
  'boomerang', 'magical_boomerang',
  'bow', 'silver_arrows',
  'blue_candle', 'red_candle',
  'recorder', 'food', 'letter',
  'blue_potion', 'red_potion',
  'magic_rod', 'book',
  'raft', 'ladder', 'stepladder',
  'blue_ring', 'red_ring',
  'power_bracelet', 'magical_shield', 'magic_key',
  'heart_container', 'triforce_piece',
  'bomb_upgrade', 'key', 'compass', 'map',
];

export interface AnnotationTypeConfig {
  label: string;
  icon: string;
  color: string;
  quickAdd?: boolean;
}

export const ANNOTATION_CONFIG: Record<LearnAnnotationType, AnnotationTypeConfig> = {
  item_pickup:   { label: 'Item Pickup',   icon: 'Package',       color: '#a855f7', quickAdd: true },
  dungeon_enter: { label: 'Enter Dungeon', icon: 'DoorOpen',      color: '#ef4444', quickAdd: true },
  dungeon_exit:  { label: 'Exit Dungeon',  icon: 'DoorClosed',    color: '#f97316', quickAdd: true },
  location:      { label: 'Location',      icon: 'MapPin',        color: '#22c55e', quickAdd: true },
  strategy:      { label: 'Strategy',      icon: 'Lightbulb',     color: '#3b82f6', quickAdd: true },
  door_repair:   { label: 'Door Repair',   icon: 'Hammer',        color: '#eab308', quickAdd: true },
  death:         { label: 'Death',         icon: 'Skull',         color: '#dc2626', quickAdd: true },
  game_event:    { label: 'Event',         icon: 'Zap',           color: '#06b6d4', quickAdd: true },
  note:          { label: 'Note',          icon: 'StickyNote',    color: '#9ca3af', quickAdd: true },
  bookmark:      { label: 'Bookmark',      icon: 'Bookmark',      color: '#d4af37' },
  correction:    { label: 'Correction',    icon: 'PenLine',       color: '#f59e0b' },
  error:         { label: 'Error',         icon: 'AlertTriangle', color: '#ef4444' },
};

export const B_ITEMS = [
  'boomerang', 'bomb', 'bow', 'candle', 'recorder',
  'food', 'blue_potion', 'red_potion', 'magic_rod',
] as const;

export const SCREEN_TYPES = [
  'overworld', 'dungeon', 'cave', 'subscreen', 'title', 'unknown',
] as const;

export function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatTimestampLong(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
