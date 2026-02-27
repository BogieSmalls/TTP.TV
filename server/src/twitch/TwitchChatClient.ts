import tmi from 'tmi.js';
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

export interface ChatMessage {
  username: string;
  displayName: string;
  message: string;
  timestamp: number;
  isMod: boolean;
  isSub: boolean;
}

/**
 * Wraps tmi.js to connect to a Twitch channel's chat.
 * Emits 'message' events with ChatMessage payloads.
 */
export class TwitchChatClient extends EventEmitter {
  private client: tmi.Client | null = null;
  private channel: string;
  private connected = false;

  constructor(channel: string, oauthToken?: string) {
    super();
    this.channel = channel.toLowerCase().replace(/^#/, '');

    const opts: tmi.Options = {
      channels: [this.channel],
      connection: { reconnect: true, secure: true },
    };

    // If OAuth token provided, authenticate (allows reading sub/mod badges)
    if (oauthToken) {
      opts.identity = {
        username: this.channel,
        password: oauthToken.startsWith('oauth:') ? oauthToken : `oauth:${oauthToken}`,
      };
    }

    this.client = new tmi.Client(opts);

    this.client.on('message', (_channel, tags, message, self) => {
      if (self) return; // ignore messages from the bot itself

      const chatMsg: ChatMessage = {
        username: tags.username ?? 'anonymous',
        displayName: tags['display-name'] ?? tags.username ?? 'Anonymous',
        message,
        timestamp: Date.now(),
        isMod: tags.mod ?? false,
        isSub: tags.subscriber ?? false,
      };

      this.emit('message', chatMsg);
    });

    this.client.on('connected', () => {
      this.connected = true;
      logger.info(`[TwitchChat] Connected to #${this.channel}`);
      this.emit('connected');
    });

    this.client.on('disconnected', (reason) => {
      this.connected = false;
      logger.warn(`[TwitchChat] Disconnected: ${reason}`);
      this.emit('disconnected', reason);
    });
  }

  async connect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.connect();
    } catch (err) {
      logger.error(`[TwitchChat] Failed to connect: ${err}`);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.disconnect();
    } catch {
      // tmi.js may throw on disconnect if already disconnected
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getChannel(): string {
    return this.channel;
  }
}
