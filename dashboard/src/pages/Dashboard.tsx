import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Radio, Eye, MessageSquare, Server, Wifi, Volume2, BookOpen, Trophy, Power, Square, Users, Zap, Play } from 'lucide-react';
import { getHealth, getRaceHistory, getDetectedRaces, launchObs, killObs } from '../lib/api';
import type { RaceHistoryPage, DetectedRace } from '../lib/api';
import { Card, StatCard, Badge, Button, SectionHeader, EmptyState } from '../ui';
import { useNavigate } from 'react-router-dom';
import { useSocketEvent } from '../hooks/useSocket';

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function raceStatusBadge(status: string): { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string } {
  switch (status) {
    case 'in_progress': return { variant: 'success', label: 'LIVE' };
    case 'open': return { variant: 'warning', label: 'OPEN' };
    case 'pending': return { variant: 'warning', label: 'PENDING' };
    case 'invitational': return { variant: 'neutral', label: 'INVITE' };
    case 'finished': return { variant: 'neutral', label: 'FINISHED' };
    default: return { variant: 'neutral', label: status.toUpperCase() };
  }
}

export default function Dashboard() {
  const queryClient = useQueryClient();

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    refetchInterval: 5000,
  });

  const { data: raceHistory } = useQuery<RaceHistoryPage>({
    queryKey: ['raceHistory', 1],
    queryFn: () => getRaceHistory(1),
    refetchInterval: 120000,
  });

  const { data: detectedRaces } = useQuery<DetectedRace[]>({
    queryKey: ['detectedRaces'],
    queryFn: getDetectedRaces,
    refetchInterval: 30000,
  });

  // Real-time updates via socket
  const onRaceDetected = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['detectedRaces'] });
  }, [queryClient]);
  useSocketEvent('race:detected', onRaceDetected);

  const navigate = useNavigate();

  // Filter to last 72 hours
  const cutoff = Date.now() - 72 * 60 * 60 * 1000;
  const recentRaces = raceHistory?.races.filter(
    r => r.startedAt && new Date(r.startedAt).getTime() > cutoff
  ) ?? [];

  const [obsLoading, setObsLoading] = useState(false);

  const streamCount = health ? Object.keys(health.streams).length : 0;
  const activeStreams = health
    ? Object.values(health.streams).filter((s) => s.state === 'running').length
    : 0;

  const obsConnected = health?.obs.connected ?? false;

  async function handleLaunchObs() {
    setObsLoading(true);
    try { await launchObs(); } catch { /* health poll will update */ }
    setObsLoading(false);
  }

  async function handleKillObs() {
    setObsLoading(true);
    try { await killObs(); } catch { /* health poll will update */ }
    setObsLoading(false);
  }

  const liveRaces = detectedRaces ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader title="Dashboard" />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="OBS"
          value={obsConnected ? health!.obs.scene || 'Connected' : 'Disconnected'}
          icon={<Monitor size={20} />}
          status={obsConnected ? 'ok' : 'error'}
          action={
            !obsConnected ? (
              <Button size="sm" variant="primary" icon={<Power size={14} />} onClick={handleLaunchObs} loading={obsLoading}>
                Launch
              </Button>
            ) : (
              <Button size="sm" variant="danger" icon={<Square size={14} />} onClick={handleKillObs} loading={obsLoading}>
                Stop
              </Button>
            )
          }
        />
        <StatCard
          label="Streams"
          value={activeStreams > 0 ? `${activeStreams} active` : `${streamCount} total`}
          icon={<Radio size={20} />}
          status={activeStreams > 0 ? 'ok' : streamCount > 0 ? 'warn' : undefined}
        />
        <StatCard
          label="Vision"
          value={health?.vision.bridgeCount ?? 0}
          icon={<Eye size={20} />}
          status={health?.vision.bridgeCount ? 'ok' : undefined}
        />
        <StatCard
          label="Commentary"
          value={health?.commentary.enabled ? `${health.commentary.turnCount} turns` : 'Off'}
          icon={<MessageSquare size={20} />}
          status={health?.commentary.enabled ? 'ok' : undefined}
        />
      </div>

      {/* Detected Live Races */}
      {liveRaces.length > 0 && (
        <Card title="Detected Races">
          <div className="space-y-2">
            {liveRaces.map((race) => {
              const badge = raceStatusBadge(race.status.value);
              const streamingCount = race.entrants.filter(e => e.stream_live).length;
              return (
                <div
                  key={race.name}
                  className="flex items-center gap-3 py-3 px-3 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
                  onClick={() => navigate(`/broadcast?race=${encodeURIComponent(race.name)}`)}
                >
                  <div className="shrink-0">
                    <Badge variant={badge.variant} label={badge.label} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {race.goal.name}
                    </p>
                    <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {race.name}
                      {race.info ? ` \u2022 ${race.info.slice(0, 60)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <Users size={10} />
                      <span>{race.entrants_count}</span>
                    </div>
                    {streamingCount > 0 && (
                      <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-success, #4ade80)' }}>
                        <Radio size={10} />
                        <span>{streamingCount} live</span>
                      </div>
                    )}
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {race.started_at ? formatTimeAgo(race.started_at) : race.opened_at ? formatTimeAgo(race.opened_at) : ''}
                    </span>
                    <Play size={14} style={{ color: 'var(--accent)' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Recent Races */}
        <div className="lg:col-span-3">
          <Card
            title="Recent Races"
            action={
              <button
                onClick={() => navigate('/broadcast/replay')}
                className="text-xs hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                View All
              </button>
            }
          >
            {recentRaces.length > 0 ? (
              <div className="space-y-1">
                {recentRaces.slice(0, 8).map((race) => (
                  <div
                    key={race.slug}
                    className="flex items-center gap-3 py-2 px-1 rounded hover:bg-white/5 transition-colors group cursor-pointer"
                    title={`${race.goal}\n${race.startedAt ? new Date(race.startedAt).toLocaleString() : ''}\n${race.entrantCount} racers`}
                    onClick={() => navigate(`/broadcast/replay?race=${encodeURIComponent(race.url)}`)}
                  >
                    <Trophy size={12} className="text-gold/50 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {race.goal}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                      <Users size={10} />
                      <span>{race.finishedCount}/{race.entrantCount}</span>
                    </div>
                    <span className="text-xs shrink-0 w-16 text-right" style={{ color: 'var(--text-muted)' }}>
                      {race.startedAt ? new Date(race.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Trophy size={32} />}
                title="No recent races"
                description="No Z1R races in the last 72 hours. Check racetime.gg or browse the full Race Library."
              />
            )}
          </Card>
        </div>

        {/* System Health */}
        <div className="lg:col-span-2">
          <Card title="System Health">
            <div className="space-y-3">
              <HealthRow
                icon={<Server size={16} />}
                label="Server"
                status={health ? 'ok' : 'error'}
                detail={health?.server ?? 'Unknown'}
              />
              <HealthRow
                icon={<Wifi size={16} />}
                label="OBS"
                status={obsConnected ? 'ok' : 'error'}
                detail={obsConnected ? (health!.obs.streaming ? 'Streaming' : 'Idle') : 'Disconnected'}
              />
              <HealthRow
                icon={<Volume2 size={16} />}
                label="TTS"
                status={health?.tts.enabled ? 'ok' : 'warn'}
                detail={health?.tts.enabled ? 'Enabled' : 'Disabled'}
              />
              <HealthRow
                icon={<BookOpen size={16} />}
                label="Knowledge Base"
                status={health?.knowledgeBase.available ? 'ok' : 'warn'}
                detail={health?.knowledgeBase.available ? 'Available' : 'Unavailable'}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function HealthRow({
  icon,
  label,
  status,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}) {
  const variant = status === 'ok' ? 'success' : status === 'warn' ? 'warning' : 'danger';
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <Badge variant={variant} label={detail} />
    </div>
  );
}
