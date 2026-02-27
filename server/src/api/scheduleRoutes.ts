import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import { logger } from '../logger.js';

interface ScheduleContext {
  db: Kysely<Database>;
}

export function createScheduleRoutes(ctx: ScheduleContext): Router {
  const router = Router();

  // List blocks (optional ?from=&to= date range)
  router.get('/', async (req, res) => {
    let query = ctx.db.selectFrom('schedule_blocks')
      .selectAll()
      .orderBy('scheduled_at', 'asc');

    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    if (from) query = query.where('scheduled_at', '>=', new Date(from));
    if (to) query = query.where('scheduled_at', '<=', new Date(to));

    const blocks = await query.execute();
    res.json(blocks);
  });

  // Get block by id
  router.get('/:id', async (req, res) => {
    const block = await ctx.db.selectFrom('schedule_blocks')
      .selectAll()
      .where('id', '=', req.params.id)
      .executeTakeFirst();
    if (!block) {
      res.status(404).json({ error: 'Schedule block not found' });
      return;
    }
    res.json(block);
  });

  // Create block
  router.post('/', async (req, res) => {
    const id = crypto.randomUUID();
    const {
      type, source_url, title, scene_preset_id,
      commentary_enabled, commentary_persona_ids,
      scheduled_at, duration_minutes, auto_broadcast,
    } = req.body;

    if (!scheduled_at) {
      res.status(400).json({ error: 'scheduled_at is required' });
      return;
    }

    await ctx.db.insertInto('schedule_blocks').values({
      id,
      type: type ?? 'live',
      source_url: source_url ?? null,
      title: title ?? null,
      scene_preset_id: scene_preset_id ?? null,
      commentary_enabled: commentary_enabled ?? 1,
      commentary_persona_ids: commentary_persona_ids ? JSON.stringify(commentary_persona_ids) : null,
      scheduled_at: new Date(scheduled_at),
      duration_minutes: duration_minutes ?? null,
      auto_broadcast: auto_broadcast ?? 0,
      status: 'queued',
    } as any).execute();

    logger.info(`Created schedule block: ${title ?? type} at ${scheduled_at} (${id})`);
    res.status(201).json({ id });
  });

  // Update block
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};
    const fields = ['type', 'source_url', 'title', 'scene_preset_id',
      'commentary_enabled', 'duration_minutes', 'auto_broadcast', 'status'] as const;

    for (const f of fields) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (req.body.scheduled_at !== undefined) updates.scheduled_at = new Date(req.body.scheduled_at);
    if (req.body.commentary_persona_ids !== undefined) {
      updates.commentary_persona_ids = JSON.stringify(req.body.commentary_persona_ids);
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    await ctx.db.updateTable('schedule_blocks')
      .set(updates)
      .where('id', '=', id)
      .execute();
    res.json({ status: 'updated', id });
  });

  // Delete block
  router.delete('/:id', async (req, res) => {
    await ctx.db.deleteFrom('schedule_blocks')
      .where('id', '=', req.params.id)
      .execute();
    res.json({ status: 'deleted' });
  });

  // Go live — manually trigger a scheduled block
  router.post('/:id/go-live', async (req, res) => {
    const block = await ctx.db.selectFrom('schedule_blocks')
      .selectAll()
      .where('id', '=', req.params.id)
      .executeTakeFirst();

    if (!block) {
      res.status(404).json({ error: 'Schedule block not found' });
      return;
    }

    await ctx.db.updateTable('schedule_blocks')
      .set({ status: 'live' })
      .where('id', '=', req.params.id)
      .execute();

    logger.info(`Schedule block ${req.params.id} triggered go-live`);
    res.json({ status: 'live', id: req.params.id });
  });

  return router;
}
