import { useRef, useEffect, useCallback, useState } from 'react';
import type { LearnSnapshot, LearnAnnotation } from '../../lib/learnApi';
import { SCREEN_TYPE_COLORS, ANNOTATION_CONFIG, formatTimestamp } from './types';
import { findNearestSnapshotIndex } from './useTimelineNavigation';

interface GameEvent {
  frame: number;
  event: string;
  description: string;
  dungeon_level: number;
}

interface TimelineScrubberProps {
  snapshots: LearnSnapshot[];
  annotations: LearnAnnotation[];
  duration: number;
  currentIndex: number;
  onSeek: (index: number) => void;
  gameEvents?: GameEvent[];
  fps?: number;
}

const EVENT_COLORS: Record<string, string> = {
  death: '#ef4444',
  up_a_warp: '#f97316',
  triforce_inferred: '#eab308',
  game_complete: '#22c55e',
  heart_container: '#ec4899',
  ganon_fight: '#a855f7',
  ganon_kill: '#8b5cf6',
  dungeon_first_visit: '#38bdf8',
  sword_upgrade: '#60a5fa',
  b_item_change: '#c084fc',
};

export default function TimelineScrubber({ snapshots, annotations, duration, currentIndex, onSeek, gameEvents, fps }: TimelineScrubberProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [hoverEvent, setHoverEvent] = useState<string | null>(null);

  const drawMarkers = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || duration <= 0) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width;
    const h = 60;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Annotation markers (top 16px)
    for (const ann of annotations) {
      if (ann.videoTimestamp == null) continue;
      const x = (ann.videoTimestamp / duration) * w;
      const cfg = ANNOTATION_CONFIG[ann.type];
      ctx.fillStyle = cfg?.color || '#9ca3af';
      ctx.beginPath();
      ctx.arc(x, 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Timeline track (middle: y=20 to y=40)
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 20, w, 16);

    // Snapshot markers (bottom: y=42 to y=58)
    for (const snap of snapshots) {
      const x = (snap.videoTimestamp / duration) * w;
      const color = SCREEN_TYPE_COLORS[snap.screenType] || SCREEN_TYPE_COLORS.unknown;
      ctx.fillStyle = color;
      if (snap.reason === 'transition') {
        ctx.fillRect(x - 1, 42, 2, 16);
      } else {
        ctx.fillRect(x, 46, 1, 8);
      }
    }

    // Time labels
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    const interval = duration > 3600 ? 600 : duration > 600 ? 120 : 30;
    for (let t = 0; t <= duration; t += interval) {
      const x = (t / duration) * w;
      ctx.fillText(formatTimestamp(t), x, 38);
    }

    // Game event markers — small colored triangles at top of bar
    if (gameEvents && fps && duration > 0) {
      for (const ev of gameEvents) {
        const evTs = ev.frame / fps;
        const ex = Math.round((evTs / duration) * w);
        const color = EVENT_COLORS[ev.event] ?? '#6b7280';
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(ex, 4);
        ctx.lineTo(ex - 3, 11);
        ctx.lineTo(ex + 3, 11);
        ctx.closePath();
        ctx.fill();
      }
    }
  }, [snapshots, annotations, duration, gameEvents, fps]);

  useEffect(() => {
    drawMarkers();
    const observer = new ResizeObserver(drawMarkers);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [drawMarkers]);

  const getTimeFromEvent = useCallback((e: React.MouseEvent | MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    return (x / rect.width) * duration;
  }, [duration]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true);
    const time = getTimeFromEvent(e);
    onSeek(findNearestSnapshotIndex(snapshots, time));
  }, [getTimeFromEvent, onSeek, snapshots]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const time = getTimeFromEvent(e);
      onSeek(findNearestSnapshotIndex(snapshots, time));
    };
    const handleUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging, getTimeFromEvent, onSeek, snapshots]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    setHoverX(x);
    const time = (x / rect.width) * duration;
    setHoverTime(time);

    // Check for nearby game event
    let nearestEvent: string | null = null;
    if (gameEvents && fps && duration > 0) {
      const pixelThreshold = 6;
      for (const ev of gameEvents) {
        const evTs = ev.frame / fps;
        const evX = (evTs / duration) * rect.width;
        if (Math.abs(evX - x) <= pixelThreshold) {
          nearestEvent = ev.description;
          break;
        }
      }
    }
    setHoverEvent(nearestEvent);
  }, [isDragging, duration, gameEvents, fps]);

  const currentSnap = snapshots[currentIndex];
  const positionPct = currentSnap ? (currentSnap.videoTimestamp / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="relative w-full select-none cursor-pointer"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverTime(null)}
    >
      <canvas ref={canvasRef} className="w-full" />
      {/* Current position indicator */}
      <div
        className="absolute top-5 w-0.5 bg-gold pointer-events-none"
        style={{ left: `${positionPct}%`, height: '36px' }}
      />
      <div
        className="absolute top-[39px] w-0 h-0 pointer-events-none"
        style={{
          left: `${positionPct}%`,
          marginLeft: '-4px',
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: '5px solid #D4AF37',
        }}
      />
      {/* Hover tooltip */}
      {hoverTime != null && !isDragging && (
        <div
          className="absolute -top-7 px-2 py-0.5 text-xs bg-panel border border-white/10 rounded pointer-events-none whitespace-nowrap"
          style={{ left: `${hoverX}px`, transform: 'translateX(-50%)' }}
        >
          {formatTimestamp(hoverTime)}
          {hoverEvent && <span className="ml-1 text-yellow-300">{hoverEvent}</span>}
        </div>
      )}
    </div>
  );
}
