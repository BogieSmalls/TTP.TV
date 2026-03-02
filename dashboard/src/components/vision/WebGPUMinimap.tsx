import { useEffect, useRef, useState } from 'react';
import linkSprite from '../../assets/link-front.gif';

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
  dungeonRoomImages?: Map<number, Map<number, string>>;
}

function decodePosition(mapPosition: number, gridCols: number): { col: number; row: number } {
  return {
    col: (mapPosition % gridCols) + 1,
    row: Math.floor(mapPosition / gridCols) + 1,
  };
}

export function WebGPUMinimap({ mapPosition, screenType, dungeonLevel, dungeonRoomImages }: Props) {
  const [tileMap, setTileMap] = useState<Map<string, string>>(new Map());
  // visited rooms: Map<dungeonLevel, Set<mapPosition>>
  const visitedRef = useRef<Map<number, Set<number>>>(new Map());
  // Sticky dungeon level: once we enter a dungeon, keep showing it until
  // we see sustained overworld gameplay (handles Up+A warp transitions where
  // screenType can briefly flicker to 'overworld' during the animation)
  const stickyDungeonRef = useRef(0);
  const overworldStreakRef = useRef(0);
  const OW_STREAK_THRESHOLD = 60; // ~2 seconds at 30fps before flipping to overworld

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

  // Update sticky dungeon level — require sustained overworld before clearing
  if (dungeonLevel > 0) {
    stickyDungeonRef.current = dungeonLevel;
    overworldStreakRef.current = 0;
  } else if (screenType === 'overworld' && dungeonLevel === 0) {
    overworldStreakRef.current++;
    if (stickyDungeonRef.current === 0 || overworldStreakRef.current >= OW_STREAK_THRESHOLD) {
      stickyDungeonRef.current = 0;
    }
  } else {
    // Non-gameplay screen (transition/death/subscreen) — reset streak, keep dungeon
    overworldStreakRef.current = 0;
  }

  // Track visited rooms
  useEffect(() => {
    if (mapPosition < 0) return;
    const key = screenType === 'dungeon' ? dungeonLevel : 0;
    if (!visitedRef.current.has(key)) visitedRef.current.set(key, new Set());
    visitedRef.current.get(key)!.add(mapPosition);
  }, [mapPosition, screenType, dungeonLevel]);

  const effectiveDungeon = stickyDungeonRef.current;
  const isDungeon = effectiveDungeon > 0;
  const gridCols = isDungeon ? 8 : 16;
  const currentPos = decodePosition(mapPosition, gridCols);
  const visitedKey = isDungeon ? effectiveDungeon : 0;
  const visited = visitedRef.current.get(visitedKey) ?? new Set<number>();

  if (isDungeon) {
    const levelImages = dungeonRoomImages?.get(effectiveDungeon);
    // 8×8 dungeon grid with fixed 96×66 cells
    return (
      <div>
        <div className="text-xs text-gray-400 mb-1">Dungeon {effectiveDungeon}</div>
        <div className="inline-grid gap-px" style={{
          gridTemplateColumns: 'repeat(8, 96px)',
          gridTemplateRows: 'repeat(8, 66px)',
        }}>
          {Array.from({ length: 64 }, (_, i) => {
            const col = (i % 8) + 1;
            const row = Math.floor(i / 8) + 1;
            const pos = (row - 1) * 8 + (col - 1);
            const isCurrent = mapPosition >= 0 && currentPos.col === col && currentPos.row === row;
            const isVisited = visited.has(pos);
            const roomSrc = levelImages?.get(pos);
            return (
              <div
                key={i}
                className="relative"
                style={{
                  width: 96, height: 66,
                  ...(isCurrent ? { outline: '2px solid #4ade80', outlineOffset: '-2px', zIndex: 10 } : {}),
                }}
              >
                {roomSrc ? (
                  <img
                    src={roomSrc}
                    alt={`D${effectiveDungeon} C${col}R${row}`}
                    className={`block ${!isVisited && !isCurrent ? 'opacity-40' : ''}`}
                    style={{ width: 96, height: 66, imageRendering: 'pixelated' }}
                  />
                ) : (
                  <div
                    className={`rounded-sm ${
                      isVisited ? 'bg-blue-600 opacity-70' : 'bg-gray-800'
                    } ${!isVisited && !isCurrent ? 'opacity-40' : ''}`}
                    style={{ width: 96, height: 66 }}
                  />
                )}
                {isCurrent && (
                  <img
                    src={linkSprite}
                    alt="Link"
                    className="absolute inset-0 m-auto object-contain pointer-events-none z-20"
                    style={{ width: '40%', height: '40%', imageRendering: 'pixelated' }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 16×8 overworld tile grid
  const hasPosition = mapPosition >= 0;
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">Overworld</div>
      <div className="grid gap-px" style={{ gridTemplateColumns: 'repeat(16, 1fr)' }}>
        {Array.from({ length: 128 }, (_, i) => {
          const col = (i % 16) + 1;
          const row = Math.floor(i / 16) + 1;
          const isCurrent = hasPosition && currentPos.col === col && currentPos.row === row;
          const pos = (row - 1) * 16 + (col - 1);
          const isVisited = visited.has(pos);
          const src = tileMap.get(`${col}-${row}`);
          return (
            <div
              key={i}
              className={`relative ${isCurrent ? 'ring-2 ring-green-400 ring-inset z-10' : ''}`}
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
              {isCurrent && (
                <img
                  src={linkSprite}
                  alt="Link"
                  className="absolute inset-0 m-auto w-3/4 h-3/4 object-contain pointer-events-none z-20"
                  style={{ imageRendering: 'pixelated' }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
