import { describe, it, expect } from 'vitest';
import { computeVodOffset, parseRacetimeSlug } from '../src/race/ReplayOrchestrator.js';

describe('ReplayOrchestrator helpers', () => {
  it('parses racetime slug from URL', () => {
    expect(parseRacetimeSlug('https://racetime.gg/z1r/mysterious-vire-2312'))
      .toBe('z1r/mysterious-vire-2312');
  });

  it('parses slug with query params', () => {
    expect(parseRacetimeSlug('https://racetime.gg/z1r/test-room-1234?foo=bar'))
      .toBe('z1r/test-room-1234');
  });

  it('returns input if no match', () => {
    expect(parseRacetimeSlug('z1r/some-race-5678'))
      .toBe('z1r/some-race-5678');
  });

  it('computes VOD offset in seconds', () => {
    const raceStart = new Date('2026-02-20T18:00:00Z');
    const vodCreated = new Date('2026-02-20T17:30:00Z');
    // Race starts 30 min into the VOD
    expect(computeVodOffset(raceStart, vodCreated)).toBe(1800);
  });

  it('handles negative offset (VOD started after race)', () => {
    const raceStart = new Date('2026-02-20T18:00:00Z');
    const vodCreated = new Date('2026-02-20T18:05:00Z');
    expect(computeVodOffset(raceStart, vodCreated)).toBe(-300);
  });
});
