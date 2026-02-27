import type { CommentatorPersona } from './personas.js';

// ─── Types ───

export interface RacerSnapshot {
  racerId: string;
  displayName: string;
  screenType?: string;
  hearts?: number;
  heartsMax?: number;
  swordLevel?: number;
  bItem?: string;
  triforceCount?: number;
  dungeonLevel?: number;
  hasMasterKey?: boolean;
  gannonNearby?: boolean;
  mapPosition?: number;
  rupees?: number;
  keys?: number;
  bombs?: number;
  inventory?: Record<string, boolean>;
}

export interface ConversationLine {
  persona: 'play_by_play' | 'color';
  name: string;
  text: string;
  timestamp: number;
}

export interface FlavorEntry {
  id: string;
  text: string;
  tags: string[];
  context: string;
}

export interface PlayerStats {
  leaderboardPlace?: number;
  leaderboardScore?: number;
  bestTime?: string;
  timesRaced?: number;
}

export interface RacerStanding {
  racerId: string;
  displayName: string;
  status: 'racing' | 'finished' | 'forfeit';
  place?: number;
  finishTime?: string;
}

export interface RaceContext {
  players: string[];
  playerNames?: Record<string, string>; // racerId → display name
  flags?: string;
  tournament?: string;
  elapsedTime?: string;
  goal?: string;
  raceUrl?: string;
  raceStartedAt?: string; // ISO date — elapsed time computed dynamically
  playerStats?: Record<string, PlayerStats>;
  standings?: RacerStanding[];
}

export interface TriggerInfo {
  type: 'event' | 'periodic' | 'manual';
  description?: string;
  eventType?: string;
  racerId?: string;
}

export interface PromptParams {
  persona: CommentatorPersona;
  partnerName: string;
  raceContext: RaceContext;
  racerSnapshots: RacerSnapshot[];
  kbContext: string[];
  flavorEntries: FlavorEntry[];
  conversation: ConversationLine[];
  trigger: TriggerInfo;
  isFollowUp?: boolean;
  partnerLastLine?: string;
  recentPhrases?: string[];
  turnCount?: number;
  reactionType?: string;
  chatContext?: string;
}

// ─── Reaction Types ───

const REACTION_TYPES = [
  { id: 'agree_elaborate', instruction: 'Build on what your partner said with additional depth.' },
  { id: 'respectful_disagree', instruction: 'Offer a different take or alternative interpretation.' },
  { id: 'add_context', instruction: 'Connect this to Z1R history or strategy.' },
  { id: 'redirect_focus', instruction: 'Shift attention to something else — another racer, a detail.' },
  { id: 'playful_challenge', instruction: 'Playfully question your partner\'s take.' },
  { id: 'build_suspense', instruction: 'Look ahead — what could happen next?' },
];

export function getRandomReactionType(): string {
  const r = REACTION_TYPES[Math.floor(Math.random() * REACTION_TYPES.length)];
  return r.id;
}

function getReactionInstruction(reactionId: string): string {
  return REACTION_TYPES.find((r) => r.id === reactionId)?.instruction ?? '';
}

// ─── Prompt Builder ───

export function buildPrompt(params: PromptParams): string {
  const parts: string[] = [];

  // System persona
  parts.push(params.persona.systemPrompt);

  // Race context
  parts.push('\nRACE CONTEXT:');
  if (params.raceContext.tournament) {
    parts.push(`Tournament: ${params.raceContext.tournament}`);
  }
  if (params.raceContext.goal) {
    parts.push(`Goal: ${params.raceContext.goal}`);
  }

  // Player names with leaderboard stats
  const playerNames = params.raceContext.players.map((id) => {
    const name = params.raceContext.playerNames?.[id] ?? id;
    const stats = params.raceContext.playerStats?.[id];
    if (stats?.leaderboardPlace) {
      return `${name} (ranked #${stats.leaderboardPlace}, ${stats.timesRaced ?? '?'} races)`;
    }
    return name;
  });
  parts.push(`Players: ${playerNames.join(', ')}`);

  if (params.raceContext.flags) {
    parts.push(`Flags: ${params.raceContext.flags}`);
  }

  // Dynamic elapsed time
  const elapsed = computeElapsedTime(params.raceContext);
  if (elapsed) {
    parts.push(`Elapsed: ${elapsed}`);
  } else if (params.raceContext.elapsedTime) {
    parts.push(`Elapsed: ${params.raceContext.elapsedTime}`);
  }

  // Standings
  if (params.raceContext.standings && params.raceContext.standings.length > 0) {
    const standingLines = params.raceContext.standings.map((s) => {
      if (s.status === 'finished') return `  ${s.displayName}: FINISHED ${s.place ? `(${ordinal(s.place)})` : ''} ${s.finishTime ?? ''}`;
      if (s.status === 'forfeit') return `  ${s.displayName}: FORFEIT`;
      return `  ${s.displayName}: Racing`;
    });
    parts.push(`Standings:\n${standingLines.join('\n')}`);
  }

  // Current game state
  if (params.racerSnapshots.length > 0) {
    parts.push('\nCURRENT GAME STATE:');
    for (const snap of params.racerSnapshots) {
      parts.push(formatRacerSnapshot(snap));
    }
  }

  // Race analysis (comparative)
  const analysis = buildRaceAnalysis(params.racerSnapshots, params.raceContext);
  if (analysis) {
    parts.push(analysis);
  }

  // Variety rules
  const varietySection = buildVarietySection(params.recentPhrases, params.turnCount);
  if (varietySection) {
    parts.push(varietySection);
  }

  // KB context
  if (params.kbContext.length > 0) {
    parts.push('\nZ1R KNOWLEDGE (weave these facts into your commentary naturally — do not read verbatim):');
    for (const chunk of params.kbContext) {
      parts.push(chunk);
    }
  }

  // Community flavor
  if (params.flavorEntries.length > 0) {
    parts.push('\nCOMMUNITY REFERENCES (weave in naturally if relevant, don\'t force):');
    for (const entry of params.flavorEntries) {
      parts.push(`- "${entry.text}" (${entry.context})`);
    }
  }

  // Viewer chat context
  if (params.chatContext) {
    parts.push('\nVIEWER CHAT (reference naturally, address questions if relevant):');
    parts.push(params.chatContext);
  }

  // Conversation history
  if (params.conversation.length > 0) {
    parts.push(`\nRECENT BROADCAST (you are ${params.persona.name}, your partner is ${params.partnerName}):`);
    for (const line of params.conversation) {
      parts.push(`[${line.name}] "${line.text}"`);
    }
  }

  // Trigger instruction
  parts.push('');

  // Flagset explanation for early periodic
  if (params.trigger.type === 'periodic' && (params.turnCount ?? 0) < 3) {
    parts.push('This is early in the broadcast. Help the audience understand what they\'re watching: the flagset, what makes these flags interesting, and how the runners might approach this seed.');
  }

  if (params.isFollowUp && params.partnerLastLine) {
    parts.push(`Your partner ${params.partnerName} just said: "${params.partnerLastLine}"`);
    const reactionInstr = params.reactionType ? getReactionInstruction(params.reactionType) : '';
    if (reactionInstr) {
      parts.push(reactionInstr);
    } else {
      parts.push('Add insight or react if you have something meaningful to say.');
    }
    parts.push('If the moment has passed or there\'s nothing to add, respond with exactly: [PASS]');
  } else if (params.trigger.type === 'event' && params.trigger.description) {
    parts.push(`EVENT: ${params.trigger.description}`);
    parts.push('Call this moment for the audience.');
  } else if (params.trigger.type === 'periodic') {
    parts.push('Provide color commentary on the current state of the race. What\'s interesting right now?');
  } else if (params.trigger.type === 'manual' && params.trigger.description) {
    parts.push(`TOPIC: ${params.trigger.description}`);
    parts.push('Comment on this topic.');
  } else {
    parts.push('Provide commentary on the current race situation.');
  }

  parts.push(`\nRespond as ${params.persona.name}. 1-3 sentences, under 100 words. Do not include your name as a prefix.`);

  return parts.join('\n');
}

// ─── Race Analysis ───

function buildRaceAnalysis(snapshots: RacerSnapshot[], ctx: RaceContext): string | null {
  if (snapshots.length < 2) return null;

  const lines: string[] = ['\nRACE ANALYSIS:'];

  // Matchup — leaderboard ranks
  if (ctx.playerStats) {
    const ranked = snapshots
      .filter((s) => ctx.playerStats![s.racerId]?.leaderboardPlace)
      .map((s) => `${s.displayName} is ranked #${ctx.playerStats![s.racerId].leaderboardPlace}`);
    if (ranked.length > 0) {
      lines.push(`  Matchup: ${ranked.join(', ')} on the Z1R leaderboard`);
    }
  }

  // Triforce comparison
  const triforceLines = snapshots
    .filter((s) => s.triforceCount !== undefined)
    .map((s) => `${s.displayName} ${s.triforceCount}/8`);
  if (triforceLines.length > 0) {
    lines.push(`  Triforce: ${triforceLines.join(' vs ')}`);
  }

  // Key items
  const itemLines = snapshots.map((s) => {
    const items: string[] = [];
    if (s.swordLevel && s.swordLevel > 0) {
      const names = ['', 'Wood', 'White', 'Magical'];
      items.push(names[s.swordLevel] ?? `L${s.swordLevel}`);
    }
    if (s.bItem && s.bItem !== 'none' && s.bItem !== 'unknown') items.push(s.bItem);
    if (s.hasMasterKey) items.push('Master Key');
    return items.length > 0 ? `${s.displayName}: ${items.join(', ')}` : null;
  }).filter(Boolean);
  if (itemLines.length > 0) {
    lines.push(`  Key items: ${itemLines.join(' | ')}`);
  }

  // Standings (finished/forfeit)
  if (ctx.standings) {
    const done = ctx.standings.filter((s) => s.status !== 'racing');
    if (done.length > 0) {
      const doneLines = done.map((s) =>
        s.status === 'finished' ? `${s.displayName} FINISHED${s.place ? ` (${ordinal(s.place)})` : ''}` : `${s.displayName} FORFEIT`
      );
      lines.push(`  Race results: ${doneLines.join(', ')}`);
    }
  }

  // Inventory comparison
  const invLines = snapshots.map((s) => {
    if (!s.inventory) return null;
    const obtained = Object.entries(s.inventory)
      .filter(([_, has]) => has)
      .map(([name]) => name.replace(/_/g, ' '));
    return obtained.length > 0 ? `${s.displayName}: ${obtained.join(', ')}` : null;
  }).filter(Boolean);
  if (invLines.length > 0) {
    lines.push(`  Inventory: ${invLines.join(' | ')}`);
  }

  lines.push('  Note: Dungeon numbers do NOT indicate progress — dungeons are shuffled in Z1R. A player in L8 with 2 triforce is behind a player in L3 with 5 triforce.');

  return lines.length > 2 ? lines.join('\n') : null;
}

// ─── Variety Section ───

function buildVarietySection(recentPhrases?: string[], turnCount?: number): string | null {
  const tc = turnCount ?? 0;
  const lines: string[] = ['\nVARIETY RULES:'];
  lines.push('- Vary sentence structure and word choice. Never start the same way as a recent line.');

  if (recentPhrases && recentPhrases.length > 0) {
    const truncated = recentPhrases.slice(-5).map((p) => p.substring(0, 50));
    lines.push(`- Recent commentary to avoid repeating: ${truncated.map((t) => `"${t}..."`).join(', ')}`);
  }

  if (tc <= 3) {
    lines.push('- Broadcast phase: OPENING. Set the scene, introduce runners and their rankings, explain the flagset and what makes it interesting. Dungeon locations are shuffled — dungeon numbers do NOT indicate progression. Triforce count and key items are the true measures.');
  } else if (tc <= 10) {
    lines.push('- Broadcast phase: MID-BROADCAST. Focus on developing narratives. Who found key items? Who has more triforce? What required items (Bow, Silver Arrows) are still needed?');
  } else {
    lines.push('- Broadcast phase: DEEP. Build callbacks, reference earlier moments, track how the race narrative has evolved.');
  }

  return lines.join('\n');
}

// ─── Helpers ───

function computeElapsedTime(ctx: RaceContext): string | null {
  if (!ctx.raceStartedAt) return null;
  const start = new Date(ctx.raceStartedAt).getTime();
  if (isNaN(start)) return null;
  const diff = Date.now() - start;
  if (diff < 0) return null;
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatRacerSnapshot(snap: RacerSnapshot): string {
  const parts: string[] = [`  ${snap.displayName}:`];
  const details: string[] = [];

  if (snap.screenType) details.push(`screen=${snap.screenType}`);
  if (snap.hearts !== undefined && snap.heartsMax !== undefined) {
    details.push(`hearts=${snap.hearts}/${snap.heartsMax}`);
  }
  if (snap.swordLevel !== undefined && snap.swordLevel > 0) {
    const names = ['', 'Wood', 'White', 'Magical'];
    details.push(`sword=${names[snap.swordLevel] ?? `L${snap.swordLevel}`}`);
  }
  if (snap.bItem && snap.bItem !== 'none' && snap.bItem !== 'unknown') {
    details.push(`b-item=${snap.bItem}`);
  }
  if (snap.triforceCount !== undefined && snap.triforceCount > 0) {
    details.push(`triforce=${snap.triforceCount}/8`);
  }
  if (snap.dungeonLevel !== undefined && snap.dungeonLevel > 0) {
    details.push(`in Level ${snap.dungeonLevel}`);
  }
  if (snap.hasMasterKey) details.push('has master key');
  if (snap.gannonNearby) details.push('GANON NEARBY');
  if (snap.inventory) {
    const obtained = Object.entries(snap.inventory)
      .filter(([_, has]) => has)
      .map(([name]) => name.replace(/_/g, ' '));
    if (obtained.length > 0) {
      details.push(`inventory: ${obtained.join(', ')}`);
    }
  }

  parts.push(`    ${details.join(', ')}`);
  return parts.join('\n');
}
