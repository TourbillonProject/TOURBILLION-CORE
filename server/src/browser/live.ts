import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { AppConfig } from '../config.js';
import { NetworkPolicyError, resolveAllowed, type NetPolicy } from '../security/net.js';
import { extractResultsInPage, type VideoResult } from './youtube.js';

/**
 * Live remote browser: a real Chromium on the server (Playwright), streamed
 * to the iPad as JPEG frames over a WebSocket (CDP screencast), with taps,
 * scrolling and typing sent back. This is what makes JavaScript-heavy sites
 * (including youtube.com itself) navigable from the iPad.
 *
 * Safeguards: every request is checked against the SSRF policy (no private
 * or internal addresses), downloads are refused, no permissions are granted,
 * idle tabs are closed. Video inside the stream is low-frame-rate and silent
 * by nature — real playback is handed to the iPad's own player.
 */

// Minimal structural types so the module compiles without playwright-core installed.
interface PWPage {
  goto(url: string, opts?: unknown): Promise<unknown>;
  goBack(opts?: unknown): Promise<unknown>;
  goForward(opts?: unknown): Promise<unknown>;
  reload(opts?: unknown): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  close(): Promise<void>;
  content(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  mouse: { click(x: number, y: number): Promise<void>; move(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  keyboard: { insertText(t: string): Promise<void>; press(k: string): Promise<void> };
  on(ev: string, fn: (...a: unknown[]) => void): void;
  context(): { newCDPSession(p: PWPage): Promise<CDPSession> };
  isClosed(): boolean;
  opener(): Promise<PWPage | null>;
}
interface CDPSession {
  send(method: string, params?: unknown): Promise<unknown>;
  on(ev: string, fn: (p: { data: string; sessionId: number; metadata: unknown }) => void): void;
  detach(): Promise<void>;
}
interface PWContext {
  newPage(): Promise<PWPage>;
  route(pattern: string, handler: (route: { request(): { url(): string }; abort(code?: string): Promise<void>; continue(): Promise<void> }) => Promise<void>): Promise<void>;
  routeWebSocket?(pattern: RegExp | string, handler: (ws: { url(): string; close(): Promise<void>; connectToServer(): unknown }) => void | Promise<void>): Promise<void>;
  on(ev: string, fn: (...a: unknown[]) => void): void;
  close(): Promise<void>;
}
interface PWBrowser {
  newContext(opts: unknown): Promise<PWContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface TabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  createdAt: string;
  lastActiveAt: number;
}

interface Tab extends TabState {
  page: PWPage;
  viewers: Set<WebSocket>;
  cdp: CDPSession | null;
  viewport: { width: number; height: number };
}

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const ALLOWED_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Delete']);

export class LiveBrowser {
  private browser: PWBrowser | null = null;
  private context: PWContext | null = null;
  private starting: Promise<void> | null = null;
  private tabs = new Map<string, Tab>();
  private hostCache = new Map<string, { ok: boolean; at: number }>();
  private sweeper: NodeJS.Timeout;
  availability: { available: boolean; detail: string } = { available: false, detail: 'Not started' };
  onNavigate: ((url: string, title: string) => void) | null = null;

  constructor(
    private config: AppConfig,
    private policy: NetPolicy,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** Checks whether Playwright + Chromium can be loaded, without launching. */
  async probe(): Promise<{ available: boolean; detail: string }> {
    if (!this.config.browser.enabled) return (this.availability = { available: false, detail: 'Disabled by TC_BROWSER_ENABLED=false' });
    try {
      const pw = await import('playwright-core');
      const exe = this.config.browser.executablePath ?? pw.chromium.executablePath();
      const fs = await import('node:fs');
      if (!exe || !fs.existsSync(exe)) return (this.availability = { available: false, detail: 'Chromium not installed. Run: npx playwright-core install chromium (or set TC_BROWSER_EXECUTABLE).' });
      return (this.availability = { available: true, detail: `Chromium at ${exe}` });
    } catch {
      return (this.availability = { available: false, detail: 'playwright-core is not installed (optional dependency).' });
    }
  }

  private async ensure() {
    if (this.browser?.isConnected() && this.context) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const probe = await this.probe();
      if (!probe.available) throw new Error(`Live browser unavailable: ${probe.detail}`);
      const pw = await import('playwright-core');
      this.browser = (await pw.chromium.launch({
        headless: true,
        executablePath: this.config.browser.executablePath ?? undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=user-gesture-required', '--disable-features=MediaSessionService'],
        ...(this.config.browser.proxy ? { proxy: { server: this.config.browser.proxy } } : {}),
      })) as unknown as PWBrowser;
      this.context = await this.browser.newContext({
        userAgent: DESKTOP_UA,
        viewport: { width: 1024, height: 700 },
        acceptDownloads: false,
        permissions: [],
        locale: 'en-GB',
        javaScriptEnabled: true,
        ignoreHTTPSErrors: false,
        serviceWorkers: 'block',
      });
      await this.context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return route.continue();
        if (await this.hostAllowed(url)) return route.continue();
        return route.abort('blockedbyclient');
      });
      if (this.context.routeWebSocket) {
        await this.context.routeWebSocket(/.*/, async (ws) => {
          if (await this.hostAllowed(ws.url())) ws.connectToServer();
          else await ws.close();
        });
      }
      this.context.on('page', (p) => {
        // Popups (target=_blank / window.open) become new tabs. Pages we open ourselves have no opener.
        const page = p as PWPage;
        void page.opener().then((opener) => {
          if (opener && ![...this.tabs.values()].some((t) => t.page === page)) void this.adopt(page).catch(() => {});
        });
      });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async hostAllowed(url: string): Promise<boolean> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
    const cached = this.hostCache.get(u.hostname);
    if (cached && Date.now() - cached.at < 60_000) return cached.ok;
    let ok = true;
    try {
      await resolveAllowed(u.hostname, this.policy);
    } catch (err) {
      ok = !(err instanceof NetworkPolicyError);
    }
    this.hostCache.set(u.hostname, { ok, at: Date.now() });
    return ok;
  }

  private async adopt(page: PWPage): Promise<Tab> {
    if (this.tabs.size >= this.config.browser.maxTabs) {
      // Evict the least-recently-used tab nobody is watching; refuse only if all are in use.
      const idle = [...this.tabs.values()].filter((t) => t.viewers.size === 0).sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      if (idle) await this.close(idle.id);
      else {
        await page.close();
        throw new Error(`Tab limit reached (${this.config.browser.maxTabs}) and every tab is in use. Close a tab first.`);
      }
    }
    const tab: Tab = {
      id: crypto.randomBytes(6).toString('hex'),
      url: page.url(),
      title: '',
      loading: false,
      createdAt: new Date().toISOString(),
      lastActiveAt: Date.now(),
      page,
      viewers: new Set(),
      cdp: null,
      viewport: { width: 1024, height: 700 },
    };
    this.tabs.set(tab.id, tab);
    page.on('framenavigated', () => void this.refreshState(tab));
    page.on('load', () => {
      tab.loading = false;
      void this.refreshState(tab).then(() => this.onNavigate?.(tab.url, tab.title));
    });
    page.on('domcontentloaded', () => void this.refreshState(tab));
    page.on('close', () => {
      this.tabs.delete(tab.id);
      for (const v of tab.viewers) v.close(4404, 'tab closed');
    });
    return tab;
  }

  private async refreshState(tab: Tab) {
    if (tab.page.isClosed()) return;
    tab.url = tab.page.url();
    try {
      tab.title = await tab.page.title();
    } catch {
      /* navigating */
    }
    this.broadcast(tab, { type: 'state', ...this.state(tab) });
  }

  private state(tab: Tab): TabState {
    return { id: tab.id, url: tab.url, title: tab.title, loading: tab.loading, createdAt: tab.createdAt, lastActiveAt: tab.lastActiveAt };
  }

  private broadcast(tab: Tab, msg: unknown) {
    const s = JSON.stringify(msg);
    for (const v of tab.viewers) if (v.readyState === v.OPEN) v.send(s);
  }

  listTabs(): TabState[] {
    return [...this.tabs.values()].map((t) => this.state(t));
  }

  private tab(id: string): Tab {
    const t = this.tabs.get(id);
    if (!t) throw new Error('Tab not found (it may have been closed after being idle).');
    t.lastActiveAt = Date.now();
    return t;
  }

  async open(url: string): Promise<TabState> {
    await this.ensure();
    if (!(await this.hostAllowed(url))) throw new NetworkPolicyError('That address is blocked by the network policy (private or internal host).');
    const page = await this.context!.newPage();
    const tab = await this.adopt(page);
    tab.loading = true;
    void page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e: Error) => this.broadcast(tab, { type: 'error', message: e.message }));
    return this.state(tab);
  }

  async navigate(id: string, url: string): Promise<TabState> {
    const tab = this.tab(id);
    if (!(await this.hostAllowed(url))) throw new NetworkPolicyError('That address is blocked by the network policy (private or internal host).');
    tab.loading = true;
    this.broadcast(tab, { type: 'state', ...this.state(tab) });
    void tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e: Error) => this.broadcast(tab, { type: 'error', message: e.message }));
    return this.state(tab);
  }

  async history(id: string, action: 'back' | 'forward' | 'reload') {
    const tab = this.tab(id);
    const opts = { waitUntil: 'domcontentloaded', timeout: 30_000 };
    if (action === 'back') await tab.page.goBack(opts).catch(() => null);
    else if (action === 'forward') await tab.page.goForward(opts).catch(() => null);
    else await tab.page.reload(opts).catch(() => null);
    await this.refreshState(tab);
    return this.state(tab);
  }

  async close(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    await tab.page.close().catch(() => {});
    this.tabs.delete(id);
  }

  async closeAll() {
    for (const id of [...this.tabs.keys()]) await this.close(id);
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    clearInterval(this.sweeper);
  }

  /** Rendered HTML of the current page — used for article extraction and summaries. */
  async content(id: string): Promise<{ url: string; title: string; html: string }> {
    const tab = this.tab(id);
    return { url: tab.page.url(), title: await tab.page.title(), html: await tab.page.content() };
  }

  async youtubeResults(id: string): Promise<VideoResult[]> {
    const tab = this.tab(id);
    if (!/youtube\.com\/results/.test(tab.page.url())) throw new Error('This tab is not showing YouTube search results.');
    return tab.page.evaluate(extractResultsInPage);
  }

  /** Attaches a viewer socket: starts the CDP screencast and wires input. */
  async attach(id: string, ws: WebSocket) {
    const tab = this.tab(id);
    tab.viewers.add(ws);
    // Handlers first, so input sent while the screencast starts is not lost.
    ws.on('message', (raw) => void this.onInput(tab, String(raw)).catch((e: Error) => ws.send(JSON.stringify({ type: 'error', message: e.message }))));
    ws.on('close', () => {
      tab.viewers.delete(ws);
      if (tab.viewers.size === 0 && tab.cdp) {
        void tab.cdp.send('Page.stopScreencast').catch(() => {});
        void tab.cdp.detach().catch(() => {});
        tab.cdp = null;
      }
    });
    ws.send(JSON.stringify({ type: 'state', ...this.state(tab) }));
    if (!tab.cdp) await this.startScreencast(tab);
    // The screencast only emits on repaint; a page that is already idle would otherwise stay blank.
    await this.snapshot(tab, ws);
  }

  private async snapshot(tab: Tab, only?: WebSocket) {
    try {
      const shot = (await tab.cdp?.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })) as { data: string } | undefined;
      if (!shot) return;
      const buf = Buffer.from(shot.data, 'base64');
      for (const v of only ? [only] : tab.viewers) if (v.readyState === v.OPEN) v.send(buf, { binary: true });
    } catch {
      /* page navigating; the screencast will deliver the next frame */
    }
  }

  /** Starts the CDP screencast. Retries: during a navigation commit Chromium can reject the first attempt. */
  private async startScreencast(tab: Tab) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (tab.page.isClosed()) throw new Error('Tab not found (closed).');
      try {
        const cdp = await tab.page.context().newCDPSession(tab.page);
        cdp.on('Page.screencastFrame', (frame) => {
          const buf = Buffer.from(frame.data, 'base64');
          for (const v of tab.viewers) if (v.readyState === v.OPEN && v.bufferedAmount < 2_000_000) v.send(buf, { binary: true });
          void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
        });
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: tab.viewport.width, maxHeight: tab.viewport.height, everyNthFrame: 1 });
        tab.cdp = cdp;
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Could not start the screen stream');
  }

  private async onInput(tab: Tab, raw: string) {
    let msg: { type: string; x?: number; y?: number; dx?: number; dy?: number; text?: string; key?: string; width?: number; height?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    tab.lastActiveAt = Date.now();
    const num = (n: unknown, lo: number, hi: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo);
    switch (msg.type) {
      case 'viewport': {
        const width = Math.round(num(msg.width, 320, 1600));
        const height = Math.round(num(msg.height, 320, 1600));
        tab.viewport = { width, height };
        await tab.page.setViewportSize({ width, height });
        if (tab.cdp) {
          await tab.cdp.send('Page.stopScreencast').catch(() => {});
          await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
        } else await this.startScreencast(tab);
        await this.snapshot(tab);
        break;
      }
      case 'tap':
        await tab.page.mouse.click(num(msg.x, 0, tab.viewport.width), num(msg.y, 0, tab.viewport.height));
        break;
      case 'scroll':
        await tab.page.mouse.move(num(msg.x, 0, tab.viewport.width), num(msg.y, 0, tab.viewport.height));
        await tab.page.mouse.wheel(num(msg.dx, -5000, 5000), num(msg.dy, -5000, 5000));
        break;
      case 'text':
        if (typeof msg.text === 'string') await tab.page.keyboard.insertText(msg.text.slice(0, 2000));
        break;
      case 'key':
        if (msg.key && ALLOWED_KEYS.has(msg.key)) await tab.page.keyboard.press(msg.key === 'Space' ? ' ' : msg.key);
        break;
    }
  }

  private async sweep() {
    const now = Date.now();
    for (const t of [...this.tabs.values()]) {
      if (t.viewers.size === 0 && now - t.lastActiveAt > 30 * 60_000) await this.close(t.id);
    }
    if (this.tabs.size === 0 && this.browser) {
      await this.context?.close().catch(() => {});
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
    }
  }
}
