import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Save, Copy, Lock, Unlock, Eye, EyeOff,
  Move, Layers, GripVertical,
} from 'lucide-react';
import {
  listScenePresets, createScenePreset, updateScenePreset, deleteScenePreset,
} from '../lib/sceneApi';
import type { ScenePreset, SceneElement } from '../lib/sceneApi';
import { SectionHeader, Card, Button, Modal, SearchInput, EmptyState } from '../ui';

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const ELEMENT_TYPES = [
  { type: 'player_feed', label: 'Player Feed', defaultW: 640, defaultH: 480 },
  { type: 'hud_strip', label: 'Extended HUD Strip', defaultW: 1920, defaultH: 60 },
  { type: 'triforce_bar', label: 'Triforce Race Bar', defaultW: 1920, defaultH: 48 },
  { type: 'seed_tracker', label: 'Seed Tracker Footer', defaultW: 1920, defaultH: 80 },
  { type: 'shared_map', label: 'Shared Map', defaultW: 320, defaultH: 320 },
  { type: 'commentary_box', label: 'Commentary Box', defaultW: 400, defaultH: 200 },
  { type: 'timer', label: 'Timer', defaultW: 200, defaultH: 48 },
  { type: 'event_footer', label: 'Event Footer', defaultW: 1920, defaultH: 40 },
  { type: 'chat_highlight', label: 'Chat Highlight', defaultW: 400, defaultH: 120 },
  { type: 'replay_badge', label: 'Replay Badge', defaultW: 160, defaultH: 40 },
  { type: 'background', label: 'Background', defaultW: 1920, defaultH: 1080 },
  { type: 'custom_text', label: 'Custom Text', defaultW: 300, defaultH: 40 },
];

function parseElements(preset: ScenePreset): SceneElement[] {
  if (typeof preset.elements === 'string') {
    try { return JSON.parse(preset.elements); } catch { return []; }
  }
  return preset.elements ?? [];
}

export default function SceneBuilder() {
  const qc = useQueryClient();
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [elements, setElements] = useState<SceneElement[]>([]);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [search, setSearch] = useState('');

  const { data: presets } = useQuery<ScenePreset[]>({
    queryKey: ['scene-presets'],
    queryFn: listScenePresets,
  });

  const createMut = useMutation({
    mutationFn: createScenePreset,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['scene-presets'] });
      setSelectedPresetId(data.id);
      setElements([]);
      setDirty(false);
      setShowCreateModal(false);
      setNewPresetName('');
    },
  });

  const saveMut = useMutation({
    mutationFn: (args: { id: string; elements: SceneElement[] }) =>
      updateScenePreset(args.id, { elements: args.elements }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scene-presets'] });
      setDirty(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: deleteScenePreset,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scene-presets'] });
      setSelectedPresetId(null);
      setElements([]);
      setDirty(false);
    },
  });

  // Load elements when selecting a preset
  useEffect(() => {
    if (!selectedPresetId || !presets) return;
    const preset = presets.find(p => p.id === selectedPresetId);
    if (preset) {
      setElements(parseElements(preset));
      setSelectedElementId(null);
      setDirty(false);
    }
  }, [selectedPresetId, presets]);

  const updateElement = useCallback((id: string, updates: Partial<SceneElement>) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, ...updates } : el));
    setDirty(true);
  }, []);

  const addElement = useCallback((type: string) => {
    const def = ELEMENT_TYPES.find(t => t.type === type);
    if (!def) return;
    const el: SceneElement = {
      id: crypto.randomUUID(),
      type,
      x: Math.round((CANVAS_W - def.defaultW) / 2),
      y: Math.round((CANVAS_H - def.defaultH) / 2),
      width: def.defaultW,
      height: def.defaultH,
      zIndex: elements.length,
      locked: false,
      visible: true,
    };
    setElements(prev => [...prev, el]);
    setSelectedElementId(el.id);
    setDirty(true);
  }, [elements.length]);

  const removeElement = useCallback((id: string) => {
    setElements(prev => prev.filter(el => el.id !== id));
    if (selectedElementId === id) setSelectedElementId(null);
    setDirty(true);
  }, [selectedElementId]);

  const selectedPreset = presets?.find(p => p.id === selectedPresetId);
  const selectedElement = elements.find(el => el.id === selectedElementId);

  const filtered = presets?.filter(p => {
    if (!search) return true;
    return p.name.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Scene Builder"
        action={
          <div className="flex items-center gap-2">
            {dirty && selectedPresetId && (
              <Button
                variant="primary"
                size="sm"
                icon={<Save size={14} />}
                loading={saveMut.isPending}
                onClick={() => saveMut.mutate({ id: selectedPresetId, elements })}
              >
                Save
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={() => setShowCreateModal(true)}
            >
              New Preset
            </Button>
          </div>
        }
      />

      <div className="flex gap-4" style={{ height: 'calc(100vh - 180px)' }}>
        {/* Left: Preset library */}
        <div className="w-56 shrink-0 space-y-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search presets..." />
          <div className="space-y-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
            {filtered?.map(p => (
              <button
                key={p.id}
                onClick={() => setSelectedPresetId(p.id)}
                className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors cursor-pointer border-l-2"
                style={{
                  color: selectedPresetId === p.id ? 'var(--accent)' : 'var(--text-secondary)',
                  background: selectedPresetId === p.id ? 'var(--accent-subtle)' : undefined,
                  borderLeftColor: selectedPresetId === p.id ? 'var(--accent)' : 'transparent',
                }}
              >
                <div className="font-medium truncate">{p.name}</div>
                {p.description && (
                  <div className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{p.description}</div>
                )}
              </button>
            ))}
            {(!filtered || filtered.length === 0) && (
              <div className="px-3 py-4 text-center">
                <Layers size={24} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No presets yet. Create your first scene preset.</p>
              </div>
            )}
          </div>
        </div>

        {/* Center: Canvas */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selectedPreset ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{selectedPreset.name}</span>
                  {dirty && <span className="text-xs ml-2" style={{ color: 'var(--warning)' }}>unsaved</span>}
                </div>
                <div className="flex items-center gap-1">
                  <AddElementMenu onAdd={addElement} />
                  {!selectedPreset.is_builtin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={14} />}
                      onClick={() => { if (confirm(`Delete "${selectedPreset.name}"?`)) deleteMut.mutate(selectedPreset.id); }}
                    />
                  )}
                </div>
              </div>
              <Canvas
                elements={elements}
                selectedId={selectedElementId}
                onSelect={setSelectedElementId}
                onMove={(id, x, y) => updateElement(id, { x, y })}
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                icon={<Layers size={40} />}
                title="No preset selected"
                description="Select a preset from the sidebar or create a new one to start building your scene."
                action={<Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowCreateModal(true)}>New Preset</Button>}
              />
            </div>
          )}
        </div>

        {/* Right: Inspector + Element list */}
        {selectedPreset && (
          <div className="w-64 shrink-0 space-y-3 overflow-y-auto">
            {/* Element list */}
            <Card title="Elements" noPadding>
              <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {elements.length === 0 && (
                  <p className="text-xs px-3 py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                    No elements. Use + to add.
                  </p>
                )}
                {[...elements].sort((a, b) => b.zIndex - a.zIndex).map(el => {
                  const typeDef = ELEMENT_TYPES.find(t => t.type === el.type);
                  return (
                    <button
                      key={el.id}
                      onClick={() => setSelectedElementId(el.id)}
                      className="w-full text-left px-3 py-2 flex items-center gap-2 text-xs transition-colors cursor-pointer"
                      style={{
                        background: selectedElementId === el.id ? 'var(--accent-subtle)' : undefined,
                        color: selectedElementId === el.id ? 'var(--accent)' : 'var(--text-secondary)',
                        borderColor: 'var(--border)',
                      }}
                    >
                      <GripVertical size={12} style={{ color: 'var(--text-muted)' }} />
                      <span className="flex-1 truncate">{typeDef?.label ?? el.type}</span>
                      {!el.visible && <EyeOff size={12} style={{ color: 'var(--text-muted)' }} />}
                      {el.locked && <Lock size={12} style={{ color: 'var(--text-muted)' }} />}
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* Inspector */}
            {selectedElement && (
              <Card title="Properties">
                <Inspector
                  element={selectedElement}
                  onChange={(updates) => updateElement(selectedElement.id, updates)}
                  onDelete={() => removeElement(selectedElement.id)}
                />
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Modal open={showCreateModal} onClose={() => setShowCreateModal(false)} title="New Scene Preset">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-secondary)' }}>Name</label>
            <input
              type="text"
              value={newPresetName}
              onChange={e => setNewPresetName(e.target.value)}
              placeholder="e.g. 4-Player Race"
              className="w-full rounded px-3 py-2 text-sm focus:outline-none"
              style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowCreateModal(false)}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              loading={createMut.isPending}
              onClick={() => newPresetName.trim() && createMut.mutate({ name: newPresetName.trim() })}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── Canvas ───

function Canvas({
  elements,
  selectedId,
  onSelect,
  onMove,
}: {
  elements: SceneElement[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; elX: number; elY: number } | null>(null);

  const getScale = useCallback(() => {
    if (!containerRef.current) return 1;
    return containerRef.current.clientWidth / CANVAS_W;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent, el: SceneElement) => {
    if (el.locked) return;
    e.stopPropagation();
    onSelect(el.id);
    setDragging({ id: el.id, startX: e.clientX, startY: e.clientY, elX: el.x, elY: el.y });
  }, [onSelect]);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const scale = getScale();
      const dx = (e.clientX - dragging.startX) / scale;
      const dy = (e.clientY - dragging.startY) / scale;
      onMove(dragging.id, Math.round(dragging.elX + dx), Math.round(dragging.elY + dy));
    };
    const handleMouseUp = () => setDragging(null);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, getScale, onMove]);

  const typeColors: Record<string, string> = {
    player_feed: 'rgba(59,130,246,0.3)',
    hud_strip: 'rgba(168,85,247,0.3)',
    triforce_bar: 'rgba(212,175,55,0.3)',
    seed_tracker: 'rgba(34,197,94,0.3)',
    shared_map: 'rgba(236,72,153,0.3)',
    commentary_box: 'rgba(249,115,22,0.3)',
    timer: 'rgba(234,179,8,0.3)',
    background: 'rgba(100,100,100,0.15)',
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded border overflow-hidden"
      style={{
        aspectRatio: '16/9',
        maxHeight: 'calc(100vh - 280px)',
        background: 'var(--bg-base)',
        borderColor: 'var(--border)',
      }}
      onClick={() => onSelect(null)}
    >
      {elements.filter(el => el.visible).sort((a, b) => a.zIndex - b.zIndex).map(el => {
        const scale = getScale();
        const isSelected = el.id === selectedId;
        const typeDef = ELEMENT_TYPES.find(t => t.type === el.type);
        return (
          <div
            key={el.id}
            className="absolute flex items-center justify-center text-[10px] font-medium select-none"
            style={{
              left: el.x * scale,
              top: el.y * scale,
              width: el.width * scale,
              height: el.height * scale,
              background: typeColors[el.type] ?? 'rgba(150,150,150,0.2)',
              border: isSelected ? '2px solid var(--accent)' : '1px solid rgba(255,255,255,0.15)',
              cursor: el.locked ? 'default' : 'move',
              color: 'var(--text-secondary)',
              zIndex: el.zIndex,
            }}
            onMouseDown={(e) => handleMouseDown(e, el)}
          >
            <span className="pointer-events-none opacity-70">
              {typeDef?.label ?? el.type}
              <br />
              {el.width}x{el.height}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Add Element Menu ───

function AddElementMenu({ onAdd }: { onAdd: (type: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => setOpen(!open)}>
        Add
      </Button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 rounded-lg border shadow-lg py-1 z-50 w-52"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
        >
          {ELEMENT_TYPES.map(t => (
            <button
              key={t.type}
              onClick={() => { onAdd(t.type); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer"
              style={{ color: 'var(--text-secondary)' }}
              onMouseEnter={e => { (e.target as HTMLElement).style.background = 'var(--bg-elevated)'; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.background = ''; }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Property Inspector ───

function Inspector({
  element,
  onChange,
  onDelete,
}: {
  element: SceneElement;
  onChange: (updates: Partial<SceneElement>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <NumField label="X" value={element.x} onChange={v => onChange({ x: v })} />
        <NumField label="Y" value={element.y} onChange={v => onChange({ y: v })} />
        <NumField label="Width" value={element.width} onChange={v => onChange({ width: v })} />
        <NumField label="Height" value={element.height} onChange={v => onChange({ height: v })} />
        <NumField label="Z-Index" value={element.zIndex} onChange={v => onChange({ zIndex: v })} />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => onChange({ locked: !element.locked })}
          className="flex items-center gap-1 px-2 py-1 rounded transition-colors cursor-pointer"
          style={{
            color: element.locked ? 'var(--warning)' : 'var(--text-muted)',
            background: element.locked ? 'rgba(234,179,8,0.1)' : undefined,
          }}
        >
          {element.locked ? <Lock size={12} /> : <Unlock size={12} />}
          {element.locked ? 'Locked' : 'Unlocked'}
        </button>
        <button
          onClick={() => onChange({ visible: !element.visible })}
          className="flex items-center gap-1 px-2 py-1 rounded transition-colors cursor-pointer"
          style={{
            color: element.visible ? 'var(--text-muted)' : 'var(--danger)',
          }}
        >
          {element.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          {element.visible ? 'Visible' : 'Hidden'}
        </button>
      </div>

      <button
        onClick={onDelete}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors cursor-pointer w-full justify-center"
        style={{ color: 'var(--danger)' }}
      >
        <Trash2 size={12} />
        Delete Element
      </button>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="block mb-0.5" style={{ color: 'var(--text-muted)' }}>{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value) || 0)}
        className="w-full rounded px-2 py-1 text-xs focus:outline-none"
        style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
      />
    </div>
  );
}
