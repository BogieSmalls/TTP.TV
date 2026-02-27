import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Star, Trash2, Scissors,
  Loader2, Play, RefreshCw, Image,
} from 'lucide-react';
import { getProfiles } from '../lib/api';
import type { RacerProfile } from '../lib/api';
import { getCropProfiles, deleteCropProfile, setDefaultCropProfile } from '../lib/cropApi';
import type { CropProfile } from '../lib/cropApi';
import CropCreationWizard from '../components/crop/CropCreationWizard';
import BulkCropRacerList from '../components/crop/BulkCropRacerList';
import BulkCropEditor from '../components/crop/BulkCropEditor';
import {
  initBulkSession, getBulkSession, startDiscovery, startBulkExtraction,
  type BulkSession, type OnboardingEntry,
} from '../lib/bulkCropApi';
import { io as socketIo, type Socket } from 'socket.io-client';
import { SectionHeader, Card, Button, Badge, SearchInput, EmptyState } from '../ui';

type Mode = 'per-racer' | 'bulk';

export default function Crops() {
  const { profileId: urlProfileId } = useParams();
  const [mode, setMode] = useState<Mode>('per-racer');

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Crops"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMode('per-racer')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                mode === 'per-racer' ? 'bg-[var(--accent-subtle)]' : 'hover:bg-[var(--bg-elevated)]'
              }`}
              style={{ color: mode === 'per-racer' ? 'var(--accent)' : 'var(--text-secondary)' }}
            >
              Per Racer
            </button>
            <button
              onClick={() => setMode('bulk')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                mode === 'bulk' ? 'bg-[var(--accent-subtle)]' : 'hover:bg-[var(--bg-elevated)]'
              }`}
              style={{ color: mode === 'bulk' ? 'var(--accent)' : 'var(--text-secondary)' }}
            >
              Bulk Setup
            </button>
          </div>
        }
      />

      {mode === 'per-racer' && <PerRacerView initialProfileId={urlProfileId} />}
      {mode === 'bulk' && <BulkView />}
    </div>
  );
}

// ─── Per-Racer View ───

function PerRacerView({ initialProfileId }: { initialProfileId?: string }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(initialProfileId ?? null);
  const [showWizard, setShowWizard] = useState(false);
  const [search, setSearch] = useState('');

  const { data: profiles } = useQuery<RacerProfile[]>({
    queryKey: ['profiles'],
    queryFn: getProfiles,
  });

  const { data: cropProfiles } = useQuery<CropProfile[]>({
    queryKey: ['cropProfiles', selectedId],
    queryFn: () => getCropProfiles(selectedId!),
    enabled: !!selectedId,
  });

  const remove = useMutation({
    mutationFn: deleteCropProfile,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cropProfiles', selectedId] }),
  });

  const makeDefault = useMutation({
    mutationFn: setDefaultCropProfile,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cropProfiles', selectedId] }),
  });

  useEffect(() => {
    if (initialProfileId) setSelectedId(initialProfileId);
  }, [initialProfileId]);

  const filtered = profiles?.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return p.display_name.toLowerCase().includes(q) || p.twitch_channel.toLowerCase().includes(q);
  });

  const selectedRacer = profiles?.find(p => p.id === selectedId);

  if (showWizard && selectedId) {
    return (
      <div className="h-[calc(100vh-200px)] flex flex-col">
        <CropCreationWizard
          racerProfileId={selectedId}
          onComplete={() => {
            setShowWizard(false);
            qc.invalidateQueries({ queryKey: ['cropProfiles', selectedId] });
          }}
          onCancel={() => setShowWizard(false)}
        />
      </div>
    );
  }

  return (
    <div className="flex gap-6 min-h-[500px]">
      {/* Left: Racer list */}
      <div className="w-56 shrink-0 space-y-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search racers..." />
        <div className="space-y-1">
          {filtered?.map(p => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                selectedId === p.id ? 'border-l-2' : 'border-l-2 border-transparent'
              }`}
              style={{
                color: selectedId === p.id ? 'var(--accent)' : 'var(--text-secondary)',
                background: selectedId === p.id ? 'var(--accent-subtle)' : undefined,
                borderLeftColor: selectedId === p.id ? 'var(--accent)' : 'transparent',
              }}
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.preferred_color }} />
                <span className="truncate">{p.display_name}</span>
              </div>
            </button>
          ))}
          {(!filtered || filtered.length === 0) && (
            <div className="px-3 py-4 text-center">
              <Scissors size={24} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No racer profiles found. Create profiles in the Racers page first.</p>
            </div>
          )}
        </div>
      </div>

      {/* Right: Crop profiles */}
      <div className="flex-1 min-w-0">
        {selectedId && selectedRacer ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {selectedRacer.display_name}
                </h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {selectedRacer.twitch_channel}
                </p>
              </div>
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowWizard(true)}>
                New Crop Profile
              </Button>
            </div>

            {cropProfiles && cropProfiles.length === 0 && (
              <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No crop profiles yet. Click "New Crop Profile" to create one.
              </div>
            )}

            <div className="space-y-2">
              {cropProfiles?.map(cp => (
                <div
                  key={cp.id}
                  className="rounded-lg p-4 border flex items-center gap-4"
                  style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
                >
                  <div className="w-6 shrink-0 text-center">
                    {cp.is_default ? (
                      <Star size={16} style={{ color: 'var(--accent)' }} fill="var(--accent)" />
                    ) : (
                      <button
                        onClick={() => makeDefault.mutate(cp.id)}
                        className="transition-colors cursor-pointer hover:text-[var(--accent)]"
                        style={{ color: 'var(--text-muted)' }}
                        title="Set as default"
                      >
                        <Star size={16} />
                      </button>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{cp.label}</span>
                      {cp.is_default && <Badge variant="warning" label="DEFAULT" />}
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{cp.stream_width}x{cp.stream_height}</span>
                    </div>
                    <div className="text-xs mt-0.5 font-mono" style={{ color: 'var(--text-muted)' }}>
                      crop: {cp.crop_x},{cp.crop_y} {cp.crop_w}x{cp.crop_h}
                      {' · '}grid: ({cp.grid_offset_dx},{cp.grid_offset_dy})
                      {cp.confidence != null && ` · conf: ${cp.confidence}`}
                    </div>
                    {cp.screenshot_source && (
                      <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                        src: {cp.screenshot_source}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => { if (confirm(`Delete "${cp.label}"?`)) remove.mutate(cp.id); }}
                    className="p-2 transition-colors cursor-pointer hover:text-[var(--danger)]"
                    style={{ color: 'var(--text-muted)' }}
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">Select a racer from the list to manage their crop profiles.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Bulk View (from BulkCropOnboarding) ───

function BulkView() {
  const [session, setSession] = useState<BulkSession | null>(null);
  const [activeRacerId, setActiveRacerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    getBulkSession().then((s) => {
      if (s) {
        setSession(s);
        const firstReady = s.racers.find((r) => r.status === 'ready');
        if (firstReady) setActiveRacerId(firstReady.racerProfileId);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const socket = socketIo(window.location.origin);
    socketRef.current = socket;
    socket.on('connect', () => socket.emit('join', 'bulk-crop'));
    socket.on('bulk-crop:session-update', (updatedSession: BulkSession) => {
      setSession(updatedSession);
    });
    return () => { socket.disconnect(); };
  }, []);

  const handleInit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await initBulkSession();
      setSession(s);
      setActiveRacerId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDiscover = useCallback(async () => {
    setError(null);
    try { await startDiscovery(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);

  const handleExtractAll = useCallback(async () => {
    setError(null);
    try { await startBulkExtraction(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);

  const advanceToNext = useCallback(() => {
    if (!session) return;
    const actionable = session.racers.filter((r) =>
      ['ready', 'vod_found', 'vod_not_found', 'error'].includes(r.status)
    );
    const currentIdx = actionable.findIndex((r) => r.racerProfileId === activeRacerId);
    const next = actionable[currentIdx + 1] ?? actionable[0];
    if (next) setActiveRacerId(next.racerProfileId);
  }, [session, activeRacerId]);

  const activeRacer: OnboardingEntry | undefined = session?.racers.find(
    (r) => r.racerProfileId === activeRacerId
  );

  const stats = session?.stats;
  const progressPct = stats
    ? Math.round(((stats.completed + stats.skipped) / Math.max(stats.total, 1)) * 100)
    : 0;

  return (
    <div className="h-[calc(100vh-200px)] flex flex-col gap-4">
      {/* Controls */}
      <div className="shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scissors size={16} style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Bulk Crop Onboarding</span>
          {stats && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {stats.completed} done · {stats.skipped} skipped · {stats.vodNotFound} no VOD · {stats.total} total
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {!session && (
            <Button variant="primary" size="sm" icon={<Play size={14} />} loading={loading} onClick={handleInit}>
              Initialize Session
            </Button>
          )}
          {session && session.status === 'idle' && (
            <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={handleDiscover}>
              Discover VODs
            </Button>
          )}
          {session && (session.status === 'ready' || session.status === 'idle') && stats && stats.vodFound > 0 && (
            <Button variant="secondary" size="sm" icon={<Image size={14} />} onClick={handleExtractAll}>
              Extract All
            </Button>
          )}
          {session && (
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={handleInit}>
              Reinit
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="shrink-0 text-sm px-3 py-2 rounded" style={{ color: 'var(--danger)', background: 'rgba(248,113,113,0.1)' }}>
          {error}
        </div>
      )}

      {stats && stats.total > 0 && (
        <div className="shrink-0 flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <div className="flex-1 rounded-full h-2 overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${progressPct}%`, background: 'var(--accent)' }} />
          </div>
          <span className="font-mono">{progressPct}%</span>
        </div>
      )}

      {session && session.racers.length > 0 ? (
        <div className="flex-1 min-h-0 flex gap-4">
          <div className="w-64 shrink-0 border rounded overflow-hidden" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}>
            <BulkCropRacerList
              racers={session.racers}
              activeRacerId={activeRacerId}
              onSelect={setActiveRacerId}
            />
          </div>
          <div className="flex-1 min-w-0 border rounded p-4" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}>
            {activeRacer ? (
              <BulkCropEditor racer={activeRacer} onSaved={advanceToNext} onSkipped={advanceToNext} />
            ) : (
              <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--text-muted)' }}>
                Select a racer from the list to start defining crop regions
              </div>
            )}
          </div>
        </div>
      ) : session ? (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
          {session.status === 'discovering' ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={32} className="animate-spin" style={{ color: 'var(--accent)' }} />
              <p>Discovering VODs...</p>
              <p className="text-xs">{stats?.vodFound ?? 0} found so far</p>
            </div>
          ) : (
            'All racers already have crop profiles, or no racers with Twitch channels found.'
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Click "Initialize Session" to find racers that need crop profiles
        </div>
      )}
    </div>
  );
}
