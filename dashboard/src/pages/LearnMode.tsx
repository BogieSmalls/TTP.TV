import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  GraduationCap,
  Play,
  Square,
  Save,
  MessageSquarePlus,
  Bookmark,
  AlertTriangle,
  CheckCircle2,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight,
  MonitorPlay,
} from 'lucide-react';
import {
  getSessions,
  startSession,
  startBatchSessions,
  cancelSession,
  deleteSession,
  saveCrop,
  addAnnotation,
  deleteAnnotation,
} from '../lib/learnApi';
import type { LearnSession, LearnAnnotation, LearnReport, LearnSnapshot } from '../lib/learnApi';
import { useSocketEvent } from '../hooks/useSocket';
import TimelineReview from '../components/learn/TimelineReview';
import RaceEventLog from '../components/learn/RaceEventLog';
import { SectionHeader, EmptyState, Card } from '../ui';

export default function LearnMode() {
  const qc = useQueryClient();
  const [source, setSource] = useState('');
  const [sourceType, setSourceType] = useState<'single' | 'youtube_playlist' | 'twitch_collection'>('single');
  const [fps, setFps] = useState(2);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [trainingMode, setTrainingMode] = useState(false);
  const [snapshotInterval, setSnapshotInterval] = useState(1);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<{ queued: number; sessionIds: string[] } | null>(null);

  // Fetch sessions
  const { data: sessions = [] } = useQuery({
    queryKey: ['learn-sessions'],
    queryFn: getSessions,
    refetchInterval: 5000,
  });

  // Real-time progress updates
  const handleProgress = useCallback((data: { sessionId: string }) => {
    qc.invalidateQueries({ queryKey: ['learn-sessions'] });
    void data;
  }, [qc]);

  const handleComplete = useCallback((data: { sessionId: string }) => {
    qc.invalidateQueries({ queryKey: ['learn-sessions'] });
    void data;
  }, [qc]);

  useSocketEvent('learn:progress', handleProgress);
  useSocketEvent('learn:complete', handleComplete);
  useSocketEvent('learn:cancelled', handleComplete);
  useSocketEvent('learn:error', handleComplete);

  // Start session mutation
  const startMutation = useMutation({
    mutationFn: () => startSession(source, {
      fps,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      snapshotInterval: trainingMode ? snapshotInterval : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['learn-sessions'] });
      setSource('');
      setStartTime('');
      setEndTime('');
    },
  });

  // Batch session mutation
  const batchMutation = useMutation({
    mutationFn: (url: string) => startBatchSessions([url], {
      fps,
      snapshotInterval: trainingMode ? snapshotInterval : undefined,
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['learn-sessions'] });
      setBatchResult(data);
      setSource('');
    },
  });

  // Cancel mutation
  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learn-sessions'] }),
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learn-sessions'] }),
  });

  const active = sessions.filter(s => s.status === 'running' || s.status === 'starting');
  const completed = sessions.filter(s => s.status === 'completed');
  const errored = sessions.filter(s => s.status === 'error' || s.status === 'cancelled');

  // Timeline review mode — takes over the full page
  if (reviewSessionId) {
    return (
      <TimelineReview
        sessionId={reviewSessionId}
        onClose={() => setReviewSessionId(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="Learn Mode" />

      {/* Start Session Form */}
      <div
        className="rounded-lg p-4 border space-y-3"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Start Learn Session</h3>

        {/* Source type selector */}
        <div className="flex gap-2">
          {([
            { value: 'single', label: 'Single VOD' },
            { value: 'youtube_playlist', label: 'YouTube Playlist' },
            { value: 'twitch_collection', label: 'Twitch Collection' },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setSourceType(opt.value); setBatchResult(null); }}
              className="px-3 py-1.5 rounded text-xs cursor-pointer border transition-colors"
              style={{
                borderColor: sourceType === opt.value ? 'var(--accent)' : 'var(--border)',
                background: sourceType === opt.value ? 'var(--accent-subtle)' : 'transparent',
                color: sourceType === opt.value ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <input
            type="text"
            value={source}
            onChange={e => setSource(e.target.value)}
            placeholder={
              sourceType === 'youtube_playlist'
                ? 'YouTube playlist URL (e.g. https://youtube.com/playlist?list=...)'
                : sourceType === 'twitch_collection'
                ? 'Twitch collection URL (e.g. https://twitch.tv/collections/...)'
                : 'Twitch VOD URL, file path, or video URL...'
            }
            className="flex-1 rounded px-3 py-2 text-sm focus:outline-none"
            style={{
              background: 'var(--bg-base)',
              color: 'var(--text-primary)',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--border)',
            }}
          />
          {sourceType === 'single' && (
            <>
              <input
                type="text"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                placeholder="Start (e.g. 1:30:00)"
                className="w-36 rounded px-3 py-2 text-sm focus:outline-none"
                style={{
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--border)',
                }}
              />
              <input
                type="text"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                placeholder="End (e.g. 2:00:00)"
                className="w-36 rounded px-3 py-2 text-sm focus:outline-none"
                style={{
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--border)',
                }}
              />
            </>
          )}
          <select
            value={fps}
            onChange={e => setFps(Number(e.target.value))}
            className="rounded px-3 py-2 text-sm"
            style={{
              background: 'var(--bg-base)',
              color: 'var(--text-primary)',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--border)',
            }}
          >
            <option value={1}>1 fps</option>
            <option value={2}>2 fps</option>
            <option value={4}>4 fps</option>
            <option value={8}>8 fps</option>
          </select>
          <button
            onClick={() => {
              if (sourceType === 'single') {
                startMutation.mutate();
              } else {
                batchMutation.mutate(source);
              }
            }}
            disabled={!source.trim() || startMutation.isPending || batchMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
          >
            {(startMutation.isPending || batchMutation.isPending) ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {sourceType === 'single' ? 'Start' : 'Queue All'}
          </button>
        </div>
        {/* Training mode toggle */}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={trainingMode}
              onChange={e => setTrainingMode(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Training Mode</span>
          </label>
          {trainingMode && (
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Snapshot every</span>
              <select
                value={snapshotInterval}
                onChange={e => setSnapshotInterval(Number(e.target.value))}
                className="rounded px-2 py-1 text-xs"
                style={{
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--border)',
                }}
              >
                <option value={1}>1s</option>
                <option value={2}>2s</option>
                <option value={3}>3s</option>
                <option value={5}>5s</option>
                <option value={10}>10s</option>
                <option value={15}>15s</option>
                <option value={30}>30s</option>
              </select>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>(dense capture for annotation review)</span>
            </div>
          )}
        </div>
        {startMutation.isError && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>{(startMutation.error as Error).message}</p>
        )}
        {batchMutation.isError && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>{(batchMutation.error as Error).message}</p>
        )}

        {/* Batch result */}
        {batchResult && (
          <div className="rounded px-3 py-2 text-sm flex items-center gap-2"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
            <CheckCircle2 size={14} />
            Queued {batchResult.queued} session{batchResult.queued !== 1 ? 's' : ''} for processing.
          </div>
        )}

        {/* Batch progress — count active from this batch */}
        {batchResult && batchResult.queued > 0 && (() => {
          const batchIds = new Set(batchResult.sessionIds);
          const batchSessions = sessions.filter(s => batchIds.has(s.id));
          const done = batchSessions.filter(s => s.status === 'completed' || s.status === 'error').length;
          const total = batchResult.queued;
          if (done < total) {
            return (
              <div className="space-y-1">
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  Processing {done + 1}/{total} videos
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${Math.max(5, (done / total) * 100)}%`,
                    background: 'var(--accent)',
                  }} />
                </div>
              </div>
            );
          }
          return null;
        })()}

        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {sourceType === 'single'
            ? <>Paste a Twitch VOD URL (e.g. https://www.twitch.tv/videos/...) or a local file path. Start/End times are optional — use seconds (3600) or HH:MM:SS (1:00:00) to process a specific section.</>
            : sourceType === 'youtube_playlist'
            ? <>Paste a YouTube playlist URL. All videos in the playlist will be queued as individual learn sessions.</>
            : <>Paste a Twitch collection URL. All VODs in the collection will be queued as individual learn sessions.</>
          }
          {trainingMode && ' Training mode captures snapshots at shorter intervals for detailed annotation.'}
        </p>
      </div>

      {/* Active Sessions */}
      {active.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Active Sessions</h3>
          {active.map(s => (
            <ActiveSessionCard
              key={s.id}
              session={s}
              onCancel={() => cancelMutation.mutate(s.id)}
              expanded={expandedSession === s.id}
              onToggle={() => setExpandedSession(expandedSession === s.id ? null : s.id)}
            />
          ))}
        </div>
      )}

      {/* Completed Sessions */}
      {completed.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Completed Sessions</h3>
          {completed.map(s => (
            <CompletedSessionCard
              key={s.id}
              session={s}
              expanded={expandedSession === s.id}
              onToggle={() => setExpandedSession(expandedSession === s.id ? null : s.id)}
              onReview={() => setReviewSessionId(s.id)}
              onDelete={() => deleteMutation.mutate(s.id)}
            />
          ))}
        </div>
      )}

      {/* Errored Sessions */}
      {errored.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Failed / Cancelled</h3>
          {errored.map(s => (
            <div
              key={s.id}
              className="rounded-lg p-3 border"
              style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="mr-2" style={{ color: 'var(--text-muted)' }}>{s.id}</span>
                  <span style={{ color: s.status === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>{s.status}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs truncate max-w-xs" style={{ color: 'var(--text-muted)' }}>{s.source}</span>
                  <button
                    onClick={() => deleteMutation.mutate(s.id)}
                    className="flex items-center px-1.5 py-0.5 text-xs rounded transition-colors"
                    style={{ color: 'var(--danger)' }}
                    title="Delete session"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {s.error && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{s.error}</p>}
            </div>
          ))}
        </div>
      )}

      {sessions.length === 0 && (
        <Card>
          <EmptyState
            icon={<GraduationCap size={32} />}
            title="No learn sessions yet"
            description="Paste a Twitch VOD URL above to start analyzing detection quality."
          />
        </Card>
      )}
    </div>
  );
}

// ─── Active Session Card ───

function ActiveSessionCard({
  session: s,
  onCancel,
  expanded,
  onToggle,
}: {
  session: LearnSession;
  onCancel: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={onToggle} className="transition-colors" style={{ color: 'var(--text-muted)' }}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.id}</span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{s.status}</span>
          </div>
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors"
            style={{ color: 'var(--danger)' }}
          >
            <Square size={12} />
            Cancel
          </button>
        </div>

        <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{s.source}</div>

        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
            <span>{s.progress.framesProcessed} frames processed</span>
            {s.progress.currentScreenType && (
              <span style={{ color: 'var(--text-secondary)' }}>{s.progress.currentScreenType}</span>
            )}
          </div>
          <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
            {s.progress.percentComplete > 0 ? (
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(s.progress.percentComplete, 100)}%`, background: 'var(--accent)' }}
              />
            ) : (
              <div
                className="h-full rounded-full animate-pulse"
                style={{ width: '100%', background: 'var(--accent)', opacity: 0.8 }}
              />
            )}
          </div>
        </div>

        {/* Crop info */}
        {s.cropResult && (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Crop: {s.cropResult.x},{s.cropResult.y} {s.cropResult.w}x{s.cropResult.h}
            <span className="ml-2">
              confidence: {(s.cropResult.confidence * 100).toFixed(0)}%
              {s.cropResult.hud_verified && <span className="ml-1" style={{ color: 'var(--success)' }}>HUD verified</span>}
            </span>
          </div>
        )}
      </div>

      {/* Expanded: Annotation panel */}
      {expanded && <AnnotationPanel sessionId={s.id} annotations={s.annotations} />}
    </div>
  );
}

// ─── Completed Session Card ───

function CompletedSessionCard({
  session: s,
  expanded,
  onToggle,
  onReview,
  onDelete,
}: {
  session: LearnSession;
  expanded: boolean;
  onToggle: () => void;
  onReview: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const saveCropMutation = useMutation({
    mutationFn: () => saveCrop(s.id, s.profileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learn-sessions'] }),
  });

  const report = s.report;

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={onToggle} className="transition-colors" style={{ color: 'var(--text-muted)' }}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <CheckCircle2 size={14} style={{ color: 'var(--success)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.id}</span>
            {report && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {report.total_frames} frames | {report.video_duration_s.toFixed(0)}s video | {report.speedup_factor}x speed
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {s.report?.snapshots && s.report.snapshots.length > 0 && (
              <button
                onClick={onReview}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors"
                style={{ color: 'var(--accent)', background: 'var(--accent-subtle)' }}
              >
                <MonitorPlay size={12} />
                Review Timeline
              </button>
            )}
            {s.cropResult && (
              <button
                onClick={() => saveCropMutation.mutate()}
                disabled={saveCropMutation.isPending}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Save size={12} />
                Save Crop
              </button>
            )}
            <button
              onClick={onDelete}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors"
              style={{ color: 'var(--danger)' }}
              title="Delete session"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>

        <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{s.source}</div>

        {/* Crop result */}
        {s.cropResult && (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Crop: {s.cropResult.x},{s.cropResult.y} {s.cropResult.w}x{s.cropResult.h}
            <span className="ml-2">
              confidence: {(s.cropResult.confidence * 100).toFixed(0)}%
              {s.cropResult.hud_verified && <span className="ml-1" style={{ color: 'var(--success)' }}>HUD verified</span>}
            </span>
          </div>
        )}

        {saveCropMutation.isSuccess && (
          <p className="text-xs" style={{ color: 'var(--success)' }}>Crop saved to profile</p>
        )}
      </div>

      {/* Expanded: Race event log + report details + annotations */}
      {expanded && (
        <div className="border-t" style={{ borderColor: 'var(--border)' }}>
          {report?.game_events && report.game_events.length > 0 && (
            <RaceEventLog report={report} source={s.source} sessionId={s.id} />
          )}
          {report && <ReportDetails report={report} />}
          <AnnotationPanel sessionId={s.id} annotations={s.annotations} />
        </div>
      )}
    </div>
  );
}

// ─── Report Details ───

function ReportDetails({ report }: { report: LearnReport }) {
  return (
    <div className="p-4 space-y-4">
      {/* Screen type distribution */}
      <div>
        <h4 className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Screen Types</h4>
        <div className="flex flex-wrap gap-2">
          {Object.entries(report.screen_type_counts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <div key={type} className="rounded px-2 py-1 text-xs" style={{ background: 'var(--bg-base)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{type}</span>
                <span className="ml-1" style={{ color: 'var(--text-muted)' }}>{count}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-2">
        <StatBox label="Transitions" value={report.screen_transitions.length} />
        <StatBox label="Anomalies" value={report.anomalies.length} warn={report.anomalies.length > 0} />
        <StatBox label="Flicker Events" value={report.flicker_events.length} warn={report.flicker_events.length > 5} />
        <StatBox label="Processing" value={`${report.processing_time_s.toFixed(1)}s`} />
      </div>

      {/* Detector stats */}
      {Object.keys(report.detector_stats).length > 0 && (
        <div>
          <h4 className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Detector Value Changes</h4>
          <div className="flex flex-wrap gap-2">
            {Object.entries(report.detector_stats)
              .sort(([, a], [, b]) => b.value_changes - a.value_changes)
              .slice(0, 12)
              .map(([key, stat]) => (
                <div key={key} className="rounded px-2 py-1 text-xs" style={{ background: 'var(--bg-base)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{key}:</span>
                  <span className="ml-1" style={{ color: 'var(--text-primary)' }}>{stat.value_changes} changes</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Anomalies table */}
      {report.anomalies.length > 0 && (
        <div>
          <h4 className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Anomalies</h4>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {report.anomalies.slice(0, 50).map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
                <span style={{ color: 'var(--text-muted)' }}>{a.timestamp.toFixed(1)}s</span>
                <span style={{ color: 'var(--text-secondary)' }}>[{a.detector}]</span>
                <span style={{ color: 'var(--text-primary)' }}>{a.description}</span>
              </div>
            ))}
            {report.anomalies.length > 50 && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>...and {report.anomalies.length - 50} more</p>
            )}
          </div>
        </div>
      )}

      {/* Flicker events */}
      {report.flicker_events.length > 0 && (
        <div>
          <h4 className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Flicker Events</h4>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {report.flicker_events.slice(0, 20).map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span style={{ color: 'var(--text-muted)' }}>{f.timestamp.toFixed(1)}s</span>
                <span style={{ color: 'var(--text-secondary)' }}>{f.sequence}</span>
                <span style={{ color: 'var(--text-muted)' }}>({(f.duration * 1000).toFixed(0)}ms)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Snapshot Gallery */}
      {report.snapshots && report.snapshots.length > 0 && (
        <SnapshotGallery sessionId={report.session_id} snapshots={report.snapshots} />
      )}
    </div>
  );
}

function SnapshotGallery({ sessionId, snapshots }: { sessionId: string; snapshots: LearnSnapshot[] }) {
  const [selected, setSelected] = useState<LearnSnapshot | null>(null);
  const [filter, setFilter] = useState<'all' | 'transition' | 'interval'>('all');

  const filtered = filter === 'all' ? snapshots : snapshots.filter(s => s.reason === filter);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Snapshots ({snapshots.length})
        </h4>
        <div className="flex gap-1">
          {(['all', 'transition', 'interval'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-2 py-0.5 text-[10px] rounded"
              style={{
                background: filter === f ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                color: filter === f ? 'var(--accent)' : 'var(--text-muted)',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Thumbnail grid */}
      <div className="grid grid-cols-6 gap-1.5 max-h-64 overflow-y-auto">
        {filtered.map((snap) => (
          <button
            key={snap.filename}
            onClick={() => setSelected(selected?.filename === snap.filename ? null : snap)}
            className="relative rounded overflow-hidden"
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: selected?.filename === snap.filename ? 'var(--accent)' : 'var(--border)',
            }}
          >
            <img
              src={`/api/learn/snapshots/${sessionId}/${snap.filename}`}
              alt={`${snap.reason} at ${formatTime(snap.videoTimestamp)}`}
              className="w-full aspect-[4/3] object-cover"
              loading="lazy"
            />
            <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px]" style={{ background: 'rgba(0,0,0,0.7)' }}>
              <span style={{ color: snap.reason === 'transition' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                {formatTime(snap.videoTimestamp)}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Selected snapshot detail */}
      {selected && (
        <div className="mt-3 rounded p-3" style={{ background: 'var(--bg-base)' }}>
          <div className="flex gap-4">
            <img
              src={`/api/learn/snapshots/${sessionId}/${selected.filename}`}
              alt="Selected snapshot"
              className="w-64 rounded"
              style={{ borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)' }}
            />
            <div className="flex-1 space-y-2 text-xs">
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Time: </span>
                <span style={{ color: 'var(--text-primary)' }}>{formatTime(selected.videoTimestamp)}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Frame: </span>
                <span style={{ color: 'var(--text-primary)' }}>#{selected.frame}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Reason: </span>
                <span style={{ color: selected.reason === 'transition' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                  {selected.reason}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Screen: </span>
                <span style={{ color: 'var(--text-primary)' }}>{selected.screenType}</span>
              </div>
              {selected.extra && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Detail: </span>
                  <span style={{ color: 'var(--text-primary)' }}>{selected.extra}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="rounded p-2 text-center" style={{ background: 'var(--bg-base)' }}>
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm font-medium" style={{ color: warn ? 'var(--warning)' : 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

// ─── Annotation Panel (interactive training/feedback) ───

function AnnotationPanel({
  sessionId,
  annotations,
}: {
  sessionId: string;
  annotations: LearnAnnotation[];
}) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [noteType, setNoteType] = useState<LearnAnnotation['type']>('note');
  const [noteText, setNoteText] = useState('');
  const [noteField, setNoteField] = useState('');
  const [noteExpected, setNoteExpected] = useState('');

  const addMutation = useMutation({
    mutationFn: () =>
      addAnnotation(sessionId, {
        type: noteType,
        note: noteText,
        field: noteField || undefined,
        expectedValue: noteExpected || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['learn-sessions'] });
      setNoteText('');
      setNoteField('');
      setNoteExpected('');
      setShowForm(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (annotationId: string) => deleteAnnotation(sessionId, annotationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learn-sessions'] }),
  });

  return (
    <div className="border-t p-4 space-y-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Training Notes ({annotations.length})
        </h4>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors"
          style={{ color: 'var(--accent)' }}
        >
          <MessageSquarePlus size={12} />
          Add Note
        </button>
      </div>

      {/* Add annotation form */}
      {showForm && (
        <div className="rounded p-3 space-y-2" style={{ background: 'var(--bg-base)' }}>
          <div className="flex gap-2">
            <select
              value={noteType}
              onChange={e => setNoteType(e.target.value as LearnAnnotation['type'])}
              className="rounded px-2 py-1 text-xs"
              style={{
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--border)',
              }}
            >
              <option value="note">Note</option>
              <option value="correction">Correction</option>
              <option value="bookmark">Bookmark</option>
              <option value="error">Error</option>
            </select>
            {noteType === 'correction' && (
              <>
                <input
                  type="text"
                  value={noteField}
                  onChange={e => setNoteField(e.target.value)}
                  placeholder="Field (e.g. hearts_current)"
                  className="rounded px-2 py-1 text-xs w-40"
                  style={{
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--border)',
                  }}
                />
                <input
                  type="text"
                  value={noteExpected}
                  onChange={e => setNoteExpected(e.target.value)}
                  placeholder="Expected value"
                  className="rounded px-2 py-1 text-xs w-32"
                  style={{
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--border)',
                  }}
                />
              </>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="Your observation or correction..."
              className="flex-1 rounded px-2 py-1 text-xs focus:outline-none"
              style={{
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--border)',
              }}
              onKeyDown={e => e.key === 'Enter' && noteText.trim() && addMutation.mutate()}
            />
            <button
              onClick={() => addMutation.mutate()}
              disabled={!noteText.trim() || addMutation.isPending}
              className="px-3 py-1 rounded text-xs disabled:opacity-40"
              style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Annotation list */}
      {annotations.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {annotations.map(a => (
            <div key={a.id} className="flex items-start gap-2 text-xs group">
              <AnnotationIcon type={a.type} />
              <div className="flex-1 min-w-0">
                <span style={{ color: 'var(--text-primary)' }}>{a.note}</span>
                {a.field && (
                  <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
                    [{a.field}{a.expectedValue ? ` = ${a.expectedValue}` : ''}]
                  </span>
                )}
              </div>
              <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                {new Date(a.timestamp).toLocaleTimeString()}
              </span>
              <button
                onClick={() => deleteMutation.mutate(a.id)}
                className="opacity-0 group-hover:opacity-100 shrink-0 transition-opacity"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnnotationIcon({ type }: { type: LearnAnnotation['type'] }) {
  switch (type) {
    case 'correction':
      return <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />;
    case 'bookmark':
      return <Bookmark size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />;
    case 'error':
      return <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />;
    default:
      return <MessageSquarePlus size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />;
  }
}
