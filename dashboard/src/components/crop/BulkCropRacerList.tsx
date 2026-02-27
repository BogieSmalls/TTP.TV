import { Check, ChevronRight, Clock, AlertTriangle, SkipForward, Loader2, Search } from 'lucide-react';
import { useState } from 'react';
import type { OnboardingEntry, OnboardingRacerStatus } from '../../lib/bulkCropApi';

interface Props {
  racers: OnboardingEntry[];
  activeRacerId: string | null;
  onSelect: (racerProfileId: string) => void;
}

const statusIcons: Record<OnboardingRacerStatus, typeof Check> = {
  pending: Clock,
  discovering: Loader2,
  vod_found: ChevronRight,
  vod_not_found: AlertTriangle,
  extracting: Loader2,
  ready: ChevronRight,
  skipped: SkipForward,
  completed: Check,
  error: AlertTriangle,
};

const statusColors: Record<OnboardingRacerStatus, string> = {
  pending: 'text-white/30',
  discovering: 'text-blue-400 animate-spin',
  vod_found: 'text-white/50',
  vod_not_found: 'text-yellow-500',
  extracting: 'text-blue-400 animate-spin',
  ready: 'text-green-400',
  skipped: 'text-white/30',
  completed: 'text-green-500',
  error: 'text-red-400',
};

export default function BulkCropRacerList({ racers, activeRacerId, onSelect }: Props) {
  const [filter, setFilter] = useState('');

  const filtered = racers.filter((r) =>
    r.displayName.toLowerCase().includes(filter.toLowerCase()) ||
    r.twitchChannel.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-3 py-2 border-b border-white/10">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter racers..."
            className="w-full bg-surface text-sm text-white pl-7 pr-2 py-1.5 rounded border border-white/10 focus:border-gold/50 focus:outline-none"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((racer) => {
          const Icon = statusIcons[racer.status];
          const isActive = racer.racerProfileId === activeRacerId;

          return (
            <button
              key={racer.racerProfileId}
              onClick={() => onSelect(racer.racerProfileId)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors border-l-2 ${
                isActive
                  ? 'bg-white/10 border-gold text-white'
                  : 'border-transparent text-white/70 hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon size={14} className={`shrink-0 ${statusColors[racer.status]}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{racer.displayName}</div>
                <div className="truncate text-xs text-white/40">{racer.twitchChannel}</div>
              </div>
              {racer.vodTitle && racer.status !== 'completed' && racer.status !== 'skipped' && (
                <span className="text-[10px] text-white/30 truncate max-w-[80px]" title={racer.vodTitle}>
                  {racer.vodTitle === '(manual)' ? 'manual' : 'VOD'}
                </span>
              )}
            </button>
          );
        })}

        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-white/30 text-sm">
            {racers.length === 0 ? 'No racers in session' : 'No matches'}
          </div>
        )}
      </div>
    </div>
  );
}
