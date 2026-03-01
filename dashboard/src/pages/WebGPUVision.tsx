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
}

// Friendly display names for pending fields
const FIELD_LABELS: Record<string, string> = {
  heartsCurrent: 'hearts', heartsMax: 'hearts max', screenType: 'screen',
  rupees: 'rupees', keys: 'keys', bombs: 'bombs', dungeonLevel: 'dungeon',
  bItem: 'b-item', swordLevel: 'sword', hasMasterKey: 'master key',
  mapPosition: 'room', triforce: 'triforce',
};

function HeartDisplay({ current, max }: { current: number; max: number }) {
  return (
    <span>
      {'❤'.repeat(current)}{'🖤'.repeat(Math.max(0, max - current))} /{max}
    </span>
  );
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
  const [stable, setStable] = useState<StableGameState | null>(null);
  const [pending, setPending] = useState<PendingFieldInfo[]>([]);
  const [fps, setFps] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [latency, setLatency] = useState(0);
  const frameTimesRef = useRef<number[]>([]);
  const prevRacerRef = useRef<string | null>(null);

  // Fetch active racers on mount
  useEffect(() => {
    fetch('/api/vision/racers')
      .then(r => r.json())
      .then((d: { racerIds: string[] }) => setRacerIds(d.racerIds))
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
    const now = Date.now();
    setLatency(now - update.timestamp);
    setFrameCount(update.frameCount);
    frameTimesRef.current.push(now);
    frameTimesRef.current = frameTimesRef.current.filter(t => now - t < 1000);
    setFps(frameTimesRef.current.length);
  }, [selectedRacer]);

  useSocketEvent<WebGPUStateUpdate>('vision:webgpu:state', handleStateUpdate);

  const isRunning = selectedRacer !== null && racerIds.includes(selectedRacer);

  async function handleStart() {
    if (!selectedRacer) return;
    await fetch(`/api/vision/${selectedRacer}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamUrl: '' }),
    });
    setRacerIds(prev => prev.includes(selectedRacer) ? prev : [...prev, selectedRacer]);
  }

  async function handleStop() {
    if (!selectedRacer) return;
    await fetch(`/api/vision/${selectedRacer}`, { method: 'DELETE' });
    setRacerIds(prev => prev.filter(id => id !== selectedRacer));
    setStable(null);
    setPending([]);
  }

  return (
    <div className="h-screen flex flex-col bg-[#0f0f1a] text-white p-2 gap-2">

      {/* Header */}
      <div className="flex items-center gap-4 px-2 py-1 bg-[#1a1a2e] rounded">
        <select
          className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm"
          value={selectedRacer ?? ''}
          onChange={e => setSelectedRacer(e.target.value || null)}
        >
          <option value="">— select racer —</option>
          {racerIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <span className={`text-xs ${fps > 0 ? 'text-green-400' : 'text-gray-500'}`}>
          ● {fps}fps
        </span>
        <span className="text-xs text-gray-400">⬡ {frameCount.toLocaleString()} frames</span>
        <span className="text-xs text-gray-400">⚡ {latency}ms</span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={handleStart}
            disabled={!selectedRacer || isRunning}
            className="px-3 py-1 text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded"
          >Start</button>
          <button
            onClick={handleStop}
            disabled={!isRunning}
            className="px-3 py-1 text-xs bg-red-800 hover:bg-red-700 disabled:opacity-40 rounded"
          >Stop</button>
        </div>
      </div>

      {/* Top state row */}
      <div className="grid grid-cols-2 gap-2">
        {/* Left: primary state */}
        <div className="bg-[#1a1a2e] rounded p-3 text-sm space-y-1">
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

        {/* Right: secondary state */}
        <div className="bg-[#1a1a2e] rounded p-3 text-sm space-y-1">
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
          {/* Pending fields */}
          {pending.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-700">
              <div className="text-xs text-yellow-500 font-semibold mb-1">PENDING</div>
              {pending.map(p => (
                <div key={p.field} className="text-xs text-yellow-300">
                  {FIELD_LABELS[p.field] ?? p.field}:{' '}
                  {String(p.stableValue)}→{String(p.pendingValue)}{' '}
                  <span className="text-gray-500">({p.count}/{p.threshold})</span>
                </div>
              ))}
            </div>
          )}
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
            mapPosition={stable?.mapPosition ?? 0}
            screenType={stable?.screenType ?? 'unknown'}
            dungeonLevel={stable?.dungeonLevel ?? 0}
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
