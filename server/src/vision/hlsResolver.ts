import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** Resolve an HLS .m3u8 URL for a given stream source. */
export async function resolveHlsUrl(source: string): Promise<string> {
  // Local RTMP stream → use node-media-server HLS output
  if (source.startsWith('rtmp://localhost')) {
    const key = source.split('/').pop()!;
    return `http://localhost:${config.mediaServer.http.port}/live/${key}/index.m3u8`;
  }
  // Twitch VOD or channel → use streamlink
  const { stdout } = await execFileAsync(config.tools.streamlinkPath, [
    '--stream-url', source, 'best',
  ]);
  return stdout.trim();
}
