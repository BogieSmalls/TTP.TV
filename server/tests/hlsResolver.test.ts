import { describe, it, expect } from 'vitest';
import { resolveHlsUrl } from '../src/vision/hlsResolver';

describe('resolveHlsUrl', () => {
  it('resolves local RTMP to HLS URL', async () => {
    const url = await resolveHlsUrl('rtmp://localhost:8888/live/bogie');
    expect(url).toBe('http://localhost:8000/live/bogie/index.m3u8');
  });
});
