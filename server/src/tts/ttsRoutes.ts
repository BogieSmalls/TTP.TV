import { Router } from 'express';
import type { TtsServiceManager } from './TtsServiceManager.js';
import type { Config } from '../config.js';

interface TtsRouteContext {
  ttsManager: TtsServiceManager;
  config: Config;
}

export function createTtsRoutes(ctx: TtsRouteContext): Router {
  const router = Router();

  // GET /api/tts/status
  router.get('/status', (_req, res) => {
    res.json({
      healthy: ctx.ttsManager.isHealthy(),
      enabled: ctx.config.tts.enabled,
      defaultVoice: ctx.config.tts.defaultVoice,
      speed: ctx.config.tts.speed,
      voices: ctx.config.tts.voices,
    });
  });

  // GET /api/tts/voices — proxy to Python service
  router.get('/voices', async (_req, res) => {
    if (!ctx.ttsManager.isHealthy()) {
      res.status(503).json({ error: 'TTS service unavailable' });
      return;
    }
    try {
      const resp = await fetch(`${ctx.config.tts.serviceUrl}/voices`, {
        signal: AbortSignal.timeout(5_000),
      });
      const data = await resp.json();
      res.json(data);
    } catch {
      res.status(503).json({ error: 'TTS service unavailable' });
    }
  });

  // POST /api/tts/test — synthesize test audio
  router.post('/test', async (req, res) => {
    const { text, voice, speed } = req.body as {
      text?: string;
      voice?: string;
      speed?: number;
    };

    const filename = await ctx.ttsManager.synthesize(
      text ?? 'This is a test of the TTP commentary system. Welcome to Zelda 1 Randomizer!',
      voice,
      speed,
    );

    if (!filename) {
      res.status(503).json({ error: 'TTS synthesis failed or service unavailable' });
      return;
    }

    res.json({ audioUrl: `/tts/${filename}` });
  });

  return router;
}
