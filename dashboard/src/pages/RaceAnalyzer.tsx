import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSocketEvent } from '../hooks/useSocket.js';
import { SectionHeader } from '../ui';

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

function formatItemName(snake: string): string {
  return snake.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

interface DisplayEvent {
  type: string;
  frameNumber: number;
  priority: 'high' | 'medium' | 'low';
  description: string;
}

function deriveDisplayEvents(events: GameEvent[]): DisplayEvent[] {
  const seenItems = new Set<string>();
  const display: DisplayEvent[] = [];
  for (const evt of events) {
    if (evt.type === 'b_item_change') {
      const to = evt.data?.to as string | null;
      if (!to || seenItems.has(to)) continue;
      seenItems.add(to);
      display.push({
        type: 'item_pickup',
        frameNumber: evt.frameNumber,
        priority: 'medium',
        description: `Picked up ${formatItemName(to)}`,
      });
    } else {
      display.push(evt);
    }
  }
  return display;
}

export default function RaceAnalyzer() {
  const [vodUrl, setVodUrl] = useState('');
  const [racerId, setRacerId] = useState('');
  const [startOffset, setStartOffset] = useState('');
  const [playbackRate, setPlaybackRate] = useState(2);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<AnalyzerProgress | null>(null);
  const [result, setResult] = useState<AnalyzerResult | null>(null);
  const [scrubIndex, setScrubIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [frameTimes, setFrameTimes] = useState<number[]>([]);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // On mount, fetch current session state so late-joining browsers see an active session
  useEffect(() => {
    fetch('/api/analyzer/status')
      .then(r => r.json())
      .then((status: { state: string; eventsFound: number; frameCount: number; vodTime: number }) => {
        if (status.state === 'running') {
          setIsRunning(true);
          setProgress({ racerId: '', vodTime: status.vodTime, frameCount: status.frameCount, eventsFound: status.eventsFound });
        } else if (status.state === 'completed') {
          // Fetch the result too
          fetch('/api/analyzer/result')
            .then(r => r.ok ? r.json() : null)
            .then((res: AnalyzerResult | null) => {
              if (res) { setResult(res); setScrubIndex(0); }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Fetch frame metadata when result is available
  useEffect(() => {
    if (!result) { setFrameTimes([]); setFrameUrl(null); return; }
    fetch('/api/analyzer/frames')
      .then(r => r.json())
      .then((data: { count: number; times: number[] }) => setFrameTimes(data.times))
      .catch(() => {});
  }, [result]);

  // Debounced frame thumbnail fetch on scrub
  useEffect(() => {
    if (!result || frameTimes.length === 0) return;
    if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = setTimeout(() => {
      const snap = result.stateSnapshots[scrubIndex];
      if (!snap) return;
      // Find nearest frame by vodTime
      let bestIdx = 0;
      let bestDist = Math.abs(frameTimes[0] - snap.vodTime);
      for (let i = 1; i < frameTimes.length; i++) {
        const dist = Math.abs(frameTimes[i] - snap.vodTime);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      fetch(`/api/analyzer/frame/${bestIdx}`)
        .then(r => r.ok ? r.blob() : null)
        .then(blob => {
          if (blob) {
            // Revoke previous URL to prevent memory leaks
            setFrameUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
          }
        })
        .catch(() => {});
    }, 200);
    return () => { if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current); };
  }, [scrubIndex, result, frameTimes]);

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
    try {
      await fetch('/api/analyzer/stop', { method: 'POST' });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setIsRunning(false);
  }

  const snapshot = result?.stateSnapshots[scrubIndex];
  const displayEvents = useMemo(() => result ? deriveDisplayEvents(result.events) : [], [result]);

  return (
    <div className="flex flex-col gap-2" style={{ color: 'var(--text-primary)' }}>
      <SectionHeader title="Race Analyzer" />
      <div className="flex flex-col gap-1 px-2 py-2 rounded" style={{ background: 'var(--bg-surface)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>VOD URL</label>
            <input
              value={vodUrl}
              onChange={e => setVodUrl(e.target.value)}
              placeholder="https://twitch.tv/videos/123456"
              className="border rounded px-2 py-1 text-sm w-80"
              style={{ background: 'var(--bg-base)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>Racer</label>
            <input
              value={racerId}
              onChange={e => setRacerId(e.target.value)}
              placeholder="Bogie"
              className="border rounded px-2 py-1 text-sm w-28"
              style={{ background: 'var(--bg-base)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>Start at</label>
            <input
              value={startOffset}
              onChange={e => setStartOffset(e.target.value)}
              placeholder="0:11:30"
              className="border rounded px-2 py-1 text-sm w-20"
              style={{ background: 'var(--bg-base)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
              disabled={isRunning}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>Speed</label>
            <select
              value={playbackRate}
              onChange={e => setPlaybackRate(Number(e.target.value))}
              className="border rounded px-2 py-1 text-sm"
              style={{ background: 'var(--bg-base)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
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
              disabled={isRunning || !vodUrl.trim() || !racerId.trim()}
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
          <div className="flex gap-4 px-2 py-2 rounded text-sm" style={{ background: 'var(--bg-surface)' }}>
            <span>Deaths: <strong className="text-red-400">{result.summary.deaths}</strong></span>
            <span>Triforce: <strong className="text-yellow-400">{result.summary.triforceCount}/8</strong></span>
            <span>Dungeons: <strong>{result.summary.dungeonsVisited.join(', ') || 'none'}</strong></span>
            <span>Complete: <strong className={result.summary.gameComplete ? 'text-green-400' : ''} style={result.summary.gameComplete ? undefined : { color: 'var(--text-muted)' }}>{result.summary.gameComplete ? 'Yes' : 'No'}</strong></span>
            <span>Frames: {result.summary.totalFrames.toLocaleString()}</span>
            <span>Duration: {formatTime(result.duration)}</span>
            <span style={{ color: 'var(--text-muted)' }}>({result.playbackRate}x)</span>
          </div>

          {/* State Scrubber */}
          <div className="rounded p-2" style={{ background: 'var(--bg-surface)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>TIME</span>
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
              <div className="flex gap-3">
                {frameUrl && (
                  <img src={frameUrl} alt="Frame" className="rounded shrink-0" style={{ width: 320, height: 240, objectFit: 'contain', background: '#000' }} />
                )}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm flex-1 content-start">
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>screen:</span> {snapshot.state.screenType}
                    {snapshot.state.dungeonLevel > 0 && <span className="text-indigo-400"> L{snapshot.state.dungeonLevel}</span>}
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>hearts:</span> {snapshot.state.heartsCurrentStable}/{snapshot.state.heartsMaxStable}
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>rupees:</span> {snapshot.state.rupees}
                    <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>keys:</span> {snapshot.state.keys}
                    <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>bombs:</span> {snapshot.state.bombs}
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>sword:</span> {swordLabel(snapshot.state.swordLevel)}
                    <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>b:</span> {snapshot.state.bItem ?? '—'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Event Timeline */}
          <div className="flex-1 rounded p-2 min-h-0 overflow-auto" style={{ background: 'var(--bg-surface)' }}>
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>EVENTS ({displayEvents.length})</div>
            <div className="space-y-0.5">
              {displayEvents.map((evt, i) => (
                <div key={i} className={`text-xs flex gap-2 ${EVENT_COLORS[evt.priority] ?? ''}`} style={EVENT_COLORS[evt.priority] ? undefined : { color: 'var(--text-secondary)' }}>
                  <span className="font-mono w-14 shrink-0" style={{ color: 'var(--text-muted)' }}>{formatTime(evt.frameNumber / 30)}</span>
                  <span className="font-semibold w-32 shrink-0">{evt.type}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{evt.description}</span>
                </div>
              ))}
              {displayEvents.length === 0 && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No events detected</div>}
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {!result && !isRunning && (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
          Enter a VOD URL and click Start to analyze a race
        </div>
      )}
    </div>
  );
}
