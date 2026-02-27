import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import { logger } from '../logger.js';

interface PersonaContext {
  db: Kysely<Database>;
}

// Built-in Kokoro voices that are always available
const KOKORO_BUILTIN_VOICES = [
  { id: 'kokoro-am_adam', name: 'Adam', type: 'kokoro', kokoro_voice_id: 'am_adam', clip_count: 0, quality_score: null },
  { id: 'kokoro-am_michael', name: 'Michael', type: 'kokoro', kokoro_voice_id: 'am_michael', clip_count: 0, quality_score: null },
  { id: 'kokoro-af_heart', name: 'Heart', type: 'kokoro', kokoro_voice_id: 'af_heart', clip_count: 0, quality_score: null },
  { id: 'kokoro-af_nice', name: 'Nice', type: 'kokoro', kokoro_voice_id: 'af_nice', clip_count: 0, quality_score: null },
  { id: 'kokoro-bf_emma', name: 'Emma', type: 'kokoro', kokoro_voice_id: 'bf_emma', clip_count: 0, quality_score: null },
  { id: 'kokoro-bf_isabella', name: 'Isabella', type: 'kokoro', kokoro_voice_id: 'bf_isabella', clip_count: 0, quality_score: null },
  { id: 'kokoro-bm_george', name: 'George', type: 'kokoro', kokoro_voice_id: 'bm_george', clip_count: 0, quality_score: null },
  { id: 'kokoro-bm_lewis', name: 'Lewis', type: 'kokoro', kokoro_voice_id: 'bm_lewis', clip_count: 0, quality_score: null },
];

export function createPersonaRoutes(ctx: PersonaContext): Router {
  const router = Router();

  // ─── Personas ───

  router.get('/personas', async (_req, res) => {
    const personas = await ctx.db.selectFrom('commentary_personas')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    res.json(personas);
  });

  router.post('/personas', async (req, res) => {
    const id = crypto.randomUUID();
    const { name, role, system_prompt, personality, voice_id } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    await ctx.db.insertInto('commentary_personas').values({
      id,
      name,
      role: role ?? 'play-by-play',
      system_prompt: system_prompt ?? null,
      personality: personality ?? null,
      voice_id: voice_id ?? null,
      is_active: 1,
    } as any).execute();

    logger.info(`Created persona: ${name} (${id})`);
    res.status(201).json({ id });
  });

  router.put('/personas/:id', async (req, res) => {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};
    const fields = ['name', 'role', 'system_prompt', 'personality', 'voice_id', 'is_active'] as const;
    for (const f of fields) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    await ctx.db.updateTable('commentary_personas')
      .set(updates)
      .where('id', '=', id)
      .execute();
    res.json({ status: 'updated', id });
  });

  router.delete('/personas/:id', async (req, res) => {
    await ctx.db.deleteFrom('commentary_personas')
      .where('id', '=', req.params.id)
      .execute();
    res.json({ status: 'deleted' });
  });

  // ─── Voice Profiles ───

  router.get('/voices', async (_req, res) => {
    const customVoices = await ctx.db.selectFrom('voice_profiles')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();

    // Merge custom voices with built-in Kokoro voices
    const builtins = KOKORO_BUILTIN_VOICES.map(v => ({
      ...v,
      is_builtin: true,
      created_at: null,
    }));

    res.json([...builtins, ...customVoices.map(v => ({ ...v, is_builtin: false }))]);
  });

  router.post('/voices', async (req, res) => {
    const id = crypto.randomUUID();
    const { name, type, kokoro_voice_id } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    await ctx.db.insertInto('voice_profiles').values({
      id,
      name,
      type: type ?? 'custom',
      kokoro_voice_id: kokoro_voice_id ?? null,
      clip_count: 0,
      quality_score: null,
    } as any).execute();

    logger.info(`Created voice profile: ${name} (${id})`);
    res.status(201).json({ id });
  });

  router.put('/voices/:id', async (req, res) => {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};
    const fields = ['name', 'type', 'kokoro_voice_id', 'clip_count', 'quality_score'] as const;
    for (const f of fields) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    await ctx.db.updateTable('voice_profiles')
      .set(updates)
      .where('id', '=', id)
      .execute();
    res.json({ status: 'updated', id });
  });

  router.delete('/voices/:id', async (req, res) => {
    // Don't allow deleting built-in voices (they have kokoro- prefix IDs)
    if (req.params.id.startsWith('kokoro-')) {
      res.status(403).json({ error: 'Cannot delete built-in voices' });
      return;
    }
    await ctx.db.deleteFrom('voice_profiles')
      .where('id', '=', req.params.id)
      .execute();
    res.json({ status: 'deleted' });
  });

  router.post('/voices/:id/test', async (req, res) => {
    // Placeholder — actual TTS test generation would integrate with TtsServiceManager
    const voiceId = req.params.id;
    const text = req.body.text ?? 'Hello, this is a voice test.';
    logger.info(`Voice test requested: ${voiceId} — "${text}"`);
    res.json({ status: 'ok', voiceId, text, message: 'Voice test queued' });
  });

  return router;
}
