import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Mic, MicOff, Send, Trash2, Plus,
  RefreshCw, Loader2, Volume2, Play,
  MessageSquare, Star, Users, AudioLines, Edit2,
} from 'lucide-react';
import { useSocketEvent } from '../hooks/useSocket';
import {
  getStatus, setEnabled, updateConfig, manualTrigger, clearState,
  getPresets, setActivePreset,
  getFlavorEntries, addFlavorEntry, deleteFlavorEntry,
} from '../lib/commentaryApi';
import type {
  CommentaryStatus, CommentaryTextEvent, PresetSummary,
  FlavorEntry, ConversationLine,
} from '../lib/commentaryApi';
import { featureChatMessage } from '../lib/api';
import { getTtsStatus, getTtsVoices, testTts } from '../lib/ttsApi';
import type { TtsStatus } from '../lib/ttsApi';
import {
  listPersonas, createPersona, updatePersona, deletePersona,
  listVoices, createVoice, deleteVoice, testVoice,
} from '../lib/personaApi';
import type { Persona, VoiceProfile } from '../lib/personaApi';
import { SectionHeader, Tabs, Card, Badge, Modal, Button, DataGrid, EmptyState } from '../ui';

const commentaryTabs = [
  { id: 'config', label: 'Config' },
  { id: 'tts', label: 'TTS' },
  { id: 'log', label: 'Live Log' },
  { id: 'flavor', label: 'Flavor' },
  { id: 'personas', label: 'Personas' },
  { id: 'voices', label: 'Voice Studio' },
];

export default function Commentary() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('log');
  const [triggerPrompt, setTriggerPrompt] = useState('');
  const [liveConversation, setLiveConversation] = useState<ConversationLine[]>([]);
  const [chatMessages, setChatMessages] = useState<{ username: string; displayName: string; message: string; timestamp: number }[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ─── Queries ───

  const { data: status, isLoading } = useQuery<CommentaryStatus>({
    queryKey: ['commentary-status'],
    queryFn: getStatus,
    refetchInterval: 5000,
  });

  const { data: presets } = useQuery<PresetSummary[]>({
    queryKey: ['commentary-presets'],
    queryFn: getPresets,
  });

  const { data: flavorEntries, refetch: refetchFlavor } = useQuery<FlavorEntry[]>({
    queryKey: ['commentary-flavor'],
    queryFn: getFlavorEntries,
  });

  const { data: ttsStatus } = useQuery<TtsStatus>({
    queryKey: ['tts-status'],
    queryFn: getTtsStatus,
    refetchInterval: 10000,
  });

  const { data: ttsVoices } = useQuery<{ voices: string[] }>({
    queryKey: ['tts-voices'],
    queryFn: getTtsVoices,
    enabled: tab === 'tts',
  });

  const testTtsMut = useMutation({
    mutationFn: ({ text, voice, speed }: { text?: string; voice?: string; speed?: number }) =>
      testTts(text, voice, speed),
    onSuccess: (data) => {
      if (data.audioUrl) {
        const audio = new Audio(data.audioUrl);
        audio.play();
      }
    },
  });

  // Initialize live conversation from status
  useEffect(() => {
    if (status?.recentConversation && liveConversation.length === 0) {
      setLiveConversation(status.recentConversation);
    }
  }, [status?.recentConversation]);

  // ─── Socket Events ───

  const handleCommentaryText = useCallback((event: CommentaryTextEvent) => {
    setLiveConversation((prev) => [
      ...prev.slice(-49),
      {
        persona: event.persona,
        name: event.name,
        text: event.text,
        timestamp: Date.now(),
        generationMs: event.generationMs,
      },
    ]);
  }, []);

  useSocketEvent<CommentaryTextEvent>('commentary:text', handleCommentaryText);

  const handleChatMessage = useCallback((msg: { username: string; displayName: string; message: string; timestamp: number }) => {
    setChatMessages((prev) => [...prev.slice(-99), msg]);
  }, []);

  useSocketEvent('chat:message', handleChatMessage);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveConversation]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ─── Mutations ───

  const enableMut = useMutation({
    mutationFn: (enabled: boolean) => setEnabled(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commentary-status'] }),
  });

  const presetMut = useMutation({
    mutationFn: (presetId: string) => setActivePreset(presetId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commentary-status'] }),
  });

  const configMut = useMutation({
    mutationFn: (cfg: Record<string, number | string>) => updateConfig(cfg),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commentary-status'] }),
  });

  const triggerMut = useMutation({
    mutationFn: (prompt?: string) => manualTrigger(prompt),
  });

  const clearMut = useMutation({
    mutationFn: () => clearState(),
    onSuccess: () => {
      setLiveConversation([]);
      qc.invalidateQueries({ queryKey: ['commentary-status'] });
    },
  });

  const addFlavorMut = useMutation({
    mutationFn: (entry: FlavorEntry) => addFlavorEntry(entry),
    onSuccess: () => refetchFlavor(),
  });

  const deleteFlavorMut = useMutation({
    mutationFn: (id: string) => deleteFlavorEntry(id),
    onSuccess: () => refetchFlavor(),
  });

  const handleTrigger = () => {
    triggerMut.mutate(triggerPrompt || undefined);
    setTriggerPrompt('');
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
        <Loader2 className="animate-spin" size={18} />
        Loading commentary engine...
      </div>
    );
  }

  const enabled = status?.enabled ?? false;
  const isGenerating = status?.isGenerating ?? false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <SectionHeader
        title="Commentary"
        action={
          <div className="flex items-center gap-3">
            {isGenerating && <Badge variant="success" label="Generating" pulse />}
            {(status?.turnCount ?? 0) > 0 && (
              <Badge variant="neutral" label={`Turn ${status?.turnCount}`} />
            )}
            <button
              onClick={() => enableMut.mutate(!enabled)}
              className="flex items-center gap-2 px-4 py-2 rounded font-medium text-sm transition-colors cursor-pointer"
              style={{
                background: enabled ? 'var(--success)' : 'var(--bg-elevated)',
                color: enabled ? 'white' : 'var(--text-secondary)',
              }}
            >
              {enabled ? <Mic size={16} /> : <MicOff size={16} />}
              {enabled ? 'On Air' : 'Off Air'}
            </button>
          </div>
        }
      />

      {/* Booth Setup */}
      <Card title="Broadcast Booth">
        <div className="flex items-center gap-4">
          <select
            value={status?.activePreset?.id ?? ''}
            onChange={(e) => presetMut.mutate(e.target.value)}
            className="rounded px-3 py-2 text-sm flex-1 border outline-none"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          >
            {presets?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <span className="text-blue-400">{status?.activePreset?.playByPlay}</span>
            {' + '}
            <span className="text-amber-400">{status?.activePreset?.color}</span>
          </div>
        </div>
        {presets && (
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            {presets.find((p) => p.id === status?.activePreset?.id)?.description}
          </p>
        )}
      </Card>

      {/* Tabs */}
      <Tabs tabs={commentaryTabs} active={tab} onChange={setTab} />

      <div className="mt-4">
        {/* Config Tab */}
        {tab === 'config' && status?.config && (
          <Card title="Configuration">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <ConfigSlider label="Periodic Interval" value={status.config.periodicIntervalSec}
                  min={5} max={120} step={5} suffix="s"
                  onChange={(v) => configMut.mutate({ periodicIntervalSec: v })} />
                <ConfigSlider label="Cooldown" value={status.config.cooldownSec}
                  min={2} max={30} step={1} suffix="s"
                  onChange={(v) => configMut.mutate({ cooldownSec: v })} />
                <ConfigSlider label="Temperature" value={status.config.temperature}
                  min={0.1} max={1.5} step={0.1}
                  onChange={(v) => configMut.mutate({ temperature: v })} />
                <ConfigSlider label="Max Tokens" value={status.config.maxTokens}
                  min={50} max={500} step={25}
                  onChange={(v) => configMut.mutate({ maxTokens: v })} />
              </div>
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="text"
                  value={triggerPrompt}
                  onChange={(e) => setTriggerPrompt(e.target.value)}
                  placeholder="Manual trigger prompt (optional)"
                  className="flex-1 rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]"
                  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  onKeyDown={(e) => e.key === 'Enter' && handleTrigger()}
                />
                <button
                  onClick={handleTrigger}
                  disabled={!enabled || isGenerating}
                  className="px-3 py-2 rounded text-sm cursor-pointer disabled:opacity-30 transition-colors"
                  style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                >
                  <Send size={16} />
                </button>
              </div>
              <button
                onClick={() => clearMut.mutate()}
                className="flex items-center gap-1 text-xs cursor-pointer transition-colors"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 size={12} />
                Clear conversation + state
              </button>
            </div>
          </Card>
        )}

        {/* TTS Tab */}
        {tab === 'tts' && (
          <Card title="Text-to-Speech">
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <span>
                  Status:{' '}
                  <span style={{ color: ttsStatus?.healthy ? 'var(--success)' : 'var(--danger)' }}>
                    {ttsStatus?.healthy ? 'Healthy' : 'Unavailable'}
                  </span>
                </span>
                <span>Default voice: {ttsStatus?.defaultVoice ?? '—'}</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Play-by-Play Voice
                  </label>
                  <select
                    value={ttsStatus?.voices?.play_by_play ?? ''}
                    disabled
                    className="w-full rounded px-2 py-1.5 text-sm border disabled:opacity-60"
                    style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  >
                    {ttsVoices?.voices?.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    )) ?? (
                      <option value={ttsStatus?.voices?.play_by_play ?? ''}>
                        {ttsStatus?.voices?.play_by_play ?? 'Loading...'}
                      </option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Color Voice
                  </label>
                  <select
                    value={ttsStatus?.voices?.color ?? ''}
                    disabled
                    className="w-full rounded px-2 py-1.5 text-sm border disabled:opacity-60"
                    style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  >
                    {ttsVoices?.voices?.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    )) ?? (
                      <option value={ttsStatus?.voices?.color ?? ''}>
                        {ttsStatus?.voices?.color ?? 'Loading...'}
                      </option>
                    )}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>
                  Speed: {ttsStatus?.speed ?? 1.0}x
                </label>
                <input
                  type="range"
                  min={0.5} max={2.0} step={0.1}
                  value={ttsStatus?.speed ?? 1.0}
                  disabled
                  className="w-full accent-gold disabled:opacity-60"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => testTtsMut.mutate({
                    voice: ttsStatus?.voices?.play_by_play,
                    speed: ttsStatus?.speed,
                  })}
                  disabled={!ttsStatus?.healthy || testTtsMut.isPending}
                  className="flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer disabled:opacity-30 transition-colors"
                  style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                >
                  {testTtsMut.isPending ? <Loader2 className="animate-spin" size={14} /> : <Play size={14} />}
                  Test Play-by-Play
                </button>
                <button
                  onClick={() => testTtsMut.mutate({
                    voice: ttsStatus?.voices?.color,
                    speed: ttsStatus?.speed,
                  })}
                  disabled={!ttsStatus?.healthy || testTtsMut.isPending}
                  className="flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer disabled:opacity-30 transition-colors"
                  style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                >
                  {testTtsMut.isPending ? <Loader2 className="animate-spin" size={14} /> : <Play size={14} />}
                  Test Color
                </button>
              </div>
              {testTtsMut.isError && (
                <p className="text-xs" style={{ color: 'var(--danger)' }}>
                  TTS test failed: {(testTtsMut.error as Error).message}
                </p>
              )}
            </div>
          </Card>
        )}

        {/* Live Log Tab */}
        {tab === 'log' && (
          <div className="space-y-4">
            {/* Live Broadcast Log */}
            <Card title="Live Broadcast" action={
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{liveConversation.length} lines</span>
            }>
              <div className="overflow-y-auto space-y-2" style={{ height: 350 }}>
                {liveConversation.length === 0 ? (
                  <div className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                    {enabled ? 'Waiting for commentary...' : 'Enable commentary to start the broadcast.'}
                  </div>
                ) : (
                  liveConversation.map((line, i) => (
                    <div key={i} className="flex gap-2 text-sm">
                      <span className={`shrink-0 font-semibold ${
                        line.persona === 'play_by_play' ? 'text-blue-400' : 'text-amber-400'
                      }`}>
                        [{line.name}]
                      </span>
                      <span style={{ color: 'var(--text-primary)' }}>{line.text}</span>
                      {line.generationMs != null && (
                        <span className="shrink-0 text-[10px] self-center" style={{ color: 'var(--text-muted)' }}>
                          ({(line.generationMs / 1000).toFixed(1)}s)
                        </span>
                      )}
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </Card>

            {/* Twitch Chat */}
            <Card title="Twitch Chat" action={
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{chatMessages.length} messages</span>
            }>
              <div className="overflow-y-auto space-y-1" style={{ height: 200 }}>
                {chatMessages.length === 0 ? (
                  <div className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>
                    No chat messages yet. Enable chat in config to connect.
                  </div>
                ) : (
                  chatMessages.map((msg, i) => (
                    <div key={i} className="text-xs flex items-center gap-1 group">
                      <button
                        onClick={() => featureChatMessage(msg.displayName, msg.message)}
                        className="opacity-0 group-hover:opacity-100 shrink-0 transition-opacity cursor-pointer"
                        style={{ color: 'var(--accent)' }}
                        title="Feature in overlay"
                      >
                        <Star size={12} />
                      </button>
                      <span className="font-semibold text-purple-400">{msg.displayName}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>: {msg.message}</span>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>
            </Card>

            {/* Racer State */}
            {status?.racerSnapshots && Object.keys(status.racerSnapshots).length > 0 && (
              <Card title="Racer State">
                <div className="grid grid-cols-2 gap-3">
                  {Object.values(status.racerSnapshots).map((snap) => (
                    <div key={snap.racerId} className="rounded p-3 text-xs space-y-1"
                      style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                      <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{snap.displayName}</div>
                      <div>Screen: {snap.screenType ?? '?'} | Hearts: {snap.hearts ?? '?'}/{snap.heartsMax ?? '?'}</div>
                      <div>Triforce: {snap.triforceCount ?? 0}/8 | Sword: L{snap.swordLevel ?? 0}</div>
                      {snap.dungeonLevel ? <div>In Level {snap.dungeonLevel}</div> : null}
                      {snap.gannonNearby ? <div className="font-semibold" style={{ color: 'var(--danger)' }}>GANON NEARBY</div> : null}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* Flavor Tab */}
        {tab === 'flavor' && (
          <Card title="Community Flavor Bank" action={
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{flavorEntries?.length ?? 0} entries</span>
          }>
            <div className="space-y-2">
              {flavorEntries?.map((entry) => (
                <FlavorEntryRow
                  key={entry.id}
                  entry={entry}
                  onDelete={() => deleteFlavorMut.mutate(entry.id)}
                />
              ))}
              <NewFlavorForm onAdd={(e) => addFlavorMut.mutate(e)} />
            </div>
          </Card>
        )}

        {/* Personas Tab */}
        {tab === 'personas' && <PersonasTab />}

        {/* Voice Studio Tab */}
        {tab === 'voices' && <VoiceStudioTab />}
      </div>
    </div>
  );
}

// ─── Sub-components ───

function ConfigSlider({
  label, value, min, max, step, suffix, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}: {value}{suffix}
      </label>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-gold"
      />
    </div>
  );
}

function FlavorEntryRow({ entry, onDelete }: { entry: FlavorEntry; onDelete: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded p-2" style={{ background: 'var(--bg-elevated)' }}>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{entry.text}</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{entry.context}</div>
        <div className="flex gap-1 mt-1">
          {entry.tags.map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>
              {tag}
            </span>
          ))}
        </div>
      </div>
      <button onClick={onDelete} className="p-1 cursor-pointer transition-colors hover:text-[var(--danger)]"
        style={{ color: 'var(--text-muted)' }}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function NewFlavorForm({ onAdd }: { onAdd: (entry: FlavorEntry) => void }) {
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const [context, setContext] = useState('');

  const handleSubmit = () => {
    if (!text.trim()) return;
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
    onAdd({
      id: `${id}_${Date.now()}`,
      text: text.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      context: context.trim(),
    });
    setText('');
    setTags('');
    setContext('');
  };

  return (
    <div className="border border-dashed rounded p-3 space-y-2 mt-2" style={{ borderColor: 'var(--border)' }}>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Flavor text..."
        className="w-full rounded px-2 py-1.5 text-sm border outline-none focus:border-[var(--accent)]"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
      />
      <div className="flex gap-2">
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="Tags (comma-separated)"
          className="flex-1 rounded px-2 py-1.5 text-xs border outline-none focus:border-[var(--accent)]"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
        />
        <input
          type="text"
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Context"
          className="flex-1 rounded px-2 py-1.5 text-xs border outline-none focus:border-[var(--accent)]"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={!text.trim()}
        className="flex items-center gap-1 text-xs cursor-pointer disabled:opacity-30"
        style={{ color: 'var(--accent)' }}
      >
        <Plus size={12} />
        Add Entry
      </button>
    </div>
  );
}

// ─── Personas Tab ───

function PersonasTab() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);

  const { data: personas, isLoading } = useQuery({
    queryKey: ['personas'],
    queryFn: listPersonas,
  });

  const { data: voices } = useQuery({
    queryKey: ['voices'],
    queryFn: listVoices,
  });

  const createMut = useMutation({
    mutationFn: createPersona,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['personas'] }); setModalOpen(false); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updatePersona>[1] }) =>
      updatePersona(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['personas'] }); setEditing(null); setModalOpen(false); },
  });

  const deleteMut = useMutation({
    mutationFn: deletePersona,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      updatePersona(id, { is_active: active ? 1 : 0 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  });

  const openEdit = (p: Persona) => { setEditing(p); setModalOpen(true); };
  const openCreate = () => { setEditing(null); setModalOpen(true); };

  const columns = [
    {
      key: 'name', label: 'Name',
      render: (row: Persona) => (
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{row.name}</span>
      ),
    },
    {
      key: 'role', label: 'Role',
      render: (row: Persona) => (
        <Badge
          variant={row.role === 'play_by_play' ? 'info' : 'warning'}
          label={row.role === 'play_by_play' ? 'Play-by-Play' : 'Color'}
        />
      ),
    },
    {
      key: 'voice_id', label: 'Voice',
      render: (row: Persona) => {
        const v = voices?.find((v) => v.id === row.voice_id);
        return <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{v?.name ?? '—'}</span>;
      },
    },
    {
      key: 'is_active', label: 'Active',
      render: (row: Persona) => (
        <button
          onClick={(e) => { e.stopPropagation(); toggleActive.mutate({ id: row.id, active: !row.is_active }); }}
          className="text-xs px-2 py-0.5 rounded cursor-pointer transition-colors"
          style={{
            background: row.is_active ? 'var(--success)' : 'var(--bg-elevated)',
            color: row.is_active ? 'white' : 'var(--text-muted)',
          }}
        >
          {row.is_active ? 'On' : 'Off'}
        </button>
      ),
    },
    {
      key: 'actions', label: '',
      render: (row: Persona) => (
        <div className="flex items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); openEdit(row); }}
            className="p-1 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <Edit2 size={13} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); deleteMut.mutate(row.id); }}
            className="p-1 cursor-pointer" style={{ color: 'var(--danger)' }}>
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card
        title="Personas"
        action={
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={openCreate}>
            New Persona
          </Button>
        }
      >
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 justify-center" style={{ color: 'var(--text-secondary)' }}>
            <Loader2 className="animate-spin" size={16} /> Loading...
          </div>
        ) : (personas ?? []).length > 0 ? (
          <DataGrid columns={columns as any} data={(personas ?? []) as any} emptyMessage="No personas yet." />
        ) : (
          <EmptyState
            icon={<Users size={32} />}
            title="No personas configured"
            description="Create your first AI commentator persona to get started."
            action={<Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={openCreate}>New Persona</Button>}
          />
        )}
      </Card>

      <PersonaFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        persona={editing}
        voices={voices ?? []}
        onSubmit={(data) => {
          if (editing) {
            updateMut.mutate({ id: editing.id, data });
          } else {
            createMut.mutate(data as Parameters<typeof createPersona>[0]);
          }
        }}
        isSubmitting={createMut.isPending || updateMut.isPending}
      />
    </div>
  );
}

function PersonaFormModal({
  open, onClose, persona, voices, onSubmit, isSubmitting,
}: {
  open: boolean;
  onClose: () => void;
  persona: Persona | null;
  voices: VoiceProfile[];
  onSubmit: (data: Record<string, unknown>) => void;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState(persona?.name ?? '');
  const [role, setRole] = useState(persona?.role ?? 'play_by_play');
  const [systemPrompt, setSystemPrompt] = useState(persona?.system_prompt ?? '');
  const [personality, setPersonality] = useState(persona?.personality ?? '');
  const [voiceId, setVoiceId] = useState(persona?.voice_id ?? '');

  // Reset on persona change
  useState(() => {
    setName(persona?.name ?? '');
    setRole(persona?.role ?? 'play_by_play');
    setSystemPrompt(persona?.system_prompt ?? '');
    setPersonality(persona?.personality ?? '');
    setVoiceId(persona?.voice_id ?? '');
  });

  const inputStyle = { background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={persona ? 'Edit Persona' : 'New Persona'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => onSubmit({ name, role, system_prompt: systemPrompt || undefined, personality: personality || undefined, voice_id: voiceId || undefined })} loading={isSubmitting}>
            {persona ? 'Save' : 'Create'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hype Master"
            className="w-full rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]" style={inputStyle} />
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Role</label>
          <div className="flex gap-2">
            {(['play_by_play', 'color'] as const).map((r) => (
              <button key={r} onClick={() => setRole(r)}
                className="px-3 py-1.5 rounded text-xs cursor-pointer border transition-colors"
                style={{
                  borderColor: role === r ? 'var(--accent)' : 'var(--border)',
                  background: role === r ? 'var(--accent-subtle)' : 'transparent',
                  color: role === r ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                {r === 'play_by_play' ? 'Play-by-Play' : 'Color'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>System Prompt</label>
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Instructions for this persona's commentary style..."
            rows={3} className="w-full rounded px-3 py-2 text-sm border outline-none resize-y focus:border-[var(--accent)]" style={inputStyle} />
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Personality</label>
          <textarea value={personality} onChange={(e) => setPersonality(e.target.value)}
            placeholder="Character traits, speaking style, catchphrases..."
            rows={2} className="w-full rounded px-3 py-2 text-sm border outline-none resize-y focus:border-[var(--accent)]" style={inputStyle} />
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Voice</label>
          <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}
            className="w-full rounded px-3 py-2 text-sm border outline-none" style={inputStyle}>
            <option value="">None</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.is_builtin ? ' (Kokoro)' : ''}</option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

// ─── Voice Studio Tab ───

function VoiceStudioTab() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKokoroId, setNewKokoroId] = useState('');

  const { data: voices, isLoading } = useQuery({
    queryKey: ['voices'],
    queryFn: listVoices,
  });

  const createMut = useMutation({
    mutationFn: createVoice,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['voices'] }); setCreateOpen(false); setNewName(''); setNewKokoroId(''); },
  });

  const deleteMut = useMutation({
    mutationFn: deleteVoice,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voices'] }),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => testVoice(id),
  });

  const builtins = (voices ?? []).filter((v) => v.is_builtin);
  const custom = (voices ?? []).filter((v) => !v.is_builtin);

  const inputStyle = { background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

  return (
    <div className="space-y-4">
      {/* Built-in Voices */}
      <Card title="Built-in Voices (Kokoro)" action={
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{builtins.length} voices</span>
      }>
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 justify-center" style={{ color: 'var(--text-secondary)' }}>
            <Loader2 className="animate-spin" size={16} /> Loading...
          </div>
        ) : (
          <div className="space-y-1">
            {builtins.map((v) => (
              <VoiceRow key={v.id} voice={v} onTest={() => testMut.mutate(v.id)} testing={testMut.isPending} />
            ))}
          </div>
        )}
      </Card>

      {/* Custom Voices */}
      <Card
        title="Custom Voices"
        action={
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
            New Voice
          </Button>
        }
      >
        {custom.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
            No custom voices yet. Create one to get started.
          </div>
        ) : (
          <div className="space-y-1">
            {custom.map((v) => (
              <VoiceRow
                key={v.id}
                voice={v}
                onTest={() => testMut.mutate(v.id)}
                onDelete={() => deleteMut.mutate(v.id)}
                testing={testMut.isPending}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Create Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Custom Voice"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm"
              onClick={() => createMut.mutate({ name: newName, kokoro_voice_id: newKokoroId || undefined })}
              loading={createMut.isPending} disabled={!newName.trim()}>
              Create
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Voice Name</label>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Excited Narrator"
              className="w-full rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]" style={inputStyle} />
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Kokoro Voice ID (optional)</label>
            <input type="text" value={newKokoroId} onChange={(e) => setNewKokoroId(e.target.value)}
              placeholder="e.g. am_adam"
              className="w-full rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]" style={inputStyle} />
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Audio upload for custom voice training will be available in a future update.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function VoiceRow({
  voice, onTest, onDelete, testing,
}: {
  voice: VoiceProfile;
  onTest: () => void;
  onDelete?: () => void;
  testing: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded group" style={{ background: 'var(--bg-base)' }}>
      <AudioLines size={14} style={{ color: 'var(--text-muted)' }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{voice.name}</span>
          {voice.is_builtin && <Badge variant="info" label="Kokoro" />}
          {voice.kokoro_voice_id && (
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{voice.kokoro_voice_id}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={onTest} disabled={testing}
          className="p-1.5 rounded cursor-pointer transition-colors disabled:opacity-30"
          style={{ color: 'var(--accent)' }} title="Test voice">
          <Play size={13} />
        </button>
        {onDelete && (
          <button onClick={onDelete}
            className="p-1.5 rounded cursor-pointer transition-colors"
            style={{ color: 'var(--danger)' }} title="Delete">
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
