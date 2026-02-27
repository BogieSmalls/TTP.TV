import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Film,
  Plus,
  Trash2,
  Play,
  Square,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Crop,
  X,
  Volume2,
  VolumeX,
  RotateCw,
  WifiOff,
} from 'lucide-react';
import { getProfiles } from '../../lib/api';
import type { RacerProfile } from '../../lib/api';
import { getCropProfiles } from '../../lib/cropApi';
import type { CropProfile } from '../../lib/cropApi';
import CropCreationWizard from '../crop/CropCreationWizard';
import {
  getVodRaceStatus,
  setupVodRace,
  confirmVodRace,
  goLiveVodRace,
  endVodRace,
  rebuildVodRaceScene,
  goOfflineVodRace,
} from '../../lib/vodRaceApi';
import type { VodRaceStatus } from '../../lib/vodRaceApi';
import { featureRacer, getFeaturedRacer } from '../../lib/raceApi';

interface RacerSlot {
  profileId: string;
  vodUrl: string;
  startOffsetMinutes: string;
  startOffsetSeconds: string;
}

const EMPTY_SLOT: RacerSlot = { profileId: '', vodUrl: '', startOffsetMinutes: '0', startOffsetSeconds: '0' };

function parseOffset(slot: RacerSlot): number {
  return (parseInt(slot.startOffsetMinutes) || 0) * 60 + (parseInt(slot.startOffsetSeconds) || 0);
}

export function VodTab() {
  const qc = useQueryClient();
  const [slots, setSlots] = useState<RacerSlot[]>([{ ...EMPTY_SLOT }, { ...EMPTY_SLOT }]);
  const [title, setTitle] = useState('');
  const [racetimeRoom, setRacetimeRoom] = useState('');
  const [cropTarget, setCropTarget] = useState<{ profileId: string; twitchChannel: string } | null>(null);

  const { data: profiles } = useQuery<RacerProfile[]>({
    queryKey: ['profiles'],
    queryFn: getProfiles,
  });

  // Fetch crop profiles for all selected racers
  const selectedProfileIds = slots.map(s => s.profileId).filter(Boolean);
  const { data: cropProfiles, refetch: refetchCrops } = useQuery({
    queryKey: ['slot-crops', selectedProfileIds],
    queryFn: async () => {
      const results: Record<string, CropProfile[]> = {};
      for (const id of selectedProfileIds) {
        results[id] = await getCropProfiles(id);
      }
      return results;
    },
    enabled: selectedProfileIds.length > 0,
  });

  const { data: vodStatus, refetch: refetchStatus } = useQuery<VodRaceStatus>({
    queryKey: ['vod-race-status'],
    queryFn: getVodRaceStatus,
    refetchInterval: 3000,
  });

  const setup = useMutation({
    mutationFn: () => setupVodRace({
      racers: slots.filter(s => s.profileId && s.vodUrl).map(s => ({
        profileId: s.profileId,
        vodUrl: s.vodUrl,
        startOffsetSeconds: parseOffset(s),
      })),
      title: title || undefined,
      racetimeRoom: racetimeRoom || undefined,
    }),
    onSuccess: () => refetchStatus(),
  });

  const confirm = useMutation({
    mutationFn: confirmVodRace,
    onSuccess: () => refetchStatus(),
  });

  const goLive = useMutation({
    mutationFn: goLiveVodRace,
    onSuccess: () => refetchStatus(),
  });

  const end = useMutation({
    mutationFn: endVodRace,
    onSuccess: () => refetchStatus(),
  });

  const rebuild = useMutation({
    mutationFn: rebuildVodRaceScene,
    onSuccess: () => refetchStatus(),
  });

  const goOffline = useMutation({
    mutationFn: goOfflineVodRace,
    onSuccess: () => refetchStatus(),
  });

  const updateSlot = useCallback((index: number, updates: Partial<RacerSlot>) => {
    setSlots(prev => prev.map((s, i) => i === index ? { ...s, ...updates } : s));
  }, []);

  const addSlot = useCallback(() => {
    if (slots.length < 4) setSlots(prev => [...prev, { ...EMPTY_SLOT }]);
  }, [slots.length]);

  const removeSlot = useCallback((index: number) => {
    if (slots.length > 2) setSlots(prev => prev.filter((_, i) => i !== index));
  }, [slots.length]);

  const state = vodStatus?.state ?? 'idle';
  const isActive = state !== 'idle';
  const validSlots = slots.filter(s => s.profileId && s.vodUrl);

  const { data: featuredData } = useQuery<{ racerId: string | null }>({
    queryKey: ['featured-racer'],
    queryFn: getFeaturedRacer,
    enabled: state === 'ready' || state === 'live',
  });

  const featureMutation = useMutation({
    mutationFn: (racerId: string | null) => featureRacer(racerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['featured-racer'] }),
  });

  // Get layout label
  const layoutLabel = validSlots.length === 2 ? '2-Player' :
    validSlots.length === 3 ? '3-Player' : validSlots.length === 4 ? '4-Player' : '';

  return (
    <div className="space-y-6">
      {/* Active Race View */}
      {isActive && vodStatus && (
        <div className="space-y-4">
          {vodStatus.title && (
            <div className="bg-panel rounded-lg px-4 py-3 border border-white/5">
              <span className="text-sm font-medium">{vodStatus.title}</span>
              <span className="text-xs text-white/30 ml-2">{vodStatus.layoutType?.replace('_', ' ')}</span>
            </div>
          )}

          <div className="space-y-2">
            {vodStatus.racers.map(r => {
              const isFeatured = featuredData?.racerId === r.profileId;
              return (
                <div key={r.profileId} className="bg-panel rounded-lg p-3 border border-white/5 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{r.displayName}</span>
                    <span className="text-xs text-white/30 ml-2">Slot {r.slot + 1}</span>
                    {r.hasCrop ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-400 ml-2"><Crop size={10} /> Crop</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-orange-400 ml-2"><Crop size={10} /> No Crop</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-white/40 font-mono">
                      offset: {r.startOffsetSeconds}s
                    </span>
                    {(state === 'ready' || state === 'live') && (
                      <button
                        onClick={() => featureMutation.mutate(isFeatured ? null : r.profileId)}
                        title={isFeatured ? 'Mute audio' : 'Feature audio'}
                        className={`flex items-center justify-center w-8 h-8 rounded transition-colors ${
                          isFeatured
                            ? 'bg-gold/20 text-gold hover:bg-gold/30'
                            : 'bg-white/5 text-white/30 hover:text-white/60 hover:bg-white/10'
                        }`}
                      >
                        {isFeatured ? <Volume2 size={14} /> : <VolumeX size={14} />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Mute All */}
          {(state === 'ready' || state === 'live') && (
            <button
              onClick={() => featureMutation.mutate(null)}
              className="text-xs text-white/40 hover:text-white/60 flex items-center gap-1 transition-colors"
            >
              <VolumeX size={12} /> Mute All
            </button>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3 flex-wrap">
            {state === 'setup' && (
              <button
                onClick={() => confirm.mutate()}
                disabled={confirm.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-500/15 text-blue-400 rounded-lg hover:bg-blue-500/25 transition-colors disabled:opacity-50"
              >
                {confirm.isPending ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                {confirm.isPending ? 'Starting streams...' : 'Confirm Setup'}
              </button>
            )}

            {state === 'ready' && (
              <button
                onClick={() => goLive.mutate()}
                disabled={goLive.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-500/15 text-red-400 rounded-lg hover:bg-red-500/25 transition-colors disabled:opacity-50"
              >
                {goLive.isPending ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                {goLive.isPending ? 'Going live...' : 'Go Live'}
              </button>
            )}

            {/* Rebuild Scene — available in ready/live */}
            {(state === 'ready' || state === 'live') && (
              <button
                onClick={() => rebuild.mutate()}
                disabled={rebuild.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white/5 text-white/60 rounded-lg hover:bg-white/10 hover:text-white/80 transition-colors disabled:opacity-50"
              >
                {rebuild.isPending ? <Loader2 size={16} className="animate-spin" /> : <RotateCw size={16} />}
                {rebuild.isPending ? 'Rebuilding...' : 'Rebuild Scene'}
              </button>
            )}

            {/* Go Offline — available in ready/live */}
            {(state === 'ready' || state === 'live') && (
              <button
                onClick={() => goOffline.mutate()}
                disabled={goOffline.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white/5 text-white/60 rounded-lg hover:bg-white/10 hover:text-white/80 transition-colors disabled:opacity-50"
              >
                {goOffline.isPending ? <Loader2 size={16} className="animate-spin" /> : <WifiOff size={16} />}
                {goOffline.isPending ? 'Going offline...' : 'Go Offline'}
              </button>
            )}

            {/* End Race — available in any active state */}
            <button
              onClick={() => end.mutate()}
              disabled={end.isPending}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-500/15 text-red-400 rounded-lg hover:bg-red-500/25 transition-colors disabled:opacity-50"
            >
              {end.isPending ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} />}
              {end.isPending ? 'Ending...' : 'End Race'}
            </button>
          </div>

          {/* Errors */}
          {setup.error && <p className="text-xs text-red-400">Setup: {setup.error.message}</p>}
          {confirm.error && <p className="text-xs text-red-400">Confirm: {confirm.error.message}</p>}
          {goLive.error && <p className="text-xs text-red-400">Go Live: {goLive.error.message}</p>}
          {end.error && <p className="text-xs text-red-400">End: {end.error.message}</p>}
          {rebuild.error && <p className="text-xs text-red-400">Rebuild: {rebuild.error.message}</p>}
          {goOffline.error && <p className="text-xs text-red-400">Go Offline: {goOffline.error.message}</p>}
        </div>
      )}

      {/* Setup Form (idle only) */}
      {!isActive && (
        <div className="space-y-4">
          {/* Title + Racetime Room */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-white/40 mb-1">Title (optional)</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Winter Tourney R3"
                className="w-full bg-panel border border-white/10 rounded px-3 py-2 text-sm focus:border-gold focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-white/40 mb-1">Racetime.gg Room (optional)</label>
              <input
                type="text"
                value={racetimeRoom}
                onChange={e => setRacetimeRoom(e.target.value)}
                placeholder="z1r/daring-fairyfountain-1032"
                className="w-full bg-panel border border-white/10 rounded px-3 py-2 text-sm focus:border-gold focus:outline-none"
              />
            </div>
          </div>

          {/* Racer Slots */}
          <div className="space-y-3">
            {slots.map((slot, i) => (
              <div key={i} className="bg-panel rounded-lg p-4 border border-white/5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-white/60">Racer {i + 1}</span>
                  {slots.length > 2 && (
                    <button
                      onClick={() => removeSlot(i)}
                      className="p-1 text-white/20 hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                  {/* Racer select */}
                  <div>
                    <label className="block text-xs text-white/40 mb-1">Racer</label>
                    <select
                      value={slot.profileId}
                      onChange={e => updateSlot(i, { profileId: e.target.value })}
                      className="w-full bg-surface border border-white/10 rounded px-3 py-2 text-sm focus:border-gold focus:outline-none"
                    >
                      <option value="">Select racer...</option>
                      {profiles?.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.display_name} ({p.twitch_channel})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* VOD URL */}
                  <div>
                    <label className="block text-xs text-white/40 mb-1">VOD / Live URL</label>
                    <input
                      type="text"
                      value={slot.vodUrl}
                      onChange={e => updateSlot(i, { vodUrl: e.target.value })}
                      placeholder="twitch.tv/username, twitch.tv/videos/..., youtube.com/..."
                      className="w-full bg-surface border border-white/10 rounded px-3 py-2 text-sm focus:border-gold focus:outline-none"
                    />
                  </div>

                  {/* Start offset */}
                  <div>
                    <label className="block text-xs text-white/40 mb-1">Offset (m:s)</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        value={slot.startOffsetMinutes}
                        onChange={e => updateSlot(i, { startOffsetMinutes: e.target.value })}
                        className="w-14 bg-surface border border-white/10 rounded px-2 py-2 text-sm text-center focus:border-gold focus:outline-none"
                      />
                      <span className="text-white/30">:</span>
                      <input
                        type="number"
                        min="0"
                        max="59"
                        value={slot.startOffsetSeconds}
                        onChange={e => updateSlot(i, { startOffsetSeconds: e.target.value })}
                        className="w-14 bg-surface border border-white/10 rounded px-2 py-2 text-sm text-center focus:border-gold focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Crop status */}
                {slot.profileId && (() => {
                  const profile = profiles?.find(p => p.id === slot.profileId);
                  const crops = cropProfiles?.[slot.profileId] ?? [];
                  const hasCrop = crops.length > 0;
                  return (
                    <div className="flex items-center gap-2 mt-2">
                      {hasCrop ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-400">
                          <Crop size={11} /> Crop ({crops.length} profile{crops.length > 1 ? 's' : ''})
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-orange-400">
                          <Crop size={11} /> No Crop
                        </span>
                      )}
                      <button
                        onClick={() => setCropTarget({
                          profileId: slot.profileId,
                          twitchChannel: profile?.twitch_channel ?? '',
                        })}
                        className="text-xs px-2 py-0.5 rounded border border-white/10 text-white/50 hover:text-gold hover:border-gold/30 transition-colors"
                      >
                        {hasCrop ? 'Edit Crop' : 'Set Crop'}
                      </button>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>

          {/* Add racer */}
          {slots.length < 4 && (
            <button
              onClick={addSlot}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white/40 hover:text-white/80 transition-colors"
            >
              <Plus size={14} /> Add Racer
            </button>
          )}

          {/* Layout preview */}
          {validSlots.length >= 2 && (
            <div className="bg-panel rounded-lg p-4 border border-white/5">
              <div className="text-xs text-white/40 mb-2">Layout: {layoutLabel}</div>
              <div className={`grid gap-2 aspect-video max-w-md ${
                validSlots.length === 2 ? 'grid-cols-2' :
                validSlots.length === 3 ? 'grid-cols-2 grid-rows-2' :
                'grid-cols-2 grid-rows-2'
              }`}>
                {validSlots.map((s, i) => {
                  const profile = profiles?.find(p => p.id === s.profileId);
                  return (
                    <div
                      key={i}
                      className={`bg-surface rounded flex items-center justify-center text-xs text-white/40 ${
                        validSlots.length === 3 && i === 2 ? 'col-span-2' : ''
                      }`}
                    >
                      {profile?.display_name ?? `Racer ${i + 1}`}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Setup button */}
          <button
            onClick={() => setup.mutate()}
            disabled={setup.isPending || validSlots.length < 2}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-gold/15 text-gold rounded-lg hover:bg-gold/25 transition-colors disabled:opacity-30"
          >
            {setup.isPending ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {setup.isPending ? 'Setting up...' : 'Create VOD Race'}
          </button>

          {setup.error && <p className="text-xs text-red-400">{setup.error.message}</p>}
        </div>
      )}

      {/* Crop creation modal */}
      {cropTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-surface border border-white/10 rounded-lg w-[90vw] max-w-5xl h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 shrink-0">
              <span className="text-sm font-medium">
                Set Crop — {profiles?.find(p => p.id === cropTarget.profileId)?.display_name}
              </span>
              <button
                onClick={() => setCropTarget(null)}
                className="p-1 text-white/40 hover:text-white/80 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <CropCreationWizard
                racerProfileId={cropTarget.profileId}
                initialVodUrl={cropTarget.twitchChannel ? `https://twitch.tv/${cropTarget.twitchChannel}` : undefined}
                onComplete={() => {
                  setCropTarget(null);
                  refetchCrops();
                }}
                onCancel={() => setCropTarget(null)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
