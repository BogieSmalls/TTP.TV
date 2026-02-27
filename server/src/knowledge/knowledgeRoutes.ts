import { Router } from 'express';
import type { KnowledgeBaseService } from './KnowledgeBaseService.js';
import type { VodIngestionService } from './VodIngestionService.js';
import type { RaceHistoryImporter } from './RaceHistoryImporter.js';

interface KnowledgeRouteContext {
  knowledgeBase: KnowledgeBaseService;
  vodIngestion: VodIngestionService;
  historyImporter: RaceHistoryImporter;
}

export function createKnowledgeRoutes(ctx: KnowledgeRouteContext): Router {
  const router = Router();

  // GET /api/knowledge/status — health check for ChromaDB + Ollama
  router.get('/status', async (_req, res) => {
    try {
      const status = await ctx.knowledgeBase.isAvailable();
      res.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ available: false, error: msg });
    }
  });

  // GET /api/knowledge/query?q=...&n=5&source=z1r_wiki
  router.get('/query', async (req, res) => {
    const q = req.query.q as string | undefined;
    if (!q) {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    const nResults = parseInt(req.query.n as string, 10) || 5;
    const source = req.query.source as string | undefined;

    try {
      const results = await ctx.knowledgeBase.query(q, { nResults, source });
      res.json({ query: q, results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/knowledge/ingest-vod — ingest a VOD transcript
  router.post('/ingest-vod', async (req, res) => {
    const { vodUrl, title } = req.body;
    if (!vodUrl) {
      res.status(400).json({ error: 'vodUrl is required' });
      return;
    }

    // Start ingestion (non-blocking — progress sent via socket)
    res.json({ status: 'started', vodUrl });

    ctx.vodIngestion.ingestVod(vodUrl, {
      source: vodUrl,
      title: title ?? undefined,
    }).catch(() => {
      // error emitted via progress event
    });
  });

  // POST /api/knowledge/import-history — import racetime.gg race history
  router.post('/import-history', async (req, res) => {
    const pages = parseInt(req.body.pages as string, 10) || 10;
    try {
      const result = await ctx.historyImporter.importHistory(pages);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
