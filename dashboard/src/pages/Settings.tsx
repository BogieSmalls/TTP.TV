import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Info, Wrench, MonitorCog, Twitch, Brain, Timer, Radio, Palette,
  Save, RotateCcw, Loader2, AlertTriangle,
} from 'lucide-react';
import { getConfig, updateConfig, restartServer, type EditableConfig } from '../lib/configApi';
import { Card, Tabs, SectionHeader, FormField, Button } from '../ui';
import { ThemeToggle } from '../ui/ThemeToggle';

const inputClass = 'w-full rounded-md border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]';
const inputStyle: React.CSSProperties = { background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

const settingsTabs = [
  { id: 'general', label: 'General', icon: <Info size={16} /> },
  { id: 'tools', label: 'Tools', icon: <Wrench size={16} /> },
  { id: 'obs', label: 'OBS', icon: <MonitorCog size={16} /> },
  { id: 'twitch', label: 'Twitch', icon: <Twitch size={16} /> },
  { id: 'ai', label: 'AI', icon: <Brain size={16} /> },
  { id: 'racetime', label: 'Racetime', icon: <Timer size={16} /> },
  { id: 'broadcast', label: 'Broadcast', icon: <Radio size={16} /> },
  { id: 'display', label: 'Display', icon: <Palette size={16} /> },
];

function TextInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'>) {
  return <input className={inputClass} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

function NumberInput({ value, onChange, ...rest }: { value: number; onChange: (v: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return <input type="number" className={inputClass} style={inputStyle} value={value} onChange={(e) => onChange(Number(e.target.value))} {...rest} />;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer"
      style={{ background: checked ? 'var(--accent)' : 'var(--bg-elevated)', border: '1px solid var(--border)' }}
      onClick={() => onChange(!checked)}
    >
      <span
        className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
        style={{ transform: checked ? 'translateX(22px)' : 'translateX(4px)' }}
      />
    </button>
  );
}

function MaskedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>{value || '(not set)'}</span>
    </div>
  );
}

export default function Settings() {
  const [tab, setTab] = useState('general');
  const [draft, setDraft] = useState<EditableConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const queryClient = useQueryClient();

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  useEffect(() => {
    if (config && !draft) setDraft(structuredClone(config));
  }, [config, draft]);

  const saveMutation = useMutation({
    mutationFn: (updates: Record<string, unknown>) => updateConfig(updates),
    onSuccess: (result) => {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      if (result.restartRequired) setNeedsRestart(true);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try { await restartServer(); } catch { /* server dies mid-response */ }
    // Poll for reconnection
    const poll = setInterval(async () => {
      try {
        await fetch('/api/config');
        clearInterval(poll);
        setRestarting(false);
        setNeedsRestart(false);
        queryClient.invalidateQueries({ queryKey: ['config'] });
      } catch { /* still down */ }
    }, 2000);
  }, [queryClient]);

  function update<S extends keyof EditableConfig>(section: S, field: keyof EditableConfig[S], value: unknown) {
    if (!draft) return;
    setDraft({ ...draft, [section]: { ...draft[section], [field]: value } });
  }

  function updateNested<S extends keyof EditableConfig>(section: S, path: string, value: unknown) {
    if (!draft) return;
    const parts = path.split('.');
    const sectionData = { ...(draft[section] as Record<string, unknown>) };
    if (parts.length === 2) {
      const [sub, key] = parts;
      sectionData[sub] = { ...(sectionData[sub] as Record<string, unknown>), [key]: value };
    }
    setDraft({ ...draft, [section]: sectionData as EditableConfig[S] });
  }

  function saveSection(section: keyof EditableConfig) {
    if (!draft) return;
    saveMutation.mutate({ [section]: draft[section] });
  }

  if (isLoading) return <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading configuration...</div>;
  if (error) return <div className="p-8 text-center" style={{ color: 'var(--danger)' }}>Failed to load configuration: {String(error)}</div>;
  if (!draft) return null;

  return (
    <div className="space-y-6">
      <SectionHeader title="Settings" />

      {/* Restart banner */}
      {needsRestart && !restarting && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border" style={{ background: 'rgba(251,191,36,0.08)', borderColor: 'var(--warning)' }}>
          <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
          <span className="text-sm flex-1" style={{ color: 'var(--warning)' }}>Some changes require a server restart to take effect.</span>
          <Button variant="primary" size="sm" onClick={handleRestart}>Restart Now</Button>
        </div>
      )}

      {/* Restarting overlay */}
      {restarting && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border" style={{ background: 'var(--accent-subtle)', borderColor: 'var(--accent)' }}>
          <Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent)' }} />
          <span className="text-sm" style={{ color: 'var(--accent)' }}>Server is restarting... reconnecting automatically.</span>
        </div>
      )}

      {/* Success toast */}
      {saved && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg" style={{ background: 'rgba(52,211,153,0.1)', color: 'var(--success)' }}>
          <Save size={16} /> <span className="text-sm font-medium">Settings saved successfully.</span>
        </div>
      )}

      <Tabs tabs={settingsTabs} active={tab} onChange={setTab} />

      <div className="mt-6">
        {/* General */}
        {tab === 'general' && (
          <Card title="General">
            <div className="space-y-5">
              <FormField label="Server Port" description="Express HTTP server port">
                <NumberInput value={draft.server.port} onChange={(v) => update('server', 'port', v)} />
              </FormField>
              <FormField label="Canvas Width" description="OBS canvas width in pixels">
                <NumberInput value={draft.canvas.width} onChange={(v) => update('canvas', 'width', v)} />
              </FormField>
              <FormField label="Canvas Height" description="OBS canvas height in pixels">
                <NumberInput value={draft.canvas.height} onChange={(v) => update('canvas', 'height', v)} />
              </FormField>
              <div className="flex gap-2 pt-2">
                <Button variant="primary" icon={<Save size={14} />} onClick={() => { saveSection('server'); saveSection('canvas'); }} loading={saveMutation.isPending}>Save</Button>
              </div>
            </div>
          </Card>
        )}

        {/* Tools */}
        {tab === 'tools' && (
          <Card title="Tool Paths">
            <div className="space-y-5">
              <FormField label="FFmpeg Path" description="Absolute path to ffmpeg executable">
                <TextInput value={draft.tools.ffmpegPath} onChange={(v) => update('tools', 'ffmpegPath', v)} />
              </FormField>
              <FormField label="Streamlink Path" description="Absolute path to streamlink executable">
                <TextInput value={draft.tools.streamlinkPath} onChange={(v) => update('tools', 'streamlinkPath', v)} />
              </FormField>
              <div className="flex gap-2 pt-2">
                <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('tools')} loading={saveMutation.isPending}>Save</Button>
              </div>
            </div>
          </Card>
        )}

        {/* OBS */}
        {tab === 'obs' && (
          <Card title="OBS Connection">
            <div className="space-y-5">
              <FormField label="WebSocket URL" description="OBS WebSocket server URL">
                <TextInput value={draft.obs.url} onChange={(v) => update('obs', 'url', v)} />
              </FormField>
              <FormField label="Executable Path" description="Path to OBS executable (for auto-launch)">
                <TextInput value={draft.obs.execPath} onChange={(v) => update('obs', 'execPath', v)} />
              </FormField>
              <div className="flex gap-2 pt-2">
                <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('obs')} loading={saveMutation.isPending}>Save</Button>
              </div>
            </div>
            <div className="mt-6 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
              <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>Secrets (edit in .env)</p>
              <MaskedField label="OBS Password" value="●●●●●●●●" />
            </div>
          </Card>
        )}

        {/* Twitch */}
        {tab === 'twitch' && (
          <Card title="Twitch">
            <div className="space-y-5">
              <FormField label="Channel" description="Twitch channel name">
                <TextInput value={draft.twitch.channel} onChange={(v) => update('twitch', 'channel', v)} />
              </FormField>
              <FormField label="Chat Enabled">
                <Toggle checked={draft.twitch.chatEnabled} onChange={(v) => update('twitch', 'chatEnabled', v)} />
              </FormField>
              <FormField label="Chat Buffer Size" description="Number of chat messages to keep in memory">
                <NumberInput value={draft.twitch.chatBufferSize} onChange={(v) => update('twitch', 'chatBufferSize', v)} />
              </FormField>
              <div className="flex gap-2 pt-2">
                <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('twitch')} loading={saveMutation.isPending}>Save</Button>
              </div>
            </div>
            <div className="mt-6 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
              <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>Secrets (edit in .env)</p>
              <MaskedField label="Stream Key" value={draft.twitch.streamKey} />
              <MaskedField label="OAuth Token" value="●●●●●●●●" />
              <MaskedField label="Client ID" value="●●●●●●●●" />
              <MaskedField label="Client Secret" value="●●●●●●●●" />
            </div>
          </Card>
        )}

        {/* AI */}
        {tab === 'ai' && (
          <div className="space-y-6">
            <Card title="Knowledge Base">
              <div className="space-y-5">
                <FormField label="Ollama URL" description="Ollama API endpoint">
                  <TextInput value={draft.knowledgeBase.ollamaUrl} onChange={(v) => update('knowledgeBase', 'ollamaUrl', v)} />
                </FormField>
                <FormField label="ChromaDB URL" description="ChromaDB server URL">
                  <TextInput value={draft.knowledgeBase.chromaUrl} onChange={(v) => update('knowledgeBase', 'chromaUrl', v)} />
                </FormField>
                <FormField label="ChromaDB Collection">
                  <TextInput value={draft.knowledgeBase.chromaCollection} onChange={(v) => update('knowledgeBase', 'chromaCollection', v)} />
                </FormField>
                <FormField label="Embedding Model">
                  <TextInput value={draft.knowledgeBase.embeddingModel} onChange={(v) => update('knowledgeBase', 'embeddingModel', v)} />
                </FormField>
                <div className="flex gap-2 pt-2">
                  <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('knowledgeBase')} loading={saveMutation.isPending}>Save</Button>
                </div>
              </div>
            </Card>

            <Card title="Commentary Engine">
              <div className="space-y-5">
                <FormField label="LLM Model" description="Ollama model for commentary generation">
                  <TextInput value={draft.commentary.model} onChange={(v) => update('commentary', 'model', v)} />
                </FormField>
                <FormField label="Ollama URL" description="Can differ from knowledge base Ollama">
                  <TextInput value={draft.commentary.ollamaUrl} onChange={(v) => update('commentary', 'ollamaUrl', v)} />
                </FormField>
                <div className="grid grid-cols-2 gap-4">
                  <FormField label="Periodic Interval (sec)">
                    <NumberInput value={draft.commentary.periodicIntervalSec} onChange={(v) => update('commentary', 'periodicIntervalSec', v)} />
                  </FormField>
                  <FormField label="Cooldown (sec)">
                    <NumberInput value={draft.commentary.cooldownSec} onChange={(v) => update('commentary', 'cooldownSec', v)} />
                  </FormField>
                  <FormField label="Max Tokens">
                    <NumberInput value={draft.commentary.maxTokens} onChange={(v) => update('commentary', 'maxTokens', v)} />
                  </FormField>
                  <FormField label="Temperature">
                    <NumberInput value={draft.commentary.temperature} onChange={(v) => update('commentary', 'temperature', v)} step={0.1} min={0} max={2} />
                  </FormField>
                  <FormField label="History Size">
                    <NumberInput value={draft.commentary.historySize} onChange={(v) => update('commentary', 'historySize', v)} />
                  </FormField>
                  <FormField label="KB Chunks per Query">
                    <NumberInput value={draft.commentary.kbChunksPerQuery} onChange={(v) => update('commentary', 'kbChunksPerQuery', v)} />
                  </FormField>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('commentary')} loading={saveMutation.isPending}>Save</Button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Racetime */}
        {tab === 'racetime' && (
          <Card title="Racetime.gg">
            <div className="space-y-5">
              <FormField label="Category" description="Racetime.gg game category slug">
                <TextInput value={draft.racetime.category} onChange={(v) => update('racetime', 'category', v)} />
              </FormField>
              <FormField label="Poll Interval (ms)" description="How often to poll for new races">
                <NumberInput value={draft.racetime.pollIntervalMs} onChange={(v) => update('racetime', 'pollIntervalMs', v)} />
              </FormField>
              <FormField label="Goal Filter" description="Only show races matching this goal string">
                <TextInput value={draft.racetime.goalFilter} onChange={(v) => update('racetime', 'goalFilter', v)} />
              </FormField>
              <div className="flex gap-2 pt-2">
                <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('racetime')} loading={saveMutation.isPending}>Save</Button>
              </div>
            </div>
            <div className="mt-6 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
              <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>Secrets (edit in .env)</p>
              <MaskedField label="Client ID" value="●●●●●●●●" />
              <MaskedField label="Client Secret" value="●●●●●●●●" />
            </div>
          </Card>
        )}

        {/* Broadcast */}
        {tab === 'broadcast' && (
          <div className="space-y-6">
            <Card title="Vision">
              <div className="space-y-5">
                <FormField label="FPS" description="Frames per second for vision processing">
                  <NumberInput value={draft.vision.fps} onChange={(v) => update('vision', 'fps', v)} min={1} max={30} />
                </FormField>
                <div className="grid grid-cols-3 gap-4">
                  <FormField label="Digit Confidence">
                    <NumberInput value={draft.vision.confidence.digit} onChange={(v) => updateNested('vision', 'confidence.digit', v)} step={0.05} min={0} max={1} />
                  </FormField>
                  <FormField label="Item Confidence">
                    <NumberInput value={draft.vision.confidence.item} onChange={(v) => updateNested('vision', 'confidence.item', v)} step={0.05} min={0} max={1} />
                  </FormField>
                  <FormField label="Heart Confidence">
                    <NumberInput value={draft.vision.confidence.heart} onChange={(v) => updateNested('vision', 'confidence.heart', v)} step={0.05} min={0} max={1} />
                  </FormField>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('vision')} loading={saveMutation.isPending}>Save</Button>
                </div>
              </div>
            </Card>

            <Card title="Text-to-Speech">
              <div className="space-y-5">
                <FormField label="Enabled">
                  <Toggle checked={draft.tts.enabled} onChange={(v) => update('tts', 'enabled', v)} />
                </FormField>
                <FormField label="Service URL" description="Kokoro TTS service endpoint">
                  <TextInput value={draft.tts.serviceUrl} onChange={(v) => update('tts', 'serviceUrl', v)} />
                </FormField>
                <FormField label="Default Voice" description="Voice ID for general narration">
                  <TextInput value={draft.tts.defaultVoice} onChange={(v) => update('tts', 'defaultVoice', v)} />
                </FormField>
                <FormField label="Speed" description="Playback speed multiplier">
                  <NumberInput value={draft.tts.speed} onChange={(v) => update('tts', 'speed', v)} step={0.1} min={0.5} max={2} />
                </FormField>
                <div className="grid grid-cols-2 gap-4">
                  <FormField label="Play-by-Play Voice">
                    <TextInput value={draft.tts.voices.play_by_play} onChange={(v) => updateNested('tts', 'voices.play_by_play', v)} />
                  </FormField>
                  <FormField label="Color Voice">
                    <TextInput value={draft.tts.voices.color} onChange={(v) => updateNested('tts', 'voices.color', v)} />
                  </FormField>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('tts')} loading={saveMutation.isPending}>Save</Button>
                </div>
              </div>
            </Card>

            <Card title="RTMP">
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <FormField label="RTMP Port">
                    <NumberInput value={draft.rtmp.port} onChange={(v) => update('rtmp', 'port', v)} />
                  </FormField>
                  <FormField label="HTTP Port">
                    <NumberInput value={draft.rtmp.httpPort} onChange={(v) => update('rtmp', 'httpPort', v)} />
                  </FormField>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button variant="primary" icon={<Save size={14} />} onClick={() => saveSection('rtmp')} loading={saveMutation.isPending}>Save</Button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Display */}
        {tab === 'display' && (
          <Card title="Appearance">
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
                  Theme
                </p>
                <ThemeToggle />
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  Choose light, dark, or match your system preference.
                </p>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
