import {
  User,
  CheckCircle,
  Link2,
  HelpCircle,
  Tv,
  Trophy,
  XCircle,
  AlertTriangle,
  Crop,
} from 'lucide-react';
import type { EntrantMatch } from '../lib/raceTypes';

interface Props {
  match: EntrantMatch;
  raceStatus?: 'racing' | 'finished' | 'forfeit' | 'dq';
  finishTime?: string | null;
  finishPlace?: number | null;
  placeOrdinal?: string | null;
  onAutoCreate?: () => void;
  onSetCrop?: (profileId: string, twitchChannel: string) => void;
}

function MatchBadge({ method }: { method: EntrantMatch['matchMethod'] }) {
  switch (method) {
    case 'racetime_id':
      return (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--success)' }} title="Matched by racetime.gg ID">
          <CheckCircle size={12} /> Profile
        </span>
      );
    case 'twitch_channel':
      return (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--warning)' }} title="Matched by Twitch channel">
          <Link2 size={12} /> Twitch
        </span>
      );
    case 'auto_created':
      return (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--info)' }} title="Auto-created profile">
          <User size={12} /> New
        </span>
      );
    case 'manual':
      return (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--accent)' }} title="Manually assigned">
          <User size={12} /> Manual
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--danger)' }} title="No profile match">
          <HelpCircle size={12} /> Unmatched
        </span>
      );
  }
}

function StatusIndicator({ status }: { status?: string }) {
  switch (status) {
    case 'finished':
      return <Trophy size={14} style={{ color: 'var(--success)' }} />;
    case 'forfeit':
      return <XCircle size={14} style={{ color: 'var(--text-muted)' }} />;
    case 'dq':
      return <AlertTriangle size={14} style={{ color: 'var(--danger)' }} />;
    case 'racing':
      return <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--success)' }} />;
    default:
      return null;
  }
}

function formatDuration(iso: string): string {
  // Parse ISO 8601 duration like "PT1H23M45S"
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!match) return iso;
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseFloat(match[3] || '0');
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
  }
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

export default function EntrantCard({ match, raceStatus, finishTime, finishPlace, placeOrdinal, onAutoCreate, onSetCrop }: Props) {
  const { entrant } = match;
  const displayStatus = raceStatus || match.entrant.status.value;

  return (
    <div
      className="rounded-lg p-3 border"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <StatusIndicator status={displayStatus} />
          <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
            {match.profileDisplayName || entrant.user.name}
          </span>
          {finishPlace && placeOrdinal && (
            <span
              className="text-xs font-bold"
              style={{ color: finishPlace === 1 ? 'var(--gold)' : 'var(--text-muted)' }}
            >
              {placeOrdinal}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Slot {match.slot + 1}</span>
          <MatchBadge method={match.matchMethod} />
          {match.profileId && match.hasCropProfile && (
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--success)' }} title="Has crop profile">
              <Crop size={11} /> Crop
            </span>
          )}
          {match.profileId && !match.hasCropProfile && (
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--warning)' }} title="No crop profile">
              <Crop size={11} /> No Crop
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
        <div className="flex items-center gap-3">
          {match.twitchChannel && (
            <span className="flex items-center gap-1">
              <Tv size={11} />
              {match.twitchChannel}
            </span>
          )}
          <span>{entrant.user.full_name}</span>
        </div>

        <div className="flex items-center gap-2">
          {finishTime && (
            <span style={{ color: displayStatus === 'finished' ? 'var(--success)' : 'var(--text-muted)' }}>
              {formatDuration(finishTime)}
            </span>
          )}
          {displayStatus === 'forfeit' && (
            <span style={{ color: 'var(--text-muted)' }}>FORFEIT</span>
          )}
          {displayStatus === 'dq' && (
            <span style={{ color: 'var(--danger)' }}>DQ</span>
          )}
          {!match.matchMethod && onAutoCreate && (
            <button
              onClick={onAutoCreate}
              className="px-2 py-0.5 text-xs rounded transition-colors"
              style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
            >
              Auto-create
            </button>
          )}
          {match.profileId && onSetCrop && match.twitchChannel && (
            <button
              onClick={() => onSetCrop(match.profileId!, match.twitchChannel!)}
              className="px-2 py-0.5 text-xs rounded transition-colors"
              style={
                match.hasCropProfile
                  ? { background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }
                  : { background: 'var(--accent-subtle)', color: 'var(--accent)' }
              }
            >
              {match.hasCropProfile ? 'Edit Crop' : 'Set Crop'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
