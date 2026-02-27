import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getKnowledgeStatus, ingestVod, importRaceHistory } from '../lib/api';
import { io } from 'socket.io-client';
import { SectionHeader } from '../ui';

interface IngestionProgress {
  stage: 'extracting_audio' | 'transcribing' | 'chunking' | 'embedding' | 'complete' | 'error';
  pct: number;
  message?: string;
}

export default function KnowledgeManager() {
  const [vodUrl, setVodUrl] = useState('');
  const [vodTitle, setVodTitle] = useState('');
  const [ingestionProgress, setIngestionProgress] = useState<IngestionProgress | null>(null);
  const [historyPages, setHistoryPages] = useState(10);

  const kbStatus = useQuery({
    queryKey: ['knowledgeStatus'],
    queryFn: getKnowledgeStatus,
    refetchInterval: 10000,
  });

  const vodMutation = useMutation({
    mutationFn: () => ingestVod(vodUrl, vodTitle || undefined),
    onSuccess: () => {
      setIngestionProgress({ stage: 'extracting_audio', pct: 0 });
    },
  });

  const historyMutation = useMutation({
    mutationFn: () => importRaceHistory(historyPages),
  });

  // Listen for ingestion progress via socket
  useEffect(() => {
    const socket = io({ path: '/socket.io' });
    socket.emit('join', 'dashboard');

    socket.on('knowledge:ingestionProgress', (progress: IngestionProgress) => {
      setIngestionProgress(progress);
    });

    return () => { socket.disconnect(); };
  }, []);

  const handleIngest = useCallback(() => {
    if (!vodUrl.trim()) return;
    vodMutation.mutate();
  }, [vodUrl, vodTitle]);

  const stageLabel = (stage: string) => {
    switch (stage) {
      case 'extracting_audio': return 'Extracting audio...';
      case 'transcribing': return 'Transcribing with Whisper...';
      case 'chunking': return 'Chunking transcript...';
      case 'embedding': return 'Embedding chunks...';
      case 'complete': return 'Complete!';
      case 'error': return 'Error';
      default: return stage;
    }
  };

  const status = kbStatus.data;

  return (
    <div className="space-y-6">
      <SectionHeader title="Knowledge Base" />

      {/* KB Status Card */}
      <div
        className="rounded-lg border p-5"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <h3 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>Status</h3>
        {status ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatusDot label="ChromaDB" ok={status.chromaConnected} />
            <StatusDot label="Ollama" ok={status.ollamaConnected} />
            <div className="text-sm">
              <span style={{ color: 'var(--text-secondary)' }}>Collection size:</span>{' '}
              <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{status.collectionSize.toLocaleString()}</span>
            </div>
            <div className="text-sm">
              <span style={{ color: 'var(--text-secondary)' }}>Available:</span>{' '}
              <span style={{ color: status.available ? 'var(--success)' : 'var(--danger)' }}>
                {status.available ? 'Yes' : 'No'}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</p>
        )}
      </div>

      {/* VOD Ingestion */}
      <div
        className="rounded-lg border p-5"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <h3 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>
          VOD Transcript Ingestion
        </h3>
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
          Extract audio from a Twitch VOD, transcribe with Whisper, and ingest into the knowledge base.
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <input
              type="text"
              value={vodUrl}
              onChange={(e) => setVodUrl(e.target.value)}
              placeholder="https://www.twitch.tv/videos/..."
              className="flex-1 rounded px-3 py-2 text-sm focus:outline-none"
              style={{
                background: 'var(--bg-base)',
                color: 'var(--text-primary)',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--border)',
              }}
            />
            <input
              type="text"
              value={vodTitle}
              onChange={(e) => setVodTitle(e.target.value)}
              placeholder="Title (optional)"
              className="w-48 rounded px-3 py-2 text-sm focus:outline-none"
              style={{
                background: 'var(--bg-base)',
                color: 'var(--text-primary)',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--border)',
              }}
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleIngest}
              disabled={!vodUrl.trim() || vodMutation.isPending || (ingestionProgress?.stage !== 'complete' && ingestionProgress?.stage !== 'error' && ingestionProgress !== null)}
              className="px-4 py-2 rounded text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
            >
              Ingest VOD
            </button>
            {ingestionProgress && (
              <div className="flex-1">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span style={{
                    color: ingestionProgress.stage === 'error' ? 'var(--danger)' : ingestionProgress.stage === 'complete' ? 'var(--success)' : 'var(--text-secondary)',
                  }}>
                    {stageLabel(ingestionProgress.stage)}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>{ingestionProgress.pct}%</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${ingestionProgress.pct}%`,
                      background: ingestionProgress.stage === 'error' ? 'var(--danger)' : ingestionProgress.stage === 'complete' ? 'var(--success)' : 'var(--accent)',
                    }}
                  />
                </div>
                {ingestionProgress.message && (
                  <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{ingestionProgress.message}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* History Import */}
      <div
        className="rounded-lg border p-5"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <h3 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>
          Race History Import
        </h3>
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
          Import race history from racetime.gg to update racer stats (times raced, average time).
        </p>
        <div className="flex items-center gap-3">
          <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>Pages:</label>
          <input
            type="number"
            value={historyPages}
            onChange={(e) => setHistoryPages(Number(e.target.value) || 10)}
            min={1}
            max={50}
            className="w-20 rounded px-3 py-2 text-sm focus:outline-none"
            style={{
              background: 'var(--bg-base)',
              color: 'var(--text-primary)',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--border)',
            }}
          />
          <button
            onClick={() => historyMutation.mutate()}
            disabled={historyMutation.isPending}
            className="px-4 py-2 rounded text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
          >
            {historyMutation.isPending ? 'Importing...' : 'Import History'}
          </button>
          {historyMutation.isSuccess && historyMutation.data && (
            <span className="text-sm" style={{ color: 'var(--success)' }}>
              {historyMutation.data.racesImported} races, {historyMutation.data.racersUpdated} racers updated
            </span>
          )}
          {historyMutation.isError && (
            <span className="text-sm" style={{ color: 'var(--danger)' }}>
              {historyMutation.error instanceof Error ? historyMutation.error.message : 'Failed'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className="w-2 h-2 rounded-full" style={{ background: ok ? 'var(--success)' : 'var(--danger)' }} />
      <span style={{ color: 'var(--text-primary)' }}>{label}</span>
    </div>
  );
}
