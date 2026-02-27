import { useState, useEffect } from 'react';
import { Save, ChevronDown, ChevronRight } from 'lucide-react';
import type { SessionMetadata } from '../../lib/learnApi';

interface SessionMetadataFormProps {
  metadata?: SessionMetadata;
  onSave: (metadata: Partial<SessionMetadata>) => void;
}

export default function SessionMetadataForm({ metadata, onSave }: SessionMetadataFormProps) {
  const [isOpen, setIsOpen] = useState(!!metadata?.flagset || !!metadata?.playerName);
  const [flagset, setFlagset] = useState(metadata?.flagset || '');
  const [seed, setSeed] = useState(metadata?.seed || '');
  const [playerName, setPlayerName] = useState(metadata?.playerName || '');
  const [notes, setNotes] = useState(metadata?.notes || '');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setFlagset(metadata?.flagset || '');
    setSeed(metadata?.seed || '');
    setPlayerName(metadata?.playerName || '');
    setNotes(metadata?.notes || '');
    setDirty(false);
  }, [metadata]);

  function handleSave() {
    onSave({ flagset: flagset || undefined, seed: seed || undefined, playerName: playerName || undefined, notes: notes || undefined });
    setDirty(false);
  }

  function markDirty() { setDirty(true); }

  return (
    <div className="bg-panel rounded-lg border border-white/5">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/60 hover:text-white/80 transition-colors"
      >
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>Flagset & Seed Info</span>
        {metadata?.flagset && (
          <span className="text-xs text-white/30 truncate ml-2">{metadata.flagset}</span>
        )}
      </button>
      {isOpen && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          <div>
            <label className="text-xs text-white/40 mb-0.5 block">Flagset</label>
            <input
              value={flagset}
              onChange={e => { setFlagset(e.target.value); markDirty(); }}
              placeholder="e.g., book is atlas, swordless, full heart shuffle"
              className="w-full bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-white/40 mb-0.5 block">Seed</label>
              <input
                value={seed}
                onChange={e => { setSeed(e.target.value); markDirty(); }}
                placeholder="Seed hash"
                className="w-full bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10"
              />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-0.5 block">Player</label>
              <input
                value={playerName}
                onChange={e => { setPlayerName(e.target.value); markDirty(); }}
                placeholder="Runner name"
                className="w-full bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-white/40 mb-0.5 block">Notes</label>
            <textarea
              value={notes}
              onChange={e => { setNotes(e.target.value); markDirty(); }}
              placeholder="Additional notes about this run..."
              rows={2}
              className="w-full bg-surface text-white/90 text-xs rounded px-2 py-1.5 border border-white/10 resize-none"
            />
          </div>
          {dirty && (
            <button
              onClick={handleSave}
              className="self-start flex items-center gap-1 px-3 py-1 text-xs font-medium bg-gold/20 text-gold rounded hover:bg-gold/30 transition-colors"
            >
              <Save size={12} />
              Save
            </button>
          )}
        </div>
      )}
    </div>
  );
}
