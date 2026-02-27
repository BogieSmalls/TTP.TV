import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';
import type { Config } from '../config.js';
import type { KnowledgeBaseService } from '../knowledge/KnowledgeBaseService.js';
import type { TtsServiceManager } from '../tts/TtsServiceManager.js';
import type { ChatBuffer } from '../twitch/ChatBuffer.js';
import { logger } from '../logger.js';
import { getPreset, type CommentaryPreset } from './personas.js';
import {
  buildPrompt,
  getRandomReactionType,
  type RacerSnapshot,
  type ConversationLine,
  type FlavorEntry,
  type RaceContext,
  type TriggerInfo,
} from './PromptBuilder.js';

// ─── Types ───

interface GameEvent {
  type: string;
  racerId: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  timestamp: number;
}

interface CommentaryTextEvent {
  persona: 'play_by_play' | 'color';
  name: string;
  text: string;
  trigger: 'event' | 'periodic' | 'manual';
  eventType?: string;
  generationMs: number;
  audioUrl?: string;
}

const DATA_DIR = resolve(import.meta.dirname, '../../../data/commentary');
const FLAVOR_PATH = resolve(DATA_DIR, 'community-flavor.json');

// ─── CommentaryEngine ───

export class CommentaryEngine {
  private enabled = false;
  private isGenerating = false;
  private currentSpeaker: 'play_by_play' | 'color' = 'play_by_play';
  private activePreset: CommentaryPreset;
  private conversation: ConversationLine[] = [];
  private racerSnapshots = new Map<string, RacerSnapshot>();
  private pendingEvents: GameEvent[] = [];
  private commentedTopics = new Set<string>();
  private raceContext: RaceContext = { players: [] };
  private flavorEntries: FlavorEntry[] = [];
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private lastGenerationTime = 0;
  private recentPhrases: string[] = [];
  private turnCount = 0;
  private recentDeathTimes = new Map<string, number>();
  private lastEventTimePerRacer = new Map<string, number>();

  private readonly io: SocketIOServer;
  private readonly knowledgeBase: KnowledgeBaseService;
  private readonly ttsManager?: TtsServiceManager;
  private readonly config: Config;
  private chatBuffer?: ChatBuffer;

  // Runtime config (mutable)
  private periodicIntervalSec: number;
  private cooldownSec: number;
  private maxTokens: number;
  private temperature: number;
  private historySize: number;
  private kbChunksPerQuery: number;
  private model: string;

  constructor(config: Config, io: SocketIOServer, knowledgeBase: KnowledgeBaseService, ttsManager?: TtsServiceManager) {
    this.config = config;
    this.io = io;
    this.knowledgeBase = knowledgeBase;
    this.ttsManager = ttsManager;

    // Initialize from config
    this.periodicIntervalSec = config.commentary.periodicIntervalSec;
    this.cooldownSec = config.commentary.cooldownSec;
    this.maxTokens = config.commentary.maxTokens;
    this.temperature = config.commentary.temperature;
    this.historySize = config.commentary.historySize;
    this.kbChunksPerQuery = config.commentary.kbChunksPerQuery;
    this.model = config.commentary.model;

    // Load preset
    this.activePreset = getPreset(config.commentary.activePreset) ?? getPreset('classic_broadcast')!;

    // Load flavor entries
    this.loadFlavorEntries();

    logger.info('[Commentary] Engine initialized');
  }

  // ─── Public API ───

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.startPeriodicTimer();
    logger.info('[Commentary] Enabled');
  }

  disable(): void {
    this.enabled = false;
    this.stopPeriodicTimer();
    logger.info('[Commentary] Disabled');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  stop(): void {
    this.disable();
    this.pendingEvents = [];
    this.conversation = [];
    this.commentedTopics.clear();
  }

  setPreset(presetId: string): boolean {
    const preset = getPreset(presetId);
    if (!preset) return false;
    this.activePreset = preset;
    logger.info(`[Commentary] Switched to preset: ${preset.name}`);
    return true;
  }

  getActivePreset(): CommentaryPreset {
    return this.activePreset;
  }

  setRaceContext(ctx: Partial<RaceContext>): void {
    Object.assign(this.raceContext, ctx);
  }

  getRaceContext(): RaceContext {
    return this.raceContext;
  }

  updateConfig(updates: Partial<{
    periodicIntervalSec: number;
    cooldownSec: number;
    maxTokens: number;
    temperature: number;
    historySize: number;
    kbChunksPerQuery: number;
    model: string;
  }>): void {
    if (updates.periodicIntervalSec !== undefined) this.periodicIntervalSec = updates.periodicIntervalSec;
    if (updates.cooldownSec !== undefined) this.cooldownSec = updates.cooldownSec;
    if (updates.maxTokens !== undefined) this.maxTokens = updates.maxTokens;
    if (updates.temperature !== undefined) this.temperature = updates.temperature;
    if (updates.historySize !== undefined) this.historySize = updates.historySize;
    if (updates.kbChunksPerQuery !== undefined) this.kbChunksPerQuery = updates.kbChunksPerQuery;
    if (updates.model !== undefined) this.model = updates.model;

    // Restart periodic timer with new interval
    if (updates.periodicIntervalSec !== undefined && this.enabled) {
      this.stopPeriodicTimer();
      this.startPeriodicTimer();
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.model,
      periodicIntervalSec: this.periodicIntervalSec,
      cooldownSec: this.cooldownSec,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      historySize: this.historySize,
      kbChunksPerQuery: this.kbChunksPerQuery,
    };
  }

  clearState(): void {
    this.conversation = [];
    this.pendingEvents = [];
    this.commentedTopics.clear();
    this.racerSnapshots.clear();
    this.recentPhrases = [];
    this.turnCount = 0;
    this.recentDeathTimes.clear();
    this.lastEventTimePerRacer.clear();
    logger.info('[Commentary] State cleared');
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  getConversation(): ConversationLine[] {
    return [...this.conversation];
  }

  getSnapshots(): Record<string, RacerSnapshot> {
    return Object.fromEntries(this.racerSnapshots);
  }

  getIsGenerating(): boolean {
    return this.isGenerating;
  }

  // ─── Vision Update Hook ───

  onVisionUpdate(
    racerId: string,
    state: Record<string, unknown>,
    gameEvents?: Array<Record<string, unknown>>,
  ): void {
    if (!this.enabled) return;

    const prev = this.racerSnapshots.get(racerId);
    const snap = this.buildSnapshot(racerId, state);
    this.racerSnapshots.set(racerId, snap);

    // Process Python-sourced game events (more reliable than diff-based)
    if (gameEvents && gameEvents.length > 0) {
      for (const evt of gameEvents) {
        const mapped = this.mapPythonEvent(racerId, snap, evt);
        if (mapped) this.enqueueEvent(mapped);
      }
    }

    if (!prev) return; // First update, no diff possible

    // Diff-based fallback: skip event types already covered by Python events
    const pythonTypes = new Set((gameEvents ?? []).map(e => e.event as string));
    const events = this.detectEvents(racerId, prev, snap, pythonTypes);
    for (const event of events) {
      this.enqueueEvent(event);
    }
  }

  // ─── Manual Trigger ───

  async manualTrigger(prompt?: string): Promise<void> {
    if (!this.enabled || this.isGenerating) return;

    const trigger: TriggerInfo = {
      type: 'manual',
      description: prompt ?? 'Provide commentary on the current race state.',
    };

    await this.generateTurn(trigger);

    // Generate partner follow-up for manual triggers
    if (this.enabled) {
      await new Promise((r) => setTimeout(r, this.getFollowUpDelay()));
      await this.generateFollowUp(trigger);
    }
  }

  // ─── Race Summary ───

  async generateRaceSummary(): Promise<void> {
    if (!this.enabled || this.isGenerating) return;

    const trigger: TriggerInfo = {
      type: 'event',
      description: 'The race has ended! Summarize the key moments, final standings, and congratulate the winners.',
      eventType: 'race_summary',
    };

    this.currentSpeaker = 'play_by_play';
    await this.generateTurn(trigger);

    if (this.enabled) {
      await new Promise((r) => setTimeout(r, this.getFollowUpDelay()));
      await this.generateFollowUp(trigger);
    }
  }

  // ─── Flavor Entries ───

  setChatBuffer(buffer: ChatBuffer): void {
    this.chatBuffer = buffer;
  }

  loadFlavorEntries(): void {
    if (!existsSync(FLAVOR_PATH)) {
      this.flavorEntries = [];
      return;
    }
    try {
      const raw = readFileSync(FLAVOR_PATH, 'utf-8');
      const data = JSON.parse(raw) as { entries?: FlavorEntry[] };
      this.flavorEntries = data.entries ?? [];
    } catch {
      this.flavorEntries = [];
    }
  }

  getFlavorEntries(): FlavorEntry[] {
    return this.flavorEntries;
  }

  setFlavorEntries(entries: FlavorEntry[]): void {
    this.flavorEntries = entries;
  }

  // ─── Internal: Event Detection ───

  private buildSnapshot(racerId: string, state: Record<string, unknown>): RacerSnapshot {
    const displayName = (state.displayName as string)
      ?? (state.display_name as string)
      ?? this.raceContext.playerNames?.[racerId]
      ?? racerId;
    const triforce = state.triforce as boolean[] | undefined;
    const triforceCount = triforce ? triforce.filter(Boolean).length : undefined;

    return {
      racerId,
      displayName,
      screenType: (state.screen_type as string) ?? (state.screenType as string),
      hearts: (state.hearts_current as number) ?? (state.hearts as number),
      heartsMax: (state.hearts_max as number) ?? (state.heartsMax as number),
      swordLevel: (state.sword_level as number) ?? (state.swordLevel as number),
      bItem: (state.b_item as string) ?? (state.bItem as string),
      triforceCount,
      dungeonLevel: (state.dungeon_level as number) ?? (state.dungeonLevel as number),
      hasMasterKey: (state.has_master_key as boolean) ?? (state.hasMasterKey as boolean),
      gannonNearby: (state.gannon_nearby as boolean) ?? (state.gannonNearby as boolean),
      mapPosition: (state.map_position as number) ?? (state.mapPosition as number),
      rupees: state.rupees as number | undefined,
      keys: state.keys as number | undefined,
      bombs: state.bombs as number | undefined,
      inventory: state.items as Record<string, boolean> | undefined,
    };
  }

  private mapPythonEvent(
    racerId: string,
    snap: RacerSnapshot,
    evt: Record<string, unknown>,
  ): GameEvent | null {
    const name = snap.displayName;
    const eventType = evt.event as string;
    const description = evt.description as string;
    const dungeonLevel = evt.dungeon_level as number | undefined;
    const item = evt.item as string | undefined;
    const itemName = item?.replace(/_/g, ' ') ?? 'an item';

    switch (eventType) {
      case 'staircase_item_acquired':
        return {
          type: 'staircase_item_acquired',
          racerId,
          description: `${name} picked up ${itemName} from a dungeon staircase${dungeonLevel ? ` in Level ${dungeonLevel}` : ''}!`,
          priority: 'medium',
          timestamp: Date.now(),
        };
      case 'item_pickup':
        return {
          type: 'item_pickup',
          racerId,
          description: `${name} picked up ${itemName}${dungeonLevel ? ` in Level ${dungeonLevel}` : ''}.`,
          priority: 'low',
          timestamp: Date.now(),
        };
      case 'item_drop':
        return {
          type: 'item_drop',
          racerId,
          description: `An enemy dropped ${itemName} near ${name}.`,
          priority: 'low',
          timestamp: Date.now(),
        };
      case 'triforce_inferred': {
        const key = `triforce:${racerId}:${description}`;
        if (this.commentedTopics.has(key)) return null;
        this.commentedTopics.add(key);
        return {
          type: 'triforce',
          racerId,
          description: `${name} collected a triforce piece! ${description}`,
          priority: 'high',
          timestamp: Date.now(),
        };
      }
      case 'death': {
        const lastDeath = this.recentDeathTimes.get(racerId);
        if (lastDeath && (Date.now() - lastDeath) < 30_000) return null;
        this.recentDeathTimes.set(racerId, Date.now());
        return {
          type: 'death',
          racerId,
          description: `${name} just died!${dungeonLevel ? ` In Level ${dungeonLevel}.` : ''}`,
          priority: 'high',
          timestamp: Date.now(),
        };
      }
      case 'heart_container':
        return {
          type: 'heart_container',
          racerId,
          description: `${name} got a heart container!`,
          priority: 'medium',
          timestamp: Date.now(),
        };
      case 'game_complete': {
        const key = `complete:${racerId}`;
        if (this.commentedTopics.has(key)) return null;
        this.commentedTopics.add(key);
        return {
          type: 'game_complete',
          racerId,
          description: `${name} has completed the game!`,
          priority: 'high',
          timestamp: Date.now(),
        };
      }
      case 'ganon_fight': {
        const key = `ganon:${racerId}`;
        if (this.commentedTopics.has(key)) return null;
        this.commentedTopics.add(key);
        return {
          type: 'ganon_nearby',
          racerId,
          description: `${name} is fighting Ganon in Level 9!`,
          priority: 'high',
          timestamp: Date.now(),
        };
      }
      case 'ganon_kill':
        return {
          type: 'ganon_kill',
          racerId,
          description: `${name} defeated Ganon!`,
          priority: 'high',
          timestamp: Date.now(),
        };
      case 'up_a_warp':
        return {
          type: 'up_a_warp',
          racerId,
          description: `${name} used Up+A to warp back to start.`,
          priority: 'low',
          timestamp: Date.now(),
        };
      case 'dungeon_first_visit': {
        const key = `dungeon:${racerId}:${dungeonLevel}`;
        if (this.commentedTopics.has(key)) return null;
        this.commentedTopics.add(key);
        return {
          type: 'dungeon_entry',
          racerId,
          description: `${name} entered Level ${dungeonLevel} for the first time.`,
          priority: 'medium',
          timestamp: Date.now(),
        };
      }
      case 'sword_upgrade':
        return {
          type: 'sword_upgrade',
          racerId,
          description: `${name}: ${description}`,
          priority: 'medium',
          timestamp: Date.now(),
        };
      default:
        return null; // Ignore subscreen_open, b_item_change (low commentary value)
    }
  }

  private detectEvents(racerId: string, prev: RacerSnapshot, curr: RacerSnapshot, pythonTypes?: Set<string>): GameEvent[] {
    const events: GameEvent[] = [];
    const name = curr.displayName;

    // Triforce gained (HIGH) — skip if Python already sent triforce_inferred
    if (!pythonTypes?.has('triforce_inferred') && curr.triforceCount !== undefined && prev.triforceCount !== undefined && curr.triforceCount > prev.triforceCount) {
      const key = `triforce:${racerId}:${curr.triforceCount}`;
      if (!this.commentedTopics.has(key)) {
        this.commentedTopics.add(key);
        events.push({
          type: 'triforce',
          racerId,
          description: `${name} collected triforce piece #${curr.triforceCount}! They now have ${curr.triforceCount}/8.`,
          priority: 'high',
          timestamp: Date.now(),
        });
      }
    }

    // Death — hearts dropped to 0 (HIGH, 30s dedup) — skip if Python already sent death
    if (!pythonTypes?.has('death') && curr.hearts === 0 && prev.hearts !== undefined && prev.hearts > 0) {
      const lastDeath = this.recentDeathTimes.get(racerId);
      if (!lastDeath || (Date.now() - lastDeath) > 30_000) {
        this.recentDeathTimes.set(racerId, Date.now());
        events.push({
          type: 'death',
          racerId,
          description: `${name} just died!${curr.dungeonLevel ? ` In Level ${curr.dungeonLevel}.` : ''}`,
          priority: 'high',
          timestamp: Date.now(),
        });
      }
    }

    // Game complete (HIGH) — skip if Python already sent game_complete
    if (!pythonTypes?.has('game_complete') && curr.screenType === 'credits' && prev.screenType !== 'credits') {
      const key = `complete:${racerId}`;
      if (!this.commentedTopics.has(key)) {
        this.commentedTopics.add(key);
        events.push({
          type: 'game_complete',
          racerId,
          description: `${name} has completed the game!`,
          priority: 'high',
          timestamp: Date.now(),
        });
      }
    }

    // New dungeon (MEDIUM) — skip if Python already sent dungeon_first_visit
    if (!pythonTypes?.has('dungeon_first_visit') && curr.dungeonLevel && curr.dungeonLevel > 0 && curr.dungeonLevel !== prev.dungeonLevel) {
      const key = `dungeon:${racerId}:${curr.dungeonLevel}`;
      if (!this.commentedTopics.has(key)) {
        this.commentedTopics.add(key);
        events.push({
          type: 'dungeon_entry',
          racerId,
          description: `${name} entered Level ${curr.dungeonLevel}.`,
          priority: 'medium',
          timestamp: Date.now(),
        });
      }
    }

    // Sword upgrade (MEDIUM) — skip if Python already sent sword_upgrade
    if (!pythonTypes?.has('sword_upgrade') && curr.swordLevel !== undefined && prev.swordLevel !== undefined && curr.swordLevel > prev.swordLevel) {
      const names = ['', 'Wood Sword', 'White Sword', 'Magical Sword'];
      events.push({
        type: 'sword_upgrade',
        racerId,
        description: `${name} got the ${names[curr.swordLevel] ?? `sword level ${curr.swordLevel}`}!`,
        priority: 'medium',
        timestamp: Date.now(),
      });
    }

    // B-item change (MEDIUM) — skip if Python already sent b_item_change
    if (!pythonTypes?.has('b_item_change') && curr.bItem && curr.bItem !== 'none' && curr.bItem !== 'unknown' && curr.bItem !== prev.bItem) {
      events.push({
        type: 'b_item_change',
        racerId,
        description: `${name} switched to ${curr.bItem} as their B-item.`,
        priority: 'low',
        timestamp: Date.now(),
      });
    }

    // Ganon nearby (MEDIUM) — skip if Python already sent ganon_fight
    if (!pythonTypes?.has('ganon_fight') && curr.gannonNearby && !prev.gannonNearby) {
      const key = `ganon:${racerId}`;
      if (!this.commentedTopics.has(key)) {
        this.commentedTopics.add(key);
        events.push({
          type: 'ganon_nearby',
          racerId,
          description: `${name} is approaching Ganon in Level 9!`,
          priority: 'medium',
          timestamp: Date.now(),
        });
      }
    }

    return events;
  }

  private enqueueEvent(event: GameEvent): void {
    const isHighPriority = event.priority === 'high';

    // Per-racer rate limit: drop non-high events if same racer had event < 10s ago
    if (!isHighPriority) {
      const lastTime = this.lastEventTimePerRacer.get(event.racerId);
      if (lastTime !== undefined && (Date.now() - lastTime) < 10_000) {
        return;
      }
    }

    this.pendingEvents.push(event);
    this.lastEventTimePerRacer.set(event.racerId, Date.now());

    // Discard stale events (>30s)
    const cutoff = Date.now() - 30_000;
    this.pendingEvents = this.pendingEvents.filter((e) => e.timestamp > cutoff);

    // Max queue depth: 5. Evict oldest non-high event when exceeded.
    if (this.pendingEvents.length > 5) {
      const idx = this.pendingEvents.findIndex(e => e.priority !== 'high');
      if (idx !== -1) this.pendingEvents.splice(idx, 1);
      else this.pendingEvents.shift();
    }

    this.processQueue();
  }

  // ─── Internal: Generation Loop ───

  private async processQueue(): Promise<void> {
    if (this.isGenerating || !this.enabled) return;

    // Check cooldown
    const elapsed = Date.now() - this.lastGenerationTime;
    const cooldownMs = this.cooldownSec * 1000;

    // High-priority events skip cooldown
    const highPriority = this.pendingEvents.find((e) => e.priority === 'high');
    if (!highPriority && elapsed < cooldownMs) return;

    // Pick the highest priority event
    const event = highPriority ?? this.pendingEvents.shift();
    if (!event) return;

    // Remove the event from queue
    this.pendingEvents = this.pendingEvents.filter((e) => e !== event);

    const trigger: TriggerInfo = {
      type: 'event',
      description: event.description,
      eventType: event.type,
      racerId: event.racerId,
    };

    // High-priority → play-by-play first; otherwise alternate
    if (event.priority === 'high') {
      this.currentSpeaker = 'play_by_play';
    }

    await this.generateTurn(trigger);

    // Conditional follow-up
    if (this.shouldFollowUp(event) && this.enabled) {
      await new Promise((r) => setTimeout(r, this.getFollowUpDelay()));
      await this.generateFollowUp(trigger);
    }
  }

  private shouldFollowUp(event: GameEvent): boolean {
    switch (event.type) {
      case 'game_complete':
      case 'ganon_nearby':
      case 'ganon_kill':
        return true;
      case 'death':
        return false; // one call is enough
      case 'triforce': {
        // Find the racer's current triforce count
        const snap = this.racerSnapshots.get(event.racerId);
        return (snap?.triforceCount ?? 0) >= 3;
      }
      case 'staircase_item_acquired': {
        const desc = event.description.toLowerCase();
        return desc.includes('bow') || desc.includes('sword') || desc.includes('candle')
          || desc.includes('ladder') || desc.includes('raft');
      }
      default:
        return event.priority === 'high';
    }
  }

  private getFollowUpDelay(): number {
    return (this.ttsManager && this.config.tts.enabled) ? 5000 : 3000;
  }

  private async generateTurn(trigger: TriggerInfo): Promise<void> {
    if (this.isGenerating) return;
    this.isGenerating = true;

    try {
      const persona = this.currentSpeaker === 'play_by_play'
        ? this.activePreset.playByPlay
        : this.activePreset.color;
      const partner = this.currentSpeaker === 'play_by_play'
        ? this.activePreset.color
        : this.activePreset.playByPlay;

      // Fetch KB context
      const kbContext = await this.fetchKBContext(trigger);

      // Select relevant flavor entries
      const flavorEntries = this.selectFlavor(trigger);

      // Build prompt
      const chatContext = this.chatBuffer?.getSummary(10) || undefined;
      const prompt = buildPrompt({
        persona,
        partnerName: partner.name,
        raceContext: this.raceContext,
        racerSnapshots: Array.from(this.racerSnapshots.values()),
        kbContext,
        flavorEntries,
        conversation: this.conversation.slice(-this.historySize),
        trigger,
        recentPhrases: this.recentPhrases,
        turnCount: this.turnCount,
        chatContext,
      });

      // Generate via Ollama
      const startMs = Date.now();
      const text = await this.generate(prompt);
      const generationMs = Date.now() - startMs;

      if (text) {
        // Track for anti-repetition
        this.recentPhrases.push(text);
        if (this.recentPhrases.length > 10) this.recentPhrases.shift();
        this.turnCount++;
        // Synthesize TTS audio
        let audioUrl: string | undefined;
        if (this.ttsManager && this.config.tts.enabled) {
          const voice = persona.voiceId ?? this.config.tts.voices[this.currentSpeaker];
          const filename = await this.ttsManager.synthesize(text, voice);
          if (filename) audioUrl = `/tts/${filename}`;
        }

        // Add to conversation
        this.conversation.push({
          persona: this.currentSpeaker,
          name: persona.name,
          text,
          timestamp: Date.now(),
        });

        // Trim conversation history
        if (this.conversation.length > this.historySize * 2) {
          this.conversation = this.conversation.slice(-this.historySize);
        }

        // Emit to clients
        const event: CommentaryTextEvent = {
          persona: this.currentSpeaker,
          name: persona.name,
          text,
          trigger: trigger.type,
          eventType: trigger.eventType,
          generationMs,
          audioUrl,
        };
        this.io.to('overlay').emit('commentary:text', event);
        this.io.to('commentary').emit('commentary:text', event);

        logger.info(`[Commentary] [${persona.name}] ${text} (${generationMs}ms${audioUrl ? ', +audio' : ''})`);
      }

      // Alternate speaker for next turn
      this.currentSpeaker = this.currentSpeaker === 'play_by_play' ? 'color' : 'play_by_play';
      this.lastGenerationTime = Date.now();
    } catch (err) {
      logger.error('[Commentary] Generation error', { err });
    } finally {
      this.isGenerating = false;
    }
  }

  private async generateFollowUp(trigger: TriggerInfo): Promise<void> {
    if (this.isGenerating || !this.enabled) return;
    this.isGenerating = true;

    try {
      const persona = this.currentSpeaker === 'play_by_play'
        ? this.activePreset.playByPlay
        : this.activePreset.color;
      const partner = this.currentSpeaker === 'play_by_play'
        ? this.activePreset.color
        : this.activePreset.playByPlay;

      const lastLine = this.conversation[this.conversation.length - 1]?.text ?? '';

      const kbContext = await this.fetchKBContext(trigger);
      const flavorEntries = this.selectFlavor(trigger);
      const reactionType = getRandomReactionType();

      const chatContext = this.chatBuffer?.getSummary(10) || undefined;
      const prompt = buildPrompt({
        persona,
        partnerName: partner.name,
        raceContext: this.raceContext,
        racerSnapshots: Array.from(this.racerSnapshots.values()),
        kbContext,
        flavorEntries,
        conversation: this.conversation.slice(-this.historySize),
        trigger,
        isFollowUp: true,
        partnerLastLine: lastLine,
        recentPhrases: this.recentPhrases,
        turnCount: this.turnCount,
        reactionType,
        chatContext,
      });

      const startMs = Date.now();
      const text = await this.generate(prompt);
      const generationMs = Date.now() - startMs;

      // Check for [PASS]
      if (text && !text.includes('[PASS]')) {
        // Track for anti-repetition
        this.recentPhrases.push(text);
        if (this.recentPhrases.length > 10) this.recentPhrases.shift();
        this.turnCount++;
        // Synthesize TTS audio
        let audioUrl: string | undefined;
        if (this.ttsManager && this.config.tts.enabled) {
          const voice = persona.voiceId ?? this.config.tts.voices[this.currentSpeaker];
          const filename = await this.ttsManager.synthesize(text, voice);
          if (filename) audioUrl = `/tts/${filename}`;
        }

        this.conversation.push({
          persona: this.currentSpeaker,
          name: persona.name,
          text,
          timestamp: Date.now(),
        });

        if (this.conversation.length > this.historySize * 2) {
          this.conversation = this.conversation.slice(-this.historySize);
        }

        const event: CommentaryTextEvent = {
          persona: this.currentSpeaker,
          name: persona.name,
          text,
          trigger: trigger.type,
          eventType: trigger.eventType,
          generationMs,
          audioUrl,
        };
        this.io.to('overlay').emit('commentary:text', event);
        this.io.to('commentary').emit('commentary:text', event);

        logger.info(`[Commentary] [${persona.name}] (follow-up) ${text} (${generationMs}ms${audioUrl ? ', +audio' : ''})`);
      }

      this.currentSpeaker = this.currentSpeaker === 'play_by_play' ? 'color' : 'play_by_play';
      this.lastGenerationTime = Date.now();
    } catch (err) {
      logger.error('[Commentary] Follow-up generation error', { err });
    } finally {
      this.isGenerating = false;
    }
  }

  // ─── Internal: Ollama Generation ───

  private async generate(prompt: string): Promise<string | null> {
    const ollamaUrl = this.config.commentary.ollamaUrl;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const resp = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            num_predict: this.maxTokens,
            temperature: this.temperature,
          },
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text();
        logger.error(`[Commentary] Ollama error: ${resp.status} ${body}`);
        return null;
      }

      const data = await resp.json() as { response?: string };
      const text = data.response?.trim();
      return text || null;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.warn('[Commentary] Ollama generation timed out (30s)');
      } else {
        logger.error('[Commentary] Ollama fetch error', { err });
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Internal: KB + Flavor ───

  private async fetchKBContext(trigger: TriggerInfo): Promise<string[]> {
    try {
      const query = this.buildKBQuery(trigger);
      const results = await this.knowledgeBase.query(query, { nResults: this.kbChunksPerQuery });
      return results.map((r) => `[${r.pageTitle}] ${r.text.substring(0, 500)}`);
    } catch {
      return [];
    }
  }

  private buildKBQuery(trigger: TriggerInfo): string {
    switch (trigger.eventType) {
      case 'triforce':
        return 'triforce collection strategy dungeon completion';
      case 'death':
        return 'death recovery strategy save continue restart';
      case 'dungeon_entry': {
        const level = trigger.description?.match(/Level (\d)/)?.[1] ?? '';
        return `Level ${level} dungeon strategy items boss`;
      }
      case 'ganon_nearby':
        return 'Ganon fight silver arrows endgame strategy';
      case 'sword_upgrade':
        return 'sword upgrade damage progression';
      case 'game_complete':
        return 'game completion race finish celebration';
      case 'staircase_item_acquired':
        return `staircase item dungeon strategy ${trigger.description}`;
      case 'item_pickup':
        return `item pickup strategy ${trigger.description}`;
      case 'heart_container':
        return 'heart container health upgrade progression';
      case 'up_a_warp':
        return 'Up+A warp save continue strategy';
      case 'ganon_kill':
        return 'Ganon defeated endgame victory';
      default:
        if (trigger.type === 'periodic') {
          // Base on current game state
          const snaps = Array.from(this.racerSnapshots.values());
          const inDungeon = snaps.some((s) => s.dungeonLevel && s.dungeonLevel > 0);
          if (inDungeon) return 'dungeon routing strategy items progression';
          return 'overworld exploration routing item locations';
        }
        // Default: use trigger description + flags
        const parts: string[] = [];
        if (trigger.description) parts.push(trigger.description);
        if (this.raceContext.flags) parts.push(`flags: ${this.raceContext.flags}`);
        return parts.join(' ') || 'Z1R race commentary';
    }
  }

  private selectFlavor(trigger: TriggerInfo): FlavorEntry[] {
    if (this.flavorEntries.length === 0) return [];

    const eventType = trigger.eventType ?? '';
    const desc = (trigger.description ?? '').toLowerCase();

    // Score each entry by tag relevance
    const scored = this.flavorEntries.map((entry) => {
      let score = 0;
      for (const tag of entry.tags) {
        if (eventType.includes(tag)) score += 2;
        if (desc.includes(tag)) score += 1;
      }
      return { entry, score };
    });

    // Return top 1-3 entries with score > 0
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => s.entry);
  }

  // ─── Internal: Periodic Timer ───

  private startPeriodicTimer(): void {
    this.stopPeriodicTimer();
    this.periodicTimer = setInterval(() => {
      if (!this.enabled || this.isGenerating) return;
      if (this.racerSnapshots.size === 0) return; // No race data yet

      const elapsed = Date.now() - this.lastGenerationTime;
      if (elapsed < this.cooldownSec * 1000) return;

      // Alternate commentators on periodic ticks (don't force one speaker)
      const trigger: TriggerInfo = { type: 'periodic' };
      this.generateTurn(trigger);
    }, this.periodicIntervalSec * 1000);
  }

  private stopPeriodicTimer(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}
