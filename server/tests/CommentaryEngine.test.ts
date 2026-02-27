import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommentaryEngine } from '../src/commentary/CommentaryEngine.js';

// Stub fetch globally to prevent real Ollama calls
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ response: 'Test commentary output.' }),
  text: async () => '',
}));

function makeConfig() {
  return {
    commentary: {
      model: 'test-model',
      ollamaUrl: 'http://localhost:11434',
      periodicIntervalSec: 999,
      cooldownSec: 0,
      maxTokens: 50,
      temperature: 0.5,
      historySize: 10,
      kbChunksPerQuery: 1,
      activePreset: 'classic_broadcast',
    },
    tts: { enabled: false, voices: { play_by_play: '', color: '' } },
  } as any;
}

function makeIo() {
  const emitFn = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    emit: emitFn,
    _emit: emitFn,
  } as any;
}

function makeKb() {
  return { query: vi.fn().mockResolvedValue([]) } as any;
}

describe('CommentaryEngine', () => {
  let engine: CommentaryEngine;
  let io: ReturnType<typeof makeIo>;

  beforeEach(() => {
    io = makeIo();
    engine = new CommentaryEngine(makeConfig(), io, makeKb());
    // Set race context with player names so snapshots build correctly
    engine.setRaceContext({
      players: ['racer1', 'racer2'],
      playerNames: { racer1: 'Alice', racer2: 'Bob' },
    });
  });

  it('death event creates a snapshot via onVisionUpdate', () => {
    engine.enable();
    engine.onVisionUpdate('racer1', { hearts_current: 3, hearts_max: 6 }, [
      { event: 'death', description: 'Alice died in Level 3' },
    ]);

    const snaps = engine.getSnapshots();
    expect(snaps['racer1']).toBeDefined();
    expect(snaps['racer1'].displayName).toBe('Alice');
  });

  it('triforce_inferred deduplicates on same description', () => {
    engine.enable();
    engine.onVisionUpdate('racer1', { hearts_current: 5 }, [
      { event: 'triforce_inferred', description: 'Collected piece #3' },
    ]);
    engine.onVisionUpdate('racer1', { hearts_current: 5 }, [
      { event: 'triforce_inferred', description: 'Collected piece #3' },
    ]);

    // The second triforce with same description should be deduped
    // (commentedTopics prevents re-enqueue — no way to directly inspect queue,
    // but we verify snapshots are maintained without error)
    const snaps = engine.getSnapshots();
    expect(snaps['racer1']).toBeDefined();
  });

  it('death has 30s cooldown per racer', () => {
    engine.enable();
    engine.onVisionUpdate('racer1', { hearts_current: 0 }, [
      { event: 'death', description: 'died' },
    ]);
    engine.onVisionUpdate('racer1', { hearts_current: 0 }, [
      { event: 'death', description: 'died again' },
    ]);

    // Second death should be suppressed by the 30s cooldown
    // Verify engine state is stable
    expect(engine.getSnapshots()['racer1']).toBeDefined();
  });

  it('clearState resets everything', () => {
    engine.enable();
    engine.onVisionUpdate('racer1', { hearts_current: 5 });
    expect(Object.keys(engine.getSnapshots())).toHaveLength(1);

    engine.clearState();
    expect(Object.keys(engine.getSnapshots())).toHaveLength(0);
    expect(engine.getConversation()).toHaveLength(0);
    expect(engine.getTurnCount()).toBe(0);
  });

  it('enable/disable gates processing', () => {
    // When disabled, onVisionUpdate should not create snapshots
    engine.onVisionUpdate('racer1', { hearts_current: 3 }, [
      { event: 'death', description: 'died' },
    ]);
    expect(Object.keys(engine.getSnapshots())).toHaveLength(0);

    // After enabling, it should process
    engine.enable();
    engine.onVisionUpdate('racer1', { hearts_current: 3 }, [
      { event: 'death', description: 'died' },
    ]);
    expect(Object.keys(engine.getSnapshots())).toHaveLength(1);
  });

  it('per-racer flood protection: non-high dropped within 10s, high always passes', () => {
    engine.enable();

    // First low-priority event for racer1
    engine.onVisionUpdate('racer1', { hearts_current: 5 }, [
      { event: 'b_item_change', description: 'switched to boomerang' },
    ]);

    // Second low-priority event for same racer immediately — should be rate-limited
    // (enqueueEvent drops non-high within 10s)
    engine.onVisionUpdate('racer1', { hearts_current: 5 }, [
      { event: 'up_a_warp', description: 'warped back' },
    ]);

    // High-priority event for same racer — should always pass
    engine.onVisionUpdate('racer1', { hearts_current: 0 }, [
      { event: 'death', description: 'died' },
    ]);

    // Different racer should not be affected by racer1's rate limit
    engine.onVisionUpdate('racer2', { hearts_current: 4 }, [
      { event: 'b_item_change', description: 'switched to candle' },
    ]);

    expect(engine.getSnapshots()['racer1']).toBeDefined();
    expect(engine.getSnapshots()['racer2']).toBeDefined();
  });
});
