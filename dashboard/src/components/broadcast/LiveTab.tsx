import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Play,
  Square,
  RefreshCw,
  ExternalLink,
  Zap,
  CheckCircle2,
  Radio,
  RotateCcw,
  Volume2,
  VolumeX,
  ArrowLeftRight,
  ChevronUp,
  ChevronDown,
  WifiOff,
  Hammer,
} from 'lucide-react';
import {
  getStatus,
  getObsStatus,
  connectObs,
  stopAllStreams,
  stopStream,
  stopStreaming,
  getMultitrackVideo,
  setMultitrackVideo,
} from '../../lib/api';
import type { SystemStatus, ObsStatus } from '../../lib/api';
import {
  getRaceCurrent,
  getDetectedRaces,
  setupRace,
  confirmSetup,
  goLive,
  endRace,
  getAutoMode,
  setAutoMode,
  swapRunner,
  featureRacer,
  getFeaturedRacer,
  refreshEntrants,
  goOffline,
  rebuildScene,
  updateCropLive,
} from '../../lib/raceApi';
import type {
  RaceCurrentResponse,
  RacetimeRace,
  OrchestratorState,
  EntrantUpdatePayload,
  TimerPayload,
  AutoModeConfig,
} from '../../lib/raceTypes';
import { useSocketEvent } from '../../hooks/useSocket';
import StatusBadge from '../StatusBadge';
import StreamCard from '../StreamCard';
import EntrantCard from '../EntrantCard';
import RaceTimerDisplay from '../RaceTimerDisplay';
import ConfirmDialog from '../ConfirmDialog';
import CropCreationWizard from '../crop/CropCreationWizard';

const STATE_LABELS: Record<OrchestratorState, string> = {
  idle: 'Idle',
  detected: 'Race Detected',
  setup: 'Setting Up',
  ready: 'Ready',
  live: 'LIVE',
  monitoring: 'Monitoring',
  finished: 'Finished',
};

const STATE_COLORS: Record<OrchestratorState, string> = {
  idle: 'bg-white/10 text-white/50',
  detected: 'bg-blue-500/15 text-blue-400',
  setup: 'bg-yellow-500/15 text-yellow-400',
  ready: 'bg-green-500/15 text-green-400',
  live: 'bg-red-500/15 text-red-400',
  monitoring: 'bg-red-500/15 text-red-400',
  finished: 'bg-purple-500/15 text-purple-400',
};

export { STATE_LABELS, STATE_COLORS };

export function LiveTab() {
  const qc = useQueryClient();
  const [timerData, setTimerData] = useState<TimerPayload | null>(null);
  const [entrantUpdates, setEntrantUpdates] = useState<Map<string, EntrantUpdatePayload>>(new Map());
  const [confirmAction, setConfirmAction] = useState<'endRace' | 'stopAll' | 'stopBroadcast' | null>(null);
  const [autoModePaused, setAutoModePaused] = useState(false);
  const [cropTarget, setCropTarget] = useState<{ profileId: string; twitchChannel: string } | null>(null);
  // Slot selection: maps racetimeUserId → assigned slot (0-indexed). Only populated during setup.
  const [slotSelections, setSlotSelections] = useState<Map<string, number>>(new Map());
  const autoInitSlugRef = useRef<string | null>(null);
  // Which racer's swap picker is open (racetimeUserId or null)
  const [swapPickerOpen, setSwapPickerOpen] = useState<string | null>(null);

  // Queries
  const { data: status } = useQuery<SystemStatus>({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 5000,
  });

  const { data: obsStatus } = useQuery<ObsStatus>({
    queryKey: ['obs-status'],
    queryFn: getObsStatus,
    refetchInterval: 5000,
  });

  const { data: raceCurrent, refetch: refetchRace } = useQuery<RaceCurrentResponse>({
    queryKey: ['race-current'],
    queryFn: getRaceCurrent,
    refetchInterval: 3000,
  });

  const { data: detectedRaces } = useQuery<RacetimeRace[]>({
    queryKey: ['detected-races'],
    queryFn: getDetectedRaces,
    refetchInterval: 10000,
    enabled: raceCurrent?.state === 'idle' || raceCurrent?.state === 'detected',
  });

  const { data: autoModeData } = useQuery<AutoModeConfig>({
    queryKey: ['auto-mode'],
    queryFn: getAutoMode,
  });

  const { data: multitrackData } = useQuery<{ enabled: boolean }>({
    queryKey: ['multitrack-video'],
    queryFn: getMultitrackVideo,
    enabled: obsStatus?.connected ?? false,
  });

  const multitrackMutation = useMutation({
    mutationFn: (enabled: boolean) => setMultitrackVideo(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['multitrack-video'] }),
  });

  const { data: featuredData } = useQuery<{ racerId: string | null }>({
    queryKey: ['featured-racer'],
    queryFn: getFeaturedRacer,
    enabled: raceCurrent?.state === 'live' || raceCurrent?.state === 'monitoring',
  });

  // Mutations
  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['status'] });
    qc.invalidateQueries({ queryKey: ['obs-status'] });
    qc.invalidateQueries({ queryKey: ['race-current'] });
    qc.invalidateQueries({ queryKey: ['detected-races'] });
  }, [qc]);

  const setupMutation = useMutation({
    mutationFn: (slug: string) => setupRace(slug),
    onSuccess: invalidateAll,
  });

  const confirmMutation = useMutation({
    mutationFn: (overrides?: { entrantOverrides?: Array<{ racetimeUserId: string; profileId: string; slot: number }> }) =>
      confirmSetup(overrides),
    onSuccess: invalidateAll,
  });

  const refreshMutation = useMutation({
    mutationFn: refreshEntrants,
    onSuccess: () => {
      setSlotSelections(new Map());
      invalidateAll();
    },
  });

  const goLiveMutation = useMutation({
    mutationFn: goLive,
    onSuccess: invalidateAll,
  });

  const endMutation = useMutation({
    mutationFn: endRace,
    onSuccess: () => {
      setTimerData(null);
      setEntrantUpdates(new Map());
      invalidateAll();
    },
  });

  const obsConnect = useMutation({ mutationFn: connectObs, onSuccess: invalidateAll });
  const stopBroadcastMutation = useMutation({
    mutationFn: stopStreaming,
    onSuccess: () => {
      setConfirmAction(null);
      invalidateAll();
    },
  });
  const killAll = useMutation({
    mutationFn: stopAllStreams,
    onSuccess: () => {
      setConfirmAction(null);
      invalidateAll();
    },
  });

  const autoModeMutation = useMutation({
    mutationFn: (config: Partial<AutoModeConfig>) => setAutoMode(config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-mode'] }),
  });

  const swapMutation = useMutation({
    mutationFn: ({ racerId, newRacetimeUserId, channel }: { racerId: string; newRacetimeUserId: string; channel: string }) =>
      swapRunner(racerId, channel, newRacetimeUserId),
    onSuccess: invalidateAll,
  });

  const offlineMutation = useMutation({
    mutationFn: goOffline,
    onSuccess: invalidateAll,
  });

  const rebuildMutation = useMutation({
    mutationFn: rebuildScene,
    onSuccess: invalidateAll,
  });

  const updateCropMutation = useMutation({
    mutationFn: (racerId: string) => updateCropLive(racerId),
    onSuccess: invalidateAll,
  });

  const featureMutation = useMutation({
    mutationFn: (racerId: string | null) => featureRacer(racerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['featured-racer'] }),
  });

  // Socket events
  useSocketEvent('race:stateChange', useCallback(() => {
    refetchRace();
  }, [refetchRace]));

  useSocketEvent('race:detected', useCallback(() => {
    qc.invalidateQueries({ queryKey: ['detected-races'] });
    refetchRace();
  }, [qc, refetchRace]));

  useSocketEvent<TimerPayload>('race:timer', useCallback((data: TimerPayload) => {
    setTimerData(data);
  }, []));

  useSocketEvent<EntrantUpdatePayload>('race:entrantUpdate', useCallback((data: EntrantUpdatePayload) => {
    setEntrantUpdates((prev) => {
      const next = new Map(prev);
      next.set(data.racetimeUserId, data);
      return next;
    });
    refetchRace();
  }, [refetchRace]));

  useSocketEvent('stream:stateChange', invalidateAll);
  useSocketEvent('obs:connected', invalidateAll);
  useSocketEvent('obs:disconnected', invalidateAll);

  useSocketEvent('race:autoModePaused', useCallback(() => {
    setAutoModePaused(true);
  }, []));

  useSocketEvent('race:runnerSwapped', useCallback(() => {
    invalidateAll();
  }, [invalidateAll]));

  const state = raceCurrent?.state ?? 'idle';
  const activeRace = raceCurrent?.activeRace;
  const streams = status?.streams ?? {};
  const streamCount = Object.keys(streams).length;

  // Auto-populate slot selections with first maxSlots entrants when setup has overflow
  useEffect(() => {
    if (!activeRace || state !== 'setup') return;
    const maxSlots = activeRace.layoutType === 'two_player' ? 2
      : activeRace.layoutType === 'three_player' ? 3 : 4;
    if (activeRace.entrants.length <= maxSlots) return;
    if (autoInitSlugRef.current === activeRace.raceSlug) return;
    autoInitSlugRef.current = activeRace.raceSlug;
    const sorted = [...activeRace.entrants].sort((a, b) => a.slot - b.slot);
    const initial = new Map<string, number>();
    sorted.slice(0, maxSlots).forEach((m, i) => initial.set(m.entrant.user.id, i));
    setSlotSelections(initial);
  }, [activeRace, state]);

  return (
    <div className="space-y-6">
      {/* Auto-Mode Toggle */}
      <div className="bg-panel rounded-lg px-4 py-3 border border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap size={14} className={autoModeData?.enabled ? 'text-gold' : 'text-white/30'} />
          <span className="text-xs font-medium">Auto-Mode</span>
          {autoModeData?.enabled && (
            <span className="text-[10px] text-white/30">
              {(autoModeData.delayAfterDetectionMs / 1000)}s / {(autoModeData.delayAfterSetupMs / 1000)}s / {(autoModeData.delayAfterConfirmMs / 1000)}s / {(autoModeData.delayAfterFinishMs / 1000)}s
            </span>
          )}
        </div>
        <button
          onClick={() => autoModeMutation.mutate({ enabled: !autoModeData?.enabled })}
          disabled={autoModeMutation.isPending}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            autoModeData?.enabled
              ? 'bg-gold/15 text-gold hover:bg-gold/25'
              : 'bg-white/10 text-white/40 hover:bg-white/15'
          }`}
        >
          {autoModeData?.enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Auto-Mode Paused Warning */}
      {autoModePaused && autoModeData?.enabled && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3 flex items-center justify-between">
          <span className="text-xs text-yellow-400">
            Auto-mode paused: unmatched entrant profiles detected. Resolve matches to continue.
          </span>
          <button
            onClick={() => setAutoModePaused(false)}
            className="text-xs text-yellow-400/60 hover:text-yellow-400 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status Cards */}
      <div className="grid grid-cols-3 gap-4">
        {/* Server */}
        <div className="bg-panel rounded-lg p-4 border border-white/5">
          <div className="text-xs text-white/40 mb-2">Server</div>
          <StatusBadge connected={status?.server === 'running'} label={status?.server ?? 'unknown'} />
        </div>

        {/* OBS */}
        <div className="bg-panel rounded-lg p-4 border border-white/5">
          <div className="text-xs text-white/40 mb-2">OBS Studio</div>
          <div className="flex items-center gap-3">
            <StatusBadge connected={obsStatus?.connected ?? false} />
            {!obsStatus?.connected && (
              <button
                onClick={() => obsConnect.mutate()}
                disabled={obsConnect.isPending}
                className="text-xs text-gold hover:text-gold-dim transition-colors disabled:opacity-50"
              >
                {obsConnect.isPending ? 'Connecting...' : 'Connect'}
              </button>
            )}
          </div>
        </div>

        {/* Broadcast */}
        <div className="bg-panel rounded-lg p-4 border border-white/5">
          <div className="text-xs text-white/40 mb-2">Twitch Broadcast</div>
          <div className="flex items-center justify-between">
            {obsStatus?.streaming ? (
              <StatusBadge connected label="LIVE" />
            ) : (
              <StatusBadge connected={false} label="Offline" />
            )}
            <div className="flex items-center gap-2">
              {obsStatus?.streaming && (
                <button
                  onClick={() => setConfirmAction('stopBroadcast')}
                  disabled={stopBroadcastMutation.isPending}
                  title="Stop Twitch broadcast"
                  className="px-2 py-1 text-[10px] font-medium rounded transition-colors bg-danger/15 text-danger hover:bg-danger/25 disabled:opacity-40"
                >
                  {stopBroadcastMutation.isPending ? 'Stopping...' : 'Stop'}
                </button>
              )}
              {obsStatus?.connected && (
                <button
                  onClick={() => multitrackMutation.mutate(!multitrackData?.enabled)}
                  disabled={multitrackMutation.isPending || obsStatus?.streaming}
                  title={obsStatus?.streaming ? 'Cannot toggle while streaming' : multitrackData?.enabled ? 'Disable Enhanced Broadcasting' : 'Enable Enhanced Broadcasting'}
                  className={`px-2 py-1 text-[10px] font-medium rounded transition-colors disabled:opacity-40 ${
                    multitrackData?.enabled
                      ? 'bg-purple-500/15 text-purple-400 hover:bg-purple-500/25'
                      : 'bg-white/5 text-white/30 hover:bg-white/10'
                  }`}
                >
                  MTV {multitrackData?.enabled ? 'ON' : 'OFF'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Race Timer (shown during live/monitoring) */}
      {(state === 'live' || state === 'monitoring') && (
        <div className="bg-panel rounded-lg p-6 border border-white/5 text-center">
          <RaceTimerDisplay
            startedAt={timerData?.startedAt ?? activeRace?.startedAt ?? null}
            clockOffsetMs={timerData?.clockOffsetMs ?? activeRace?.clockOffsetMs ?? 0}
          />
          {activeRace && (
            <div className="mt-2 text-xs text-white/40">
              {activeRace.goal} &middot;{' '}
              <a
                href={activeRace.raceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gold hover:underline"
              >
                racetime.gg <ExternalLink size={10} className="inline" />
              </a>
            </div>
          )}
        </div>
      )}

      {/* Detected Races (shown when idle/detected) */}
      {(state === 'idle' || state === 'detected') && (
        <div className="bg-panel rounded-lg p-4 border border-white/5">
          <div className="flex items-center gap-2 mb-3">
            <Radio size={16} className="text-blue-400" />
            <h3 className="text-sm font-medium">Detected TTP Races</h3>
          </div>

          {!detectedRaces || detectedRaces.length === 0 ? (
            <p className="text-xs text-white/40 py-4 text-center">
              No TTP races detected on racetime.gg. Polling every 30s...
            </p>
          ) : (
            <div className="space-y-2">
              {detectedRaces.map((race) => (
                <div
                  key={race.name}
                  className="flex items-center justify-between bg-white/5 rounded-lg p-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{race.name.split('/').pop()}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        race.status.value === 'open'
                          ? 'bg-blue-500/15 text-blue-400'
                          : race.status.value === 'in_progress'
                            ? 'bg-red-500/15 text-red-400'
                            : 'bg-white/10 text-white/40'
                      }`}>
                        {race.status.verbose_value}
                      </span>
                    </div>
                    <div className="text-xs text-white/40 mt-1">
                      {race.goal.name} &middot; {race.entrants_count} entrants
                    </div>
                  </div>
                  <button
                    onClick={() => setupMutation.mutate(race.name)}
                    disabled={setupMutation.isPending}
                    className="px-3 py-1.5 text-xs font-medium bg-gold/15 text-gold rounded hover:bg-gold/25 transition-colors disabled:opacity-50"
                  >
                    {setupMutation.isPending ? 'Setting up...' : 'Setup Race'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Entrant List (shown during setup/ready/live/monitoring) */}
      {activeRace && state !== 'idle' && (() => {
        const maxSlots = activeRace.layoutType === 'two_player' ? 2
          : activeRace.layoutType === 'three_player' ? 3 : 4;
        const needsSlotPicker = state === 'setup' && activeRace.entrants.length > maxSlots;
        const selectedCount = slotSelections.size;

        // Helper to toggle an entrant into/out of the slot selection
        const toggleSlot = (userId: string) => {
          setSlotSelections((prev) => {
            const next = new Map(prev);
            if (next.has(userId)) {
              // Remove and compact remaining slots
              next.delete(userId);
              const sorted = [...next.entries()].sort((a, b) => a[1] - b[1]);
              const compacted = new Map<string, number>();
              sorted.forEach(([id], i) => compacted.set(id, i));
              return compacted;
            }
            if (next.size >= maxSlots) return prev; // Already full
            next.set(userId, next.size);
            return next;
          });
        };

        // Move a selected entrant up/down in slot order
        const moveSlot = (userId: string, direction: -1 | 1) => {
          setSlotSelections((prev) => {
            const currentSlot = prev.get(userId);
            if (currentSlot === undefined) return prev;
            const targetSlot = currentSlot + direction;
            if (targetSlot < 0 || targetSlot >= prev.size) return prev;
            const next = new Map(prev);
            // Find who occupies the target slot
            for (const [id, slot] of next) {
              if (slot === targetSlot) {
                next.set(id, currentSlot);
                break;
              }
            }
            next.set(userId, targetSlot);
            return next;
          });
        };

        // Sort entrants for display: selected first (by slot), then unselected
        const sortedEntrants = needsSlotPicker
          ? [...activeRace.entrants].sort((a, b) => {
              const slotA = slotSelections.get(a.entrant.user.id);
              const slotB = slotSelections.get(b.entrant.user.id);
              if (slotA !== undefined && slotB !== undefined) return slotA - slotB;
              if (slotA !== undefined) return -1;
              if (slotB !== undefined) return 1;
              return a.slot - b.slot;
            })
          : activeRace.entrants;

        return (
          <div className="bg-panel rounded-lg p-4 border border-white/5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Zap size={16} className="text-gold" />
                <h3 className="text-sm font-medium">
                  Entrants ({activeRace.entrants.length})
                </h3>
                <span className="text-xs text-white/30">{activeRace.layoutType.replace('_', ' ')}</span>
                {needsSlotPicker && (
                  <span className="text-xs text-yellow-400">
                    Select {maxSlots} of {activeRace.entrants.length}
                    {selectedCount > 0 && ` (${selectedCount} selected)`}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                {state === 'setup' && (
                  <button
                    onClick={() => refreshMutation.mutate()}
                    disabled={refreshMutation.isPending}
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={refreshMutation.isPending ? 'animate-spin' : ''} />
                    {refreshMutation.isPending ? 'Refreshing...' : 'Refresh Entrants'}
                  </button>
                )}
                {(state === 'live' || state === 'monitoring') && (
                  <button
                    onClick={() => featureMutation.mutate(null)}
                    className="text-xs text-white/40 hover:text-white/60 flex items-center gap-1 transition-colors"
                  >
                    <VolumeX size={12} /> Mute All
                  </button>
                )}
                {activeRace.raceUrl && (
                  <a
                    href={activeRace.raceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gold hover:underline flex items-center gap-1"
                  >
                    racetime.gg <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {sortedEntrants.map((match) => {
                const update = entrantUpdates.get(match.entrant.user.id);
                const featureId = match.profileId || match.entrant.user.id;
                const isFeatured = featuredData?.racerId === featureId;
                const isLiveState = state === 'live' || state === 'monitoring';
                const canSwap = state === 'ready' || state === 'live' || state === 'monitoring';
                const assignedSlot = slotSelections.get(match.entrant.user.id);
                const isSelected = assignedSlot !== undefined;
                return (
                  <div key={match.entrant.user.id} className="flex items-stretch gap-2">
                    {/* Slot picker controls (setup state with overflow entrants) */}
                    {needsSlotPicker && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleSlot(match.entrant.user.id)}
                          className={`w-8 h-8 rounded text-xs font-bold flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'bg-gold/20 text-gold border border-gold/40'
                              : selectedCount >= maxSlots
                                ? 'bg-white/5 text-white/15 cursor-not-allowed'
                                : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60 border border-white/10'
                          }`}
                          disabled={!isSelected && selectedCount >= maxSlots}
                          title={isSelected ? `Slot ${assignedSlot! + 1} — click to remove` : 'Click to add to display'}
                        >
                          {isSelected ? assignedSlot! + 1 : '+'}
                        </button>
                        {isSelected && (
                          <div className="flex flex-col">
                            <button
                              onClick={() => moveSlot(match.entrant.user.id, -1)}
                              disabled={assignedSlot === 0}
                              className="text-white/30 hover:text-white/60 disabled:text-white/10 transition-colors"
                              title="Move up"
                            >
                              <ChevronUp size={12} />
                            </button>
                            <button
                              onClick={() => moveSlot(match.entrant.user.id, 1)}
                              disabled={assignedSlot === selectedCount - 1}
                              className="text-white/30 hover:text-white/60 disabled:text-white/10 transition-colors"
                              title="Move down"
                            >
                              <ChevronDown size={12} />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className={`flex-1 ${needsSlotPicker && !isSelected ? 'opacity-50' : ''}`}>
                      <EntrantCard
                        match={match}
                        raceStatus={update?.status}
                        finishTime={update?.finishTime ?? match.entrant.finish_time}
                        finishPlace={update?.finishPlace ?? match.entrant.place}
                        placeOrdinal={update?.placeOrdinal ?? match.entrant.place_ordinal}
                        onSetCrop={(profileId, twitchChannel) => setCropTarget({ profileId, twitchChannel })}
                      />
                    </div>
                    {canSwap && (
                      <div className="flex flex-col gap-1">
                        {isLiveState && (
                          <button
                            onClick={() => featureMutation.mutate(isFeatured ? null : featureId)}
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
                        <div className="relative">
                          <button
                            onClick={() => setSwapPickerOpen(swapPickerOpen === match.entrant.user.id ? null : match.entrant.user.id)}
                            title="Swap runner"
                            disabled={swapMutation.isPending}
                            className={`flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-50 ${
                              swapPickerOpen === match.entrant.user.id
                                ? 'bg-gold/20 text-gold'
                                : 'bg-white/5 text-white/30 hover:text-white/60 hover:bg-white/10'
                            }`}
                          >
                            <ArrowLeftRight size={14} />
                          </button>
                          {swapPickerOpen === match.entrant.user.id && activeRace && (() => {
                            const maxSlots = activeRace.layoutType === 'two_player' ? 2
                              : activeRace.layoutType === 'three_player' ? 3 : 4;
                            const bench = activeRace.entrants.filter((m) =>
                              m.slot >= maxSlots && m.twitchChannel,
                            );
                            return (
                              <div className="absolute right-0 top-9 z-20 bg-surface border border-white/10 rounded-lg shadow-xl min-w-[180px] py-1">
                                <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider">
                                  Replace with...
                                </div>
                                {bench.length === 0 ? (
                                  <div className="px-3 py-2 text-xs text-white/30">No bench runners</div>
                                ) : (
                                  bench.map((b) => (
                                    <button
                                      key={b.entrant.user.id}
                                      onClick={() => {
                                        swapMutation.mutate({
                                          racerId: match.entrant.user.id,
                                          newRacetimeUserId: b.entrant.user.id,
                                          channel: b.twitchChannel!,
                                        });
                                        setSwapPickerOpen(null);
                                      }}
                                      className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors flex items-center justify-between"
                                    >
                                      <span>{b.profileDisplayName || b.entrant.user.name}</span>
                                      <span className="text-white/20">{b.twitchChannel}</span>
                                    </button>
                                  ))
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Action Buttons */}
      <div className="flex items-center gap-3">
        {state === 'setup' && (() => {
          const maxSlots = activeRace
            ? (activeRace.layoutType === 'two_player' ? 2 : activeRace.layoutType === 'three_player' ? 3 : 4)
            : 4;
          const needsPick = activeRace && activeRace.entrants.length > maxSlots;
          const canConfirm = !needsPick || slotSelections.size === maxSlots;

          const handleConfirm = () => {
            if (needsPick && slotSelections.size > 0 && activeRace) {
              const entrantOverrides = [...slotSelections.entries()].map(([userId, slot]) => {
                const match = activeRace.entrants.find((m) => m.entrant.user.id === userId);
                return {
                  racetimeUserId: userId,
                  profileId: match?.profileId || '',
                  slot,
                };
              });
              confirmMutation.mutate({ entrantOverrides });
            } else {
              confirmMutation.mutate({});
            }
          };

          return (
            <button
              onClick={handleConfirm}
              disabled={confirmMutation.isPending || !canConfirm}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-500/15 text-blue-400 rounded-lg hover:bg-blue-500/25 transition-colors disabled:opacity-50"
            >
              <CheckCircle2 size={16} />
              {confirmMutation.isPending
                ? 'Starting streams...'
                : !canConfirm
                  ? `Select ${maxSlots} entrants first`
                  : 'Confirm Setup'}
            </button>
          );
        })()}

        {state === 'ready' && (
          <button
            onClick={() => goLiveMutation.mutate()}
            disabled={goLiveMutation.isPending || !obsStatus?.connected}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-green-500/15 text-green-400 rounded-lg hover:bg-green-500/25 transition-colors disabled:opacity-50"
          >
            <Play size={16} />
            {goLiveMutation.isPending ? 'Going live...' : 'Go Live'}
          </button>
        )}

        {/* Rebuild Scene — re-reads crop profiles and rebuilds OBS layout */}
        {(state === 'ready' || state === 'live' || state === 'monitoring') && (
          <button
            onClick={() => rebuildMutation.mutate()}
            disabled={rebuildMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white/10 text-white/60 rounded-lg hover:bg-white/15 transition-colors disabled:opacity-50"
          >
            <Hammer size={16} />
            {rebuildMutation.isPending ? 'Rebuilding...' : 'Rebuild Scene'}
          </button>
        )}

        {/* Go Offline — stops streaming, switches to TTP_Offline scene */}
        {(state === 'ready' || state === 'live' || state === 'monitoring') && (
          <button
            onClick={() => offlineMutation.mutate()}
            disabled={offlineMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-yellow-500/15 text-yellow-400 rounded-lg hover:bg-yellow-500/25 transition-colors disabled:opacity-50"
          >
            <WifiOff size={16} />
            {offlineMutation.isPending ? 'Going offline...' : 'Go Offline'}
          </button>
        )}

        {/* End Race — available in ready/live/monitoring/finished */}
        {(state === 'ready' || state === 'live' || state === 'monitoring' || state === 'finished') && (
          <button
            onClick={() => setConfirmAction('endRace')}
            disabled={endMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-danger/15 text-danger rounded-lg hover:bg-danger/25 transition-colors disabled:opacity-50"
          >
            <Square size={16} />
            {endMutation.isPending ? 'Ending...' : 'End Race'}
          </button>
        )}

        {state === 'finished' && (
          <button
            onClick={() => endMutation.mutate()}
            disabled={endMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white/10 text-white/60 rounded-lg hover:bg-white/15 transition-colors disabled:opacity-50"
          >
            <RotateCcw size={16} />
            Reset
          </button>
        )}

        {state !== 'idle' && state !== 'detected' && (
          <span className="text-xs text-white/30">
            {streamCount} stream{streamCount !== 1 ? 's' : ''} active
          </span>
        )}
      </div>

      {/* Active Streams (shown when streams exist) */}
      {streamCount > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-white/60">Active Streams</h3>
            <button
              onClick={() => setConfirmAction('stopAll')}
              className="text-xs text-danger/60 hover:text-danger transition-colors"
            >
              Stop All
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(streams).map(([id, stream]) => (
              <StreamCard
                key={id}
                status={stream}
                onStop={async () => {
                  await stopStream(id);
                  invalidateAll();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Mutation Errors */}
      {setupMutation.error && (
        <p className="text-xs text-danger">Setup error: {setupMutation.error.message}</p>
      )}
      {confirmMutation.error && (
        <p className="text-xs text-danger">Confirm error: {confirmMutation.error.message}</p>
      )}
      {goLiveMutation.error && (
        <p className="text-xs text-danger">Go live error: {goLiveMutation.error.message}</p>
      )}
      {endMutation.error && (
        <p className="text-xs text-danger">End race error: {endMutation.error.message}</p>
      )}
      {swapMutation.error && (
        <p className="text-xs text-danger">Swap error: {swapMutation.error.message}</p>
      )}
      {featureMutation.error && (
        <p className="text-xs text-danger">Feature error: {featureMutation.error.message}</p>
      )}
      {refreshMutation.error && (
        <p className="text-xs text-danger">Refresh error: {refreshMutation.error.message}</p>
      )}
      {offlineMutation.error && (
        <p className="text-xs text-danger">Offline error: {offlineMutation.error.message}</p>
      )}
      {rebuildMutation.error && (
        <p className="text-xs text-danger">Rebuild error: {rebuildMutation.error.message}</p>
      )}
      {updateCropMutation.error && (
        <p className="text-xs text-danger">Crop update error: {updateCropMutation.error.message}</p>
      )}

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        open={confirmAction === 'endRace'}
        title="End Race"
        message="This will stop all streams, tear down the OBS scene, and reset the orchestrator. Are you sure?"
        confirmLabel="End Race"
        onConfirm={() => {
          setConfirmAction(null);
          endMutation.mutate();
        }}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === 'stopAll'}
        title="Stop All Streams"
        message="This will kill all active ffmpeg processes. The OBS scene will show stale frames until streams are restarted."
        confirmLabel="Stop All"
        onConfirm={() => {
          killAll.mutate();
        }}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === 'stopBroadcast'}
        title="Stop Twitch Broadcast"
        message="This will stop the OBS stream to Twitch immediately. The channel will go offline."
        confirmLabel="Stop Broadcast"
        onConfirm={() => stopBroadcastMutation.mutate()}
        onCancel={() => setConfirmAction(null)}
      />

      {/* Inline Crop Creation Modal */}
      {cropTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-surface rounded-xl border border-white/10 w-[90vw] h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
              <h3 className="text-sm font-medium">Set Crop Profile</h3>
              <button
                onClick={() => setCropTarget(null)}
                className="p-1 text-white/40 hover:text-white/80 transition-colors"
              >
                <Square size={14} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <CropCreationWizard
                racerProfileId={cropTarget.profileId}
                initialVodUrl={`https://www.twitch.tv/${cropTarget.twitchChannel}`}
                onComplete={() => {
                  // After crop saved, trigger live OBS update if race is active
                  if (state === 'ready' || state === 'live' || state === 'monitoring') {
                    updateCropMutation.mutate(cropTarget.profileId);
                  }
                  setCropTarget(null);
                  refetchRace();
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
