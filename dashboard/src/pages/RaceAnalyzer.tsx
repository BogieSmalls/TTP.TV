import { useCallback, useState } from 'react';
import { useSocket, useSocketEvent } from '../hooks/useSocket.js';

interface GameEvent {
  type: string;
  racerId: string;
  timestamp: number;
  frameNumber: number;
  priority: 'high' | 'medium' | 'low';
  description: string;
  data?: Record<string, unknown>;
}

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

interface AnalyzerResult {
  racerId: string;
  vodUrl: string;
  duration: number;
  playbackRate: number;
  events: GameEvent[];
  stateSnapshots: Array<{ vodTime: number; state: StableGameState; items: Record<string, boolean> }>;
  summary: {
    deaths: number;
    triforceCount: number;
    dungeonsVisited: number[];
    gameComplete: boolean;
    totalFrames: number;
  };
}

interface AnalyzerProgress {
  racerId: string;
  vodTime: number;
  frameCount: number;
  eventsFound: number;
}

const EVENT_COLORS: Record<string, string> = {
  high: 'text-red-400',
  medium: 'text-yellow-400',
  low: 'text-gray-400',
};

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function swordLabel(level: number): string {
  return ['none', 'wood', 'white', 'magical'][level] ?? `L${level}`;
}

export default function RaceAnalyzer() {
  const socket = useSocket();
  const [vodUrl, setVodUrl] = useState('');
  const [racerId, setRacerId] = useState('analyzer');
  const [startOffset, setStartOffset] = useState('');
  const [playbackRate, setPlaybackRate] = useState(2);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<AnalyzerProgress | null>(null);
  const [result, setResult] = useState<AnalyzerResult | null>(null);
  const [scrubIndex, setScrubIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleProgress = useCallback((data: AnalyzerProgress) => {
    setProgress(data);
  }, []);
  useSocketEvent<AnalyzerProgress>('analyzer:progress', handleProgress);

  const handleComplete = useCallback((data: { racerId: string; result: AnalyzerResult }) => {
    setResult(data.result);
    setIsRunning(false);
    setScrubIndex(0);
  }, []);
  useSocketEvent<{ racerId: string; result: AnalyzerResult }>('analyzer:complete', handleComplete);

  function parseOffset(s: string): number | undefined {
    const trimmed = s.trim();
    if (!trimmed) return undefined;
    const parts = trimmed.split(':').map(Number);
    if (parts.some(isNaN)) return undefined;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }

  async function handleStart() {
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      const body: Record<string, unknown> = { racerId, vodUrl, playbackRate };
      const offset = parseOffset(startOffset);
      if (offset !== undefined) body.startOffset = offset;
      const res = await fetch('/api/analyzer/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setIsRunning(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleStop() {
    await fetch('/api/analyzer/stop', { method: 'POST' });
    setIsRunning(false);
  }

  const snapshot = result?.stateSnapshots[scrubIndex];

  return (
    <div className="h-screen flex flex-col bg-[#0f0f1a] text-white p-2 gap-2">
      {/* Header */}
      <div className="flex flex-col gap-1 px-2 py-2 bg-[#1a1a2e] rounded">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">VOD URL</label>
            <input
              value={vodUrl}
              onChange={e => setVodUrl(e.target.value)}
              placeholder="https://twitch.tv/videos/123456"
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-80"
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">Racer</label>
            <input
              value={racerId}
              onChange={e => setRacerId(e.target.value)}
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-28"
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">Start at</label>
            <input
              value={startOffset}
              onChange={e => setStartOffset(e.target.value)}
              placeholder="0:11:30"
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm w-20"
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-400">Speed</label>
            <select
              value={playbackRate}
              onChange={e => setPlaybackRate(Number(e.target.value))}
              className="bg-[#0f0f1a] border border-gray-700 rounded px-2 py-1 text-sm"
              disabled={isRunning}
            >
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={handleStart}
              disabled={isRunning || !vodUrl.trim()}
              className="px-3 py-1 text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded"
            >Start</button>
            <button
              onClick={handleStop}
              disabled={!isRunning}
              className="px-3 py-1 text-xs bg-red-800 hover:bg-red-700 disabled:opacity-40 rounded"
            >Stop</button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isRunning && progress && (
            <span className="text-xs text-green-400">
              Processing: {formatTime(progress.vodTime)} | {progress.frameCount} frames | {progress.eventsFound} events
            </span>
          )}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>

      {/* Results */}
      {result && (
        <>
          {/* Summary */}
          <div className="flex gap-4 px-2 py-2 bg-[#1a1a2e] rounded text-sm">
            <span>Deaths: <strong className="text-red-400">{result.summary.deaths}</strong></span>
            <span>Triforce: <strong className="text-yellow-400">{result.summary.triforceCount}/8</strong></span>
            <span>Dungeons: <strong>{result.summary.dungeonsVisited.join(', ') || 'none'}</strong></span>
            <span>Complete: <strong className={result.summary.gameComplete ? 'text-green-400' : 'text-gray-500'}>{result.summary.gameComplete ? 'Yes' : 'No'}</strong></span>
            <span>Frames: {result.summary.totalFrames.toLocaleString()}</span>
            <span>Duration: {formatTime(result.duration)}</span>
            <span className="text-gray-500">({result.playbackRate}x)</span>
          </div>

          {/* State Scrubber */}
          <div className="bg-[#1a1a2e] rounded p-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-gray-400">TIME</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, result.stateSnapshots.length - 1)}
                value={scrubIndex}
                onChange={e => setScrubIndex(Number(e.target.value))}
                className="flex-1"
              />
              <span className="text-xs font-mono w-16 text-right">{snapshot ? formatTime(snapshot.vodTime) : '—'}</span>
            </div>
            {snapshot && (
              <div className="grid grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-gray-400">screen:</span> {snapshot.state.screenType}
                  {snapshot.state.dungeonLevel > 0 && <span className="text-indigo-400"> L{snapshot.state.dungeonLevel}</span>}
                </div>
                <div>
                  <span className="text-gray-400">hearts:</span> {snapshot.state.heartsCurrentStable}/{snapshot.state.heartsMaxStable}
                </div>
                <div>
                  <span className="text-gray-400">rupees:</span> {snapshot.state.rupees}
                  <span className="text-gray-400 ml-2">keys:</span> {snapshot.state.keys}
                  <span className="text-gray-400 ml-2">bombs:</span> {snapshot.state.bombs}
                </div>
                <div>
                  <span className="text-gray-400">sword:</span> {swordLabel(snapshot.state.swordLevel)}
                  <span className="text-gray-400 ml-2">b:</span> {snapshot.state.bItem ?? '—'}
                </div>
              </div>
            )}
          </div>

          {/* Event Timeline */}
          <div className="flex-1 bg-[#1a1a2e] rounded p-2 min-h-0 overflow-auto">
            <div className="text-xs font-semibold text-gray-400 mb-2">EVENTS ({result.events.length})</div>
            <div className="space-y-0.5">
              {result.events.map((evt, i) => (
                <div key={i} className={`text-xs flex gap-2 ${EVENT_COLORS[evt.priority] ?? 'text-gray-400'}`}>
                  <span className="font-mono w-14 shrink-0 text-gray-500">{formatTime(evt.frameNumber / 30)}</span>
                  <span className="font-semibold w-32 shrink-0">{evt.type}</span>
                  <span className="text-gray-300">{evt.description}</span>
                </div>
              ))}
              {result.events.length === 0 && <div className="text-gray-600 text-xs">No events detected</div>}
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {!result && !isRunning && (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          Enter a VOD URL and click Start to analyze a race
        </div>
      )}
    </div>
  );
}
