import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import type { LearnSnapshot } from '../../lib/learnApi';
import { formatTimestampLong, SCREEN_TYPE_COLORS } from './types';

interface SnapshotViewerProps {
  sessionId: string;
  snapshots: LearnSnapshot[];
  currentIndex: number;
  setCurrentIndex: (i: number) => void;
  isPlaying: boolean;
  setIsPlaying: (p: boolean) => void;
  playbackSpeed: number;
  setPlaybackSpeed: (s: number) => void;
}

const SPEEDS = [1, 2, 5, 10, 20, 50];

export default function SnapshotViewer({
  sessionId, snapshots, currentIndex, setCurrentIndex,
  isPlaying, setIsPlaying, playbackSpeed, setPlaybackSpeed,
}: SnapshotViewerProps) {
  const count = snapshots.length;
  const snap = snapshots[currentIndex];

  // Preload adjacent images
  useEffect(() => {
    const indices = [currentIndex - 1, currentIndex + 1, currentIndex + 2, currentIndex + 3]
      .filter(i => i >= 0 && i < count);
    const images = indices.map(i => {
      const img = new Image();
      img.src = `/api/learn/snapshots/${sessionId}/${snapshots[i].filename}`;
      return img;
    });
    return () => { images.forEach(img => { img.src = ''; }); };
  }, [sessionId, snapshots, currentIndex, count]);

  // Time-proportional playback: use actual video timestamp gaps between snapshots
  const indexRef = useRef(currentIndex);
  indexRef.current = currentIndex;
  useEffect(() => {
    if (!isPlaying || count < 2) return;

    let timer: ReturnType<typeof setTimeout>;

    function scheduleNext() {
      const idx = indexRef.current;
      if (idx >= count - 1) {
        setIsPlaying(false);
        return;
      }
      // Time gap between current and next snapshot in video seconds
      const gap = snapshots[idx + 1].videoTimestamp - snapshots[idx].videoTimestamp;
      // Convert to real-time ms, divided by speed multiplier, with a min of 50ms
      const delayMs = Math.max((gap * 1000) / playbackSpeed, 50);

      timer = setTimeout(() => {
        const newIdx = Math.min(indexRef.current + 1, count - 1);
        setCurrentIndex(newIdx);
        if (newIdx < count - 1) scheduleNext();
        else setIsPlaying(false);
      }, delayMs);
    }

    scheduleNext();
    return () => clearTimeout(timer);
  }, [isPlaying, playbackSpeed, count, snapshots, setCurrentIndex, setIsPlaying]);

  if (!snap) return <div className="bg-panel rounded-lg p-8 text-white/40 text-center">No snapshots</div>;

  const screenColor = SCREEN_TYPE_COLORS[snap.screenType] || SCREEN_TYPE_COLORS.unknown;

  return (
    <div className="flex flex-col gap-1 min-h-0 h-full">
      {/* Image container */}
      <div className="relative group rounded-lg overflow-hidden flex-1 min-h-0">
        <img
          src={`/api/learn/snapshots/${sessionId}/${snap.filename}`}
          alt={`Frame ${snap.frame}`}
          className="w-full h-full object-contain"
          draggable={false}
        />
        {/* Nav overlays */}
        {currentIndex > 0 && (
          <button
            onClick={() => setCurrentIndex(currentIndex - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/60 text-white/80 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {currentIndex < count - 1 && (
          <button
            onClick={() => setCurrentIndex(currentIndex + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/60 text-white/80 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
          >
            <ChevronRight size={24} />
          </button>
        )}
        {/* Frame counter */}
        <div className="absolute top-2 right-2 px-2 py-0.5 text-xs bg-black/70 text-white/70 rounded">
          {currentIndex + 1} / {count}
        </div>
      </div>

      {/* Metadata + playback controls combined */}
      <div className="flex items-center gap-2 px-1 shrink-0">
        <button
          onClick={() => setCurrentIndex(0)}
          className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white/90 transition-colors"
          title="Start"
        >
          <SkipBack size={16} />
        </button>
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className="p-1.5 rounded bg-gold/20 hover:bg-gold/30 text-gold transition-colors"
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          onClick={() => setCurrentIndex(count - 1)}
          className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white/90 transition-colors"
          title="End"
        >
          <SkipForward size={16} />
        </button>
        <div className="flex items-center gap-1 ml-2 text-xs text-white/50">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setPlaybackSpeed(s)}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                playbackSpeed === s ? 'bg-gold/25 text-gold' : 'hover:bg-white/10'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
        {/* Metadata inline */}
        <div className="flex items-center gap-2 ml-auto text-xs text-white/50">
          <span className="font-mono text-white/80">{formatTimestampLong(snap.videoTimestamp)}</span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: screenColor }} />
            {snap.screenType}
          </span>
          {snap.dungeonLevel > 0 && (
            <span className="text-red-400 font-medium text-[11px]">L{snap.dungeonLevel}</span>
          )}
          {snap.swordLevel > 0 && (
            <span className="text-blue-300 text-[11px]">Sw{snap.swordLevel}</span>
          )}
          {snap.bItem && snap.bItem !== '' && (
            <span className="text-purple-300 text-[11px]">B:{snap.bItem}</span>
          )}
          {snap.hasMasterKey && (
            <span className="text-yellow-300 font-medium text-[11px]">MK</span>
          )}
          {snap.gannonNearby && (
            <span className="text-red-500 font-bold text-[11px]">ROAR</span>
          )}
          {snap.mapPosition > 0 && (
            <span className="text-white/40 text-[11px]">#{snap.mapPosition}</span>
          )}
          {snap.reason === 'transition' && snap.extra && (
            <span className="text-gold text-[11px]">{snap.extra}</span>
          )}
        </div>
      </div>
    </div>
  );
}
