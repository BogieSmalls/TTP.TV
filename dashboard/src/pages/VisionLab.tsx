import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Play, Square, RotateCcw } from 'lucide-react';
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

function screenTypeBadge(screenType: string): { bg: string; color: string } {
  switch (screenType) {
    case 'overworld': return { bg: 'rgba(52,211,153,0.2)', color: 'var(--success)' };
    case 'dungeon':   return { bg: 'rgba(99,102,241,0.2)', color: '#a5b4fc' };
    case 'cave':      return { bg: 'rgba(234,179,8,0.2)', color: 'var(--warning)' };
    case 'subscreen': return { bg: 'rgba(59,130,246,0.2)', color: '#93c5fd' };
    case 'death':     return { bg: 'rgba(239,68,68,0.2)', color: 'var(--danger)' };
    default:          return { bg: 'var(--bg-elevated)', color: 'var(--text-muted)' };
  }
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
// Returns null for 0 (undetected) or negative values — position byte 0 = C1,R1 is
// indistinguishable from "not detected", so we treat 0 as unknown.
function decodePosition(mapPos: number | null, screenType: string): { col: number; row: number } | null {
  if (mapPos == null || mapPos <= 0) return null;
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

interface PoolRacer {
  profile_id: string;
  name: string;
  twitch_name: string | null;
}

export default function VisionLab() {
  const [states, setStates] = useState<Record<string, VisionState>>({});
  const [events, setEvents] = useState<FlatEvent[]>([]);
  const [visitedRooms, setVisitedRooms] = useState<Record<string, Set<string>>>({});
  const [deathTimes, setDeathTimes] = useState<Record<string, number[]>>({});
  const [frameTicks, setFrameTicks] = useState<Record<string, number>>({});
  const [verification, setVerification] = useState<Record<string, { promoted: boolean; flaggedBad: boolean; ratio: number } | null>>({});
  const nextId = useRef(0);

  // VOD session form
  const [pool, setPool] = useState<PoolRacer[]>([]);
  const [vodUrl, setVodUrl] = useState('');
  const [vodStartTime, setVodStartTime] = useState('');
  const [vodProfileId, setVodProfileId] = useState('');
  const [vodRacerId, setVodRacerId] = useState('');
  const [vodActive, setVodActive] = useState<string | null>(null); // racerId of running session
  const [vodError, setVodError] = useState<string | null>(null);
  const [vodBusy, setVodBusy] = useState(false);

  useEffect(() => {
    fetch('/api/pool').then(r => r.json()).then((data: PoolRacer[]) => {
      const sorted = [...data].sort((a, b) => a.name.localeCompare(b.name));
      setPool(sorted);
      if (sorted.length > 0) {
        setVodProfileId(sorted[0].profile_id);
        setVodRacerId(sorted[0].name.toLowerCase());
      }
    }).catch(() => {});
  }, []);

  const resetRacer = useCallback(async (racerId: string) => {
    await fetch(`/api/vision/${racerId}/reset`, { method: 'POST' }).catch(() => {});
    setStates(prev => { const n = { ...prev }; delete n[racerId]; return n; });
    setVisitedRooms(prev => { const n = { ...prev }; delete n[racerId]; return n; });
    setDeathTimes(prev => { const n = { ...prev }; delete n[racerId]; return n; });
    setVerification(prev => { const n = { ...prev }; delete n[racerId]; return n; });
  }, []);

  // Poll verification status for active racers every 5s
  useEffect(() => {
    const racerIds = Object.keys(states);
    if (racerIds.length === 0) return;
    const poll = () => {
      racerIds.forEach(id => {
        fetch(`/api/vision/${id}/verification`)
          .then(r => r.json())
          .then(d => setVerification(prev => ({ ...prev, [id]: d.verification })))
          .catch(() => {});
      });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [Object.keys(states).join(',')]);

  const startVod = async () => {
    if (!vodUrl || !vodProfileId || !vodRacerId) return;
    setVodBusy(true);
    setVodError(null);
    try {
      const res = await fetch('/api/vision-vod/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ racerId: vodRacerId, vodUrl, profileId: vodProfileId, startTime: vodStartTime || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to start');
      setVodActive(vodRacerId);
    } catch (err) {
      setVodError(err instanceof Error ? err.message : String(err));
    } finally {
      setVodBusy(false);
    }
  };

  const stopVod = async () => {
    if (!vodActive) return;
    setVodBusy(true);
    try {
      await fetch('/api/vision-vod/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ racerId: vodActive }),
      });
      setVodActive(null);
    } finally {
      setVodBusy(false);
    }
  };

  const handleVision = useCallback((data: VisionState) => {
    setStates(prev => ({ ...prev, [data.racerId]: data }));
    setFrameTicks(prev => ({ ...prev, [data.racerId]: (prev[data.racerId] ?? 0) + 1 }));

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

  // Build alarm list: racers with >3 deaths in last 60s
  const now = Date.now();
  const alarms = racers
    .map(s => ({
      racerId: s.racerId,
      recentDeaths: (deathTimes[s.racerId] ?? []).filter(t => t > now - 60_000).length,
    }))
    .filter(a => a.recentDeaths > 3);

  return (
    <div className="space-y-6">
      <SectionHeader title="Vision Lab" />

      {/* VOD Session Panel */}
      <div
        className="rounded-lg p-4 border"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <div className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>VOD Session</div>
        <div className="flex gap-2 items-end flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Racer</label>
            <select
              value={vodProfileId}
              disabled={!!vodActive || vodBusy}
              onChange={e => {
                const r = pool.find(p => p.profile_id === e.target.value);
                setVodProfileId(e.target.value);
                if (r) setVodRacerId(r.name.toLowerCase());
              }}
              className="text-sm rounded px-2 py-1.5"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', minWidth: 140 }}
            >
              {pool.map(r => (
                <option key={r.profile_id} value={r.profile_id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1" style={{ minWidth: 240 }}>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>VOD URL</label>
            <input
              type="text"
              placeholder="https://www.twitch.tv/videos/..."
              value={vodUrl}
              disabled={!!vodActive || vodBusy}
              onChange={e => setVodUrl(e.target.value)}
              className="text-sm rounded px-2 py-1.5"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </div>
          <div className="flex flex-col gap-1" style={{ width: 90 }}>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Start (HH:MM:SS)</label>
            <input
              type="text"
              placeholder="0:00:00"
              value={vodStartTime}
              disabled={!!vodActive || vodBusy}
              onChange={e => setVodStartTime(e.target.value)}
              className="text-sm rounded px-2 py-1.5"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </div>
          {!vodActive ? (
            <button
              onClick={startVod}
              disabled={vodBusy || !vodUrl || !vodProfileId}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium"
              style={{ background: 'var(--accent)', color: '#000', opacity: vodBusy || !vodUrl ? 0.5 : 1 }}
            >
              <Play size={14} />
              {vodBusy ? 'Starting…' : 'Start'}
            </button>
          ) : (
            <button
              onClick={stopVod}
              disabled={vodBusy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium"
              style={{ background: 'rgba(239,68,68,0.2)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
            >
              <Square size={14} />
              {vodBusy ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
        {vodActive && (
          <div className="mt-2 text-xs" style={{ color: 'var(--success)' }}>
            ● Running: {vodActive}
          </div>
        )}
        {vodError && (
          <div className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{vodError}</div>
        )}
      </div>

      {alarms.length > 0 && (
        <div
          className="rounded-lg px-4 py-3 flex items-center gap-2 text-sm font-medium"
          style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid var(--danger)', color: 'var(--danger)' }}
        >
          <span>⚠</span>
          <span>
            FALSE DEATH LIKELY:{' '}
            {alarms.map(a => `${a.racerId} (${a.recentDeaths} deaths/min)`).join(', ')}
          </span>
        </div>
      )}

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
          {racers.map(s => {
            const pos = decodePosition(s.map_position, s.screen_type);
            const visited = visitedRooms[s.racerId] ?? new Set<string>();
            const recentDeaths = (deathTimes[s.racerId] ?? []).filter(t => t > Date.now() - 60_000).length;
            const totalDeaths = (deathTimes[s.racerId] ?? []).length;
            const sbadge = screenTypeBadge(s.screen_type);
            const isOverworld = s.screen_type === 'overworld' || s.screen_type === 'cave';
            const isDungeon = s.screen_type === 'dungeon';
            const verif = verification[s.racerId];

            return (
              <div
                key={s.racerId}
                className="rounded-lg p-4 border space-y-3"
                style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
              >
                {/* Header: name + badges + reset */}
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {s.racerId}
                  </h3>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Crop calibration status */}
                    {verif && (
                      <span
                        className="text-xs px-2 py-0.5 rounded font-medium"
                        style={{
                          background: verif.flaggedBad ? 'rgba(239,68,68,0.2)' : verif.promoted ? 'rgba(52,211,153,0.15)' : 'var(--bg-elevated)',
                          color: verif.flaggedBad ? 'var(--danger)' : verif.promoted ? 'var(--success)' : 'var(--text-muted)',
                        }}
                        title={`Crop calibration: ${(verif.ratio * 100).toFixed(0)}% gameplay frames`}
                      >
                        {verif.flaggedBad ? '⚠ bad crop' : verif.promoted ? '✓ crop ok' : `~${(verif.ratio * 100).toFixed(0)}%`}
                      </span>
                    )}
                    {totalDeaths > 0 && (
                      <span
                        className="text-xs px-2 py-0.5 rounded font-medium"
                        style={{
                          background: recentDeaths > 3 ? 'rgba(239,68,68,0.2)' : 'var(--bg-elevated)',
                          color: recentDeaths > 3 ? 'var(--danger)' : 'var(--text-muted)',
                        }}
                      >
                        {totalDeaths}☠{recentDeaths > 0 ? ` (${recentDeaths}/min)` : ''}
                      </span>
                    )}
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{ background: sbadge.bg, color: sbadge.color }}
                    >
                      {s.screen_type === 'dungeon' ? (s.dungeon_level > 0 ? `DUNGEON-${s.dungeon_level}` : 'DUNGEON') : s.screen_type.toUpperCase()}
                    </span>
                    <button
                      onClick={() => resetRacer(s.racerId)}
                      title="Reset cached state"
                      className="p-1 rounded hover:bg-white/10 transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <RotateCcw size={12} />
                    </button>
                  </div>
                </div>

                {/* Live frame preview */}
                <img
                  src={`/api/vision-py/${s.racerId}/frame?t=${frameTicks[s.racerId] ?? 0}`}
                  alt="vision frame"
                  style={{ width: '100%', maxHeight: '180px', objectFit: 'contain', borderRadius: 4, imageRendering: 'pixelated', display: 'block', background: '#000' }}
                />

                {/* Visual minimap */}
                {pos && isOverworld && (
                  <OverworldMinimap currentCol={pos.col} currentRow={pos.row} visited={visited} />
                )}
                {pos && isDungeon && (
                  <DungeonMinimap
                    currentCol={pos.col}
                    currentRow={pos.row}
                    dungeonLevel={s.dungeon_level}
                    visited={visited}
                  />
                )}
                {!pos && (
                  <div
                    className="text-xs text-center py-3 rounded"
                    style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}
                  >
                    no position data
                  </div>
                )}

                {/* HUD Values */}
                <div className="grid grid-cols-4 gap-2 text-center">
                  <HudVal label="Hearts" value={`${s.hearts_current}${s.has_half_heart ? '½' : ''}/${s.hearts_max}`} />
                  <HudVal label="Rupees" value={s.rupees} />
                  <HudVal label="Keys" value={s.keys} />
                  <HudVal label="Bombs" value={s.bombs} />
                </div>

                {/* Sword + B-item */}
                <div className="flex gap-4 text-xs">
                  <span style={{ color: 'var(--text-muted)' }}>Sword: <span style={{ color: 'var(--text-secondary)' }}>{s.sword_level}</span></span>
                  <span style={{ color: 'var(--text-muted)' }}>B-item: <span style={{ color: 'var(--text-secondary)' }}>{s.b_item ?? 'none'}</span></span>
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
            );
          })}
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
                loading={isCurrent ? 'eager' : 'lazy'}
                fetchPriority={isCurrent ? 'high' : 'auto'}
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

const DG_COLS = 8;
const DG_ROWS = 8;

function DungeonMinimap({
  currentCol,
  currentRow,
  dungeonLevel,
  visited,
}: {
  currentCol: number;
  currentRow: number;
  dungeonLevel: number;
  visited: Set<string>;
}) {
  return (
    <div>
      <div
        className="text-xs font-bold mb-1 text-center"
        style={{ color: 'var(--text-muted)', letterSpacing: '0.1em' }}
      >
        LEVEL {dungeonLevel}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${DG_COLS}, 1fr)`,
          gap: 2,
          background: 'var(--bg-base)',
          padding: 4,
          borderRadius: 4,
        }}
      >
        {Array.from({ length: DG_ROWS }, (_, rowIdx) =>
          Array.from({ length: DG_COLS }, (_, colIdx) => {
            const col = colIdx + 1;
            const row = rowIdx + 1;
            const isCurrent = col === currentCol && row === currentRow;
            const isVisited = visited.has(`dg:${col},${row}`);
            let bg = 'var(--bg-elevated)';
            if (isCurrent) bg = '#D4AF37';
            else if (isVisited) bg = 'rgba(52,211,153,0.3)';
            return (
              <div
                key={`${col}-${row}`}
                title={`C${col},R${row}`}
                style={{
                  aspectRatio: '1',
                  borderRadius: 2,
                  background: bg,
                  outline: isCurrent ? '1px solid rgba(212,175,55,0.8)' : undefined,
                  boxShadow: isCurrent ? '0 0 4px rgba(212,175,55,0.6)' : undefined,
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
