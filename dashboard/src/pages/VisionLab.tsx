import { useCallback, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { useSocketEvent } from '../hooks/useSocket';
import { SectionHeader } from '../ui';

interface FlatEvent {
  id: number;
  racerId: string;
  type: string;
  description: string;
  timestamp: number;
}

const HIGH_EVENTS = new Set([
  'triforce_inferred', 'death', 'game_complete', 'ganon_fight', 'ganon_kill',
]);
const MEDIUM_EVENTS = new Set([
  'heart_container', 'dungeon_first_visit', 'sword_upgrade', 'staircase_item_acquired',
]);

function eventColor(type: string): { bg: string; text: string } {
  if (HIGH_EVENTS.has(type)) return { bg: 'rgba(239,68,68,0.2)', text: 'var(--danger)' };
  if (MEDIUM_EVENTS.has(type)) return { bg: 'rgba(234,179,8,0.2)', text: 'var(--warning)' };
  return { bg: 'var(--bg-elevated)', text: 'var(--text-muted)' };
}

interface VisionState {
  racerId: string;
  screen_type: string;
  dungeon_level: number;
  hearts_current: number;
  hearts_max: number;
  has_half_heart: boolean;
  rupees: number;
  keys: number;
  bombs: number;
  b_item: string | null;
  sword_level: number;
  items: Record<string, boolean>;
  triforce: boolean[];
  map_position: number | null;
}

const ITEMS = [
  'boomerang', 'magic_boomerang', 'bow', 'silver_arrows',
  'blue_candle', 'red_candle', 'recorder', 'food',
  'letter', 'potion_red', 'potion_blue', 'magic_rod',
  'raft', 'ladder', 'book', 'ring_blue', 'ring_red',
  'power_bracelet', 'magic_shield', 'magic_key',
];

// Decode NES map_position byte → 1-based {col, row}
function decodePosition(mapPos: number | null, screenType: string): { col: number; row: number } | null {
  if (mapPos == null || mapPos < 0) return null;
  if (screenType === 'overworld' || screenType === 'cave') {
    return { col: (mapPos % 16) + 1, row: Math.floor(mapPos / 16) + 1 };
  }
  if (screenType === 'dungeon') {
    return { col: (mapPos % 8) + 1, row: Math.floor(mapPos / 8) + 1 };
  }
  return null;
}

function roomImageUrl(col: number, row: number): string {
  return `/api/learn/rooms/C${col}_R${row}.jpg`;
}

export default function VisionLab() {
  const [states, setStates] = useState<Record<string, VisionState>>({});
  const [events, setEvents] = useState<FlatEvent[]>([]);
  const [visitedRooms, setVisitedRooms] = useState<Record<string, Set<string>>>({});
  const [deathTimes, setDeathTimes] = useState<Record<string, number[]>>({});
  const nextId = useRef(0);

  const handleVision = useCallback((data: VisionState) => {
    setStates(prev => ({ ...prev, [data.racerId]: data }));

    // Track visited rooms for minimap dimming
    const pos = decodePosition(data.map_position, data.screen_type);
    if (pos) {
      const screenCategory = (data.screen_type === 'overworld' || data.screen_type === 'cave') ? 'ow' : 'dg';
      const key = `${screenCategory}:${pos.col},${pos.row}`;
      setVisitedRooms(prev => {
        const existing = prev[data.racerId] ?? new Set<string>();
        if (existing.has(key)) return prev; // no change needed
        const next = new Set(existing);
        next.add(key);
        return { ...prev, [data.racerId]: next };
      });
    }
  }, []);

  const handleVisionEvents = useCallback((data: { racerId: string; events: Array<{ type: string; description?: string }> }) => {
    const now = Date.now();

    // Track death timestamps for alarm (keep last 60s only)
    const deaths = data.events.filter(e => e.type === 'death');
    if (deaths.length > 0) {
      setDeathTimes(prev => {
        const cutoff = now - 60_000;
        const existing = (prev[data.racerId] ?? []).filter(t => t > cutoff);
        return { ...prev, [data.racerId]: [...existing, ...deaths.map(() => now)] };
      });
    }

    const flat: FlatEvent[] = data.events.map(e => ({
      id: nextId.current++,
      racerId: data.racerId,
      type: e.type,
      description: e.description ?? e.type,
      timestamp: now,
    }));
    setEvents(prev => [...flat, ...prev].slice(0, 100));
  }, []);

  useSocketEvent('vision:raw', handleVision);
  useSocketEvent('vision:events', handleVisionEvents);

  const racers = Object.values(states);

  return (
    <div className="space-y-6">
      <SectionHeader title="Vision Lab" />

      {racers.length === 0 ? (
        <div
          className="rounded-lg p-8 border text-center"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
        >
          <Eye size={32} className="mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Waiting for vision engine data...</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Start a stream and run the Python vision engine to see live detections
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {racers.map(s => (
            <div
              key={s.racerId}
              className="rounded-lg p-4 border space-y-3"
              style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.racerId}</h3>
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
                >
                  {s.screen_type}
                </span>
              </div>

              {/* HUD Values */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <HudVal label="Hearts" value={`${s.hearts_current}/${s.hearts_max}${s.has_half_heart ? '½' : ''}`} />
                <HudVal label="Rupees" value={s.rupees} />
                <HudVal label="Keys" value={s.keys} />
                <HudVal label="Bombs" value={s.bombs} />
              </div>

              {/* Sword + B-item */}
              <div className="flex gap-4 text-xs">
                <span style={{ color: 'var(--text-muted)' }}>Sword: <span style={{ color: 'var(--text-secondary)' }}>{s.sword_level}</span></span>
                <span style={{ color: 'var(--text-muted)' }}>B-item: <span style={{ color: 'var(--text-secondary)' }}>{s.b_item ?? 'none'}</span></span>
                {s.map_position != null && (
                  <span style={{ color: 'var(--text-muted)' }}>Map: <span style={{ color: 'var(--text-secondary)' }}>0x{s.map_position.toString(16).padStart(2, '0')}</span></span>
                )}
              </div>

              {/* Triforce */}
              <div>
                <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Triforce</div>
                <div className="flex gap-1">
                  {(s.triforce || Array(8).fill(false)).map((has, i) => (
                    <div
                      key={i}
                      className="w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold"
                      style={{
                        background: has ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                        color: has ? 'var(--accent)' : 'var(--text-muted)',
                      }}
                    >
                      {i + 1}
                    </div>
                  ))}
                </div>
              </div>

              {/* Items */}
              <div>
                <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Items</div>
                <div className="flex flex-wrap gap-1">
                  {ITEMS.map(item => {
                    const has = s.items?.[item];
                    return (
                      <span
                        key={item}
                        className="px-1.5 py-0.5 rounded text-[10px]"
                        style={{
                          background: has ? 'rgba(52,211,153,0.15)' : 'var(--bg-elevated)',
                          color: has ? 'var(--success)' : 'var(--text-muted)',
                        }}
                      >
                        {item.replace(/_/g, ' ')}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Event Log */}
      <div
        className="rounded-lg border p-4"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          Game Events
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>({events.length})</span>
        </h3>
        {events.length === 0 ? (
          <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>No events yet</p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1">
            {events.map(e => {
              const ec = eventColor(e.type);
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-2 text-xs py-1 border-b"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <span className="w-16 shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="w-24 shrink-0 truncate" style={{ color: 'var(--text-secondary)' }}>{e.racerId}</span>
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{ background: ec.bg, color: ec.text }}
                  >
                    {e.type}
                  </span>
                  <span className="truncate" style={{ color: 'var(--text-muted)' }}>{e.description}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HudVal({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded p-2" style={{ background: 'var(--bg-base)' }}>
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

const OW_COLS = 16;
const OW_ROWS = 8;

function OverworldMinimap({
  currentCol,
  currentRow,
  visited,
}: {
  currentCol: number;
  currentRow: number;
  visited: Set<string>;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${OW_COLS}, 1fr)`,
        gap: 1,
        background: 'var(--bg-base)',
        padding: 4,
        borderRadius: 4,
      }}
    >
      {Array.from({ length: OW_ROWS }, (_, rowIdx) =>
        Array.from({ length: OW_COLS }, (_, colIdx) => {
          const col = colIdx + 1;
          const row = rowIdx + 1;
          const isCurrent = col === currentCol && row === currentRow;
          const isVisited = visited.has(`ow:${col},${row}`);
          return (
            <div
              key={`${col}-${row}`}
              title={`C${col},R${row}`}
              style={{
                position: 'relative',
                aspectRatio: '256/176',
                overflow: 'hidden',
                borderRadius: 1,
                outline: isCurrent ? '2px solid #D4AF37' : undefined,
                boxShadow: isCurrent ? '0 0 6px rgba(212,175,55,0.8)' : undefined,
                zIndex: isCurrent ? 1 : 0,
              }}
            >
              <img
                src={roomImageUrl(col, row)}
                alt={`C${col}R${row}`}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                  opacity: isCurrent ? 1 : isVisited ? 0.85 : 0.25,
                  filter: isCurrent ? 'none' : isVisited ? 'none' : 'grayscale(60%)',
                }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}
