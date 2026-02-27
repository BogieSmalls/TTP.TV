import { EventEmitter } from 'node:events';

export interface MapMarker {
  col: number;     // 1-16 (overworld) or 1-8 (dungeon)
  row: number;     // 1-8
  type: 'dungeon' | 'landmark';
  label: string;   // "L3", "White Sword", etc.
  discoveredBy: string; // racerId who found it
  timestamp: number;
}

export interface RacerPosition {
  racerId: string;
  col: number;
  row: number;
  screenType: 'overworld' | 'dungeon' | 'cave';
  dungeonLevel?: number;
}

export class SeedMapState extends EventEmitter {
  private markers = new Map<string, MapMarker>(); // key: "col,row,label"
  private positions = new Map<string, RacerPosition>();

  /** Update a racer's current position on the overworld/dungeon map. */
  updatePosition(racerId: string, col: number, row: number, screenType: string, dungeonLevel?: number): void {
    if (screenType !== 'overworld' && screenType !== 'dungeon' && screenType !== 'cave') return;
    this.positions.set(racerId, {
      racerId,
      col,
      row,
      screenType: screenType as RacerPosition['screenType'],
      dungeonLevel,
    });
    this.emit('positionUpdate', this.getState());
  }

  /** Pin a dungeon entrance discovered by a racer. */
  addDungeonMarker(racerId: string, col: number, row: number, dungeonLevel: number): void {
    const key = `${col},${row},L${dungeonLevel}`;
    if (this.markers.has(key)) return; // already discovered
    this.markers.set(key, {
      col,
      row,
      type: 'dungeon',
      label: `L${dungeonLevel}`,
      discoveredBy: racerId,
      timestamp: Date.now(),
    });
    this.emit('markerUpdate', this.getState());
  }

  /** Pin a landmark (sword cave, etc.). */
  addLandmark(racerId: string, col: number, row: number, label: string): void {
    const key = `${col},${row},${label}`;
    if (this.markers.has(key)) return;
    this.markers.set(key, {
      col,
      row,
      type: 'landmark',
      label,
      discoveredBy: racerId,
      timestamp: Date.now(),
    });
    this.emit('markerUpdate', this.getState());
  }

  getState(): { markers: MapMarker[]; positions: RacerPosition[] } {
    return {
      markers: Array.from(this.markers.values()),
      positions: Array.from(this.positions.values()),
    };
  }

  clear(): void {
    this.markers.clear();
    this.positions.clear();
  }
}
