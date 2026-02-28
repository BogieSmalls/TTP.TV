import { Browser, chromium, Page } from 'playwright';
import { RacerConfig, RawPixelState } from './types.js';

export class VisionWorkerManager {
  private browser: Browser | null = null;
  private tabs = new Map<string, { page: Page; ws: WebSocket | null }>();
  private onStateCallback: ((state: RawPixelState) => void) | null = null;

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-web-security', '--enable-unsafe-webgpu'],
    });
  }

  onRawState(cb: (state: RawPixelState) => void): void {
    this.onStateCallback = cb;
  }

  async addRacer(config: RacerConfig): Promise<void> {
    if (!this.browser) throw new Error('VisionWorkerManager not started');
    const page = await this.browser.newPage();
    page.on('console', msg => console.log(`[vision:${config.racerId}]`, msg.text()));
    page.on('pageerror', err => console.error(`[vision:${config.racerId}] ERROR`, err));

    const tabUrl = new URL('http://localhost:3000/vision-tab/');
    tabUrl.searchParams.set('racerId', config.racerId);
    tabUrl.searchParams.set('streamUrl', config.streamUrl);
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
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'calibration') {
            this.emit('calibration', msg);
          } else {
            const state = msg as RawPixelState;
            this.onStateCallback?.(state);
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
    for (const [id] of this.tabs) await this.removeRacer(id);
    await this.browser?.close();
    this.browser = null;
  }

  sendToTab(racerId: string, message: object): void {
    const entry = this.tabs.get(racerId);
    if (entry?.ws?.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify(message));
    }
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
