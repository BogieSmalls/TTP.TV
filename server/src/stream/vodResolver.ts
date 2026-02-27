import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export type VodSourceType = 'twitch' | 'youtube' | 'direct';

export interface ResolvedVod {
  directUrl: string;
  sourceType: VodSourceType;
  duration?: number;
}

export function detectSourceType(url: string): VodSourceType {
  if (/twitch\.tv/i.test(url)) return 'twitch';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  return 'direct';
}

export async function resolveVodUrl(url: string, twitchToken?: string): Promise<ResolvedVod> {
  const sourceType = detectSourceType(url);

  if (sourceType === 'twitch') {
    return resolveTwitch(url, twitchToken);
  }
  if (sourceType === 'youtube') {
    return resolveYoutube(url);
  }
  return resolveDirect(url);
}

async function resolveTwitch(url: string, twitchToken?: string): Promise<ResolvedVod> {
  logger.info(`[vod] Resolving Twitch VOD: ${url}`);
  try {
    const args = [url, 'best', '--stream-url'];
    if (twitchToken) {
      args.push('--twitch-api-header', `Authorization=OAuth ${twitchToken}`);
    }
    const { stdout } = await execFileAsync('streamlink', args, {
      timeout: 30000,
    });
    const directUrl = stdout.trim();
    if (directUrl) {
      const duration = await probeDuration(directUrl);
      return { directUrl, sourceType: 'twitch', duration };
    }
  } catch (err) {
    logger.error(`[vod] streamlink failed for ${url}`, { err });
  }
  throw new Error(`Failed to resolve Twitch VOD: ${url}`);
}

async function resolveYoutube(url: string): Promise<ResolvedVod> {
  logger.info(`[vod] Resolving YouTube URL: ${url}`);
  try {
    const { stdout } = await execFileAsync('yt-dlp', ['--get-url', '-f', 'best', url], {
      timeout: 60000,
    });
    const directUrl = stdout.trim().split('\n')[0];
    if (directUrl) {
      const duration = await probeDuration(directUrl);
      return { directUrl, sourceType: 'youtube', duration };
    }
  } catch (err) {
    logger.error(`[vod] yt-dlp failed for ${url}`, { err });
  }
  throw new Error(`Failed to resolve YouTube URL: ${url}`);
}

async function resolveDirect(url: string): Promise<ResolvedVod> {
  const duration = await probeDuration(url);
  return { directUrl: url, sourceType: 'direct', duration };
}

async function probeDuration(url: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'json',
      url,
    ], { timeout: 30000 });
    const data = JSON.parse(stdout);
    const dur = data?.format?.duration;
    return dur ? parseFloat(dur) : undefined;
  } catch {
    return undefined;
  }
}
