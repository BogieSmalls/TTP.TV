import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Radio, Film, RotateCcw, Tv } from 'lucide-react';
import { getObsStatus } from '../lib/api';
import { getRaceCurrent } from '../lib/raceApi';
import { getVodRaceStatus } from '../lib/vodRaceApi';
import type { RaceCurrentResponse } from '../lib/raceTypes';
import type { VodRaceStatus } from '../lib/vodRaceApi';
import type { ObsStatus } from '../lib/api';
import { SectionHeader, Tabs, Badge } from '../ui';
import { LiveTab } from '../components/broadcast/LiveTab';
import { VodTab } from '../components/broadcast/VodTab';
import { ReplayTab } from '../components/broadcast/ReplayTab';
import { StreamInfoTab } from '../components/broadcast/StreamInfoTab';

const broadcastTabs = [
  { id: 'live', label: 'Live', icon: <Radio size={16} /> },
  { id: 'vod', label: 'VOD', icon: <Film size={16} /> },
  { id: 'replay', label: 'Replay', icon: <RotateCcw size={16} /> },
  { id: 'stream-info', label: 'Stream Info', icon: <Tv size={16} /> },
];

export default function Broadcast() {
  const { tab: urlTab } = useParams();
  const navigate = useNavigate();
  const [fallbackTab, setFallbackTab] = useState('live');
  const activeTab = urlTab ?? fallbackTab;

  const { data: obsStatus } = useQuery<ObsStatus>({
    queryKey: ['obs-status'],
    queryFn: getObsStatus,
    refetchInterval: 5000,
  });

  const { data: raceCurrent } = useQuery<RaceCurrentResponse>({
    queryKey: ['race-current'],
    queryFn: getRaceCurrent,
    refetchInterval: 5000,
  });

  const { data: vodStatus } = useQuery<VodRaceStatus>({
    queryKey: ['vod-race-status'],
    queryFn: getVodRaceStatus,
    refetchInterval: 5000,
  });

  const isLiveActive = raceCurrent?.state === 'live' || raceCurrent?.state === 'monitoring';
  const isVodActive = vodStatus?.state === 'live' || vodStatus?.state === 'ready';
  const isAnyLive = isLiveActive || isVodActive || obsStatus?.streaming;

  function handleTabChange(id: string) {
    setFallbackTab(id);
    navigate(`/broadcast/${id}`, { replace: true });
  }

  return (
    <div className="space-y-6">
      {/* Shared Broadcast Header */}
      <div className="flex items-center justify-between">
        <SectionHeader
          title="Broadcast"
          action={
            <div className="flex items-center gap-2">
              <Badge
                variant={obsStatus?.connected ? 'success' : 'danger'}
                label={obsStatus?.connected ? 'OBS Connected' : 'OBS Disconnected'}
              />
              {isAnyLive && <Badge variant="danger" label="LIVE" pulse />}
            </div>
          }
        />
      </div>

      <Tabs tabs={broadcastTabs} active={activeTab} onChange={handleTabChange} />

      <div className="mt-4">
        {activeTab === 'live' && <LiveTab />}
        {activeTab === 'vod' && <VodTab />}
        {activeTab === 'replay' && <ReplayTab />}
        {activeTab === 'stream-info' && <StreamInfoTab />}
      </div>
    </div>
  );
}
