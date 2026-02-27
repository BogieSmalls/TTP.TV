import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  RotateCcw,
  Play,
  Loader2,
  Search,
  Clock,
  User,
  Film,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Library,
  Trophy,
  Users,
} from 'lucide-react';
import {
  resolveReplay,
  listReplays,
  startReplay,
  getProfiles,
  getRaceHistory,
} from '../../lib/api';
import type { ReplayData, ReplayListItem, RacerProfile, RaceHistoryPage } from '../../lib/api';

export function ReplayTab() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [url, setUrl] = useState('');
  const [resolved, setResolved] = useState<ReplayData | null>(null);
  const [profileMap, setProfileMap] = useState<Record<string, string>>({});
  const [historyPage, setHistoryPage] = useState(1);

  const { data: recentReplays } = useQuery<ReplayListItem[]>({
    queryKey: ['replays'],
    queryFn: listReplays,
  });

  const { data: profiles } = useQuery<RacerProfile[]>({
    queryKey: ['profiles'],
    queryFn: getProfiles,
  });

  const { data: raceHistory, isLoading: historyLoading } = useQuery<RaceHistoryPage>({
    queryKey: ['raceHistory', historyPage],
    queryFn: () => getRaceHistory(historyPage),
  });

  const resolveMut = useMutation({
    mutationFn: (racetimeUrl: string) => resolveReplay(racetimeUrl),
    onSuccess: (data) => {
      setResolved(data);
      qc.invalidateQueries({ queryKey: ['replays'] });
      // Auto-map profiles by twitch channel match
      const map: Record<string, string> = {};
      for (const ent of data.entrants) {
        if (ent.twitchChannel && profiles) {
          const match = profiles.find(
            p => p.twitch_channel.toLowerCase() === ent.twitchChannel!.toLowerCase()
          );
          if (match) map[ent.racetimeId] = match.id;
        }
      }
      setProfileMap(map);
    },
  });

  const startMut = useMutation({
    mutationFn: () => startReplay(resolved!.id, profileMap),
  });

  // Auto-resolve from ?race= query param (e.g. from Dashboard click)
  useEffect(() => {
    const raceUrl = searchParams.get('race');
    if (raceUrl && !resolved && !resolveMut.isPending) {
      setUrl(raceUrl);
      resolveMut.mutate(raceUrl);
      setSearchParams({}, { replace: true }); // clear param after use
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function formatDuration(iso: string | null): string {
    if (!iso) return 'DNF';
    const m = iso.match(/P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
    if (!m) return iso;
    const h = parseInt(m[1] || '0');
    const min = parseInt(m[2] || '0');
    const sec = Math.floor(parseFloat(m[3] || '0'));
    if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  function formatOffset(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatRaceDuration(start: string | null, end: string | null): string {
    if (!start || !end) return '—';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function extractSeed(info: string): string {
    const m = info.match(/Seed:\s*(\d+)/);
    return m ? m[1] : '';
  }

  function handleReplayRace(raceUrl: string) {
    setUrl(raceUrl);
    resolveMut.mutate(raceUrl);
  }

  const readyCount = resolved
    ? resolved.entrants.filter(e => e.vodUrl && profileMap[e.racetimeId]).length
    : 0;

  return (
    <div className="space-y-6">
      {/* URL Input */}
      <div className="bg-panel rounded-lg border border-white/10 p-5">
        <label className="block text-sm text-white/60 mb-2">Racetime.gg URL</label>
        <div className="flex gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://racetime.gg/z1r/..."
            className="flex-1 bg-surface border border-white/10 rounded px-3 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-gold/50"
          />
          <button
            onClick={() => resolveMut.mutate(url)}
            disabled={!url || resolveMut.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-gold/20 text-gold rounded hover:bg-gold/30 disabled:opacity-40 transition-colors"
          >
            {resolveMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Resolve
          </button>
        </div>
        {resolveMut.isError && (
          <p className="text-red-400 text-sm mt-2">
            {(resolveMut.error as Error).message}
          </p>
        )}
      </div>

      {/* Resolved Race Preview */}
      {resolved && (
        <div className="bg-panel rounded-lg border border-white/10 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">{resolved.goal ?? 'Race'}</h2>
              <p className="text-sm text-white/40 mt-0.5">
                {new Date(resolved.raceStart).toLocaleString()}
              </p>
              {resolved.seed && (
                <p className="text-xs text-white/30 mt-0.5 font-mono">{resolved.seed.slice(0, 80)}</p>
              )}
            </div>
            <button
              onClick={() => startMut.mutate()}
              disabled={readyCount < 2 || startMut.isPending}
              className="flex items-center gap-2 px-5 py-2.5 bg-green-600/80 text-white rounded-lg hover:bg-green-600 disabled:opacity-40 transition-colors"
            >
              {startMut.isPending ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
              Go Live ({readyCount} racers)
            </button>
          </div>

          {startMut.isSuccess && (
            <div className="bg-green-900/30 border border-green-500/30 rounded p-3 text-green-300 text-sm">
              Replay started with {startMut.data.entrantCount} racers
            </div>
          )}

          {startMut.isError && (
            <p className="text-red-400 text-sm mt-2">
              {(startMut.error as Error).message}
            </p>
          )}

          {/* Entrants */}
          <div className="space-y-2">
            {resolved.entrants.map((ent) => (
              <div
                key={ent.racetimeId}
                className="flex items-center gap-3 bg-surface rounded p-3 border border-white/5"
              >
                <div className="flex items-center gap-2 w-40">
                  <User size={14} className="text-white/40" />
                  <span className="text-sm text-white font-medium truncate">{ent.displayName}</span>
                </div>

                <div className="flex items-center gap-1 w-24 text-sm">
                  <Clock size={12} className="text-white/30" />
                  <span className="text-white/60">{formatDuration(ent.finishTime)}</span>
                </div>

                {ent.place && (
                  <span className="text-xs text-gold font-bold w-8">#{ent.place}</span>
                )}

                <div className="flex items-center gap-1 w-32 text-xs">
                  {ent.vodUrl ? (
                    <>
                      <Film size={12} className="text-green-400" />
                      <span className="text-green-400">VOD</span>
                      <span className="text-white/40">+{formatOffset(ent.vodOffsetSeconds)}</span>
                    </>
                  ) : (
                    <>
                      <XCircle size={12} className="text-red-400/60" />
                      <span className="text-red-400/60">No VOD</span>
                    </>
                  )}
                </div>

                {/* Profile mapping */}
                <select
                  value={profileMap[ent.racetimeId] ?? ''}
                  onChange={(e) => setProfileMap(prev => ({
                    ...prev,
                    [ent.racetimeId]: e.target.value,
                  }))}
                  className="flex-1 bg-surface border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-gold/50"
                >
                  <option value="">-- Select Profile --</option>
                  {profiles?.map(p => (
                    <option key={p.id} value={p.id}>{p.display_name} ({p.twitch_channel})</option>
                  ))}
                </select>

                {profileMap[ent.racetimeId] && ent.vodUrl ? (
                  <CheckCircle2 size={16} className="text-green-400" />
                ) : (
                  <div className="w-4" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Race Library — Browse recent Z1R races */}
      <div className="bg-panel rounded-lg border border-white/10 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Library size={16} className="text-gold" />
            <h2 className="text-sm font-semibold text-white/80">Race Library</h2>
          </div>
          {raceHistory && (
            <span className="text-xs text-white/30">
              {raceHistory.totalRaces.toLocaleString()} races
            </span>
          )}
        </div>

        {historyLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-white/30" />
          </div>
        ) : raceHistory && raceHistory.races.length > 0 ? (
          <>
            {/* Race list */}
            <div className="space-y-1">
              {raceHistory.races.map((race) => (
                <div
                  key={race.slug}
                  className="flex items-center gap-3 px-3 py-2.5 rounded hover:bg-white/5 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Trophy size={12} className="text-gold/60 shrink-0" />
                      <span className="text-sm text-white/80 font-medium truncate">{race.goal}</span>
                    </div>
                    {extractSeed(race.info) && (
                      <p className="text-[11px] text-white/25 font-mono mt-0.5 truncate pl-5">
                        Seed: {extractSeed(race.info)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 text-xs text-white/40 w-16 shrink-0">
                    <Users size={11} />
                    <span>{race.finishedCount}/{race.entrantCount}</span>
                  </div>

                  <div className="flex items-center gap-1 text-xs text-white/40 w-14 shrink-0">
                    <Clock size={11} />
                    <span>{formatRaceDuration(race.startedAt, race.endedAt)}</span>
                  </div>

                  <span className="text-xs text-white/30 w-20 shrink-0 text-right">
                    {race.startedAt ? new Date(race.startedAt).toLocaleDateString() : '—'}
                  </span>

                  <button
                    onClick={() => handleReplayRace(race.url)}
                    disabled={resolveMut.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gold/15 text-gold rounded hover:bg-gold/25 disabled:opacity-40 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    <Play size={11} />
                    Replay
                  </button>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {raceHistory.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
                <button
                  onClick={() => setHistoryPage(p => Math.max(1, p - 1))}
                  disabled={historyPage <= 1}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-white/50 hover:text-white/80 disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft size={14} />
                  Previous
                </button>
                <span className="text-xs text-white/30">
                  Page {raceHistory.page} of {raceHistory.totalPages}
                </span>
                <button
                  onClick={() => setHistoryPage(p => Math.min(raceHistory.totalPages, p + 1))}
                  disabled={historyPage >= raceHistory.totalPages}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-white/50 hover:text-white/80 disabled:opacity-30 transition-colors"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-white/30 text-center py-6">No races found</p>
        )}
      </div>

      {/* Recent Races (previously resolved) */}
      {recentReplays && recentReplays.length > 0 && (
        <div className="bg-panel rounded-lg border border-white/10 p-5">
          <h2 className="text-sm font-semibold text-white/60 mb-3">Recent Races</h2>
          <div className="space-y-1.5">
            {recentReplays.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setUrl(r.racetimeUrl);
                  resolveMut.mutate(r.racetimeUrl);
                }}
                className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-white/5 transition-colors text-left"
              >
                <RotateCcw size={14} className="text-white/30" />
                <span className="text-sm text-white/70 truncate flex-1">{r.goal ?? r.racetimeUrl}</span>
                <span className="text-xs text-white/30">{new Date(r.raceStart).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
