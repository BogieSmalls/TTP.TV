import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket, useSocketEvent } from '../hooks/useSocket.js';
import { WebGPUMinimap } from '../components/vision/WebGPUMinimap.js';
import { DebugFrame } from '../components/vision/DebugFrame.js';
import { WebGPUEventLog } from '../components/vision/WebGPUEventLog.js';

// Local copies of server types (mirrors server/src/vision/types.ts)
interface StableGameState {
  screenType: string;
  dungeonLevel: number;
  rupees: number;
  keys: number;
  bombs: number;
  heartsCurrentStable: number;
  heartsMaxStable: number;
  bItem: string | null;
  swordLevel: number;
  hasMasterKey: boolean;
  mapPosition: number;
  floorItems: Array<{ name: string; x: number; y: number; score: number }>;
  triforceCollected: number;
}

interface PendingFieldInfo {
  field: string;
  stableValue: unknown;
  pendingValue: unknown;
  count: number;
  threshold: number;
}

interface WebGPUStateUpdate {
  racerId: string;
  stable: StableGameState;
  pending: PendingFieldInfo[];
  timestamp: number;
  frameCount: number;
  diag?: { brightness: number; redAtLife: number; goldPixels: number };
}

// Friendly display names for pending fields
const FIELD_LABELS: Record<string, string> = {
  heartsCurrent: 'hearts', heartsMax: 'hearts max', screenType: 'screen',
  rupees: 'rupees', keys: 'keys', bombs: 'bombs', dungeonLevel: 'dungeon',
  bItem: 'b-item', swordLevel: 'sword', hasMasterKey: 'master key',
  mapPosition: 'room', triforce: 'triforce',
};

function HeartDisplay({ current, max }: { current: number; max: number }) {
  if (max === 0) return <span>—</span>;
  return <span>{current}/{max}</span>;
}

function TriforceDisplay({ value }: { value: number }) {
  // value is a count (0-8), not a bitmask
  return (
    <span>
      {'■'.repeat(Math.min(value, 8))}{'□'.repeat(Math.max(0, 8 - value))}
    </span>
  );
}

function swordLabel(level: number): string {
  return ['none', 'wood', 'white', 'magical'][level] ?? `L${level}`;
}

export default function WebGPUVision() {
  const socket = useSocket();
  const [racerIds, setRacerIds] = useState<string[]>([]);
  const [selectedRacer, setSelectedRacer] = useState<string | null>(null);
  const [racerInput, setRacerInput] = useState('');
  const [streamUrl, setStreamUrl] = useState('');
  const [stable, setStable] = useState<StableGameState | null>(null);
  const [pending, setPending] = useState<PendingFieldInfo[]>([]);
  const [diag, setDiag] = useState<{ brightness: number; redAtLife: number; goldPixels: number } | null>(null);
  const [fps, setFps] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [latency, setLatency] = useState(0);
  const [startOffset, setStartOffset] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const frameTimesRef = useRef<number[]>([]);
  const prevRacerRef = useRef<string | null>(null);
  const [dungeonRoomImages, setDungeonRoomImages] = useState<Map<number, Map<number, string>>>(new Map());

  // Fetch active racers on mount
  useEffect(() => {
    fetch('/api/vision/racers')
      .then(r => r.json())
      .then((d: { racerIds: string[] }) => {
        setRacerIds(d.racerIds);
        if (d.racerIds.length === 1) {
          setRacerInput(d.racerIds[0]);
          setSelectedRacer(d.racerIds[0]);
        }
      })
      .catch(() => {});
  }, []);

  // Manage debug stream start/stop when selected racer changes
  useEffect(() => {
    if (prevRacerRef.current && prevRacerRef.current !== selectedRacer) {
      socket.emit('vision:stopDebugStream', prevRacerRef.current);
    }
    if (selectedRacer) {
      socket.emit('vision:startDebugStream', selectedRacer);
    }
    prevRacerRef.current = selectedRacer;
    return () => {
      if (selectedRacer) socket.emit('vision:stopDebugStream', selectedRacer);
    };
  }, [selectedRacer, socket]);

  // Receive state updates — stable callback reference to avoid hook re-registration
  const handleStateUpdate = useCallback((update: WebGPUStateUpdate) => {
    if (update.racerId !== selectedRacer) return;
    setStable(update.stable);
    setPending(update.pending);
    if (update.diag) setDiag(update.diag);
    const now = Date.now();
    setLatency(now - update.timestamp);
    setFrameCount(update.frameCount);
    frameTimesRef.current.push(now);
    frameTimesRef.current = frameTimesRef.current.filter(t => now - t < 1000);
    setFps(frameTimesRef.current.length);
  }, [selectedRacer]);

  useSocketEvent<WebGPUStateUpdate>('vision:webgpu:state', handleStateUpdate);

  const handleRoomSnapshot = useCallback((data: { racerId: string; dungeonLevel: number; mapPosition: number; jpeg: string }) => {
    if (data.racerId !== selectedRacer) return;
    setDungeonRoomImages(prev => {
      const next = new Map(prev);
      const levelMap = new Map(next.get(data.dungeonLevel) ?? []);
      levelMap.set(data.mapPosition, `data:image/jpeg;base64,${data.jpeg}`);
      next.set(data.dungeonLevel, levelMap);
      return next;
    });
  }, [selectedRacer]);

  useSocketEvent<{ racerId: string; dungeonLevel: number; mapPosition: number; jpeg: string }>('vision:roomSnapshot', handleRoomSnapshot);

  const racerId = racerInput.trim();
  const isRunning = racerId !== '' && racerIds.includes(racerId);
  const canStart = racerId !== '' && streamUrl.trim() !== '' && !isRunning && !starting;

  /** Parse "H:MM:SS", "MM:SS", or plain seconds into seconds */
  function parseOffset(s: string): number | null {
    const trimmed = s.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }

  async function handleStart() {
    if (!canStart) return;
    setStartError(null);
    setStarting(true);
    try {
      const body: Record<string, unknown> = { streamUrl: streamUrl.trim() };
      const offset = parseOffset(startOffset);
      if (offset !== null) body.startOffset = offset;
      const res = await fetch(`/api/vision/${racerId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSelectedRacer(racerId);
      setRacerIds(prev => prev.includes(racerId) ? prev : [...prev, racerId]);
    } catch (e: unknown) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (!racerId) return;
    await fetch(`/api/vision/${racerId}`, { method: 'DELETE' });
    setRacerIds(prev => prev.filter(id => id !== racerId));
    if (selectedRacer === racerId) {
      setSelectedRacer(null);
      setStable(null);
      setPending([]);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-[#0f0f1a] text-white p-2 gap-2">

      {/* Header */}
      <div className="flex flex-col gap-1 px-2 py-2 bg-[#1a1a2e] rounded">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Racer ID */}
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400 shrink-0">Racer</label>
            <input
              list="racer-datalist"
              value={racerInput}
              onChange={e => {
                setRacerInput(e.target.value);
                if (racerIds.includes(e.target.value)) setSelectedRacer(e.target.value);
              }}
              placeholder="racer id"
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-28"
            />
            <datalist id="racer-datalist">
              {racerIds.map(id => <option key={id} value={id} />)}
            </datalist>
          </div>

          {/* Stream / VOD URL */}
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <label className="text-xs text-gray-400 shrink-0">URL</label>
            <input
              value={streamUrl}
              onChange={e => setStreamUrl(e.target.value)}
              placeholder="https://twitch.tv/channel  or  https://twitch.tv/videos/123456"
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-full"
            />
          </div>

          {/* Start offset */}
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400 shrink-0">Start at</label>
            <input
              value={startOffset}
              onChange={e => setStartOffset(e.target.value)}
              placeholder="0:11:30"
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-20"
            />
          </div>

          {/* Start / Stop */}
          <div className="flex gap-2 ml-auto">
            <button
              onClick={handleStart}
              disabled={!canStart}
              className="px-3 py-1 text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded"
            >{starting ? 'Starting…' : 'Start'}</button>
            <button
              onClick={handleStop}
              disabled={!isRunning}
              className="px-3 py-1 text-xs bg-red-800 hover:bg-red-700 disabled:opacity-40 rounded"
            >Stop</button>
          </div>
        </div>

        {/* Status row */}
        <div className="flex items-center gap-4 flex-wrap">
          <span className={`text-xs ${fps > 0 ? 'text-green-400' : 'text-gray-500'}`}>● {fps}fps</span>
          <span className="text-xs text-gray-400">⬡ {frameCount.toLocaleString()} frames</span>
          <span className="text-xs text-gray-400">⚡ {latency}ms</span>
          {isRunning && <span className="text-xs text-green-500">● live: {racerId}</span>}
          {startError && <span className="text-xs text-red-400">✗ {startError}</span>}
          {diag && (
            <span className="text-xs text-gray-500 ml-auto font-mono">
              bri={diag.brightness.toFixed(1)} red={diag.redAtLife.toFixed(1)} gold={diag.goldPixels}
            </span>
          )}
        </div>
      </div>

      {/* Top state row */}
      <div className="grid grid-cols-2 gap-2">
        {/* Left: primary state */}
        <div className="bg-[#1a1a2e] rounded p-3 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-gray-400">screen</span>
            <span>{stable?.screenType ?? '—'}</span>
            <span className="text-gray-400">hearts</span>
            <span>{stable ? <HeartDisplay current={stable.heartsCurrentStable} max={stable.heartsMaxStable} /> : '—'}</span>
            <span className="text-gray-400">rupees</span>
            <span>{stable?.rupees ?? '—'}</span>
            <span className="text-gray-400">keys</span>
            <span>{stable?.keys ?? '—'}</span>
            <span className="text-gray-400">bombs</span>
            <span>{stable?.bombs ?? '—'}</span>
          </div>
        </div>

        {/* Right: secondary state + pending (fixed height) */}
        <div className="bg-[#1a1a2e] rounded p-3 text-sm flex flex-col">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-gray-400">sword</span>
            <span>{stable ? swordLabel(stable.swordLevel) : '—'}</span>
            <span className="text-gray-400">b-item</span>
            <span>{stable?.bItem ?? '—'}</span>
            <span className="text-gray-400">dungeon</span>
            <span>{stable?.dungeonLevel ?? '—'}</span>
            <span className="text-gray-400">triforce</span>
            <span>{stable ? <TriforceDisplay value={stable.triforceCollected} /> : '—'}</span>
          </div>
          {/* Pending fields — fixed height to prevent layout jitter (up to ~7 fields) */}
          <div className="mt-2 pt-2 border-t border-gray-700 min-h-[6.5rem]">
            {pending.length > 0 ? (
              <>
                <div className="text-xs text-yellow-500 font-semibold mb-1">PENDING</div>
                {pending.map(p => (
                  <div key={p.field} className="text-xs text-yellow-300">
                    {FIELD_LABELS[p.field] ?? p.field}:{' '}
                    {String(p.stableValue)}→{String(p.pendingValue)}{' '}
                    <span className="text-gray-500">({p.count}/{p.threshold})</span>
                  </div>
                ))}
              </>
            ) : (
              <div className="text-xs text-gray-600">no pending changes</div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom panels */}
      <div className="flex-1 grid gap-2 min-h-0" style={{ gridTemplateColumns: '15% 50% 35%' }}>
        {/* Event log */}
        <div className="bg-[#1a1a2e] rounded p-2 min-h-0 overflow-hidden">
          <div className="text-xs font-semibold text-gray-400 mb-2">EVENTS</div>
          <WebGPUEventLog racerId={selectedRacer} />
        </div>

        {/* Minimap */}
        <div className="bg-[#1a1a2e] rounded p-2 min-h-0 overflow-auto">
          <WebGPUMinimap
            mapPosition={stable?.mapPosition ?? -1}
            screenType={stable?.screenType ?? 'unknown'}
            dungeonLevel={stable?.dungeonLevel ?? 0}
            dungeonRoomImages={dungeonRoomImages}
          />
        </div>

        {/* Debug frame */}
        <div className="bg-[#1a1a2e] rounded p-2 min-h-0">
          <div className="text-xs font-semibold text-gray-400 mb-1">DEBUG FRAME</div>
          <div className="h-full">
            <DebugFrame racerId={selectedRacer} />
          </div>
        </div>
      </div>
    </div>
  );
}
