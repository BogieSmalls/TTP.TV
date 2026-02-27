import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');

export class TtsServiceManager {
  private process: ChildProcess | null = null;
  private running = false;
  private healthy = false;
  private restartCount = 0;
  private readonly maxRestarts = 5;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private readonly audioDir: string;

  constructor(private config: Config) {
    this.audioDir = resolve(PROJECT_ROOT, 'data/tts-audio');
    if (!existsSync(this.audioDir)) {
      mkdirSync(this.audioDir, { recursive: true });
    }
  }

  getAudioDir(): string {
    return this.audioDir;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ─── Lifecycle ───

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.restartCount = 0;

    this.spawnProcess();

    // Health check every 10s (first check after 5s to give model time to load)
    setTimeout(() => {
      this.checkHealth();
      this.healthCheckTimer = setInterval(() => this.checkHealth(), 10_000);
    }, 5_000);

    // Cleanup old audio files every 60s
    this.cleanupTimer = setInterval(() => this.cleanupOldFiles(), 60_000);

    logger.info('[TTS] Service manager started');
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.healthy = false;
    logger.info('[TTS] Service manager stopped');
  }

  private spawnProcess(): void {
    const pythonPath = resolve(PROJECT_ROOT, this.config.tts.pythonPath);
    const ttsDir = resolve(PROJECT_ROOT, 'tts');
    const port = String(this.config.tts.servicePort);

    logger.info(`[TTS] Spawning: ${pythonPath} -m uvicorn tts_server:app --host 127.0.0.1 --port ${port}`);

    this.process = spawn(pythonPath, [
      '-m', 'uvicorn', 'tts_server:app',
      '--host', '127.0.0.1',
      '--port', port,
    ], {
      cwd: ttsDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.on('error', (err) => {
      logger.error(`[TTS] Spawn error: ${err.message}`);
      this.healthy = false;
      if (this.running) this.scheduleRestart();
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[TTS] ${msg}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[TTS] ${msg}`);
    });

    this.process.on('exit', (code) => {
      logger.warn(`[TTS] Process exited with code ${code}`);
      this.healthy = false;
      if (this.running) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartCount >= this.maxRestarts) {
      logger.error(`[TTS] Max restarts (${this.maxRestarts}) reached, giving up`);
      return;
    }
    this.restartCount++;
    const delay = Math.min(5000 * this.restartCount, 30_000);
    logger.info(`[TTS] Restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);
    setTimeout(() => {
      if (this.running) this.spawnProcess();
    }, delay);
  }

  private async checkHealth(): Promise<void> {
    try {
      const resp = await fetch(`${this.config.tts.serviceUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      const data = await resp.json() as { status: string; ready?: boolean };
      const wasHealthy = this.healthy;
      this.healthy = data.ready === true;
      this.consecutiveFailures = 0;

      if (this.healthy && !wasHealthy) {
        logger.info('[TTS] Service is healthy and ready');
        this.restartCount = 0; // Reset restart count on successful health
      }
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3 && this.healthy) {
        logger.warn('[TTS] Service unhealthy (3 consecutive failures)');
        this.healthy = false;
      }
    }
  }

  // ─── Synthesis ───

  async synthesize(text: string, voice?: string, speed?: number): Promise<string | null> {
    if (!this.healthy) {
      logger.warn('[TTS] Cannot synthesize — service not healthy');
      return null;
    }

    try {
      const startMs = Date.now();
      const resp = await fetch(`${this.config.tts.serviceUrl}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: voice ?? this.config.tts.defaultVoice,
          speed: speed ?? this.config.tts.speed,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'unknown');
        logger.error(`[TTS] Synthesis failed (${resp.status}): ${errText}`);
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = `tts_${Date.now()}.wav`;
      const filepath = resolve(this.audioDir, filename);
      writeFileSync(filepath, buffer);

      const elapsedMs = Date.now() - startMs;
      const audioDurationMs = resp.headers.get('x-audio-duration-ms');
      logger.info(
        `[TTS] Synthesized "${text.slice(0, 60)}..." → ${filename} ` +
        `(${elapsedMs}ms synth, ${audioDurationMs ?? '?'}ms audio)`,
      );

      return filename;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[TTS] Synthesis error: ${msg}`);
      return null;
    }
  }

  // ─── Cleanup ───

  private cleanupOldFiles(): void {
    const maxAgeMs = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    try {
      const files = readdirSync(this.audioDir);
      for (const file of files) {
        if (!file.startsWith('tts_') || !file.endsWith('.wav')) continue;
        const filepath = resolve(this.audioDir, file);
        const stat = statSync(filepath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filepath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
