import { useMemo } from 'react';
import { SCREEN_TYPE_COLORS } from './types';

interface Segment {
  start: number;
  end: number;
  type: string;
}

interface ScreenTypeBarProps {
  transitions: [number, string, string][];
  duration: number;
}

function buildSegments(transitions: [number, string, string][], duration: number): Segment[] {
  if (transitions.length === 0) return [{ start: 0, end: duration, type: 'unknown' }];

  const segments: Segment[] = [];
  // First segment: from 0 to first transition
  segments.push({ start: 0, end: transitions[0][0], type: transitions[0][1] });

  for (let i = 0; i < transitions.length; i++) {
    const start = transitions[i][0];
    const end = i + 1 < transitions.length ? transitions[i + 1][0] : duration;
    segments.push({ start, end, type: transitions[i][2] });
  }

  return segments;
}

export default function ScreenTypeBar({ transitions, duration }: ScreenTypeBarProps) {
  const segments = useMemo(() => buildSegments(transitions, duration), [transitions, duration]);

  if (duration <= 0) return null;

  return (
    <div className="relative w-full h-2 rounded-sm overflow-hidden bg-white/5">
      {segments.map((seg, i) => {
        const left = (seg.start / duration) * 100;
        const width = ((seg.end - seg.start) / duration) * 100;
        return (
          <div
            key={i}
            className="absolute top-0 h-full"
            style={{
              left: `${left}%`,
              width: `${Math.max(width, 0.1)}%`,
              backgroundColor: SCREEN_TYPE_COLORS[seg.type] || SCREEN_TYPE_COLORS.unknown,
              opacity: 0.8,
            }}
          />
        );
      })}
    </div>
  );
}
