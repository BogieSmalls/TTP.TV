import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Edit3, Save, X, Crop,
  RefreshCw, UserPlus, Check, ExternalLink, Link2, Loader2,
} from 'lucide-react';
import {
  getProfiles, createProfile, updateProfile, deleteProfile,
  getPool, syncPool, importRacer, importFromUrl,
} from '../lib/api';
import type { RacerProfile, PoolEntry } from '../lib/api';
import { SectionHeader, Tabs, SearchInput, Card, Badge, Button, Modal, EmptyState } from '../ui';

// ─── Types ───

interface ProfileFormData {
  display_name: string;
  twitch_channel: string;
  racetime_id: string;
  racetime_name: string;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  stream_width: number;
  stream_height: number;
  preferred_color: string;
  notes: string;
}

const emptyForm: ProfileFormData = {
  display_name: '',
  twitch_channel: '',
  racetime_id: '',
  racetime_name: '',
  crop_x: 0, crop_y: 0, crop_w: 1920, crop_h: 1080,
  stream_width: 1920, stream_height: 1080,
  preferred_color: '#D4AF37',
  notes: '',
};

// ─── Helpers ───

function formatDuration(iso: string | null): string {
  if (!iso) return '—';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!match) return iso;
  const h = match[1] ? parseInt(match[1]) : 0;
  const m = match[2] ? parseInt(match[2]) : 0;
  const s = match[3] ? Math.floor(parseFloat(match[3])) : 0;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function twitchUrl(channel: string | null): string | null {
  if (!channel) return null;
  if (channel.startsWith('http')) return channel;
  const name = channel.replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').split('/')[0];
  return `https://www.twitch.tv/${name}`;
}

function twitchName(channel: string | null): string {
  if (!channel) return '—';
  try {
    const url = new URL(channel);
    return url.pathname.replace(/^\//, '').split('/')[0];
  } catch {
    return channel;
  }
}

// ─── Tabs ───

const racerTabs = [
  { id: 'roster', label: 'Roster' },
  { id: 'import', label: 'Import' },
];

// ─── Main Page ───

export default function Racers() {
  const { tab: urlTab } = useParams();
  const navigate = useNavigate();
  const [fallbackTab, setFallbackTab] = useState('roster');
  const activeTab = urlTab ?? fallbackTab;

  function handleTabChange(id: string) {
    setFallbackTab(id);
    navigate(`/racers/${id}`, { replace: true });
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="Racers" />
      <Tabs tabs={racerTabs} active={activeTab} onChange={handleTabChange} />
      <div className="mt-4">
        {activeTab === 'roster' && <RosterTab />}
        {activeTab === 'import' && <ImportTab />}
      </div>
    </div>
  );
}

// ─── Roster Tab (from ProfileManager) ───

function RosterTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormData>({ ...emptyForm });
  const [search, setSearch] = useState('');

  const { data: profiles } = useQuery<RacerProfile[]>({
    queryKey: ['profiles'],
    queryFn: getProfiles,
  });

  const create = useMutation({
    mutationFn: () => createProfile(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setShowForm(false);
      setForm({ ...emptyForm });
    },
  });

  const update = useMutation({
    mutationFn: () => updateProfile(editingId!, form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setEditingId(null);
      setForm({ ...emptyForm });
    },
  });

  const remove = useMutation({
    mutationFn: deleteProfile,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  });

  function startEdit(p: RacerProfile) {
    setEditingId(p.id);
    setShowForm(false);
    setForm({
      display_name: p.display_name,
      twitch_channel: p.twitch_channel,
      racetime_id: p.racetime_id ?? '',
      racetime_name: p.racetime_name ?? '',
      crop_x: p.crop_x, crop_y: p.crop_y,
      crop_w: p.crop_w, crop_h: p.crop_h,
      stream_width: p.stream_width, stream_height: p.stream_height,
      preferred_color: p.preferred_color,
      notes: p.notes ?? '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setShowForm(false);
    setForm({ ...emptyForm });
  }

  const setField = <K extends keyof ProfileFormData>(key: K, value: ProfileFormData[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const filtered = profiles?.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return p.display_name.toLowerCase().includes(q) || p.twitch_channel.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or channel..." />
        {!showForm && !editingId && (
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>
            New Profile
          </Button>
        )}
      </div>

      {/* Create / Edit Form */}
      <Modal
        open={showForm || !!editingId}
        onClose={cancelEdit}
        title={editingId ? 'Edit Profile' : 'New Profile'}
        footer={
          <>
            <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
            <Button
              variant="primary"
              icon={<Save size={14} />}
              loading={create.isPending || update.isPending}
              disabled={!form.display_name || !form.twitch_channel}
              onClick={() => editingId ? update.mutate() : create.mutate()}
            >
              {editingId ? 'Save Changes' : 'Create Profile'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Display Name" value={form.display_name}
              onChange={v => setField('display_name', v)} />
            <Field label="Twitch Channel" value={form.twitch_channel}
              onChange={v => setField('twitch_channel', v)} />
            <Field label="Racetime ID" value={form.racetime_id}
              onChange={v => setField('racetime_id', v)} />
            <Field label="Racetime Name" value={form.racetime_name}
              onChange={v => setField('racetime_name', v)} />
          </div>

          <div>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>NES Capture Crop (stream pixels)</p>
            <div className="grid grid-cols-4 gap-3">
              <NumField label="X" value={form.crop_x} onChange={v => setField('crop_x', v)} />
              <NumField label="Y" value={form.crop_y} onChange={v => setField('crop_y', v)} />
              <NumField label="Width" value={form.crop_w} onChange={v => setField('crop_w', v)} />
              <NumField label="Height" value={form.crop_h} onChange={v => setField('crop_h', v)} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <NumField label="Stream Width" value={form.stream_width} onChange={v => setField('stream_width', v)} />
            <NumField label="Stream Height" value={form.stream_height} onChange={v => setField('stream_height', v)} />
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Color</label>
              <input
                type="color"
                value={form.preferred_color}
                onChange={e => setField('preferred_color', e.target.value)}
                className="w-full h-[34px] rounded cursor-pointer border"
                style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setField('notes', e.target.value)}
              rows={2}
              className="w-full rounded px-3 py-2 text-sm border resize-none outline-none focus:border-[var(--accent)]"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>
      </Modal>

      {/* Profile List */}
      {filtered?.length === 0 && (
        <EmptyState
          icon={<UserPlus size={32} />}
          title="No racer profiles"
          description="Import racers from the Racer Pool tab, or create a profile manually."
          action={<Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>New Profile</Button>}
        />
      )}

      <div className="space-y-2">
        {filtered?.map(p => (
          <div
            key={p.id}
            className="rounded-lg p-4 border flex items-center gap-4"
            style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
          >
            <div className="w-3 h-8 rounded-full shrink-0" style={{ backgroundColor: p.preferred_color }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{p.display_name}</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>({p.twitch_channel})</span>
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Crop: {p.crop_x},{p.crop_y} {p.crop_w}x{p.crop_h}
                {p.racetime_name && ` · RT: ${p.racetime_name}`}
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => navigate(`/crops/${p.id}`)}
                className="p-2 transition-colors hover:text-[var(--accent)]"
                style={{ color: 'var(--text-muted)' }}
                title="Manage Crops"
              >
                <Crop size={14} />
              </button>
              <button
                onClick={() => startEdit(p)}
                className="p-2 transition-colors hover:text-[var(--accent)]"
                style={{ color: 'var(--text-muted)' }}
                title="Edit"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => { if (confirm(`Delete ${p.display_name}?`)) remove.mutate(p.id); }}
                className="p-2 transition-colors hover:text-[var(--danger)]"
                style={{ color: 'var(--text-muted)' }}
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Import Tab (from RacerPool) ───

function ImportTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importResult, setImportResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: pool, isLoading } = useQuery<PoolEntry[]>({
    queryKey: ['pool'],
    queryFn: getPool,
  });

  const sync = useMutation({
    mutationFn: syncPool,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pool'] }),
  });

  const doImport = useMutation({
    mutationFn: importRacer,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pool'] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
    },
  });

  const urlImportMut = useMutation({
    mutationFn: importFromUrl,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['pool'] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setImportUrl('');
      setImportResult({ type: 'success', message: `Imported ${data.displayName} successfully` });
    },
    onError: (err) => {
      setImportResult({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    },
  });

  const filtered = pool?.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.name.toLowerCase().includes(q) ||
      r.full_name.toLowerCase().includes(q) ||
      (r.twitch_name && r.twitch_name.toLowerCase().includes(q)) ||
      (r.twitch_channel && r.twitch_channel.toLowerCase().includes(q))
    );
  });

  const importedCount = pool?.filter(r => r.imported).length ?? 0;
  const lastSync = pool?.[0]?.last_synced_at;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{pool?.length ?? 0} racers</span>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span>{importedCount} imported</span>
          {lastSync && (
            <>
              <span style={{ color: 'var(--border)' }}>|</span>
              <span>Last synced: {new Date(lastSync).toLocaleString()}</span>
            </>
          )}
          {sync.data && (
            <>
              <span style={{ color: 'var(--border)' }}>|</span>
              <span style={{ color: 'var(--success)' }}>Synced {sync.data.synced} racers</span>
            </>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />}
          loading={sync.isPending}
          onClick={() => sync.mutate()}
        >
          Sync Leaderboard
        </Button>
      </div>

      {/* URL Import */}
      <Card title="Import by URL" action={<Link2 size={14} style={{ color: 'var(--accent)' }} />}>
        <div className="flex gap-2">
          <input
            type="text"
            value={importUrl}
            onChange={e => { setImportUrl(e.target.value); setImportResult(null); }}
            placeholder="https://racetime.gg/user/bpNAaBvr5mBJkg04/smilefires"
            className="flex-1 rounded px-3 py-1.5 text-sm border outline-none focus:border-[var(--accent)]"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          />
          <Button
            variant="primary"
            size="sm"
            icon={<UserPlus size={14} />}
            loading={urlImportMut.isPending}
            disabled={!importUrl}
            onClick={() => urlImportMut.mutate(importUrl)}
          >
            Import
          </Button>
        </div>
        {importResult && (
          <div className="mt-2 text-xs" style={{ color: importResult.type === 'success' ? 'var(--success)' : 'var(--danger)' }}>
            {importResult.message}
          </div>
        )}
      </Card>

      <SearchInput value={search} onChange={setSearch} placeholder="Search by name or Twitch channel..." />

      {/* Empty state */}
      {!isLoading && (!pool || pool.length === 0) && (
        <EmptyState
          icon={<RefreshCw size={32} />}
          title="Racer pool is empty"
          description="Sync the Z1R leaderboard from racetime.gg to populate the pool."
        />
      )}

      {/* Table */}
      {filtered && filtered.length > 0 && (
        <Card noPadding>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th className="text-left px-4 py-2.5 w-12 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>#</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Twitch</th>
                <th className="text-right px-4 py-2.5 w-24 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Best Time</th>
                <th className="text-right px-4 py-2.5 w-16 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Races</th>
                <th className="text-center px-4 py-2.5 w-28 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr
                  key={r.racetime_id}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    background: i % 2 === 1 ? 'var(--bg-elevated)' : 'transparent',
                  }}
                >
                  <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>{r.leaderboard_place}</td>
                  <td className="px-4 py-2.5" style={{ color: 'var(--text-primary)' }}>
                    <span className="font-medium">{r.name}</span>
                    <span className="text-xs ml-1" style={{ color: 'var(--text-muted)' }}>#{r.discriminator}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.twitch_channel ? (
                      <a
                        href={twitchUrl(r.twitch_channel)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-400 hover:text-purple-300 inline-flex items-center gap-1"
                      >
                        {twitchName(r.twitch_channel)}
                        <ExternalLink size={10} />
                      </a>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {formatDuration(r.best_time)}
                  </td>
                  <td className="px-4 py-2.5 text-right" style={{ color: 'var(--text-muted)' }}>
                    {r.times_raced ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {r.imported ? (
                      <Badge variant="success" label="Imported" />
                    ) : (
                      <button
                        onClick={() => doImport.mutate(r.racetime_id)}
                        disabled={doImport.isPending}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors disabled:opacity-30"
                        style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                      >
                        <UserPlus size={10} />
                        Import
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ─── Field Helpers ───

function Field({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
      />
    </div>
  );
}

function NumField({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(parseInt(e.target.value) || 0)}
        className="w-full rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
      />
    </div>
  );
}
