import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';

interface ScenePresetContext {
  db: Kysely<Database>;
}

export function createScenePresetRoutes(ctx: ScenePresetContext): Router {
  const router = Router();

  // List all presets
  router.get('/', async (_req, res) => {
    const presets = await ctx.db.selectFrom('scene_presets')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    res.json(presets);
  });

  // Get preset by id
  router.get('/:id', async (req, res) => {
    const preset = await ctx.db.selectFrom('scene_presets')
      .selectAll()
      .where('id', '=', req.params.id)
      .executeTakeFirst();
    if (!preset) {
      res.status(404).json({ error: 'Scene preset not found' });
      return;
    }
    res.json(preset);
  });

  // Create preset
  router.post('/', async (req, res) => {
    const id = crypto.randomUUID();
    const { name, description, racer_count, elements, background } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    await ctx.db.insertInto('scene_presets').values({
      id,
      name,
      description: description ?? null,
      racer_count: racer_count ?? 2,
      elements: elements ? JSON.stringify(elements) : '[]',
      background: background ? JSON.stringify(background) : '{}',
      is_builtin: 0,
    } as any).execute();
    res.status(201).json({ id });
  });

  // Update preset
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.racer_count !== undefined) updates.racer_count = req.body.racer_count;
    if (req.body.elements !== undefined) updates.elements = JSON.stringify(req.body.elements);
    if (req.body.background !== undefined) updates.background = JSON.stringify(req.body.background);

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    await ctx.db.updateTable('scene_presets')
      .set(updates)
      .where('id', '=', id)
      .execute();
    res.json({ status: 'updated', id });
  });

  // Delete preset (not builtins)
  router.delete('/:id', async (req, res) => {
    const preset = await ctx.db.selectFrom('scene_presets')
      .select('is_builtin')
      .where('id', '=', req.params.id)
      .executeTakeFirst();

    if (!preset) {
      res.status(404).json({ error: 'Scene preset not found' });
      return;
    }
    if (preset.is_builtin) {
      res.status(403).json({ error: 'Cannot delete built-in presets' });
      return;
    }

    await ctx.db.deleteFrom('scene_presets')
      .where('id', '=', req.params.id)
      .execute();
    res.json({ status: 'deleted' });
  });

  return router;
}
