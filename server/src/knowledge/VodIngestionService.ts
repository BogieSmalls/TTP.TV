import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { v4 as uuid } from 'uuid';
import type { Config } from '../config.js';
import type { KnowledgeBaseService } from './KnowledgeBaseService.js';
import { logger } from '../logger.js';

interface IngestionProgress {
  stage: 'extracting_audio' | 'transcribing' | 'chunking' | 'embedding' | 'complete' | 'error';
  pct: number;
  message?: string;
}

export class VodIngestionService extends EventEmitter {
  constructor(
    private config: Config,
    private knowledgeBase: KnowledgeBaseService,
  ) {
    super();
  }

  async ingestVod(vodUrl: string, metadata: { source: string; title?: string }): Promise<void> {
    let tempDir: string | null = null;

    try {
      tempDir = await mkdtemp(resolve(tmpdir(), 'ttp-vod-'));
      const audioPath = resolve(tempDir, 'audio.wav');
      const transcriptPath = resolve(tempDir, 'transcript.txt');

      // Step 1: Extract audio with streamlink + ffmpeg
      this.emit('progress', { stage: 'extracting_audio', pct: 0 } as IngestionProgress);
      await this.extractAudio(vodUrl, audioPath);

      // Step 2: Transcribe with whisper.cpp
      this.emit('progress', { stage: 'transcribing', pct: 20 } as IngestionProgress);
      const transcript = await this.transcribe(audioPath, transcriptPath);

      // Step 3: Chunk transcript
      this.emit('progress', { stage: 'chunking', pct: 60 } as IngestionProgress);
      const chunks = this.chunkTranscript(transcript);

      // Step 4: Embed and ingest into ChromaDB
      this.emit('progress', { stage: 'embedding', pct: 70 } as IngestionProgress);
      await this.ingestChunks(chunks, metadata);

      this.emit('progress', { stage: 'complete', pct: 100 } as IngestionProgress);
      logger.info(`[VodIngestion] Completed: ${vodUrl} — ${chunks.length} chunks ingested`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('progress', { stage: 'error', pct: 0, message: msg } as IngestionProgress);
      throw err;
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private extractAudio(vodUrl: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const streamlink = this.config.tools.streamlinkPath;
      // Use streamlink to pipe VOD to ffmpeg for audio extraction
      const proc = spawn(streamlink, [
        vodUrl, 'audio_only', '--stdout',
        '--twitch-disable-ads',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      const ffmpeg = spawn(this.config.tools.ffmpegPath, [
        '-i', 'pipe:0',
        '-ac', '1',           // mono
        '-ar', '16000',       // 16kHz for whisper
        '-f', 'wav',
        '-y',
        outputPath,
      ], { stdio: ['pipe', 'ignore', 'ignore'] });

      proc.stdout.pipe(ffmpeg.stdin);

      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });

      proc.on('error', reject);
      ffmpeg.on('error', reject);
    });
  }

  private async transcribe(audioPath: string, outputPath: string): Promise<string> {
    // Try whisper.cpp CLI first
    const whisperPath = (this.config as any).tools?.whisperPath ?? 'whisper';

    return new Promise((resolve, reject) => {
      const proc = spawn(whisperPath, [
        '-m', (this.config as any).tools?.whisperModel ?? 'models/ggml-base.en.bin',
        '-f', audioPath,
        '-otxt',
        '-of', outputPath.replace('.txt', ''),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      proc.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`whisper exited with code ${code}: ${stderr.slice(0, 200)}`));
          return;
        }
        try {
          const text = await readFile(outputPath, 'utf-8');
          resolve(text);
        } catch (err) {
          reject(err);
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`whisper not found: ${err.message}. Install whisper.cpp and set tools.whisperPath in config.`));
      });
    });
  }

  private chunkTranscript(transcript: string, maxWords = 300): string[] {
    const words = transcript.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];

    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, i + maxWords).join(' ');
      if (chunk.length > 20) { // skip tiny trailing chunks
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  private async ingestChunks(
    chunks: string[],
    metadata: { source: string; title?: string },
  ): Promise<void> {
    const batchSize = 20;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const ids = batch.map(() => uuid());
      const metadatas = batch.map((_, j) => ({
        source: metadata.source,
        page_title: metadata.title ?? '',
        section: `chunk_${i + j}`,
        category: 'vod_transcript',
      }));

      await this.knowledgeBase.addDocuments(batch, metadatas, ids);

      const pct = 70 + Math.round(((i + batch.length) / chunks.length) * 30);
      this.emit('progress', { stage: 'embedding', pct } as IngestionProgress);
    }
  }
}
