import { useEffect, useRef, useState } from 'react';

interface RoomTemplate {
  id: number;
  col: number;
  row: number;
  pixels: number[];  // 64×44×3 floats 0-1
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
  const [templates, setTemplates] = useState<RoomTemplate[]>([]);
  // visited rooms: Map<dungeonLevel, Set<mapPosition>>
  const visitedRef = useRef<Map<number, Set<number>>>(new Map());
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // Fetch room templates once on mount
  useEffect(() => {
    fetch('/api/vision/room-templates')
      .then(r => r.json())
      .then((data: RoomTemplate[]) => setTemplates(data))
      .catch(() => {/* silently ignore — map still functional without tiles */});
  }, []);

  // Track visited rooms
  useEffect(() => {
    if (mapPosition === 0) return;
    const key = screenType === 'dungeon' ? dungeonLevel : 0;
    if (!visitedRef.current.has(key)) visitedRef.current.set(key, new Set());
    visitedRef.current.get(key)!.add(mapPosition);
  }, [mapPosition, screenType, dungeonLevel]);

  // Draw room tile onto canvas
  useEffect(() => {
    templates.forEach(t => {
      const canvas = canvasRefs.current.get(`${t.col}-${t.row}`);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const imageData = ctx.createImageData(64, 44);
      for (let i = 0; i < t.pixels.length / 3; i++) {
        imageData.data[i * 4 + 0] = Math.round(t.pixels[i * 3 + 0] * 255);
        imageData.data[i * 4 + 1] = Math.round(t.pixels[i * 3 + 1] * 255);
        imageData.data[i * 4 + 2] = Math.round(t.pixels[i * 3 + 2] * 255);
        imageData.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    });
  }, [templates]);

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
          return (
            <div
              key={i}
              className={`relative ${isCurrent ? 'ring-2 ring-yellow-400 ring-inset z-10' : ''}`}
            >
              <canvas
                ref={el => {
                  if (el) canvasRefs.current.set(`${col}-${row}`, el);
                }}
                width={64}
                height={44}
                className={`w-full block ${!isVisited && !isCurrent ? 'opacity-40' : ''}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
