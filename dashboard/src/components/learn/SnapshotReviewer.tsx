import { useState, useMemo, useEffect, useCallback } from 'react';
import { Check, X, MessageSquare, Copy, SkipForward, ArrowLeft, ChevronDown } from 'lucide-react';
import type { LearnSnapshot, LearnReport, LearnAnnotationType } from '../../lib/learnApi';
import {
  generateQueue, CATEGORY_LABELS, positionLabel, positionToGrid, gridColsForScreen,
  type ReviewCategory, type ReviewItem,
} from '../../lib/reviewQueue';
import { formatTimestampLong, ZELDA_ITEMS, B_ITEMS, SCREEN_TYPES } from './types';
import MapGrid from './MapGrid';

interface SnapshotReviewerProps {
  sessionId: string;
  snapshots: LearnSnapshot[];
  anomalies: LearnReport['anomalies'];
  calibration?: LearnReport['calibration'];
  onAddAnnotation: (ann: {
    type: LearnAnnotationType;
    note: string;
    field?: string;
    expectedValue?: string;
    detectedValue?: string;
    frameNumber?: number;
    videoTimestamp?: number;
    snapshotFilename?: string;
    metadata?: Record<string, string>;
  }) => void;
  onClose: () => void;
}

const CONFIDENCE_COLORS = {
  high: 'text-green-400',
  medium: 'text-yellow-400',
  low: 'text-red-400',
};

const CONFIDENCE_BG = {
  high: 'bg-green-500/10 border-green-500/20',
  medium: 'bg-yellow-500/10 border-yellow-500/20',
  low: 'bg-red-500/10 border-red-500/20',
};

export default function SnapshotReviewer({
  sessionId, snapshots, anomalies, calibration, onAddAnnotation, onClose,
}: SnapshotReviewerProps) {
  const [category, setCategory] = useState<ReviewCategory>('map_position');
  const [queueIndex, setQueueIndex] = useState(0);
  const [correcting, setCorrecting] = useState(false);
  const [correctionValue, setCorrectionValue] = useState('');
  const [correctionTarget, setCorrectionTarget] = useState<'current' | 'previous'>('current');
  const [commenting, setCommenting] = useState(false);
  const [commentNote, setCommentNote] = useState('');

  const queue = useMemo(
    () => generateQueue(snapshots, category, anomalies),
    [snapshots, category, anomalies],
  );

  const item: ReviewItem | null = queue[queueIndex] ?? null;

  // Reset queue position when category changes
  useEffect(() => {
    setQueueIndex(0);
    setCorrecting(false);
  }, [category]);

  const advance = useCallback(() => {
    setCorrecting(false);
    setCorrectionValue('');
    setCorrectionTarget('current');
    setCommenting(false);
    setCommentNote('');
    setQueueIndex(i => Math.min(i + 1, queue.length));
  }, [queue.length]);

  const goBack = useCallback(() => {
    setCorrecting(false);
    setCorrectionValue('');
    setCorrectionTarget('current');
    setCommenting(false);
    setCommentNote('');
    setQueueIndex(i => Math.max(i - 1, 0));
  }, []);

  const handleConfirm = useCallback(() => {
    if (!item) return;
    // Optionally log a verified annotation
    onAddAnnotation({
      type: 'correction',
      note: `Verified ${item.field} = ${item.detectedValue}`,
      field: item.field,
      expectedValue: item.detectedValue,
      detectedValue: item.detectedValue,
      frameNumber: item.snapshot.frame,
      videoTimestamp: item.snapshot.videoTimestamp,
      snapshotFilename: item.snapshot.filename,
      metadata: { review: 'verified' },
    });
    advance();
  }, [item, onAddAnnotation, advance]);

  const handleCorrect = useCallback(() => {
    if (!item || !correctionValue) return;

    const targetSnap = correctionTarget === 'previous' ? item.prevSnapshot : item.snapshot;
    if (!targetSnap) return;

    onAddAnnotation({
      type: 'correction',
      note: `Corrected ${correctionTarget} ${item.field}: ${item.detectedValue} → ${correctionValue}`,
      field: item.field,
      expectedValue: correctionValue,
      detectedValue: item.detectedValue,
      frameNumber: targetSnap.frame,
      videoTimestamp: targetSnap.videoTimestamp,
      snapshotFilename: targetSnap.filename,
      metadata: { review: 'corrected', target: correctionTarget },
    });
    // Don't auto-advance — user may want to correct the other target too.
    // Reset correction state so they can click another neighborhood or advance.
    setCorrecting(false);
    setCorrectionValue('');
  }, [item, correctionValue, correctionTarget, onAddAnnotation]);

  const handleComment = useCallback(() => {
    if (!item || !commentNote) return;
    onAddAnnotation({
      type: 'note',
      note: commentNote,
      field: item.field,
      detectedValue: item.detectedValue,
      frameNumber: item.snapshot.frame,
      videoTimestamp: item.snapshot.videoTimestamp,
      snapshotFilename: item.snapshot.filename,
      metadata: { review: 'comment' },
    });
    advance();
  }, [item, commentNote, onAddAnnotation, advance]);

  const handleCopy = useCallback(() => {
    if (!item) return;
    const snap = item.snapshot;
    const lines = [
      `**Snapshot ${snap.filename}** @ ${formatTimestampLong(snap.videoTimestamp)}`,
      `Category: ${category}`,
      `Field: ${item.field} = ${item.detectedValue}`,
      '',
      'Context:',
      ...item.context.map(c => `- ${c}`),
      '',
      `Interpretation (${item.confidence}): ${item.interpretation}`,
      '',
      `Image: /api/learn/snapshots/${sessionId}/${snap.filename}`,
    ];
    navigator.clipboard.writeText(lines.join('\n'));
  }, [item, category, sessionId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Enter' || e.key === 'y') {
        e.preventDefault();
        if (correcting) handleCorrect();
        else if (commenting) handleComment();
        else handleConfirm();
      } else if (e.key === 'n') {
        e.preventDefault();
        setCommenting(false);
        setCorrecting(true);
      } else if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setCommenting(false);
        setCorrecting(false);
        handleCopy();
      } else if (e.key === 't') {
        e.preventDefault();
        setCorrecting(false);
        setCommenting(true);
      } else if (e.key === 's' || (e.key === 'ArrowRight' && !correcting && !commenting)) {
        e.preventDefault();
        advance();
      } else if (e.key === 'ArrowLeft' && !correcting && !commenting) {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setCorrecting(false);
        setCommenting(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [correcting, handleConfirm, handleCorrect, advance, goBack]);

  // ─── Render ───

  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <CategorySelector value={category} onChange={setCategory} />
        <div className="text-white/40 text-sm">
          No snapshots to review for this category.
        </div>
        <button onClick={onClose} className="text-xs text-white/50 hover:text-white/80">
          Back to playback
        </button>
      </div>
    );
  }

  if (queueIndex >= queue.length) {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <CategorySelector value={category} onChange={setCategory} />
        <div className="text-green-400 text-sm font-medium">
          Queue complete! Reviewed {queue.length} snapshots.
        </div>
        <button onClick={onClose} className="text-xs text-white/50 hover:text-white/80">
          Back to playback
        </button>
      </div>
    );
  }

  const snap = item!.snapshot;
  const imgUrl = `/api/learn/snapshots/${sessionId}/${snap.filename}`;

  return (
    <div className="flex flex-col gap-2 h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <CategorySelector value={category} onChange={setCategory} />
        <div className="flex-1" />
        <span className="text-xs text-white/40 font-mono">
          {queueIndex + 1} / {queue.length}
        </span>
        <div className="w-24 h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-gold rounded-full transition-all"
            style={{ width: `${((queueIndex + 1) / queue.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Calibration banner */}
      {category === 'map_position' && calibration && (
        <div className={`text-xs rounded px-3 py-1.5 flex-shrink-0 ${
          calibration.applied
            ? 'bg-green-500/10 border border-green-500/20 text-green-400'
            : 'bg-white/5 border border-white/10 text-white/50'
        }`}>
          {(() => {
            const parts: string[] = [];
            if (calibration.refined) {
              const mm = calibration.minimap_corrections || 0;
              const im = calibration.image_corrections || 0;
              parts.push(`Refined ${calibration.refined}/${calibration.refined_checked} (${mm} minimap, ${im} image)`);
            }
            const refinedInfo = parts.length ? ` | ${parts.join(', ')}` : '';
            return calibration.applied
              ? `Calibrated: col ${calibration.offset_col > 0 ? '+' : ''}${calibration.offset_col}, row ${calibration.offset_row > 0 ? '+' : ''}${calibration.offset_row} (${Math.round(calibration.confidence * 100)}% confidence, ${calibration.samples} samples)${refinedInfo}`
              : `Calibration: no offset needed (${Math.round(calibration.confidence * 100)}% confidence, ${calibration.samples} samples)${refinedInfo}`;
          })()}
        </div>
      )}

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3 flex-1 min-h-0 overflow-hidden">
        {/* Left: snapshot images + map grid */}
        <div className="flex flex-col gap-2 min-h-0 overflow-hidden">
          <div className="flex-1 min-h-[200px] flex gap-1.5">
            {/* Previous snapshot (smaller, left) */}
            {item!.prevSnapshot && (
              <div className="relative bg-black rounded-lg overflow-hidden flex items-center justify-center flex-[2] min-w-0 opacity-60">
                <img
                  src={`/api/learn/snapshots/${sessionId}/${item!.prevSnapshot.filename}`}
                  alt={item!.prevSnapshot.filename}
                  className="max-w-full max-h-full object-contain"
                  style={{ imageRendering: 'pixelated' }}
                />
                <div className="absolute top-0 left-0 bg-black/70 px-2 py-0.5 text-[10px] text-white/50 rounded-br">
                  Previous
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-2 py-0.5 text-[10px]">
                  <span className="font-mono text-white/50">{formatTimestampLong(item!.prevSnapshot.videoTimestamp)}</span>
                </div>
              </div>
            )}
            {/* Current snapshot (larger, center) */}
            <div className="relative bg-black rounded-lg overflow-hidden flex items-center justify-center flex-[3] min-w-0">
              <img
                src={imgUrl}
                alt={snap.filename}
                className="max-w-full max-h-full object-contain"
                style={{ imageRendering: 'pixelated' }}
              />
              <div className={`absolute top-0 left-0 bg-black/70 px-2 py-0.5 text-[10px] rounded-br ${
                snap.positionConfidence === 'low' ? 'text-red-400' : 'text-gold/80'
              }`}>
                Current{snap.positionConfidence === 'low' ? ' (transition?)' : ''}
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-3 py-1 flex items-center gap-3 text-xs">
                <span className="font-mono text-white/80">{formatTimestampLong(snap.videoTimestamp)}</span>
                <span className="text-white/50">{snap.filename}</span>
              </div>
            </div>
            {/* Next snapshot (lookforward for low-confidence transitions) */}
            {item!.nextSnapshot && snap.positionConfidence === 'low' && (
              <div className="relative bg-black rounded-lg overflow-hidden flex items-center justify-center flex-[2] min-w-0 opacity-60">
                <img
                  src={`/api/learn/snapshots/${sessionId}/${item!.nextSnapshot.filename}`}
                  alt={item!.nextSnapshot.filename}
                  className="max-w-full max-h-full object-contain"
                  style={{ imageRendering: 'pixelated' }}
                />
                <div className="absolute top-0 left-0 bg-black/70 px-2 py-0.5 text-[10px] text-blue-400/70 rounded-br">
                  Next
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-2 py-0.5 text-[10px]">
                  <span className="font-mono text-white/50">{formatTimestampLong(item!.nextSnapshot.videoTimestamp)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Map grid + room neighborhoods (only for map_position category) */}
          {category === 'map_position' && (
            <div className="flex-shrink-0 bg-panel rounded-lg p-2 space-y-2 max-h-[320px] overflow-y-auto">
              <div className="flex items-center gap-3 mb-1">
                <MapGrid
                  position={snap.mapPosition}
                  prevPosition={item!.prevSnapshot?.mapPosition}
                  isDungeon={snap.screenType === 'dungeon'}
                />
                <div className="text-xs text-white/40">
                  <div>
                    {snap.screenType === 'dungeon' ? '8x8 dungeon' : '16x8 overworld'} grid
                  </div>
                </div>
              </div>
              {/* Side-by-side room neighborhoods: Previous + Current */}
              <div className="flex gap-3">
                {/* Previous neighborhood */}
                {item!.prevSnapshot && item!.prevSnapshot.screenType === 'overworld' && item!.prevSnapshot.mapPosition > 0 && (
                  <RoomNeighborhood
                    label="Previous"
                    position={item!.prevSnapshot.mapPosition}
                    labelColor="text-white/50"
                    borderColor="border-white/40"
                    onSelect={(pos) => {
                      const cols = gridColsForScreen(item!.prevSnapshot!.screenType);
                      setCorrectionValue(positionLabel(pos, cols));
                      setCorrectionTarget('previous');
                      setCorrecting(true);
                    }}
                  />
                )}
                {/* Current neighborhood */}
                {snap.screenType === 'overworld' && snap.mapPosition > 0 && (
                  <RoomNeighborhood
                    label="Current"
                    position={snap.mapPosition}
                    labelColor="text-gold"
                    borderColor="border-gold"
                    onSelect={(pos) => {
                      const cols = gridColsForScreen(snap.screenType);
                      setCorrectionValue(positionLabel(pos, cols));
                      setCorrectionTarget('current');
                      setCorrecting(true);
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right: context + interpretation + actions */}
        <div className="flex flex-col min-h-0">
          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pb-2">
          {/* Context */}
          <div className="bg-panel rounded-lg p-3">
            <div className="text-xs font-medium text-white/50 mb-2">Context</div>
            <ul className="text-xs text-white/80 space-y-1">
              {item!.context.map((line, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-white/30 mt-0.5">-</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Interpretation */}
          <div className={`rounded-lg p-3 border ${CONFIDENCE_BG[item!.confidence]}`}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-medium text-white/50">Interpretation</span>
              <span className={`text-xs font-mono ${CONFIDENCE_COLORS[item!.confidence]}`}>
                {item!.confidence.toUpperCase()}
              </span>
            </div>
            <div className="text-xs text-white/80">
              {item!.interpretation}
            </div>
          </div>

          {/* Comment input */}
          {commenting && (
            <div className="bg-panel-light rounded-lg p-3 border border-blue-500/20">
              <div className="text-xs font-medium text-blue-400 mb-2">Add Comment</div>
              <textarea
                value={commentNote}
                onChange={e => setCommentNote(e.target.value)}
                placeholder="Your observations — what do you see?"
                className="w-full bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10 resize-none"
                rows={2}
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleComment}
                  disabled={!commentNote}
                  className="px-3 py-1 text-xs bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30 disabled:opacity-30"
                >
                  Save &amp; Next
                </button>
                <button
                  onClick={() => setCommenting(false)}
                  className="px-3 py-1 text-xs text-white/50 hover:text-white/80"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Correction input */}
          {correcting && (
            <div className="bg-panel-light rounded-lg p-3 border border-gold/20">
              <div className="text-xs font-medium text-gold mb-2">
                Correction
                <span className={`ml-2 font-mono ${correctionTarget === 'previous' ? 'text-white/50' : 'text-gold/70'}`}>
                  ({correctionTarget})
                </span>
              </div>
              <CorrectionInput
                category={category}
                currentValue={item!.detectedValue}
                snapshot={snap}
                value={correctionValue}
                onChange={setCorrectionValue}
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleCorrect}
                  disabled={!correctionValue}
                  className="px-3 py-1 text-xs bg-gold/20 text-gold rounded hover:bg-gold/30 disabled:opacity-30"
                >
                  Submit
                </button>
                <button
                  onClick={() => setCorrecting(false)}
                  className="px-3 py-1 text-xs text-white/50 hover:text-white/80"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          </div>{/* end scrollable content */}

          {/* Action buttons — pinned at bottom */}
          <div className="flex gap-1.5 flex-shrink-0 pt-2 border-t border-white/5 flex-wrap">
            <button
              onClick={goBack}
              disabled={queueIndex === 0}
              className="px-2.5 py-2 text-xs rounded bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 disabled:opacity-30 flex items-center gap-1"
            >
              <ArrowLeft size={14} />
            </button>
            <button
              onClick={handleConfirm}
              className="px-3 py-2 text-xs rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 flex items-center gap-1.5 flex-1 justify-center"
            >
              <Check size={14} />
              Correct
              <kbd className="text-[10px] text-green-400/50 ml-1">y</kbd>
            </button>
            <button
              onClick={() => { setCommenting(false); setCorrecting(true); }}
              className="px-3 py-2 text-xs rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 flex items-center gap-1.5 flex-1 justify-center"
            >
              <X size={14} />
              Wrong
              <kbd className="text-[10px] text-red-400/50 ml-1">n</kbd>
            </button>
            <button
              onClick={() => { setCorrecting(false); setCommenting(true); }}
              className="px-3 py-2 text-xs rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 flex items-center gap-1.5 flex-1 justify-center"
            >
              <MessageSquare size={14} />
              Comment
              <kbd className="text-[10px] text-blue-400/50 ml-1">t</kbd>
            </button>
            <button
              onClick={handleCopy}
              className="px-2.5 py-2 text-xs rounded bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 flex items-center gap-1"
              title="Copy context to clipboard"
            >
              <Copy size={14} />
              <kbd className="text-[10px] text-white/30">c</kbd>
            </button>
            <button
              onClick={advance}
              className="px-2.5 py-2 text-xs rounded bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 flex items-center gap-1"
            >
              <SkipForward size={14} />
              <kbd className="text-[10px] text-white/30">s</kbd>
            </button>
          </div>

          {/* Keyboard hint */}
          <div className="text-[10px] text-white/20 text-center flex-shrink-0">
            <kbd>y</kbd> correct &middot; <kbd>n</kbd> wrong &middot; <kbd>t</kbd> comment &middot; <kbd>c</kbd> copy &middot; <kbd>s</kbd> skip &middot; <kbd>&larr;</kbd> back
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───

function RoomNeighborhood({
  position,
  label,
  labelColor = 'text-white/50',
  borderColor = 'border-gold',
  onSelect,
}: {
  position: number;
  label?: string;
  labelColor?: string;
  borderColor?: string;
  onSelect: (roomPosition: number) => void;
}) {
  const [radius, setRadius] = useState(1); // 1 = 3x3, 2 = 5x5
  const cols = 16; // overworld only
  const rows = 8;
  const centerRow = Math.floor(position / cols);
  const centerCol = position % cols;

  const minRow = Math.max(0, centerRow - radius);
  const maxRow = Math.min(rows - 1, centerRow + radius);
  const minCol = Math.max(0, centerCol - radius);
  const maxCol = Math.min(cols - 1, centerCol + radius);

  const gridRows: number[][] = [];
  for (let r = minRow; r <= maxRow; r++) {
    const rowPositions: number[] = [];
    for (let c = minCol; c <= maxCol; c++) {
      rowPositions.push(r * cols + c);
    }
    gridRows.push(rowPositions);
  }

  const gridCols = maxCol - minCol + 1;

  return (
    <div className="space-y-1 flex-1 min-w-0">
      <div className="flex items-center gap-2">
        {label && (
          <span className={`text-xs font-medium ${labelColor}`}>{label}</span>
        )}
        <span className={`text-xs font-mono ${labelColor}`}>
          {positionLabel(position, cols)}
        </span>
        <button
          onClick={() => setRadius(r => r === 1 ? 2 : 1)}
          className="text-[10px] text-white/40 hover:text-white/70 underline ml-auto"
        >
          {radius === 1 ? '5x5' : '3x3'}
        </button>
      </div>
      <div
        className="inline-grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)`, maxWidth: radius === 1 ? '200px' : '320px' }}
      >
        {gridRows.flatMap((rowPositions) =>
          rowPositions.map((pos) => {
            const r = Math.floor(pos / cols);
            const c = pos % cols;
            const isCenter = pos === position;
            return (
              <button
                key={pos}
                onClick={() => onSelect(pos)}
                className={`relative group border-2 rounded overflow-hidden ${
                  isCenter
                    ? borderColor
                    : 'border-white/10 hover:border-white/30'
                }`}
                title={`C${c + 1},R${r + 1} (room ${pos})`}
              >
                <img
                  src={`/api/learn/rooms/C${c + 1}_R${r + 1}.jpg`}
                  alt={`C${c + 1},R${r + 1}`}
                  className="w-full h-auto block"
                  style={{ imageRendering: 'pixelated' }}
                />
                <div
                  className={`absolute bottom-0 left-0 right-0 text-[8px] font-mono text-center py-0.5 ${
                    isCenter
                      ? 'bg-black/70 text-white/90 font-bold'
                      : 'bg-black/60 text-white/60 group-hover:text-white/90'
                  }`}
                >
                  C{c + 1},R{r + 1}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function CategorySelector({ value, onChange }: { value: ReviewCategory; onChange: (v: ReviewCategory) => void }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value as ReviewCategory)}
        className="appearance-none bg-panel text-white/90 text-sm rounded px-3 py-1.5 pr-7 border border-white/10 cursor-pointer hover:border-white/20"
      >
        {(Object.entries(CATEGORY_LABELS) as [ReviewCategory, string][]).map(([k, label]) => (
          <option key={k} value={k}>{label}</option>
        ))}
      </select>
      <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
    </div>
  );
}

function CorrectionInput({
  category, currentValue, snapshot, value, onChange,
}: {
  category: ReviewCategory;
  currentValue: string;
  snapshot: LearnSnapshot;
  value: string;
  onChange: (v: string) => void;
}) {
  switch (category) {
    case 'map_position': {
      const cols = gridColsForScreen(snapshot.screenType);
      // Parse CX,RY format (e.g. "C13,R4")
      const src = value || currentValue;
      const match = src.match(/C(\d+),R(\d+)/i);
      const colVal = match ? parseInt(match[1]) : 1;
      const rowVal = match ? parseInt(match[2]) : 1;
      const updatePos = (c: number, r: number) => onChange(`C${c},R${r}`);
      return (
        <div className="flex items-center gap-3">
          <label className="text-xs text-white/50">
            C:
            <input
              type="number" min={1} max={cols}
              value={colVal}
              onChange={e => updatePos(parseInt(e.target.value) || 1, rowVal)}
              className="ml-1 w-12 bg-surface text-white/90 text-xs rounded px-2 py-1 border border-white/10"
            />
          </label>
          <label className="text-xs text-white/50">
            R:
            <input
              type="number" min={1} max={8}
              value={rowVal}
              onChange={e => updatePos(colVal, parseInt(e.target.value) || 1)}
              className="ml-1 w-12 bg-surface text-white/90 text-xs rounded px-2 py-1 border border-white/10"
            />
          </label>
          <span className="text-xs text-white/30 font-mono">
            C{colVal},R{rowVal}
          </span>
        </div>
      );
    }

    case 'b_item':
      return (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10 w-full"
        >
          <option value="">Select correct B-item...</option>
          <option value="none">None (empty)</option>
          {B_ITEMS.map(item => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      );

    case 'screen_type':
      return (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10 w-full"
        >
          <option value="">Select correct screen type...</option>
          {SCREEN_TYPES.map(st => (
            <option key={st} value={st}>{st}</option>
          ))}
        </select>
      );

    case 'items':
      return (
        <div className="space-y-1">
          <div className="text-xs text-white/40 mb-1">Note what you see on the subscreen:</div>
          <textarea
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="e.g., 'missing ladder, has raft and book'"
            className="w-full bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10 resize-none"
            rows={2}
          />
          <div className="flex flex-wrap gap-1">
            {ZELDA_ITEMS.slice(0, 15).map(item => (
              <button
                key={item}
                onClick={() => onChange(value ? `${value}, ${item}` : item)}
                className="px-1.5 py-0.5 text-[10px] rounded bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      );

    default:
      return null;
  }
}
