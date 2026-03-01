import { Browser, chromium, Page } from 'playwright';
import { RacerConfig, RawPixelState } from './types.js';
import type { StableGameState } from './types.js';
import { resolveHlsUrl } from './hlsResolver.js';
// WebSocket is the Node.js 22 built-in global — no import needed (consistent with RaceMonitor.ts)

export class VisionWorkerManager {
  private browser: Browser | null = null;
  private tabs = new Map<string, { page: Page; ws: WebSocket | null }>();
  private onStateCallback: ((state: RawPixelState) => void) | null = null;
  private onDebugFrameCallback: ((racerId: string, jpeg: string) => void) | null = null;
  private monitoredRacers = new Set<string>();
  private featuredRacers = new Set<string>();
  private latestFrames = new Map<string, Buffer>();
  private latestDebugFrames = new Map<string, Buffer>();
  private latestStates = new Map<string, StableGameState>();

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-web-security', '--enable-unsafe-webgpu'],
    });
  }

  onRawState(cb: (state: RawPixelState) => void): void {
    this.onStateCallback = cb;
  }

  onDebugFrame(cb: (racerId: string, jpeg: string) => void): void {
    this.onDebugFrameCallback = cb;
  }

  async addRacer(config: RacerConfig): Promise<void> {
    if (!this.browser) throw new Error('VisionWorkerManager not started');
    if (this.tabs.has(config.racerId)) {
      throw new Error(`Racer ${config.racerId} is already being monitored`);
    }
    const page = await this.browser.newPage();
    page.on('console', msg => console.log(`[vision:${config.racerId}]`, msg.text()));
    page.on('pageerror', err => console.error(`[vision:${config.racerId}] ERROR`, err));

    const hlsUrl = await resolveHlsUrl(config.streamUrl);

    const tabUrl = new URL('http://localhost:3000/vision-tab/');
    tabUrl.searchParams.set('racerId', config.racerId);
    tabUrl.searchParams.set('streamUrl', hlsUrl);
    tabUrl.searchParams.set('calib', JSON.stringify(config.calibration));

    await page.goto(tabUrl.toString());
    this.tabs.set(config.racerId, { page, ws: null });
  }

  registerTabWebSocket(racerId: string, ws: WebSocket): void {
    const entry = this.tabs.get(racerId);
    if (entry) {
      entry.ws = ws;
      ws.addEventListener('message', (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          const msg = JSON.parse(raw);
          if (msg.type === 'calibration') {
            this.emit('calibration', msg);
          } else if (msg.type === 'previewFrame' && typeof msg.jpeg === 'string') {
            this.cacheFrame(racerId, msg.jpeg);
          } else if (msg.type === 'debugFrame' && typeof msg.jpeg === 'string') {
            this.cacheDebugFrame(racerId, msg.jpeg);
            this.onDebugFrameCallback?.(racerId, msg.jpeg);
          } else if (msg.type === 'heartbeat') {
            // intentionally ignored — tab keepalive, not game state
          } else if (msg.type === 'rawState') {
            this.onStateCallback?.(msg as RawPixelState);
          }
        } catch { /* ignore malformed */ }
      });
    }
  }

  async removeRacer(racerId: string): Promise<void> {
    const entry = this.tabs.get(racerId);
    if (entry) {
      await entry.page.close();
      this.tabs.delete(racerId);
    }
  }

  async stop(): Promise<void> {
    for (const id of Array.from(this.tabs.keys())) await this.removeRacer(id);
    await this.browser?.close();
    this.browser = null;
  }

  cacheFrame(racerId: string, jpegBase64: string): void {
    this.latestFrames.set(racerId, Buffer.from(jpegBase64, 'base64'));
  }

  cacheDebugFrame(racerId: string, jpegBase64: string): void {
    this.latestDebugFrames.set(racerId, Buffer.from(jpegBase64, 'base64'));
  }

  cacheState(racerId: string, state: StableGameState): void {
    this.latestStates.set(racerId, state);
  }

  getLatestFrame(racerId: string): Buffer | null {
    return this.latestFrames.get(racerId) ?? null;
  }

  getLatestDebugFrame(racerId: string): Buffer | null {
    return this.latestDebugFrames.get(racerId) ?? null;
  }

  getLatestState(racerId: string): StableGameState | null {
    return this.latestStates.get(racerId) ?? null;
  }

  sendToTab(racerId: string, message: object): void {
    const entry = this.tabs.get(racerId);
    if (entry?.ws?.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify(message));
    }
  }

  startDebugStream(racerId: string): void {
    this.sendToTab(racerId, { type: 'startDebugStream' });
  }

  stopDebugStream(racerId: string): void {
    this.sendToTab(racerId, { type: 'stopDebugStream' });
  }

  getActiveRacerIds(): string[] {
    return Array.from(this.tabs.keys());
  }

  setFeatured(racerIds: string[]): void {
    this.featuredRacers = new Set(racerIds);
  }

  getMonitoredCount(): number {
    return this.tabs.size;
  }

  getFeaturedIds(): string[] {
    return [...this.featuredRacers];
  }

  isFeatured(racerId: string): boolean {
    return this.featuredRacers.has(racerId);
  }

  // Minimal EventEmitter-like for calibration events
  private listeners = new Map<string, Array<(data: unknown) => void>>();

  on(event: string, cb: (data: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(cb);
  }

  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }
}
