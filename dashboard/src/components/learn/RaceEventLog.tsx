import { useState, useMemo, useCallback } from 'react';
import {
  Triangle,
  Trophy,
  Heart,
  Skull,
  ArrowUpFromDot,
  Swords,
  DoorOpen,
  Sword,
  Package,
  LayoutGrid,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Clock,
  Check,
  X,
  Send,
  Loader2,
} from 'lucide-react';
import type { LearnReport } from '../../lib/learnApi';
import { addAnnotation } from '../../lib/learnApi';

type GameEvent = NonNullable<LearnReport['game_events']>[number];

// ─── Event type config ───

const EVENT_CONFIG: Record<string, { icon: typeof Triangle; colorClass: string; label: string }> = {
  triforce_inferred: { icon: Triangle, colorClass: 'text-gold', label: 'Triforce' },
  game_complete: { icon: Trophy, colorClass: 'text-gold', label: 'Game Complete' },
  heart_container: { icon: Heart, colorClass: 'text-red-400', label: 'Heart Container' },
  death: { icon: Skull, colorClass: 'text-red-600', label: 'Death' },
  up_a_warp: { icon: ArrowUpFromDot, colorClass: 'text-blue-400', label: 'Up+A Warp' },
  ganon_fight: { icon: Swords, colorClass: 'text-purple-400', label: 'Ganon Fight' },
  ganon_kill: { icon: Swords, colorClass: 'text-green-400', label: 'Ganon Defeated' },
  dungeon_first_visit: { icon: DoorOpen, colorClass: 'text-cyan-400', label: 'Dungeon Visit' },
  sword_upgrade: { icon: Sword, colorClass: 'text-orange-400', label: 'Sword Upgrade' },
  b_item_change: { icon: Package, colorClass: 'text-white/60', label: 'B-Item' },
  subscreen_open: { icon: LayoutGrid, colorClass: 'text-white/30', label: 'Inventory' },
};

const MINOR_EVENTS = new Set(['subscreen_open']);

// ─── Helpers ───

function frameToSeconds(frame: number, fps: number): number {
  return fps > 0 ? frame / fps : 0;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildVodUrl(source: string, seconds: number): string | null {
  const match = source.match(/twitch\.tv\/videos\/(\d+)/);
  if (!match) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `https://www.twitch.tv/videos/${match[1]}?t=${h}h${m}m${s}s`;
}

// ─── Phase clustering ───

interface EventPhase {
  title: string;
  summary: string;
  events: GameEvent[];
  startTime: number;
  endTime: number;
}

function clusterIntoPhases(events: GameEvent[], fps: number): EventPhase[] {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => a.frame - b.frame);
  const groups: GameEvent[][] = [[]];

  for (let i = 0; i < sorted.length; i++) {
    const evt = sorted[i];
    const group = groups[groups.length - 1];

    if (group.length === 0) {
      group.push(evt);
      continue;
    }

    const prevEvt = group[group.length - 1];
    const gap = frameToSeconds(evt.frame - prevEvt.frame, fps);
    const dungeonChanged = evt.dungeon_level !== prevEvt.dungeon_level
      && evt.dungeon_level > 0 && prevEvt.dungeon_level > 0;

    if (gap > 90 || dungeonChanged) {
      groups.push([evt]);
    } else {
      group.push(evt);
    }
  }

  return groups.map(group => {
    const startTime = frameToSeconds(group[0].frame, fps);
    const endTime = frameToSeconds(group[group.length - 1].frame, fps);
    return {
      title: labelPhase(group),
      summary: summarizePhase(group),
      events: group,
      startTime,
      endTime,
    };
  });
}

function labelPhase(events: GameEvent[]): string {
  const types = new Set(events.map(e => e.event));

  if (types.has('game_complete')) return 'Victory';
  if (types.has('ganon_fight') || types.has('ganon_kill')) return 'Endgame — Ganon';
  if (types.has('triforce_inferred')) {
    const trifDungeon = events.find(e => e.event === 'triforce_inferred')?.dungeon_level;
    return trifDungeon ? `Triforce — D${trifDungeon}` : 'Triforce Collection';
  }

  // Check dominant dungeon
  const dungeonCounts: Record<number, number> = {};
  for (const e of events) {
    if (e.dungeon_level > 0) {
      dungeonCounts[e.dungeon_level] = (dungeonCounts[e.dungeon_level] || 0) + 1;
    }
  }
  const topDungeon = Object.entries(dungeonCounts).sort(([, a], [, b]) => b - a)[0];
  if (topDungeon && Number(topDungeon[1]) > events.length * 0.4) {
    return `Dungeon ${topDungeon[0]}`;
  }

  // Check if mostly warps
  const warpCount = events.filter(e => e.event === 'up_a_warp').length;
  if (warpCount > events.length * 0.5) return 'Overworld Routing';

  return 'Early Game';
}

function summarizePhase(events: GameEvent[]): string {
  const significant = events.filter(e => !MINOR_EVENTS.has(e.event));
  if (significant.length === 0) return 'Inventory checks';

  const parts: string[] = [];
  const triforces = significant.filter(e => e.event === 'triforce_inferred');
  const deaths = significant.filter(e => e.event === 'death');
  const warps = significant.filter(e => e.event === 'up_a_warp');
  const hearts = significant.filter(e => e.event === 'heart_container');
  const swords = significant.filter(e => e.event === 'sword_upgrade');
  const visits = significant.filter(e => e.event === 'dungeon_first_visit');
  const ganon = significant.filter(e => e.event === 'ganon_fight' || e.event === 'ganon_kill');
  const complete = significant.filter(e => e.event === 'game_complete');

  if (complete.length > 0) parts.push('Race finished!');
  if (triforces.length > 0) parts.push(`${triforces.length} triforce piece${triforces.length > 1 ? 's' : ''}`);
  if (ganon.length > 0) parts.push('Ganon encounter');
  if (swords.length > 0) parts.push(swords.map(s => s.description).join(', '));
  if (hearts.length > 0) parts.push(`${hearts.length} heart container${hearts.length > 1 ? 's' : ''}`);
  if (visits.length > 0) parts.push(`visited D${visits.map(v => v.dungeon_level).join(', D')}`);
  if (deaths.length > 0) parts.push(`${deaths.length} death${deaths.length > 1 ? 's' : ''}`);
  if (warps.length > 0) parts.push(`${warps.length} warp${warps.length > 1 ? 's' : ''}`);

  return parts.join(' · ') || `${significant.length} events`;
}

// ─── Components ───

function RaceSummary({ report }: { report: LearnReport }) {
  const events = report.game_events || [];
  const triforceCount = events.filter(e => e.event === 'triforce_inferred').length;
  const deaths = events.filter(e => e.event === 'death').length;
  const warps = events.filter(e => e.event === 'up_a_warp').length;
  const hearts = events.filter(e => e.event === 'heart_container').length;
  const completed = events.some(e => e.event === 'game_complete');
  const duration = report.video_duration_s;

  const h = Math.floor(duration / 3600);
  const m = Math.floor((duration % 3600) / 60);
  const s = Math.floor(duration % 60);
  const durationStr = h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-surface rounded-lg">
      <div className="flex items-center gap-1.5">
        <Clock size={14} className="text-white/40" />
        <span className="text-sm font-medium">{durationStr}</span>
      </div>
      <div className="w-px h-4 bg-white/10" />
      <StatChip icon={Triangle} color="text-gold" value={`${triforceCount}/8`} label="Triforce" />
      {completed && (
        <>
          <div className="w-px h-4 bg-white/10" />
          <div className="flex items-center gap-1 text-gold">
            <Trophy size={14} />
            <span className="text-xs font-medium">Complete</span>
          </div>
        </>
      )}
      <div className="w-px h-4 bg-white/10" />
      <StatChip icon={Heart} color="text-red-400" value={hearts} label="HC" />
      <StatChip icon={Skull} color="text-red-600" value={deaths} label="Deaths" />
      <StatChip icon={ArrowUpFromDot} color="text-blue-400" value={warps} label="Warps" />
    </div>
  );
}

function StatChip({ icon: Icon, color, value, label }: {
  icon: typeof Triangle;
  color: string;
  value: string | number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1" title={label}>
      <Icon size={12} className={color} />
      <span className="text-xs text-white/70">{value}</span>
    </div>
  );
}

function PhaseSection({ phase, source, fps, showMinor, sessionId, feedback, onFeedback }: {
  phase: EventPhase;
  source: string;
  fps: number;
  showMinor: boolean;
  sessionId: string;
  feedback: Record<string, 'correct' | 'incorrect'>;
  onFeedback: (frame: number, status: 'correct' | 'incorrect', note?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const visibleEvents = showMinor
    ? phase.events
    : phase.events.filter(e => !MINOR_EVENTS.has(e.event));

  if (visibleEvents.length === 0) return null;

  return (
    <div className="space-y-1">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full text-left group"
      >
        {collapsed ? (
          <ChevronRight size={12} className="text-white/30" />
        ) : (
          <ChevronDown size={12} className="text-white/30" />
        )}
        <span className="text-xs font-medium text-white/80">{phase.title}</span>
        <span className="text-[10px] text-white/30">
          {formatTimestamp(phase.startTime)}–{formatTimestamp(phase.endTime)}
        </span>
        <span className="text-[10px] text-white/25 italic flex-1 truncate">
          {phase.summary}
        </span>
      </button>
      {!collapsed && (
        <div className="ml-4 border-l border-white/5 pl-3 space-y-0.5">
          {visibleEvents.map((evt, i) => (
            <EventRow
              key={i}
              event={evt}
              source={source}
              fps={fps}
              sessionId={sessionId}
              feedbackStatus={feedback[String(evt.frame)]}
              onFeedback={onFeedback}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, source, fps, sessionId, feedbackStatus, onFeedback }: {
  event: GameEvent;
  source: string;
  fps: number;
  sessionId: string;
  feedbackStatus?: 'correct' | 'incorrect';
  onFeedback: (frame: number, status: 'correct' | 'incorrect', note?: string) => void;
}) {
  const [noteText, setNoteText] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [sending, setSending] = useState(false);

  const config = EVENT_CONFIG[event.event] || {
    icon: Package,
    colorClass: 'text-white/40',
    label: event.event,
  };
  const Icon = config.icon;
  const seconds = frameToSeconds(event.frame, fps);
  const timestamp = formatTimestamp(seconds);
  const vodUrl = buildVodUrl(source, seconds);
  const isMinor = MINOR_EVENTS.has(event.event);

  const submitFeedback = useCallback(async (status: 'correct' | 'incorrect') => {
    setSending(true);
    try {
      await addAnnotation(sessionId, {
        type: 'game_event',
        note: status === 'correct'
          ? `Confirmed: ${event.description}`
          : `Incorrect: ${event.description}${noteText ? ' — ' + noteText : ''}`,
        frameNumber: event.frame,
        videoTimestamp: seconds,
        metadata: {
          event_type: event.event,
          feedback: status,
          ...(noteText ? { user_note: noteText } : {}),
        },
      });
      onFeedback(event.frame, status, noteText || undefined);
      setShowNote(false);
      setNoteText('');
    } catch {
      // silently fail — user can retry
    } finally {
      setSending(false);
    }
  }, [sessionId, event, seconds, noteText, onFeedback]);

  const alreadyReviewed = feedbackStatus != null;

  return (
    <div className={`flex items-center gap-2 text-xs py-0.5 group ${isMinor ? 'opacity-40' : ''}`}>
      {vodUrl ? (
        <a
          href={vodUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400/70 hover:text-blue-400 hover:underline font-mono w-12 shrink-0 text-right"
          title={`Jump to ${timestamp} in VOD`}
        >
          {timestamp}
        </a>
      ) : (
        <span className="text-white/30 font-mono w-12 shrink-0 text-right">{timestamp}</span>
      )}
      <Icon size={12} className={`${config.colorClass} shrink-0`} />
      <span className="text-white/70 truncate">{event.description}</span>
      {event.dungeon_level > 0 && event.event !== 'dungeon_first_visit' && (
        <span className="text-[10px] text-white/25 bg-white/5 rounded px-1 shrink-0">
          D{event.dungeon_level}
        </span>
      )}

      {/* Feedback controls */}
      <div className="flex items-center gap-1 ml-auto shrink-0">
        {alreadyReviewed ? (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            feedbackStatus === 'correct'
              ? 'bg-green-500/10 text-green-400'
              : 'bg-red-500/10 text-red-400'
          }`}>
            {feedbackStatus === 'correct' ? 'OK' : 'Wrong'}
          </span>
        ) : sending ? (
          <Loader2 size={12} className="text-white/30 animate-spin" />
        ) : (
          <>
            <button
              onClick={() => submitFeedback('correct')}
              className="p-0.5 rounded hover:bg-green-500/20 text-white/20 hover:text-green-400 transition-colors"
              title="Correct"
            >
              <Check size={12} />
            </button>
            {showNote ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitFeedback('incorrect'); }}
                  placeholder="What's wrong?"
                  className="bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white/70 w-32 focus:outline-none focus:border-white/20"
                  autoFocus
                />
                <button
                  onClick={() => submitFeedback('incorrect')}
                  className="p-0.5 rounded hover:bg-blue-500/20 text-white/30 hover:text-blue-400 transition-colors"
                  title="Submit"
                >
                  <Send size={10} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNote(true)}
                className="p-0.5 rounded hover:bg-red-500/20 text-white/20 hover:text-red-400 transition-colors"
                title="Incorrect — add note"
              >
                <X size={12} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───

export default function RaceEventLog({ report, source, sessionId }: {
  report: LearnReport;
  source: string;
  sessionId: string;
}) {
  const [showMinor, setShowMinor] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, 'correct' | 'incorrect'>>({});

  const fps = report.video_duration_s > 0
    ? report.total_frames / report.video_duration_s
    : 4;

  const events = report.game_events || [];
  const significantEvents = events.filter(e => !MINOR_EVENTS.has(e.event));

  const phases = useMemo(
    () => clusterIntoPhases(
      showMinor ? events : significantEvents,
      fps,
    ),
    [events, significantEvents, fps, showMinor],
  );

  const handleFeedback = useCallback((frame: number, status: 'correct' | 'incorrect') => {
    setFeedback(prev => ({ ...prev, [String(frame)]: status }));
  }, []);

  const reviewedCount = Object.keys(feedback).length;

  if (events.length === 0) return null;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-white/50">Race Event Log</h4>
        <div className="flex items-center gap-3">
          {reviewedCount > 0 && (
            <span className="text-[10px] text-white/25">
              {reviewedCount}/{significantEvents.length} reviewed
            </span>
          )}
          <button
            onClick={() => setShowMinor(!showMinor)}
            className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/50"
            title={showMinor ? 'Hide inventory checks' : 'Show inventory checks'}
          >
            {showMinor ? <EyeOff size={10} /> : <Eye size={10} />}
            {showMinor ? 'Hide minor' : 'Show minor'}
          </button>
        </div>
      </div>

      <RaceSummary report={report} />

      <div className="space-y-3">
        {phases.map((phase, i) => (
          <PhaseSection
            key={i}
            phase={phase}
            source={source}
            fps={fps}
            showMinor={showMinor}
            sessionId={sessionId}
            feedback={feedback}
            onFeedback={handleFeedback}
          />
        ))}
      </div>

      <div className="text-[10px] text-white/20 text-right">
        {significantEvents.length} events · {phases.length} phases
      </div>
    </div>
  );
}
