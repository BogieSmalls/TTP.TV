import type { ChatMessage } from './TwitchChatClient.js';

/**
 * Ring buffer for Twitch chat messages with filtering and deduplication.
 *
 * Features:
 * - Fixed-size ring buffer (default 100 messages)
 * - Per-user rate limiting (max 3 messages per user in buffer)
 * - Emote-only message filtering
 * - Deduplication of repeated messages
 */
export class ChatBuffer {
  private buffer: ChatMessage[] = [];
  private maxSize: number;
  private maxPerUser: number;

  constructor(maxSize = 100, maxPerUser = 3) {
    this.maxSize = maxSize;
    this.maxPerUser = maxPerUser;
  }

  /**
   * Add a message to the buffer.
   * Returns false if the message was filtered out.
   */
  addMessage(msg: ChatMessage): boolean {
    // Filter emote-only messages (messages that are ONLY emotes/whitespace)
    if (this._isEmoteOnly(msg.message)) return false;

    // Dedup: reject exact duplicate from same user within last 10 messages
    const recent = this.buffer.slice(-10);
    if (recent.some((m) => m.username === msg.username && m.message === msg.message)) {
      return false;
    }

    // Per-user rate limit: count messages from this user in buffer
    const userCount = this.buffer.filter((m) => m.username === msg.username).length;
    if (userCount >= this.maxPerUser) {
      // Remove oldest message from this user to make room
      const idx = this.buffer.findIndex((m) => m.username === msg.username);
      if (idx >= 0) this.buffer.splice(idx, 1);
    }

    this.buffer.push(msg);

    // Trim to max size
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    return true;
  }

  /**
   * Get the N most recent messages.
   */
  getRecent(count = 20): ChatMessage[] {
    return this.buffer.slice(-count);
  }

  /**
   * Get a text summary of recent chat for the AI prompt.
   * Returns a formatted string suitable for the commentary engine.
   */
  getSummary(count = 10): string {
    const recent = this.getRecent(count);
    if (recent.length === 0) return '';

    const lines = recent.map((m) => `${m.displayName}: ${m.message}`);
    return lines.join('\n');
  }

  /**
   * Extract messages that look like questions.
   */
  getQuestions(count = 5): ChatMessage[] {
    return this.buffer
      .filter((m) => m.message.includes('?'))
      .slice(-count);
  }

  /**
   * Get total message count in the buffer.
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Check if a message is emote-only (common Twitch patterns).
   * Filters messages that are only emotes, single words with no spaces,
   * or very short messages that are likely just reactions.
   */
  private _isEmoteOnly(text: string): boolean {
    const trimmed = text.trim();

    // Empty or very short single-word messages
    if (trimmed.length <= 2) return true;

    // All caps single word (likely emote name like "KEKW", "LUL", "PogChamp")
    if (/^[A-Z][A-Za-z0-9]+$/.test(trimmed) && !trimmed.includes(' ') && trimmed.length <= 20) {
      return true;
    }

    return false;
  }
}
