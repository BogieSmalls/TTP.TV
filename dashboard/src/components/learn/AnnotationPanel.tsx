import { useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import {
  Package, DoorOpen, DoorClosed, MapPin, Lightbulb, Hammer,
  Skull, Zap, StickyNote, Bookmark, PenLine, AlertTriangle,
  Trash2, X,
} from 'lucide-react';
import type { LearnAnnotation, LearnAnnotationType, LearnSnapshot } from '../../lib/learnApi';
import { ANNOTATION_CONFIG, ZELDA_ITEMS, formatTimestampLong } from './types';

const ICON_MAP: Record<string, React.ComponentType<{ size?: number }>> = {
  Package, DoorOpen, DoorClosed, MapPin, Lightbulb, Hammer,
  Skull, Zap, StickyNote, Bookmark, PenLine, AlertTriangle,
};

interface AnnotationPanelProps {
  annotations: LearnAnnotation[];
  currentSnapshot: LearnSnapshot | null;
  onAdd: (annotation: {
    type: LearnAnnotationType;
    note: string;
    frameNumber?: number;
    videoTimestamp?: number;
    snapshotFilename?: string;
    metadata?: Record<string, string>;
  }) => void;
  onDelete: (id: string) => void;
}

export interface AnnotationPanelHandle {
  focus: () => void;
}

const QUICK_TYPES: LearnAnnotationType[] = [
  'item_pickup', 'dungeon_enter', 'dungeon_exit', 'location',
  'strategy', 'door_repair', 'death', 'note',
];

const AnnotationPanel = forwardRef<AnnotationPanelHandle, AnnotationPanelProps>(
  function AnnotationPanel({ annotations, currentSnapshot, onAdd, onDelete }, ref) {
    const [activeType, setActiveType] = useState<LearnAnnotationType | null>(null);
    const [note, setNote] = useState('');
    const [selectedItem, setSelectedItem] = useState(ZELDA_ITEMS[0]);
    const [selectedDungeon, setSelectedDungeon] = useState('1');
    const [rupeeAmount, setRupeeAmount] = useState('');

    useImperativeHandle(ref, () => ({
      focus: () => {
        if (!activeType) setActiveType('note');
      },
    }));

    const nearbyAnnotations = useMemo(() => {
      if (!currentSnapshot) return [];
      const t = currentSnapshot.videoTimestamp;
      return annotations
        .filter(a => a.videoTimestamp != null && Math.abs(a.videoTimestamp - t) <= 5)
        .sort((a, b) => (a.videoTimestamp ?? 0) - (b.videoTimestamp ?? 0));
    }, [annotations, currentSnapshot]);

    const allAnnotationsSorted = useMemo(() =>
      [...annotations].sort((a, b) => (a.videoTimestamp ?? 0) - (b.videoTimestamp ?? 0)),
    [annotations]);

    function handleSubmit() {
      if (!currentSnapshot) return;

      const base = {
        frameNumber: currentSnapshot.frame,
        videoTimestamp: currentSnapshot.videoTimestamp,
        snapshotFilename: currentSnapshot.filename,
      };

      switch (activeType) {
        case 'item_pickup':
          onAdd({ ...base, type: 'item_pickup', note: note || `Picked up ${selectedItem}`, metadata: { item: selectedItem } });
          break;
        case 'dungeon_enter':
          onAdd({ ...base, type: 'dungeon_enter', note: note || `Entered Level ${selectedDungeon}`, metadata: { dungeon: selectedDungeon } });
          break;
        case 'dungeon_exit':
          onAdd({ ...base, type: 'dungeon_exit', note: note || `Exited Level ${selectedDungeon}`, metadata: { dungeon: selectedDungeon } });
          break;
        case 'door_repair':
          onAdd({ ...base, type: 'door_repair', note: note || `Door repair: ${rupeeAmount} rupees`, metadata: { rupees: rupeeAmount } });
          break;
        case 'death':
          onAdd({ ...base, type: 'death', note: note || 'Death' });
          break;
        default:
          if (activeType && note.trim()) {
            onAdd({ ...base, type: activeType, note: note.trim() });
          }
          break;
      }

      setNote('');
      setActiveType(null);
    }

    return (
      <div className="flex flex-col gap-3 text-sm">
        {/* Quick-add buttons */}
        <div className="flex flex-wrap gap-1">
          {QUICK_TYPES.map(type => {
            const cfg = ANNOTATION_CONFIG[type];
            const Icon = ICON_MAP[cfg.icon];
            const isActive = activeType === type;
            return (
              <button
                key={type}
                onClick={() => setActiveType(isActive ? null : type)}
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
                  isActive
                    ? 'ring-1 ring-white/30'
                    : 'hover:bg-white/10'
                }`}
                style={{
                  backgroundColor: isActive ? `${cfg.color}30` : undefined,
                  color: isActive ? cfg.color : 'rgba(255,255,255,0.6)',
                }}
                title={cfg.label}
              >
                {Icon && <Icon size={12} />}
                <span>{cfg.label}</span>
              </button>
            );
          })}
        </div>

        {/* Context-specific form */}
        {activeType && (
          <div className="bg-white/5 rounded-lg p-3 border border-white/10 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium" style={{ color: ANNOTATION_CONFIG[activeType].color }}>
                {ANNOTATION_CONFIG[activeType].label}
              </span>
              <button onClick={() => setActiveType(null)} className="text-white/40 hover:text-white/80">
                <X size={14} />
              </button>
            </div>

            {activeType === 'item_pickup' && (
              <select
                value={selectedItem}
                onChange={e => setSelectedItem(e.target.value)}
                className="bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10"
              >
                {ZELDA_ITEMS.map(item => (
                  <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>
                ))}
              </select>
            )}

            {(activeType === 'dungeon_enter' || activeType === 'dungeon_exit') && (
              <div className="flex gap-1">
                {['1','2','3','4','5','6','7','8','9'].map(d => (
                  <button
                    key={d}
                    onClick={() => setSelectedDungeon(d)}
                    className={`w-7 h-7 text-xs rounded font-bold transition-colors ${
                      selectedDungeon === d ? 'bg-gold/25 text-gold' : 'bg-white/5 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}

            {activeType === 'door_repair' && (
              <input
                type="number"
                value={rupeeAmount}
                onChange={e => setRupeeAmount(e.target.value)}
                placeholder="Rupee cost"
                className="bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10 w-32"
              />
            )}

            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={activeType === 'strategy' ? 'Describe the strategic decision...' : 'Optional note...'}
              className="bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10 resize-none"
              rows={activeType === 'strategy' ? 3 : 1}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
              }}
            />

            <button
              onClick={handleSubmit}
              className="self-start px-3 py-1 text-xs font-medium bg-gold/20 text-gold rounded hover:bg-gold/30 transition-colors"
            >
              Add
            </button>
          </div>
        )}

        {/* Nearby annotations */}
        {nearbyAnnotations.length > 0 && (
          <div>
            <h4 className="text-xs text-white/40 mb-1">At this position</h4>
            <div className="flex flex-col gap-1">
              {nearbyAnnotations.map(ann => (
                <AnnotationRow key={ann.id} annotation={ann} onDelete={onDelete} />
              ))}
            </div>
          </div>
        )}

        {/* All annotations (collapsible) */}
        {allAnnotationsSorted.length > 0 && (
          <details>
            <summary className="text-xs text-white/40 cursor-pointer hover:text-white/60">
              All annotations ({allAnnotationsSorted.length})
            </summary>
            <div className="flex flex-col gap-1 mt-1 max-h-48 overflow-y-auto">
              {allAnnotationsSorted.map(ann => (
                <AnnotationRow key={ann.id} annotation={ann} onDelete={onDelete} />
              ))}
            </div>
          </details>
        )}
      </div>
    );
  }
);

function AnnotationRow({ annotation, onDelete }: { annotation: LearnAnnotation; onDelete: (id: string) => void }) {
  const cfg = ANNOTATION_CONFIG[annotation.type];
  const Icon = ICON_MAP[cfg?.icon ?? 'StickyNote'];
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 rounded bg-white/5 text-xs group">
      <span style={{ color: cfg?.color || '#9ca3af' }} className="mt-0.5">
        {Icon && <Icon size={12} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-white/80 font-medium">{cfg?.label || annotation.type}</span>
          {annotation.videoTimestamp != null && (
            <span className="text-white/40 font-mono">{formatTimestampLong(annotation.videoTimestamp)}</span>
          )}
        </div>
        {annotation.note && <div className="text-white/60 truncate">{annotation.note}</div>}
        {annotation.metadata && Object.entries(annotation.metadata).map(([k, v]) => (
          <span key={k} className="text-white/40 mr-2">{k}: {v}</span>
        ))}
      </div>
      <button
        onClick={() => onDelete(annotation.id)}
        className="text-white/20 hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export default AnnotationPanel;
