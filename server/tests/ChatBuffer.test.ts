import { describe, it, expect, beforeEach } from 'vitest';
import { ChatBuffer } from '../src/twitch/ChatBuffer.js';
import type { ChatMessage } from '../src/twitch/TwitchChatClient.js';

function msg(username: string, message: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    username,
    displayName: username,
    message,
    timestamp: Date.now(),
    isMod: false,
    isSub: false,
    ...overrides,
  };
}

describe('ChatBuffer', () => {
  let buffer: ChatBuffer;

  beforeEach(() => {
    buffer = new ChatBuffer(10, 3);
  });

  it('adds messages and retrieves them', () => {
    buffer.addMessage(msg('alice', 'hello world'));
    buffer.addMessage(msg('bob', 'hi there'));
    expect(buffer.size()).toBe(2);
    expect(buffer.getRecent(5)).toHaveLength(2);
  });

  it('getRecent returns most recent N', () => {
    for (let i = 0; i < 5; i++) {
      buffer.addMessage(msg(`user${i}`, `message ${i}`));
    }
    const recent = buffer.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].message).toBe('message 2');
    expect(recent[2].message).toBe('message 4');
  });

  it('trims to maxSize', () => {
    for (let i = 0; i < 15; i++) {
      buffer.addMessage(msg(`user${i}`, `msg ${i}`));
    }
    expect(buffer.size()).toBe(10);
  });

  it('filters emote-only messages (short)', () => {
    const added = buffer.addMessage(msg('alice', 'hi'));
    expect(added).toBe(false);
    expect(buffer.size()).toBe(0);
  });

  it('filters emote-only messages (single cap word)', () => {
    expect(buffer.addMessage(msg('alice', 'KEKW'))).toBe(false);
    expect(buffer.addMessage(msg('alice', 'PogChamp'))).toBe(false);
    expect(buffer.addMessage(msg('alice', 'LUL'))).toBe(false);
    expect(buffer.size()).toBe(0);
  });

  it('allows multi-word messages', () => {
    expect(buffer.addMessage(msg('alice', 'nice play dude'))).toBe(true);
    expect(buffer.size()).toBe(1);
  });

  it('deduplicates same user same message within 10 messages', () => {
    buffer.addMessage(msg('alice', 'hello world'));
    const dup = buffer.addMessage(msg('alice', 'hello world'));
    expect(dup).toBe(false);
    expect(buffer.size()).toBe(1);
  });

  it('allows same message from different users', () => {
    buffer.addMessage(msg('alice', 'hello world'));
    const added = buffer.addMessage(msg('bob', 'hello world'));
    expect(added).toBe(true);
    expect(buffer.size()).toBe(2);
  });

  it('enforces per-user rate limit', () => {
    buffer.addMessage(msg('alice', 'message one'));
    buffer.addMessage(msg('alice', 'message two'));
    buffer.addMessage(msg('alice', 'message three'));
    // 4th message from alice: oldest alice message is evicted to make room
    buffer.addMessage(msg('alice', 'message four'));
    expect(buffer.size()).toBe(3); // still 3, oldest was evicted before adding new
    const recent = buffer.getRecent(10);
    expect(recent.find((m) => m.message === 'message one')).toBeUndefined();
    expect(recent.find((m) => m.message === 'message four')).toBeDefined();
  });

  it('getSummary returns formatted string', () => {
    buffer.addMessage(msg('alice', 'great race', { displayName: 'Alice' }));
    buffer.addMessage(msg('bob', 'so close', { displayName: 'Bob' }));
    const summary = buffer.getSummary(5);
    expect(summary).toContain('Alice: great race');
    expect(summary).toContain('Bob: so close');
  });

  it('getSummary returns empty string when no messages', () => {
    expect(buffer.getSummary()).toBe('');
  });

  it('getQuestions finds messages with question marks', () => {
    buffer.addMessage(msg('alice', 'what items does he have?'));
    buffer.addMessage(msg('bob', 'nice run'));
    buffer.addMessage(msg('charlie', 'is that a triforce?'));
    const questions = buffer.getQuestions();
    expect(questions).toHaveLength(2);
    expect(questions[0].message).toContain('?');
    expect(questions[1].message).toContain('?');
  });

  it('clear removes all messages', () => {
    buffer.addMessage(msg('alice', 'hello world'));
    buffer.addMessage(msg('bob', 'hi there'));
    buffer.clear();
    expect(buffer.size()).toBe(0);
    expect(buffer.getRecent()).toHaveLength(0);
  });

  it('allows lowercase multi-word messages that look like emotes', () => {
    // "nice" is 4 chars, has a space? No. Let's test a borderline case
    expect(buffer.addMessage(msg('alice', 'gg wp'))).toBe(true); // multi-word, allowed
  });
});
