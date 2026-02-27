import { useState, useEffect, useRef } from 'react';
import { Timer } from 'lucide-react';

interface Props {
  startedAt: string | null;
  clockOffsetMs: number;
  size?: 'sm' | 'lg';
}

function formatTime(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function RaceTimerDisplay({ startedAt, clockOffsetMs, size = 'lg' }: Props) {
  const [elapsed, setElapsed] = useState('0:00');
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!startedAt) {
      setElapsed('0:00');
      return;
    }

    const startTime = new Date(startedAt).getTime();

    const tick = () => {
      const correctedNow = Date.now() - clockOffsetMs;
      const ms = correctedNow - startTime;
      setElapsed(formatTime(ms));
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [startedAt, clockOffsetMs]);

  const textSize = size === 'lg' ? 'text-4xl' : 'text-lg';

  return (
    <div className="flex items-center gap-3">
      <Timer size={size === 'lg' ? 28 : 16} className="text-gold" />
      <span className={`${textSize} font-mono font-bold tabular-nums tracking-wider`}>
        {elapsed}
      </span>
    </div>
  );
}
