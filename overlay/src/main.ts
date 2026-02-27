import { io, type Socket } from 'socket.io-client';

// ─── Types ───

interface RacerState {
  racerId: string;
  displayName: string;
  slot: number;
  status: 'racing' | 'finished' | 'forfeit' | 'dq';
  finishTime?: string;
  finishPlace?: number;
  // Vision data
  hearts?: { current: number; max: number; hasHalf: boolean };
  items?: Record<string, boolean>;
  triforce?: boolean[];
  screenType?: string;
  rupees?: number;
  keys?: number;
  bombs?: number;
  swordLevel?: number;
  b_item?: string;
  hasMasterKey?: boolean;
  gannonNearby?: boolean;
  mapPosition?: number;
  bombMax?: number;
  sword_level?: number; // snake_case from Python
  hearts_current?: number;
  hearts_max?: number;
  has_half_heart?: boolean;
  screen_type?: string;
}

// ─── Item Tracker Constants ───

const ITEM_SPRITE_FILES: Record<string, string> = {
  boomerang: 'boomerang.png',
  magic_boomerang: 'magical_boomerang.png',
  bow: 'bow.png',
  blue_candle: 'blue_candle.png',
  red_candle: 'red_candle.png',
  recorder: 'recorder.png',
  food: 'bait.png',
  letter: 'letter.png',
  blue_potion: 'potion_blue.png',
  red_potion: 'potion_red.png',
  magic_rod: 'wand.png',
  raft: 'raft.png',
  book: 'book_of_magic.png',
  blue_ring: 'blue_ring.png',
  red_ring: 'red_ring.png',
  ladder: 'stepladder.png',
  magic_key: 'magical_key.png',
  power_bracelet: 'power_bracelet.png',
};

const SWORD_NAMES = ['', 'Wood', 'White', 'Magical'];

// Per-runner HUD items (6 routing-critical + arrows type detection)
const HUD_ITEMS = ['bow', 'ladder', 'power_bracelet', 'raft', 'recorder'] as const;

// Track previous triforce states for piece-pop animation
const previousTriforceStates = new Map<string, boolean>();

interface OverlayState {
  raceActive: boolean;
  raceStartedAt?: string;
  clockOffsetMs: number;
  racers: RacerState[];
}

// ─── State ───

const state: OverlayState = {
  raceActive: false,
  clockOffsetMs: 0,
  racers: [],
};

// Parse URL params
const params = new URLSearchParams(window.location.search);
const racerCount = parseInt(params.get('racers') ?? '2', 10);

// Layout routing
type LayoutType = 'race' | 'featured' | 'standalone' | 'clean' | 'replay';
const layout = (params.get('layout') ?? 'race') as LayoutType;
const showSeedTracker = params.get('seed_tracker') !== '0' && layout !== 'clean';
const showMap = params.get('map') !== '0' && layout !== 'clean';
const showTriforceBar = params.get('triforce_bar') !== '0' && layout !== 'clean';

// Background option
const bgParam = params.get('bg') ?? 'transparent';
if (bgParam !== 'transparent') {
  document.getElementById('overlay')!.classList.add(`bg-${bgParam}`);
}

// ─── Socket Connection ───

const serverUrl = params.get('server') ?? window.location.origin;
const socket: Socket = io(serverUrl, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
});

socket.on('connect', () => {
  console.log('[TTP Overlay] Connected to server');
  socket.emit('join', 'overlay');
});

socket.on('disconnect', () => {
  console.log('[TTP Overlay] Disconnected from server');
});

// Listen for state updates
socket.on('overlay:state', (data: OverlayState) => {
  // Detect race end transition
  if (!data.raceActive && state.raceActive) {
    onRaceEnd();
  }
  Object.assign(state, data);
  render();
  // Start timer if race is active (handles late-connecting overlay)
  if (state.raceActive && state.raceStartedAt) {
    updateRaceStatus('RACING', 'racing');
  }
});

socket.on('vision:update', (data: { racerId: string } & Record<string, unknown>) => {
  const racer = state.racers.find((r) => r.racerId === data.racerId);
  if (racer) {
    // Normalize snake_case fields from Python vision engine
    if (data.hearts_current !== undefined || data.hearts_max !== undefined) {
      racer.hearts = {
        current: (data.hearts_current as number) ?? racer.hearts?.current ?? 0,
        max: (data.hearts_max as number) ?? racer.hearts?.max ?? 3,
        hasHalf: (data.has_half_heart as boolean) ?? racer.hearts?.hasHalf ?? false,
      };
    }
    if (data.sword_level !== undefined) {
      racer.swordLevel = data.sword_level as number;
    }
    if (data.screen_type !== undefined) {
      racer.screenType = data.screen_type as string;
    }
    // Direct fields
    if (data.rupees !== undefined) racer.rupees = data.rupees as number;
    if (data.keys !== undefined) racer.keys = data.keys as number;
    if (data.bombs !== undefined) racer.bombs = data.bombs as number;
    if (data.items !== undefined) racer.items = data.items as Record<string, boolean>;
    if (data.triforce !== undefined) racer.triforce = data.triforce as boolean[];
    if (data.b_item !== undefined) racer.b_item = data.b_item as string;
    if (data.has_master_key !== undefined) racer.hasMasterKey = data.has_master_key as boolean;
    if (data.gannon_nearby !== undefined) racer.gannonNearby = data.gannon_nearby as boolean;
    if (data.map_position !== undefined) racer.mapPosition = data.map_position as number;
    if (data.bomb_max !== undefined) racer.bombMax = data.bomb_max as number;
    render();
  }
});

socket.on('race:timer', (data: { startedAt: string; clockOffsetMs?: number }) => {
  state.raceStartedAt = data.startedAt;
  if (data.clockOffsetMs !== undefined) {
    state.clockOffsetMs = data.clockOffsetMs;
  }
  state.raceActive = true;
  updateRaceStatus('RACING', 'racing');
});

// ─── Commentary ───

interface CommentaryTextEvent {
  persona: 'play_by_play' | 'color';
  name: string;
  text: string;
  trigger: 'event' | 'periodic' | 'manual';
  eventType?: string;
  generationMs: number;
  audioUrl?: string;
}

let commentaryTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── Audio Queue ───
// Handles back-to-back commentary (play-by-play + follow-up)

const audioQueue: string[] = [];
let audioPlaying = false;
let currentAudio: HTMLAudioElement | null = null;

function enqueueAudio(url: string): void {
  audioQueue.push(url);
  if (!audioPlaying) playNextAudio();
}

function playNextAudio(): void {
  if (audioQueue.length === 0) {
    audioPlaying = false;
    return;
  }
  audioPlaying = true;
  const url = audioQueue.shift()!;

  // Stop any currently playing audio
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
  }

  currentAudio = new Audio(url);
  currentAudio.volume = 1.0; // Full volume — OBS controls actual level
  currentAudio.addEventListener('ended', playNextAudio);
  currentAudio.addEventListener('error', () => {
    console.warn('[TTP Overlay] Audio playback error for', url);
    playNextAudio();
  });
  currentAudio.play().catch((err) => {
    console.warn('[TTP Overlay] Audio play() failed:', err);
    playNextAudio();
  });
}

function scheduleTextFade(container: HTMLElement): void {
  // If audio is playing, wait for it to end + 2s grace
  if (currentAudio && audioPlaying) {
    const onAudioEnd = (): void => {
      currentAudio?.removeEventListener('ended', onAudioEnd);
      commentaryTimeout = setTimeout(() => {
        container.classList.add('fade-out');
        container.classList.remove('visible');
      }, 2_000);
    };
    currentAudio.addEventListener('ended', onAudioEnd);

    // Fallback: fade after 30s max regardless
    commentaryTimeout = setTimeout(() => {
      currentAudio?.removeEventListener('ended', onAudioEnd);
      container.classList.add('fade-out');
      container.classList.remove('visible');
    }, 30_000);
  } else {
    // No audio — fade after 10s
    commentaryTimeout = setTimeout(() => {
      container.classList.add('fade-out');
      container.classList.remove('visible');
    }, 10_000);
  }
}

socket.on('commentary:text', (data: CommentaryTextEvent) => {
  const container = document.getElementById('commentary-container');
  const nameEl = document.getElementById('commentary-name');
  const textEl = document.getElementById('commentary-text');
  if (!container || !nameEl || !textEl) return;

  // Clear any pending fade
  if (commentaryTimeout) {
    clearTimeout(commentaryTimeout);
    commentaryTimeout = null;
  }

  // Set content
  nameEl.textContent = data.name;
  nameEl.className = data.persona === 'play_by_play' ? 'play-by-play' : 'color';
  textEl.textContent = `"${data.text}"`;

  // Show immediately
  container.classList.remove('fade-out');
  container.classList.add('visible');

  // Play TTS audio if available
  if (data.audioUrl) {
    enqueueAudio(data.audioUrl);
  }

  // Schedule text fade (extends if audio is playing)
  scheduleTextFade(container);
});

// ─── Event Toasts ───

const HIGH_PRIORITY_EVENTS = new Set([
  'triforce_inferred', 'death', 'game_complete', 'ganon_fight', 'ganon_kill',
]);

const EVENT_TOAST_LABELS: Record<string, string> = {
  triforce_inferred: 'Triforce Get!',
  death: 'Death!',
  game_complete: 'Game Complete!',
  ganon_fight: 'Ganon Fight!',
  ganon_kill: 'Ganon Defeated!',
};

const toastQueue: string[] = [];
let toastActive = false;

function showNextToast(): void {
  if (toastQueue.length === 0) {
    toastActive = false;
    return;
  }
  toastActive = true;
  const label = toastQueue.shift()!;
  const container = document.getElementById('event-toasts');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'event-toast';
  toast.textContent = label;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
    showNextToast();
  }, 5000);
}

interface VisionEvent {
  type: string;
  description?: string;
}

socket.on('vision:events', (data: { racerId: string; events: VisionEvent[] }) => {
  for (const evt of data.events) {
    if (!HIGH_PRIORITY_EVENTS.has(evt.type)) continue;
    const racer = state.racers.find((r) => r.racerId === data.racerId);
    const name = racer?.displayName ?? data.racerId;
    const label = `${name}: ${EVENT_TOAST_LABELS[evt.type] ?? evt.type}`;
    toastQueue.push(label);
    if (!toastActive) showNextToast();
  }
});

socket.on('race:entrantUpdate', (data: Partial<RacerState> & { racerId: string }) => {
  const racer = state.racers.find((r) => r.racerId === data.racerId);
  if (racer) {
    Object.assign(racer, data);
    renderPlayerPanels();
  }
});

const signalLostTimers = new Map<string, ReturnType<typeof setTimeout>>();

socket.on('stream:stateChange', (data: { racerId: string; state: string }) => {
  const panels = document.querySelectorAll('.player-panel');
  const slotIndex = state.racers.findIndex(r => r.racerId === data.racerId);
  if (slotIndex < 0 || slotIndex >= panels.length) return;
  const panel = panels[slotIndex];
  const existing = panel.querySelector('.signal-lost-badge');

  if (data.state === 'disconnected' || data.state === 'error') {
    // Clear any pending recovery
    const existingTimer = signalLostTimers.get(data.racerId);
    if (existingTimer) clearTimeout(existingTimer);

    // Debounce: only show after 3s still disconnected
    if (!existing) {
      const timer = setTimeout(() => {
        const badge = document.createElement('div');
        badge.className = 'signal-lost-badge signal-fade-in';
        badge.textContent = 'SIGNAL LOST';
        panel.appendChild(badge);
        signalLostTimers.delete(data.racerId);
      }, 3000);
      signalLostTimers.set(data.racerId, timer);
    }
  } else {
    // Cancel pending show
    const pendingTimer = signalLostTimers.get(data.racerId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      signalLostTimers.delete(data.racerId);
    }
    // Show recovery if badge was visible
    if (existing) {
      existing.textContent = 'BACK ONLINE';
      existing.className = 'signal-lost-badge signal-recovery';
      setTimeout(() => existing.remove(), 2000);
    }
  }
});

// ─── Timer ───

let timerInterval: ReturnType<typeof setInterval> | null = null;

function startTimer(): void {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 100);
}

function updateTimer(): void {
  if (!state.raceStartedAt) return;
  const correctedNow = Date.now() - state.clockOffsetMs;
  const elapsed = correctedNow - new Date(state.raceStartedAt).getTime();
  const timerEl = document.getElementById('race-timer');
  if (timerEl) {
    timerEl.textContent = formatTime(elapsed);
  }
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ─── Shared Map State ───

interface MapMarker {
  col: number;
  row: number;
  type: 'dungeon' | 'landmark';
  label: string;
}

interface RacerMapPosition {
  racerId: string;
  col: number;
  row: number;
  screenType: string;
}

interface MapState {
  markers: MapMarker[];
  positions: RacerMapPosition[];
}

let mapState: MapState = { markers: [], positions: [] };

socket.on('map:state', (data: MapState) => {
  mapState = data;
  renderSharedMap();
});

// ─── Seed Item Tracker (race-wide) ───

const SEED_ITEMS = [
  'bow', 'ladder', 'raft', 'recorder', 'power_bracelet',
  'red_candle', 'book', 'magical_key', 'red_ring', 'wand',
  'silver_arrows', 'magical_boomerang', 'boomerang', 'white_sword', 'coast_heart',
];

const SEED_ITEM_SPRITES: Record<string, string> = {
  bow: 'bow.png', ladder: 'stepladder.png', raft: 'raft.png',
  recorder: 'recorder.png', power_bracelet: 'power_bracelet.png',
  red_candle: 'red_candle.png', book: 'book_of_magic.png',
  magical_key: 'magical_key.png', red_ring: 'red_ring.png',
  wand: 'wand.png', silver_arrows: 'silver_arrow.png',
  magical_boomerang: 'magical_boomerang.png', boomerang: 'boomerang.png',
  white_sword: 'sword_white.png', coast_heart: 'heart_container.png',
};

let seedItemState: Record<string, string | null> = {};
for (const item of SEED_ITEMS) seedItemState[item] = null;

socket.on('seed:itemDiscovery', (data: { item: string; location: string; state: Record<string, string | null> }) => {
  seedItemState = data.state;
  renderSeedTracker();
});

// Initial seed state on connect/reconnect
socket.on('seed:itemState', (data: Record<string, string | null>) => {
  seedItemState = data;
  renderSeedTracker();
});

// ─── Chat Highlight Lower-Third ───

const chatHighlightQueue: Array<{ username: string; message: string }> = [];
let chatHighlightActive = false;

socket.on('chat:highlight', (data: { username: string; message: string }) => {
  showChatHighlight(data.username, data.message);
});

function showChatHighlight(username: string, message: string): void {
  if (chatHighlightActive) {
    chatHighlightQueue.push({ username, message });
    return;
  }

  const container = document.getElementById('chat-highlight');
  if (!container) return;

  chatHighlightActive = true;
  container.innerHTML = '';

  const nameEl = document.createElement('span');
  nameEl.className = 'chat-hl-name';
  nameEl.textContent = username;
  container.appendChild(nameEl);

  const msgEl = document.createElement('span');
  msgEl.className = 'chat-hl-message';
  msgEl.textContent = message;
  container.appendChild(msgEl);

  container.classList.add('visible');

  // Hold for 6s, then slide out
  setTimeout(() => {
    container.classList.remove('visible');
    container.classList.add('hiding');
    setTimeout(() => {
      container.classList.remove('hiding');
      container.innerHTML = '';
      chatHighlightActive = false;

      // Process queue
      const next = chatHighlightQueue.shift();
      if (next) showChatHighlight(next.username, next.message);
    }, 500); // match slide-out duration
  }, 6000);
}

const RACER_COLORS = ['#60A0FF', '#FF6060', '#60D060', '#FFB040'];
const OW_COLS = 16;
const OW_ROWS = 8;

// ─── Race End Cleanup ───

function onRaceEnd(): void {
  // Fade out triforce race bar
  const tfBar = document.getElementById('triforce-race-bar');
  if (tfBar) {
    setTimeout(() => tfBar.classList.remove('visible'), 2000);
  }

  // Remove all signal-lost badges
  document.querySelectorAll('.signal-lost-badge').forEach(el => el.remove());
  for (const [, timer] of signalLostTimers) clearTimeout(timer);
  signalLostTimers.clear();

  // Fade out shared map after delay
  setTimeout(() => {
    const map = document.getElementById('shared-map');
    if (map) map.classList.remove('visible');
  }, 10000);

  // Clear animation tracking
  previousTriforceStates.clear();
}

// ─── Rendering ───

function render(): void {
  if (layout === 'standalone') {
    renderPlayerPanels(true);
    renderExtendedHud(true);
    return;
  }
  renderPlayerPanels(layout === 'clean');
  if (layout !== 'clean') renderExtendedHud();
  renderTriforceRaceBar();
  renderSeedTracker();
}

function updateRaceStatus(text: string, className: string): void {
  const el = document.getElementById('race-status');
  if (el) {
    el.textContent = text;
    el.className = `status-badge ${className}`;
  }
  if (className === 'racing') startTimer();
}

function renderPlayerPanels(minimal = false): void {
  const container = document.getElementById('player-panels');
  if (!container) return;

  container.innerHTML = '';

  // Standalone: single full-width panel
  const effectiveCount = layout === 'standalone' ? 1 : (state.racers.length || racerCount);
  const positions = layout === 'standalone'
    ? [{ x: 10, width: 1900 }]
    : getPanelPositions(effectiveCount);

  for (let i = 0; i < effectiveCount; i++) {
    const racer = state.racers[i];
    const pos = positions[i];
    if (!pos) continue;

    const panel = document.createElement('div');
    panel.className = 'player-panel';
    panel.style.left = `${pos.x}px`;
    panel.style.bottom = '0px';
    panel.style.width = `${pos.width}px`;

    // Player name
    const nameEl = document.createElement('div');
    nameEl.className = 'player-name';
    nameEl.textContent = racer?.displayName ?? `Player ${i + 1}`;
    panel.appendChild(nameEl);

    // Finish time / status
    const timeEl = document.createElement('div');
    timeEl.className = 'player-time';
    if (racer?.status === 'finished' && racer.finishTime) {
      timeEl.textContent = racer.finishTime;
      timeEl.classList.add('finished');
    } else if (racer?.status === 'forfeit') {
      timeEl.textContent = 'FORFEIT';
      timeEl.classList.add('forfeit');
    }
    panel.appendChild(timeEl);

    // Placement badge
    if (racer?.finishPlace) {
      const badge = document.createElement('div');
      const placeNames = ['', 'first', 'second', 'third'];
      const placeLabels = ['', '1ST', '2ND', '3RD'];
      badge.className = `placement-badge show ${placeNames[racer.finishPlace] ?? ''}`;
      badge.textContent = placeLabels[racer.finishPlace] ?? `${racer.finishPlace}TH`;
      panel.appendChild(badge);
    }

    if (!minimal) {
      // Hearts display
      if (racer?.hearts) {
        const heartsEl = document.createElement('div');
        heartsEl.className = 'hearts-display';
        for (let h = 0; h < racer.hearts.max; h++) {
          const heart = document.createElement('span');
          heart.className = 'heart';
          if (h < racer.hearts.current) {
            heart.textContent = '\u2665'; // ♥
          } else if (h === racer.hearts.current && racer.hearts.hasHalf) {
            heart.className += ' half';
            heart.textContent = '\u2665';
          } else {
            heart.className += ' empty';
            heart.textContent = '\u2665';
          }
          heartsEl.appendChild(heart);
        }
        panel.appendChild(heartsEl);
      }

      // Triforce bar
      if (racer?.triforce) {
        const tfBar = document.createElement('div');
        tfBar.className = 'triforce-bar';
        for (let t = 0; t < 8; t++) {
          const piece = document.createElement('div');
          piece.className = `triforce-piece ${racer.triforce[t] ? 'collected' : ''}`;
          tfBar.appendChild(piece);
        }
        panel.appendChild(tfBar);
      }

      // HUD counters (rupees, keys, bombs)
      if (racer && (racer.rupees !== undefined || racer.keys !== undefined || racer.bombs !== undefined)) {
        const countersEl = document.createElement('div');
        countersEl.className = 'hud-counters';

        const rupeeEl = document.createElement('span');
        rupeeEl.className = 'hud-counter rupee';
        rupeeEl.innerHTML = `<span class="counter-icon">\u25C6</span>${racer.rupees ?? 0}`;
        countersEl.appendChild(rupeeEl);

        const keyEl = document.createElement('span');
        keyEl.className = 'hud-counter key';
        keyEl.innerHTML = `<span class="counter-icon">\u26B7</span>${racer.keys ?? 0}`;
        countersEl.appendChild(keyEl);

        const bombEl = document.createElement('span');
        bombEl.className = 'hud-counter bomb';
        bombEl.innerHTML = `<span class="counter-icon">\u25CF</span>${racer.bombs ?? 0}`;
        countersEl.appendChild(bombEl);

        panel.appendChild(countersEl);
      }

      // Sword level indicator
      const swordLvl = racer?.swordLevel ?? 0;
      if (swordLvl > 0) {
        const swordEl = document.createElement('div');
        swordEl.className = `sword-indicator sword-${swordLvl}`;
        swordEl.textContent = SWORD_NAMES[swordLvl] ?? '';
        panel.appendChild(swordEl);
      }

      // B-item indicator
      if (racer?.b_item && racer.b_item !== 'none' && racer.b_item !== 'unknown') {
        const bItemEl = document.createElement('div');
        bItemEl.className = 'b-item-indicator';
        bItemEl.textContent = `B: ${racer.b_item.replace(/_/g, ' ')}`;
        panel.appendChild(bItemEl);
      }
    }

    container.appendChild(panel);
  }
}

function renderExtendedHud(standalone = false): void {
  const container = document.getElementById('bottom-bar');
  if (!container) return;
  container.innerHTML = '';

  const effectiveCount = standalone ? 1 : (state.racers.length || racerCount);
  const positions = standalone
    ? [{ x: 10, width: 1900 }]
    : getPanelPositions(effectiveCount);

  for (let i = 0; i < effectiveCount; i++) {
    const racer = state.racers[i];
    const pos = positions[i];
    if (!pos || !racer) continue;

    const strip = document.createElement('div');
    strip.className = 'extended-hud-strip';
    strip.style.position = 'absolute';
    strip.style.left = `${pos.x}px`;
    strip.style.bottom = '0px';
    strip.style.width = `${pos.width}px`;

    // ── Item icons (6) ──
    const itemsRow = document.createElement('div');
    itemsRow.className = 'hud-items-row';

    for (const itemName of HUD_ITEMS) {
      const found = racer.items?.[itemName] === true;
      const slot = document.createElement('div');
      slot.className = `hud-item${found ? ' found' : ''}`;
      const spriteFile = ITEM_SPRITE_FILES[itemName];
      if (spriteFile) {
        const icon = document.createElement('div');
        icon.className = 'hud-item-icon';
        icon.style.backgroundImage = `url(/overlay/sprites/items/${spriteFile})`;
        slot.appendChild(icon);
      }
      itemsRow.appendChild(slot);
    }

    // Arrows: show silver_arrow if has silver, else arrow if has wood, else dim
    const hasSilver = racer.items?.['silver_arrows'] === true;
    const hasWood = racer.items?.['arrow'] === true;
    const arrowSlot = document.createElement('div');
    arrowSlot.className = `hud-item${(hasSilver || hasWood) ? ' found' : ''}`;
    const arrowSprite = hasSilver ? 'silver_arrow.png' : 'arrow.png';
    const arrowIcon = document.createElement('div');
    arrowIcon.className = 'hud-item-icon';
    arrowIcon.style.backgroundImage = `url(/overlay/sprites/items/${arrowSprite})`;
    arrowSlot.appendChild(arrowIcon);
    itemsRow.appendChild(arrowSlot);

    strip.appendChild(itemsRow);

    // ── Triforce pieces (L1-L8) ──
    const tfRow = document.createElement('div');
    tfRow.className = 'hud-triforce-row';
    const triforce = racer.triforce ?? Array(8).fill(false);

    for (let t = 0; t < 8; t++) {
      const piece = document.createElement('div');
      const collected = triforce[t];
      const stateKey = `${racer.racerId}:tf:${t}`;
      const prevCollected = previousTriforceStates.get(stateKey) ?? false;
      const justCollected = collected && !prevCollected;
      piece.className = `hud-tf-piece${collected ? ' collected' : ''}${justCollected ? ' just-collected' : ''}`;

      const label = document.createElement('span');
      label.className = 'hud-tf-label';
      label.textContent = `L${t + 1}`;
      piece.appendChild(label);

      tfRow.appendChild(piece);
      previousTriforceStates.set(stateKey, collected);
    }

    strip.appendChild(tfRow);
    container.appendChild(strip);
  }
}

function renderSeedTracker(): void {
  const container = document.getElementById('seed-tracker');
  if (!container) return;

  if (!showSeedTracker) {
    container.classList.remove('visible');
    return;
  }

  const hasAny = Object.values(seedItemState).some(v => v !== null);
  if (!hasAny) {
    container.classList.remove('visible');
    return;
  }
  container.classList.add('visible');
  container.innerHTML = '';

  for (const item of SEED_ITEMS) {
    const location = seedItemState[item];
    const entry = document.createElement('div');
    entry.className = `seed-entry${location ? ' found' : ''}`;

    const icon = document.createElement('div');
    icon.className = 'seed-icon';
    const sprite = SEED_ITEM_SPRITES[item];
    if (sprite) {
      icon.style.backgroundImage = `url(/overlay/sprites/items/${sprite})`;
    }
    entry.appendChild(icon);

    if (location) {
      const code = document.createElement('span');
      code.className = 'seed-location';
      code.textContent = location;
      entry.appendChild(code);
    }

    container.appendChild(entry);
  }
}

function renderTriforceRaceBar(): void {
  if (!showTriforceBar) return;
  const container = document.getElementById('triforce-race-bar');
  if (!container) return;

  // Only show when we have racers with triforce data
  const racersWithTriforce = state.racers.filter(r => r.triforce);
  if (racersWithTriforce.length === 0) {
    container.classList.remove('visible');
    return;
  }

  container.classList.add('visible');
  container.innerHTML = '';

  for (const racer of state.racers) {
    const row = document.createElement('div');
    row.className = 'tf-racer-row';

    const name = document.createElement('span');
    name.className = 'tf-racer-name';
    name.textContent = racer.displayName ?? racer.racerId;
    row.appendChild(name);

    const pieces = document.createElement('div');
    pieces.className = 'tf-pieces';
    const triforce = racer.triforce ?? Array(8).fill(false);
    for (let t = 0; t < 8; t++) {
      const piece = document.createElement('div');
      const stateKey = `tf-bar:${racer.racerId}:${t}`;
      const prevCollected = previousTriforceStates.get(stateKey) ?? false;
      const justCollected = triforce[t] && !prevCollected;
      piece.className = `tf-piece${triforce[t] ? ' collected' : ''}${justCollected ? ' just-collected' : ''}`;
      pieces.appendChild(piece);
      previousTriforceStates.set(stateKey, triforce[t]);
    }
    row.appendChild(pieces);

    const count = document.createElement('span');
    count.className = 'tf-count';
    count.textContent = `${triforce.filter(Boolean).length}/8`;
    row.appendChild(count);

    container.appendChild(row);
  }

  // Highlight leader(s)
  let maxPieces = 0;
  const pieceCounts: number[] = [];
  for (const racer of state.racers) {
    const count = (racer.triforce ?? []).filter(Boolean).length;
    pieceCounts.push(count);
    if (count > maxPieces) maxPieces = count;
  }

  if (maxPieces > 0) {
    const rows = container.querySelectorAll('.tf-racer-row');
    for (let i = 0; i < rows.length; i++) {
      if (pieceCounts[i] === maxPieces) {
        rows[i].classList.add('tf-leader');
      }
    }
  }
}

function renderSharedMap(): void {
  if (!showMap) return;
  const container = document.getElementById('shared-map');
  if (!container) return;

  if (mapState.positions.length === 0 && mapState.markers.length === 0) {
    container.classList.remove('visible');
    return;
  }
  container.classList.add('visible');
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'map-grid';

  for (let r = 1; r <= OW_ROWS; r++) {
    for (let c = 1; c <= OW_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'map-cell';

      const marker = mapState.markers.find(m => m.col === c && m.row === r);
      if (marker) {
        cell.classList.add(marker.type === 'dungeon' ? 'map-dungeon' : 'map-landmark');
        const label = document.createElement('span');
        label.className = 'map-marker-label';
        label.textContent = marker.label;
        cell.appendChild(label);
      }

      const racersHere = mapState.positions.filter(p =>
        p.screenType === 'overworld' && p.col === c && p.row === r
      );
      const dotOffsets = racersHere.length === 2
        ? [{ x: -3, y: 0 }, { x: 3, y: 0 }]
        : racersHere.length === 3
        ? [{ x: -3, y: -2 }, { x: 3, y: -2 }, { x: 0, y: 3 }]
        : racersHere.map(() => ({ x: 0, y: 0 }));

      for (let di = 0; di < racersHere.length; di++) {
        const rp = racersHere[di];
        const dot = document.createElement('div');
        dot.className = 'map-racer-dot';
        const slotIndex = state.racers.findIndex(sr => sr.racerId === rp.racerId);
        dot.style.backgroundColor = RACER_COLORS[slotIndex] ?? RACER_COLORS[0];
        if (dotOffsets[di]) {
          dot.style.transform = `translate(${dotOffsets[di].x}px, ${dotOffsets[di].y}px)`;
        }
        cell.appendChild(dot);
      }

      grid.appendChild(cell);
    }
  }

  container.appendChild(grid);

  const legend = document.createElement('div');
  legend.className = 'map-legend';
  for (let i = 0; i < state.racers.length; i++) {
    const item = document.createElement('span');
    item.className = 'map-legend-item';
    item.innerHTML = `<span class="map-legend-dot" style="background:${RACER_COLORS[i]}"></span>${state.racers[i].displayName ?? ''}`;
    legend.appendChild(item);
  }
  container.appendChild(legend);
}

function getPanelPositions(count: number): Array<{ x: number; width: number }> {
  switch (count) {
    case 2:
      return [
        { x: 10, width: 940 },
        { x: 970, width: 940 },
      ];
    case 3:
      return [
        { x: 10, width: 625 },
        { x: 655, width: 625 },
        { x: 330, width: 625 },
      ];
    case 4:
      return [
        { x: 10, width: 460 },
        { x: 490, width: 460 },
        { x: 970, width: 460 },
        { x: 1450, width: 460 },
      ];
    default:
      return Array.from({ length: count }, (_, i) => ({
        x: (i % 2) * 960 + 10,
        width: 940,
      }));
  }
}

// ─── Initialize ───

// ─── Replay indicator ───
if (layout === 'replay') {
  const indicator = document.getElementById('replay-indicator');
  if (indicator) {
    indicator.classList.add('visible');

    const badge = document.createElement('span');
    badge.className = 'replay-badge';
    badge.textContent = 'REPLAY';
    indicator.appendChild(badge);

    const originalDate = params.get('race_date');
    if (originalDate) {
      const dateEl = document.createElement('span');
      dateEl.className = 'replay-date';
      dateEl.textContent = originalDate;
      indicator.appendChild(dateEl);
    }
  }
}

console.log(`[TTP Overlay] Initialized for ${racerCount} racers, layout: ${layout}`);
render();
