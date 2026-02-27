import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommentaryEngine } from './CommentaryEngine.js';
import { getAllPresets, saveCustomPreset, deleteCustomPreset, type CommentaryPreset } from './personas.js';
import type { FlavorEntry } from './PromptBuilder.js';

const DATA_DIR = resolve(import.meta.dirname, '../../../data/commentary');
const FLAVOR_PATH = resolve(DATA_DIR, 'community-flavor.json');

interface CommentaryRouteContext {
  commentaryEngine: CommentaryEngine;
}

export function createCommentaryRoutes(ctx: CommentaryRouteContext): Router {
  const router = Router();
  const engine = ctx.commentaryEngine;

  // ─── Status ───

  router.get('/status', (_req, res) => {
    res.json({
      enabled: engine.isEnabled(),
      isGenerating: engine.getIsGenerating(),
      config: engine.getConfig(),
      activePreset: {
        id: engine.getActivePreset().id,
        name: engine.getActivePreset().name,
        playByPlay: engine.getActivePreset().playByPlay.name,
        color: engine.getActivePreset().color.name,
      },
      conversationLength: engine.getConversation().length,
      recentConversation: engine.getConversation().slice(-10),
      racerSnapshots: engine.getSnapshots(),
      turnCount: engine.getTurnCount(),
    });
  });

  // ─── Enable / Disable ───

  router.post('/enable', (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    if (enabled) {
      engine.enable();
    } else {
      engine.disable();
    }
    res.json({ enabled: engine.isEnabled() });
  });

  // ─── Config ───

  router.post('/config', (req, res) => {
    engine.updateConfig(req.body);
    res.json({ config: engine.getConfig() });
  });

  // ─── Manual Trigger ───

  router.post('/trigger', async (req, res) => {
    const { prompt } = req.body as { prompt?: string };
    if (!engine.isEnabled()) {
      res.status(400).json({ error: 'Commentary is not enabled' });
      return;
    }
    engine.manualTrigger(prompt);
    res.json({ status: 'triggered' });
  });

  // ─── Race Context ───

  router.post('/race-context', (req, res) => {
    engine.setRaceContext(req.body);
    res.json({ raceContext: engine.getRaceContext() });
  });

  // ─── Clear State ───

  router.post('/clear', (_req, res) => {
    engine.clearState();
    res.json({ status: 'cleared' });
  });

  // ─── Presets ───

  router.get('/presets', (_req, res) => {
    const presets = getAllPresets();
    res.json(presets.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      playByPlay: { id: p.playByPlay.id, name: p.playByPlay.name },
      color: { id: p.color.id, name: p.color.name },
    })));
  });

  router.post('/presets/active', (req, res) => {
    const { presetId } = req.body as { presetId: string };
    const success = engine.setPreset(presetId);
    if (!success) {
      res.status(404).json({ error: `Preset '${presetId}' not found` });
      return;
    }
    res.json({ activePreset: engine.getActivePreset().id });
  });

  router.post('/presets/custom', (req, res) => {
    const preset = req.body as CommentaryPreset;
    if (!preset.id || !preset.name || !preset.playByPlay || !preset.color) {
      res.status(400).json({ error: 'Missing required preset fields' });
      return;
    }
    saveCustomPreset(preset);
    res.json({ status: 'saved', id: preset.id });
  });

  router.delete('/presets/custom/:id', (req, res) => {
    const deleted = deleteCustomPreset(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Custom preset not found' });
      return;
    }
    res.json({ status: 'deleted' });
  });

  // ─── Flavor Bank ───

  router.get('/flavor', (_req, res) => {
    engine.loadFlavorEntries();
    res.json(engine.getFlavorEntries());
  });

  router.post('/flavor', (req, res) => {
    const entry = req.body as FlavorEntry;
    if (!entry.id || !entry.text) {
      res.status(400).json({ error: 'id and text are required' });
      return;
    }
    const entries = loadFlavorFromFile();
    entries.push(entry);
    saveFlavorToFile(entries);
    engine.setFlavorEntries(entries);
    res.status(201).json(entry);
  });

  router.put('/flavor/:id', (req, res) => {
    const entries = loadFlavorFromFile();
    const idx = entries.findIndex((e) => e.id === req.params.id);
    if (idx < 0) {
      res.status(404).json({ error: 'Flavor entry not found' });
      return;
    }
    entries[idx] = { ...entries[idx], ...req.body, id: req.params.id };
    saveFlavorToFile(entries);
    engine.setFlavorEntries(entries);
    res.json(entries[idx]);
  });

  router.delete('/flavor/:id', (req, res) => {
    const entries = loadFlavorFromFile();
    const filtered = entries.filter((e) => e.id !== req.params.id);
    if (filtered.length === entries.length) {
      res.status(404).json({ error: 'Flavor entry not found' });
      return;
    }
    saveFlavorToFile(filtered);
    engine.setFlavorEntries(filtered);
    res.json({ status: 'deleted' });
  });

  return router;
}

// ─── Flavor File Helpers ───

function loadFlavorFromFile(): FlavorEntry[] {
  if (!existsSync(FLAVOR_PATH)) return [];
  try {
    const raw = readFileSync(FLAVOR_PATH, 'utf-8');
    const data = JSON.parse(raw) as { entries?: FlavorEntry[] };
    return data.entries ?? [];
  } catch {
    return [];
  }
}

function saveFlavorToFile(entries: FlavorEntry[]): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FLAVOR_PATH, JSON.stringify({ entries }, null, 2));
}
