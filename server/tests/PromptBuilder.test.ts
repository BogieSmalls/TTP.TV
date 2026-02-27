import { describe, it, expect } from 'vitest';
import { buildPrompt, type PromptParams, type RacerSnapshot, type RaceContext } from '../src/commentary/PromptBuilder.js';

function makeParams(overrides?: Partial<PromptParams>): PromptParams {
  return {
    persona: {
      name: 'TestCaster',
      systemPrompt: 'You are a test commentator.',
      voiceId: undefined,
    } as any,
    partnerName: 'CoHost',
    raceContext: { players: ['p1'], playerNames: { p1: 'Alice' } },
    racerSnapshots: [],
    kbContext: [],
    flavorEntries: [],
    conversation: [],
    trigger: { type: 'periodic' },
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<RacerSnapshot>): RacerSnapshot {
  return {
    racerId: 'p1',
    displayName: 'Alice',
    ...overrides,
  };
}

describe('buildPrompt()', () => {
  it('includes system prompt', () => {
    const prompt = buildPrompt(makeParams());
    expect(prompt).toContain('You are a test commentator.');
  });

  it('includes player names', () => {
    const prompt = buildPrompt(makeParams());
    expect(prompt).toContain('Alice');
  });

  it('includes EVENT section for event triggers', () => {
    const prompt = buildPrompt(makeParams({
      trigger: { type: 'event', description: 'Alice collected a triforce piece!', eventType: 'triforce' },
    }));
    expect(prompt).toContain('EVENT: Alice collected a triforce piece!');
  });

  it('includes follow-up instructions and [PASS] hint', () => {
    const prompt = buildPrompt(makeParams({
      isFollowUp: true,
      partnerLastLine: 'What a great play!',
    }));
    expect(prompt).toContain('CoHost');
    expect(prompt).toContain('What a great play!');
    expect(prompt).toContain('[PASS]');
  });

  it('includes racer snapshot details', () => {
    const prompt = buildPrompt(makeParams({
      racerSnapshots: [makeSnapshot({
        hearts: 5,
        heartsMax: 8,
        swordLevel: 2,
        triforceCount: 3,
        dungeonLevel: 4,
      })],
    }));
    expect(prompt).toContain('hearts=5/8');
    expect(prompt).toContain('sword=White');
    expect(prompt).toContain('triforce=3/8');
    expect(prompt).toContain('Level 4');
  });

  it('includes inventory in snapshot when present', () => {
    const prompt = buildPrompt(makeParams({
      racerSnapshots: [makeSnapshot({
        inventory: { bow: true, raft: false, ladder: true },
      })],
    }));
    expect(prompt).toContain('bow');
    expect(prompt).toContain('ladder');
    expect(prompt).not.toContain('inventory: raft'); // raft is false
  });

  it('includes RACE ANALYSIS for 2+ snapshots', () => {
    const prompt = buildPrompt(makeParams({
      racerSnapshots: [
        makeSnapshot({ racerId: 'p1', displayName: 'Alice', triforceCount: 3 }),
        makeSnapshot({ racerId: 'p2', displayName: 'Bob', triforceCount: 5 }),
      ],
      raceContext: { players: ['p1', 'p2'], playerNames: { p1: 'Alice', p2: 'Bob' } },
    }));
    expect(prompt).toContain('RACE ANALYSIS');
    expect(prompt).toContain('Alice 3/8');
    expect(prompt).toContain('Bob 5/8');
  });

  it('includes KB context when provided', () => {
    const prompt = buildPrompt(makeParams({
      kbContext: ['[Wiki] Level 3 boss is Manhandla.'],
    }));
    expect(prompt).toContain('Z1R KNOWLEDGE');
    expect(prompt).toContain('Level 3 boss is Manhandla');
  });

  it('includes flags when provided', () => {
    const prompt = buildPrompt(makeParams({
      raceContext: { players: ['p1'], flags: 'Swordless, Full Shuffle' },
    }));
    expect(prompt).toContain('Flags: Swordless, Full Shuffle');
  });

  it('formats standings when provided', () => {
    const prompt = buildPrompt(makeParams({
      raceContext: {
        players: ['p1', 'p2'],
        standings: [
          { racerId: 'p1', displayName: 'Alice', status: 'finished', place: 1, finishTime: '1:23:45' },
          { racerId: 'p2', displayName: 'Bob', status: 'racing' },
        ],
      },
    }));
    expect(prompt).toContain('Alice: FINISHED');
    expect(prompt).toContain('1st');
    expect(prompt).toContain('Bob: Racing');
  });
});
