import { useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { LearnReport, LearnAnnotation } from '../../lib/learnApi';
import { SCREEN_TYPE_COLORS, formatTimestampLong, ANNOTATION_CONFIG } from './types';

interface RaceStatsPanelProps {
  report: LearnReport;
  annotations: LearnAnnotation[];
}

interface ScreenTimeSegment {
  type: string;
  totalSeconds: number;
}

export default function RaceStatsPanel({ report, annotations }: RaceStatsPanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  const screenTimes = useMemo(() => {
    const times: Record<string, number> = {};
    const { screen_transitions, video_duration_s } = report;

    if (screen_transitions.length === 0) return [];

    // First segment
    const firstType = screen_transitions[0][1];
    times[firstType] = (times[firstType] || 0) + screen_transitions[0][0];

    for (let i = 0; i < screen_transitions.length; i++) {
      const start = screen_transitions[i][0];
      const end = i + 1 < screen_transitions.length ? screen_transitions[i + 1][0] : video_duration_s;
      const type = screen_transitions[i][2];
      times[type] = (times[type] || 0) + (end - start);
    }

    return Object.entries(times)
      .map(([type, totalSeconds]): ScreenTimeSegment => ({ type, totalSeconds }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds);
  }, [report]);

  const dungeonSplits = useMemo(() => {
    const enters = annotations.filter(a => a.type === 'dungeon_enter' && a.videoTimestamp != null);
    const exits = annotations.filter(a => a.type === 'dungeon_exit' && a.videoTimestamp != null);

    const splits: { dungeon: string; enterTime: number; exitTime?: number; duration?: number }[] = [];

    for (const enter of enters) {
      const d = enter.metadata?.dungeon || '?';
      const exit = exits.find(e =>
        e.metadata?.dungeon === d && e.videoTimestamp! > enter.videoTimestamp!
      );
      splits.push({
        dungeon: d,
        enterTime: enter.videoTimestamp!,
        exitTime: exit?.videoTimestamp,
        duration: exit ? exit.videoTimestamp! - enter.videoTimestamp! : undefined,
      });
    }

    return splits.sort((a, b) => a.enterTime - b.enterTime);
  }, [annotations]);

  const itemPickups = useMemo(() =>
    annotations
      .filter(a => a.type === 'item_pickup' && a.videoTimestamp != null)
      .sort((a, b) => a.videoTimestamp! - b.videoTimestamp!),
  [annotations]);

  const deathCount = useMemo(() =>
    annotations.filter(a => a.type === 'death').length,
  [annotations]);

  const doorRepairTotal = useMemo(() =>
    annotations
      .filter(a => a.type === 'door_repair')
      .reduce((sum, a) => sum + (parseInt(a.metadata?.rupees || '0', 10) || 0), 0),
  [annotations]);

  const dungeonOrder = useMemo(() =>
    dungeonSplits.map(s => `L${s.dungeon}`).join(' → '),
  [dungeonSplits]);

  return (
    <div className="bg-panel rounded-lg border border-white/5">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/60 hover:text-white/80 transition-colors"
      >
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>Race Statistics</span>
      </button>
      {isOpen && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          {/* Screen time stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {screenTimes.map(({ type, totalSeconds }) => (
              <div key={type} className="bg-white/5 rounded-lg p-2 text-center">
                <div className="flex items-center justify-center gap-1 text-xs text-white/50 mb-1">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: SCREEN_TYPE_COLORS[type] || '#6b7280' }} />
                  {type}
                </div>
                <div className="text-sm font-mono text-white/90">{formatTimestampLong(totalSeconds)}</div>
                <div className="text-xs text-white/30">{((totalSeconds / report.video_duration_s) * 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>

          {/* Annotation-derived stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatBox label="Items Found" value={String(itemPickups.length)} />
            <StatBox label="Deaths" value={String(deathCount)} />
            <StatBox label="Door Repairs" value={doorRepairTotal > 0 ? `${doorRepairTotal}r` : '—'} />
            <StatBox label="Dungeons" value={dungeonOrder || '—'} small />
          </div>

          {/* Item timeline */}
          {itemPickups.length > 0 && (
            <details>
              <summary className="text-xs text-white/40 cursor-pointer hover:text-white/60">
                Item Timeline ({itemPickups.length})
              </summary>
              <div className="mt-1 flex flex-col gap-0.5">
                {itemPickups.map(a => (
                  <div key={a.id} className="flex items-center gap-2 text-xs px-2 py-0.5">
                    <span className="font-mono text-white/40 w-12">{formatTimestampLong(a.videoTimestamp!)}</span>
                    <span style={{ color: ANNOTATION_CONFIG.item_pickup.color }}>
                      {a.metadata?.item?.replace(/_/g, ' ') || a.note}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Dungeon splits */}
          {dungeonSplits.length > 0 && (
            <details>
              <summary className="text-xs text-white/40 cursor-pointer hover:text-white/60">
                Dungeon Splits ({dungeonSplits.length})
              </summary>
              <div className="mt-1 flex flex-col gap-0.5">
                {dungeonSplits.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs px-2 py-0.5">
                    <span className="font-mono text-white/40 w-12">{formatTimestampLong(s.enterTime)}</span>
                    <span className="text-white/70 font-medium w-8">L{s.dungeon}</span>
                    {s.duration != null ? (
                      <span className="text-gold font-mono">{formatTimestampLong(s.duration)}</span>
                    ) : (
                      <span className="text-white/30">in progress</span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="bg-white/5 rounded-lg p-2 text-center">
      <div className="text-xs text-white/50 mb-1">{label}</div>
      <div className={`font-mono text-white/90 ${small ? 'text-xs' : 'text-sm'} truncate`}>{value}</div>
    </div>
  );
}
