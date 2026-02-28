import { useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ArrowLeft, Keyboard, Play, ClipboardCheck } from 'lucide-react';
import {
  getSession, addAnnotation, deleteAnnotation, updateSessionMetadata,
} from '../../lib/learnApi';
import type { LearnAnnotationType, SessionMetadata } from '../../lib/learnApi';
import ScreenTypeBar from './ScreenTypeBar';
import TimelineScrubber from './TimelineScrubber';
import SnapshotViewer from './SnapshotViewer';
import AnnotationPanel from './AnnotationPanel';
import type { AnnotationPanelHandle } from './AnnotationPanel';
import SessionMetadataForm from './SessionMetadataForm';
import RaceStatsPanel from './RaceStatsPanel';
import SnapshotReviewer from './SnapshotReviewer';
import { useTimelineNavigation } from './useTimelineNavigation';

interface TimelineReviewProps {
  sessionId: string;
  onClose: () => void;
}

export default function TimelineReview({ sessionId, onClose }: TimelineReviewProps) {
  const queryClient = useQueryClient();
  const annotationPanelRef = useRef<AnnotationPanelHandle>(null);

  const { data: session } = useQuery({
    queryKey: ['learn-session', sessionId],
    queryFn: () => getSession(sessionId),
    refetchInterval: false,
  });

  const [mode, setMode] = useState<'playback' | 'review'>('playback');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showKeys, setShowKeys] = useState(false);

  const report = session?.report;
  const snapshots = report?.snapshots ?? [];
  const annotations = session?.annotations ?? [];
  const duration = report?.video_duration_s ?? 0;
  const currentSnapshot = snapshots[currentIndex] ?? null;

  useTimelineNavigation({
    snapshots,
    currentIndex,
    setCurrentIndex,
    isPlaying,
    setIsPlaying,
    onAnnotate: () => annotationPanelRef.current?.focus(),
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['learn-session', sessionId] });
  }, [queryClient, sessionId]);

  const addMutation = useMutation({
    mutationFn: (ann: { type: LearnAnnotationType; note: string; field?: string; expectedValue?: string; detectedValue?: string; frameNumber?: number; videoTimestamp?: number; snapshotFilename?: string; metadata?: Record<string, string> }) =>
      addAnnotation(sessionId, ann),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAnnotation(sessionId, id),
    onSuccess: invalidate,
  });

  const metadataMutation = useMutation({
    mutationFn: (metadata: Partial<SessionMetadata>) => updateSessionMetadata(sessionId, metadata),
    onSuccess: invalidate,
  });

  if (!session || !report) {
    return (
      <div className="p-8 text-white/40 text-center">
        Loading session...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 h-[calc(100vh-80px)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onClose}
          className="flex items-center gap-1 px-2 py-1 text-sm text-white/60 hover:text-white/90 rounded hover:bg-white/10 transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <div className="flex-1 text-sm text-white/40 truncate">
          Session {sessionId} — {session.source}
        </div>
        {/* Mode toggle */}
        <div className="flex bg-white/5 rounded overflow-hidden">
          <button
            onClick={() => setMode('playback')}
            className={`flex items-center gap-1 px-3 py-1 text-xs transition-colors ${
              mode === 'playback' ? 'bg-gold/20 text-gold' : 'text-white/40 hover:text-white/70'
            }`}
          >
            <Play size={12} />
            Playback
          </button>
          <button
            onClick={() => setMode('review')}
            className={`flex items-center gap-1 px-3 py-1 text-xs transition-colors ${
              mode === 'review' ? 'bg-gold/20 text-gold' : 'text-white/40 hover:text-white/70'
            }`}
          >
            <ClipboardCheck size={12} />
            Review
          </button>
        </div>
        <button
          onClick={() => setShowKeys(!showKeys)}
          className="p-1 text-white/30 hover:text-white/60 transition-colors"
          title="Keyboard shortcuts"
        >
          <Keyboard size={16} />
        </button>
      </div>

      {/* Keyboard help */}
      {showKeys && (
        <div className="bg-panel rounded-lg p-3 border border-white/10 text-xs text-white/50 grid grid-cols-2 gap-x-6 gap-y-1">
          <span><kbd className="text-white/70">←</kbd> / <kbd className="text-white/70">j</kbd> Previous</span>
          <span><kbd className="text-white/70">→</kbd> / <kbd className="text-white/70">l</kbd> Next</span>
          <span><kbd className="text-white/70">↑</kbd> Prev transition</span>
          <span><kbd className="text-white/70">↓</kbd> Next transition</span>
          <span><kbd className="text-white/70">Space</kbd> Play/Pause</span>
          <span><kbd className="text-white/70">a</kbd> Add annotation</span>
          <span><kbd className="text-white/70">Home</kbd> / <kbd className="text-white/70">End</kbd> Start/End</span>
        </div>
      )}

      {/* Session metadata */}
      <SessionMetadataForm
        metadata={session.metadata}
        onSave={(m) => metadataMutation.mutate(m)}
      />

      {/* Screen type bar + timeline scrubber */}
      <div className="flex flex-col gap-1">
        <ScreenTypeBar transitions={report.screen_transitions} duration={duration} />
        <TimelineScrubber
          snapshots={snapshots}
          annotations={annotations}
          duration={duration}
          currentIndex={currentIndex}
          onSeek={setCurrentIndex}
          gameEvents={report.game_events}
          fps={report.total_frames > 0 && report.video_duration_s > 0 ? report.total_frames / report.video_duration_s : 2}
        />
      </div>

      {/* Main content */}
      {mode === 'review' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <SnapshotReviewer
            sessionId={sessionId}
            snapshots={snapshots}
            anomalies={report.anomalies}
            calibration={report.calibration}
            onAddAnnotation={(ann) => addMutation.mutate(ann)}
            onClose={() => setMode('playback')}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-2 flex-1 min-h-0 overflow-hidden">
          <div className="overflow-hidden flex flex-col min-h-0">
            <SnapshotViewer
              sessionId={sessionId}
              sessionSource={session.source}
              snapshots={snapshots}
              currentIndex={currentIndex}
              setCurrentIndex={setCurrentIndex}
              isPlaying={isPlaying}
              setIsPlaying={setIsPlaying}
              playbackSpeed={playbackSpeed}
              setPlaybackSpeed={setPlaybackSpeed}
            />
          </div>
          <div className="overflow-y-auto min-h-0">
            <AnnotationPanel
              ref={annotationPanelRef}
              annotations={annotations}
              currentSnapshot={currentSnapshot}
              onAdd={(ann) => addMutation.mutate(ann)}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
            {/* Race stats below annotations */}
            <div className="mt-3">
              <RaceStatsPanel report={report} annotations={annotations} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
