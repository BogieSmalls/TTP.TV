import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** Resolve an HLS .m3u8 URL for a given stream source. */
export async function resolveHlsUrl(source: string): Promise<string> {
  // Local RTMP stream → use node-media-server HLS output
  if (source.startsWith('rtmp://localhost') || source.startsWith('rtmp://127.0.0.1')) {
    const key = source.split('/').pop()!;
    return `http://localhost:${config.mediaServer.http.port}/live/${key}/index.m3u8`;
  }
  // Twitch VOD or channel → use streamlink
  try {
    const { stdout, stderr } = await execFileAsync(config.tools.streamlinkPath, [
      '--stream-url', source, 'best',
    ]);
    const url = stdout.trim();
    if (!url) throw new Error(`streamlink returned empty URL for ${source}. stderr: ${stderr}`);
    return url;
  } catch (err: any) {
    const stderr = err.stderr ?? '';
    throw new Error(`Failed to resolve HLS URL for ${source}: ${err.message}. stderr: ${stderr}`);
  }
}
