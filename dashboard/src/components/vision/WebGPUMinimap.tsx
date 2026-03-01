import { useEffect, useRef, useState } from 'react';

interface RoomTemplate {
  id: number;
  col: number;
  row: number;
  data: string; // base64 JPEG data URL
}

interface Props {
  mapPosition: number;
  screenType: string;
  dungeonLevel: number;
}

function decodePosition(mapPosition: number): { col: number; row: number } {
  return {
    col: (mapPosition & 0x0F) + 1,
    row: (mapPosition >> 4) + 1,
  };
}

export function WebGPUMinimap({ mapPosition, screenType, dungeonLevel }: Props) {
  const [tileMap, setTileMap] = useState<Map<string, string>>(new Map());
  // visited rooms: Map<dungeonLevel, Set<mapPosition>>
  const visitedRef = useRef<Map<number, Set<number>>>(new Map());

  // Fetch room templates once on mount
  useEffect(() => {
    fetch('/api/vision/room-templates')
      .then(r => r.json())
      .then((data: RoomTemplate[]) => {
        const m = new Map<string, string>();
        data.forEach(t => m.set(`${t.col}-${t.row}`, t.data));
        setTileMap(m);
      })
      .catch(() => {/* silently ignore — map still functional without tiles */});
  }, []);

  // Track visited rooms
  useEffect(() => {
    if (mapPosition === 0) return;
    const key = screenType === 'dungeon' ? dungeonLevel : 0;
    if (!visitedRef.current.has(key)) visitedRef.current.set(key, new Set());
    visitedRef.current.get(key)!.add(mapPosition);
  }, [mapPosition, screenType, dungeonLevel]);

  const isDungeon = screenType === 'dungeon';
  const currentPos = decodePosition(mapPosition);
  const visitedKey = isDungeon ? dungeonLevel : 0;
  const visited = visitedRef.current.get(visitedKey) ?? new Set<number>();

  if (isDungeon) {
    // 8×8 dungeon traversal grid
    return (
      <div>
        <div className="text-xs text-gray-400 mb-1">Dungeon {dungeonLevel}</div>
        <div className="grid gap-px" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
          {Array.from({ length: 64 }, (_, i) => {
            const col = (i % 8) + 1;
            const row = Math.floor(i / 8) + 1;
            const pos = ((row - 1) << 4) | (col - 1);
            const isCurrent = currentPos.col === col && currentPos.row === row;
            const isVisited = visited.has(pos);
            return (
              <div
                key={i}
                className={`w-4 h-4 rounded-sm ${
                  isCurrent ? 'bg-yellow-400' :
                  isVisited ? 'bg-blue-600 opacity-70' :
                  'bg-gray-800'
                }`}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // 16×8 overworld tile grid
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">Overworld</div>
      <div className="grid gap-px" style={{ gridTemplateColumns: 'repeat(16, 1fr)' }}>
        {Array.from({ length: 128 }, (_, i) => {
          const col = (i % 16) + 1;
          const row = Math.floor(i / 16) + 1;
          const isCurrent = currentPos.col === col && currentPos.row === row;
          const pos = ((row - 1) << 4) | (col - 1);
          const isVisited = visited.has(pos);
          const src = tileMap.get(`${col}-${row}`);
          return (
            <div
              key={i}
              className={`relative ${isCurrent ? 'ring-2 ring-yellow-400 ring-inset z-10' : ''}`}
            >
              {src ? (
                <img
                  src={src}
                  alt={`C${col}R${row}`}
                  className={`w-full block ${!isVisited && !isCurrent ? 'opacity-40' : ''}`}
                />
              ) : (
                <div
                  className={`w-full bg-gray-800 ${!isVisited && !isCurrent ? 'opacity-40' : ''}`}
                  style={{ paddingTop: '68.75%' /* 44/64 aspect ratio */ }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
