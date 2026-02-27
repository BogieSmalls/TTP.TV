import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar, Plus, Play, Trash2, Edit2, Loader2,
  Clock, Radio, Film, RotateCcw, X,
} from 'lucide-react';
import {
  listScheduleBlocks, createScheduleBlock, updateScheduleBlock,
  deleteScheduleBlock, goLiveScheduleBlock,
} from '../lib/scheduleApi';
import type { ScheduleBlock } from '../lib/scheduleApi';
import { listScenePresets } from '../lib/sceneApi';
import type { ScenePreset } from '../lib/sceneApi';
import { SectionHeader, Card, Badge, Modal, Button, EmptyState } from '../ui';

const BLOCK_TYPES = [
  { value: 'live', label: 'Live Race', icon: Radio },
  { value: 'vod', label: 'VOD Race', icon: Film },
  { value: 'replay', label: 'Replay', icon: RotateCcw },
];

const STATUS_BADGE: Record<string, { variant: 'success' | 'danger' | 'warning' | 'neutral'; label: string }> = {
  queued: { variant: 'neutral', label: 'Queued' },
  live: { variant: 'success', label: 'LIVE' },
  completed: { variant: 'warning', label: 'Completed' },
  cancelled: { variant: 'danger', label: 'Cancelled' },
};

function toLocalDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Schedule() {
  const qc = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(() => toLocalDateStr(new Date()));
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState<ScheduleBlock | null>(null);

  // Queries
  const { data: blocks, isLoading } = useQuery({
    queryKey: ['schedule', selectedDate],
    queryFn: () => {
      const from = `${selectedDate}T00:00:00`;
      const to = `${selectedDate}T23:59:59`;
      return listScheduleBlocks(from, to);
    },
  });

  const { data: presets } = useQuery({
    queryKey: ['scene-presets'],
    queryFn: listScenePresets,
  });

  // Mutations
  const createMut = useMutation({
    mutationFn: createScheduleBlock,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedule'] }); setModalOpen(false); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateScheduleBlock>[1] }) =>
      updateScheduleBlock(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedule'] }); setEditingBlock(null); },
  });

  const deleteMut = useMutation({
    mutationFn: deleteScheduleBlock,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule'] }),
  });

  const goLiveMut = useMutation({
    mutationFn: goLiveScheduleBlock,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule'] }),
  });

  // Time slots for day view
  const timeSlots = useMemo(() => {
    const slots: string[] = [];
    for (let h = 0; h < 24; h++) {
      slots.push(`${String(h).padStart(2, '0')}:00`);
    }
    return slots;
  }, []);

  const sortedBlocks = useMemo(() =>
    [...(blocks ?? [])].sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()),
    [blocks],
  );

  const openEdit = (block: ScheduleBlock) => {
    setEditingBlock(block);
    setModalOpen(true);
  };

  const openCreate = () => {
    setEditingBlock(null);
    setModalOpen(true);
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Schedule"
        action={
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={openCreate}>
            New Block
          </Button>
        }
      />

      {/* Date Picker */}
      <div className="flex items-center gap-3">
        <Calendar size={16} style={{ color: 'var(--text-secondary)' }} />
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="rounded px-3 py-1.5 text-sm border outline-none"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
        />
        <button
          onClick={() => setSelectedDate(toLocalDateStr(new Date()))}
          className="text-xs cursor-pointer"
          style={{ color: 'var(--accent)' }}
        >
          Today
        </button>
      </div>

      {/* Day View */}
      <div className="flex gap-6">
        {/* Timeline */}
        <Card noPadding className="flex-1">
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {isLoading ? (
              <div className="flex items-center justify-center py-12 gap-2" style={{ color: 'var(--text-secondary)' }}>
                <Loader2 className="animate-spin" size={18} />
                Loading schedule...
              </div>
            ) : sortedBlocks.length === 0 ? (
              <EmptyState
                icon={<Clock size={32} />}
                title="No content scheduled"
                description="Create your first broadcast block to get started."
                action={
                  <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={openCreate}>
                    New Block
                  </Button>
                }
              />
            ) : (
              sortedBlocks.map((block) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  presets={presets}
                  onEdit={() => openEdit(block)}
                  onDelete={() => deleteMut.mutate(block.id)}
                  onGoLive={() => goLiveMut.mutate(block.id)}
                />
              ))
            )}
          </div>
        </Card>

        {/* Hour markers sidebar */}
        <div className="hidden xl:block w-16 shrink-0">
          <div className="space-y-6 text-[10px] pt-2" style={{ color: 'var(--text-muted)' }}>
            {timeSlots.filter((_, i) => i % 3 === 0).map((slot) => (
              <div key={slot}>{slot}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Create / Edit Modal */}
      <BlockFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditingBlock(null); }}
        block={editingBlock}
        presets={presets ?? []}
        selectedDate={selectedDate}
        onSubmit={(data) => {
          if (editingBlock) {
            updateMut.mutate({ id: editingBlock.id, data });
          } else {
            createMut.mutate(data as Parameters<typeof createScheduleBlock>[0]);
          }
        }}
        isSubmitting={createMut.isPending || updateMut.isPending}
      />
    </div>
  );
}

// ─── Block Row ───

function BlockRow({
  block, presets, onEdit, onDelete, onGoLive,
}: {
  block: ScheduleBlock;
  presets?: ScenePreset[];
  onEdit: () => void;
  onDelete: () => void;
  onGoLive: () => void;
}) {
  const typeInfo = BLOCK_TYPES.find((t) => t.value === block.type) ?? BLOCK_TYPES[0];
  const Icon = typeInfo.icon;
  const badge = STATUS_BADGE[block.status] ?? STATUS_BADGE.queued;
  const presetName = presets?.find((p) => p.id === block.scene_preset_id)?.name;

  return (
    <div className="flex items-center gap-4 px-4 py-3 group">
      <div className="flex items-center gap-2 w-20 shrink-0">
        <Icon size={14} style={{ color: 'var(--text-muted)' }} />
        <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
          {formatTime(block.scheduled_at)}
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {block.title ?? typeInfo.label}
          </span>
          <Badge variant={badge.variant} label={badge.label} pulse={block.status === 'live'} />
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {block.duration_minutes && `${block.duration_minutes}m`}
          {presetName && ` · ${presetName}`}
          {block.source_url && ` · ${block.source_url.slice(0, 40)}...`}
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {block.status === 'queued' && (
          <button onClick={onGoLive} className="p-1.5 rounded cursor-pointer transition-colors"
            style={{ color: 'var(--success)' }} title="Go Live">
            <Play size={14} />
          </button>
        )}
        <button onClick={onEdit} className="p-1.5 rounded cursor-pointer transition-colors"
          style={{ color: 'var(--text-secondary)' }} title="Edit">
          <Edit2 size={14} />
        </button>
        <button onClick={onDelete} className="p-1.5 rounded cursor-pointer transition-colors"
          style={{ color: 'var(--danger)' }} title="Delete">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ─── Block Form Modal ───

function BlockFormModal({
  open, onClose, block, presets, selectedDate, onSubmit, isSubmitting,
}: {
  open: boolean;
  onClose: () => void;
  block: ScheduleBlock | null;
  presets: ScenePreset[];
  selectedDate: string;
  onSubmit: (data: Record<string, unknown>) => void;
  isSubmitting: boolean;
}) {
  const [type, setType] = useState(block?.type ?? 'live');
  const [title, setTitle] = useState(block?.title ?? '');
  const [sourceUrl, setSourceUrl] = useState(block?.source_url ?? '');
  const [presetId, setPresetId] = useState(block?.scene_preset_id ?? '');
  const [commentary, setCommentary] = useState(block?.commentary_enabled === 1);
  const [autoBroadcast, setAutoBroadcast] = useState(block?.auto_broadcast === 1);
  const [time, setTime] = useState(() => {
    if (block) {
      const d = new Date(block.scheduled_at);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return '12:00';
  });
  const [duration, setDuration] = useState(block?.duration_minutes ?? 60);

  // Reset when block changes
  const blockId = block?.id ?? '';
  useState(() => {
    setType(block?.type ?? 'live');
    setTitle(block?.title ?? '');
    setSourceUrl(block?.source_url ?? '');
    setPresetId(block?.scene_preset_id ?? '');
    setCommentary(block?.commentary_enabled === 1);
    setAutoBroadcast(block?.auto_broadcast === 1);
    setDuration(block?.duration_minutes ?? 60);
  });

  const handleSubmit = () => {
    const scheduled_at = `${selectedDate}T${time}:00`;
    onSubmit({
      type,
      title: title || undefined,
      source_url: sourceUrl || undefined,
      scene_preset_id: presetId || undefined,
      commentary_enabled: commentary ? 1 : 0,
      auto_broadcast: autoBroadcast ? 1 : 0,
      scheduled_at,
      duration_minutes: duration,
    });
  };

  const inputStyle = { background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={block ? 'Edit Block' : 'New Schedule Block'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={isSubmitting}>
            {block ? 'Save' : 'Create'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Type */}
        <div>
          <label className="text-xs block mb-1.5" style={{ color: 'var(--text-muted)' }}>Type</label>
          <div className="flex gap-2">
            {BLOCK_TYPES.map((bt) => {
              const Icon = bt.icon;
              return (
                <button
                  key={bt.value}
                  onClick={() => setType(bt.value)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs cursor-pointer transition-colors border"
                  style={{
                    borderColor: type === bt.value ? 'var(--accent)' : 'var(--border)',
                    background: type === bt.value ? 'var(--accent-subtle)' : 'transparent',
                    color: type === bt.value ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  <Icon size={12} />
                  {bt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Title</label>
          <input
            type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Weekly Z1R Race"
            className="w-full rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]"
            style={inputStyle}
          />
        </div>

        {/* Source URL */}
        {type !== 'live' && (
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Source URL</label>
            <input
              type="text" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="Twitch VOD or YouTube URL"
              className="w-full rounded px-3 py-2 text-sm border outline-none focus:border-[var(--accent)]"
              style={inputStyle}
            />
          </div>
        )}

        {/* Time + Duration */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Time</label>
            <input
              type="time" value={time} onChange={(e) => setTime(e.target.value)}
              className="w-full rounded px-3 py-2 text-sm border outline-none"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Duration (min)</label>
            <input
              type="number" value={duration} onChange={(e) => setDuration(parseInt(e.target.value) || 60)}
              min={5} max={600} step={5}
              className="w-full rounded px-3 py-2 text-sm border outline-none"
              style={inputStyle}
            />
          </div>
        </div>

        {/* Scene Preset */}
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Scene Preset</label>
          <select
            value={presetId} onChange={(e) => setPresetId(e.target.value)}
            className="w-full rounded px-3 py-2 text-sm border outline-none"
            style={inputStyle}
          >
            <option value="">None</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Toggles */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={commentary} onChange={(e) => setCommentary(e.target.checked)} />
            Commentary
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={autoBroadcast} onChange={(e) => setAutoBroadcast(e.target.checked)} />
            Auto-broadcast
          </label>
        </div>
      </div>
    </Modal>
  );
}
