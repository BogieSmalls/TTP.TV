import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env from project root
loadDotenv({ path: resolve(import.meta.dirname, '../../.env') });

// Load ttp.config.json
const configPath = resolve(import.meta.dirname, '../../ttp.config.json');
const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

const envSchema = z.object({
  // Twitch
  TWITCH_STREAM_KEY: z.string().default(''),
  TWITCH_CHANNEL: z.string().default('TriforceTriplePlay'),
  TWITCH_OAUTH_TOKEN: z.string().default(''),
  TWITCH_CLIENT_ID: z.string().default(''),
  TWITCH_CLIENT_SECRET: z.string().default(''),

  // OBS
  OBS_WS_URL: z.string().default('ws://127.0.0.1:4466'),
  OBS_WS_PASSWORD: z.string().default(''),

  // MySQL
  MYSQL_HOST: z.string().default('localhost'),
  MYSQL_PORT: z.coerce.number().default(3306),
  MYSQL_DATABASE: z.string().default('ttp_restream'),
  MYSQL_USER: z.string().default('ttp'),
  MYSQL_PASSWORD: z.string().default(''),

  // racetime.gg
  RACETIME_CLIENT_ID: z.string().default(''),
  RACETIME_CLIENT_SECRET: z.string().default(''),
  RACETIME_CATEGORY: z.string().default('z1r'),
});

const env = envSchema.parse(process.env);

export const config = {
  server: {
    port: fileConfig.server?.port ?? 3000,
  },
  rtmp: {
    port: fileConfig.rtmp?.port ?? 1935,
    httpPort: fileConfig.rtmp?.httpPort ?? 8888,
  },
  obs: {
    url: env.OBS_WS_URL,
    password: env.OBS_WS_PASSWORD,
    execPath: fileConfig.obs?.execPath ?? '',
  },
  twitch: {
    channel: env.TWITCH_CHANNEL,
    streamKey: env.TWITCH_STREAM_KEY,
    oauthToken: env.TWITCH_OAUTH_TOKEN,
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    turboToken: (fileConfig.twitch?.turboToken as string) || '',
    chatEnabled: (fileConfig.twitch?.chatEnabled as boolean) ?? false,
    chatBufferSize: (fileConfig.twitch?.chatBufferSize as number) ?? 100,
  },
  racetime: {
    category: env.RACETIME_CATEGORY,
    clientId: env.RACETIME_CLIENT_ID,
    clientSecret: env.RACETIME_CLIENT_SECRET,
    pollIntervalMs: fileConfig.racetime?.pollIntervalMs ?? 30000,
    goalFilter: fileConfig.racetime?.goalFilter ?? 'TTP Season 4',
  },
  vision: {
    fps: fileConfig.vision?.fps ?? 2,
    pythonPath: fileConfig.vision?.pythonPath ?? 'python',
    confidence: {
      digit: fileConfig.vision?.confidence?.digit ?? 0.75,
      item: fileConfig.vision?.confidence?.item ?? 0.70,
      heart: fileConfig.vision?.confidence?.heart ?? 0.60,
    },
  },
  mysql: {
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    database: env.MYSQL_DATABASE,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
  },
  canvas: {
    width: fileConfig.canvas?.width ?? 1920,
    height: fileConfig.canvas?.height ?? 1080,
  },
  knowledgeBase: {
    chromaUrl: (fileConfig.knowledgeBase?.chromaUrl as string) ?? 'http://localhost:8100',
    chromaCollection: (fileConfig.knowledgeBase?.chromaCollection as string) ?? 'z1r_knowledge',
    ollamaUrl: (fileConfig.knowledgeBase?.ollamaUrl as string) ?? 'http://localhost:11434',
    embeddingModel: (fileConfig.knowledgeBase?.embeddingModel as string) ?? 'nomic-embed-text',
  },
  commentary: {
    model: (fileConfig.commentary?.model as string) ?? 'qwen2.5:32b',
    ollamaUrl: (fileConfig.knowledgeBase?.ollamaUrl as string) ?? 'http://localhost:11434',
    periodicIntervalSec: (fileConfig.commentary?.periodicIntervalSec as number) ?? 20,
    cooldownSec: (fileConfig.commentary?.cooldownSec as number) ?? 8,
    maxTokens: (fileConfig.commentary?.maxTokens as number) ?? 150,
    temperature: (fileConfig.commentary?.temperature as number) ?? 0.8,
    historySize: (fileConfig.commentary?.historySize as number) ?? 20,
    kbChunksPerQuery: (fileConfig.commentary?.kbChunksPerQuery as number) ?? 3,
    activePreset: (fileConfig.commentary?.activePreset as string) ?? 'classic_broadcast',
  },
  tts: {
    enabled: (fileConfig.tts?.enabled as boolean) ?? false,
    pythonPath: (fileConfig.tts?.pythonPath as string) ?? './tts/.venv/Scripts/python.exe',
    serviceUrl: (fileConfig.tts?.serviceUrl as string) ?? 'http://127.0.0.1:5123',
    servicePort: (fileConfig.tts?.servicePort as number) ?? 5123,
    defaultVoice: (fileConfig.tts?.defaultVoice as string) ?? 'af_heart',
    speed: (fileConfig.tts?.speed as number) ?? 1.0,
    voices: {
      play_by_play: (fileConfig.tts?.voices?.play_by_play as string) ?? 'am_adam',
      color: (fileConfig.tts?.voices?.color as string) ?? 'bf_emma',
    },
  },
  tools: {
    ffmpegPath: (fileConfig.tools?.ffmpegPath as string) ?? 'ffmpeg',
    streamlinkPath: (fileConfig.tools?.streamlinkPath as string) ?? 'streamlink',
  },
  mediaServer: {
    http: {
      port: (fileConfig.mediaServer?.http?.port as number) ?? 8000,
      allow_origin: (fileConfig.mediaServer?.http?.allow_origin as string) ?? '*',
    },
    trans: {
      ffmpeg: (fileConfig.mediaServer?.trans?.ffmpeg as string) ?? (fileConfig.tools?.ffmpegPath as string) ?? 'ffmpeg',
      tasks: (fileConfig.mediaServer?.trans?.tasks as unknown[]) ?? [
        {
          app: 'live',
          hls: true,
          hlsFlags: '[hls_time=1:hls_list_size=3:hls_flags=delete_segments]',
          hlsKeep: false,
        },
      ],
    },
  },
} as const;

export type Config = typeof config;

/** Return config with secrets stripped/masked for dashboard display */
export function getEditableConfig(cfg: Config) {
  return {
    server: { port: cfg.server.port },
    rtmp: { port: cfg.rtmp.port, httpPort: cfg.rtmp.httpPort },
    obs: { url: cfg.obs.url, execPath: cfg.obs.execPath },
    twitch: {
      channel: cfg.twitch.channel,
      chatEnabled: cfg.twitch.chatEnabled,
      chatBufferSize: cfg.twitch.chatBufferSize,
      streamKey: cfg.twitch.streamKey ? '●●●●' + cfg.twitch.streamKey.slice(-4) : '',
    },
    racetime: {
      category: cfg.racetime.category,
      pollIntervalMs: cfg.racetime.pollIntervalMs,
      goalFilter: cfg.racetime.goalFilter,
    },
    vision: {
      fps: cfg.vision.fps,
      confidence: { ...cfg.vision.confidence },
    },
    canvas: { width: cfg.canvas.width, height: cfg.canvas.height },
    knowledgeBase: {
      chromaUrl: cfg.knowledgeBase.chromaUrl,
      chromaCollection: cfg.knowledgeBase.chromaCollection,
      ollamaUrl: cfg.knowledgeBase.ollamaUrl,
      embeddingModel: cfg.knowledgeBase.embeddingModel,
    },
    commentary: {
      model: cfg.commentary.model,
      ollamaUrl: cfg.commentary.ollamaUrl,
      periodicIntervalSec: cfg.commentary.periodicIntervalSec,
      cooldownSec: cfg.commentary.cooldownSec,
      maxTokens: cfg.commentary.maxTokens,
      temperature: cfg.commentary.temperature,
      historySize: cfg.commentary.historySize,
      kbChunksPerQuery: cfg.commentary.kbChunksPerQuery,
    },
    tts: {
      enabled: cfg.tts.enabled,
      serviceUrl: cfg.tts.serviceUrl,
      defaultVoice: cfg.tts.defaultVoice,
      speed: cfg.tts.speed,
      voices: { ...cfg.tts.voices },
    },
    tools: {
      ffmpegPath: cfg.tools.ffmpegPath,
      streamlinkPath: cfg.tools.streamlinkPath,
    },
  };
}

/** Deep-merge updates into ttp.config.json and write to disk */
export function writeConfigFile(updates: Record<string, unknown>): { restartRequired: boolean } {
  const cfgPath = resolve(import.meta.dirname, '../../ttp.config.json');
  const current = JSON.parse(readFileSync(cfgPath, 'utf-8'));

  // Hot-reloadable sections (no restart needed)
  const hotSections = new Set(['commentary', 'tts']);

  let restartRequired = false;

  for (const [section, values] of Object.entries(updates)) {
    if (!hotSections.has(section)) restartRequired = true;
    if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
      current[section] = { ...current[section], ...(values as Record<string, unknown>) };
    } else {
      current[section] = values;
    }
  }

  writeFileSync(cfgPath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  return { restartRequired };
}
