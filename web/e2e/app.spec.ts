import { expect, test, type Page } from '@playwright/test';

const PASS = 'tourbillion e2e passphrase';

/** Deterministic stand-ins for the browser speech APIs (not available headless). */
const SPEECH_FAKES = () => {
  const w = window as unknown as Record<string, unknown>;
  w.__spoken = [];
  class FakeRecognition {
    lang = '';
    continuous = false;
    interimResults = true;
    maxAlternatives = 1;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onstart: (() => void) | null = null;
    start() {
      w.__rec = this;
    }
    stop() {
      this.onend?.();
    }
    abort() {}
  }
  // Chromium exposes both names; the app prefers the unprefixed one.
  w.SpeechRecognition = FakeRecognition;
  w.webkitSpeechRecognition = FakeRecognition;
  w.__say = (text: string) => {
    const r = w.__rec as FakeRecognition;
    const alt = Object.assign([{ transcript: text, confidence: 0.92 }], { isFinal: true });
    r.onresult?.({ resultIndex: 0, results: [alt] });
    r.onend?.();
    w.__rec = null;
  };
  const voices = [{ name: 'Daniel', lang: 'en-GB', localService: true, default: false, voiceURI: 'Daniel' }];
  type Utt = { text: string; voice?: { name: string }; lang: string; rate: number; onstart?: () => void; onend?: () => void; done?: boolean };
  let current: Utt | null = null;
  const finish = (u: Utt) => {
    if (u.done) return;
    u.done = true;
    if (current === u) current = null;
    u.onend?.();
  };
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      get speaking() {
        return !!current;
      },
      pending: false,
      getVoices: () => voices,
      speak: (u: Utt) => {
        (w.__spoken as unknown[]).push({ text: u.text, voice: u.voice?.name, lang: u.lang, rate: u.rate });
        current = u;
        setTimeout(() => {
          u.onstart?.();
          setTimeout(() => finish(u), 60);
        }, 10);
      },
      // Like the real API: cancelling ends the current utterance.
      cancel: () => current && finish(current),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  w.SpeechSynthesisUtterance = class {
    text: string;
    constructor(t: string) {
      this.text = t;
    }
  };
};

/** Stand-in for YouTube's IFrame Player API (youtube.com is unreachable from CI). */
const FAKE_YT_API = `
window.YT = { Player: class {
  constructor(el, opts) {
    const f = document.createElement('div'); f.textContent = 'FAKE PLAYER ' + opts.videoId; f.setAttribute('data-host', opts.host); el.appendChild(f);
    setTimeout(() => { opts.events.onReady && opts.events.onReady({});
      if (opts.videoId === 'blockedvid1') opts.events.onError && opts.events.onError({ data: 150 });
      else setTimeout(() => opts.events.onStateChange && opts.events.onStateChange({ data: 1 }), 60);
    }, 60);
  }
  destroy() {}
} };
window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();`;

async function signIn(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket/.test(m.text()) && errors.push(m.text()));
  await page.addInitScript(SPEECH_FAKES);
  await page.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT_API }));
  await page.goto('/');
  // Wait until the app has checked the session: either the sign-in form or the boot screen appears.
  await expect(page.locator('input[type=password], [data-testid=initialise]').first()).toBeVisible();
  const pass = page.locator('input[type=password]');
  if (await pass.isVisible()) {
    await pass.fill(PASS);
    await page.locator('button[type=submit]').click();
  }
  await page.getByTestId('initialise').click();
  await expect(page.getByTestId('command-center')).toBeVisible();
  await expect(page.getByTestId('ws-chip')).toContainText('LINK');
  return errors;
}

async function queue(page: Page, turns: unknown[]) {
  await page.request.post('/__fake/queue', { data: turns });
}

test.describe('TOURBILLION CORE on iPad', () => {
  test('boots, greets in British English, and every navigation section works', async ({ page }) => {
    const errors = await signIn(page);
    await expect(page.getByTestId('reply')).toContainText('TOURBILLION CORE systems are online. Intelligence services are ready.');
    const spoken = await page.evaluate(() => (window as unknown as { __spoken: { text: string; voice: string; lang: string }[] }).__spoken);
    const greeting = spoken.find((s) => /Good (morning|afternoon|evening)/.test(s.text))!;
    expect(greeting).toMatchObject({ voice: 'Daniel', lang: 'en-GB' });
    expect(greeting.text).toMatch(/^Good (morning|afternoon|evening), Keenan\./);

    await expect(page.locator('.core-stage')).toHaveAttribute('data-engine', /^(3d|2d)$/);
    const labels: Record<string, string> = { intelligence: 'Intelligence', agents: 'Agents', spider: 'The Spider', browser: 'Browser', research: 'Research / OSINT', projects: 'Projects', missions: 'Missions', automations: 'Automations', apps: 'Connected Apps', memory: 'Memory', settings: 'Settings', command: 'Command Center' };
    for (const [id, label] of Object.entries(labels)) {
      await page.getByTestId(`nav-${id}`).tap();
      await expect(page.locator('.topbar h1')).toHaveText(label);
      await expect(page).toHaveURL(new RegExp(`#/${id}`));
    }
    expect(errors).toEqual([]);
  });

  test('Claude replies stream into Intelligence', async ({ page }) => {
    await signIn(page);
    await queue(page, [{ blocks: [{ type: 'thinking', thinking: 'Brief and factual.' }, { type: 'text', text: 'A tourbillon is a **rotating cage** for the escapement.' }], contains: 'What is a tourbillon' }]);
    await page.getByTestId('nav-intelligence').tap();
    await page.getByRole('button', { name: /New/ }).tap();
    await page.getByTestId('chat-input').fill('What is a tourbillon?');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('messages')).toContainText('rotating cage', { timeout: 20_000 });
    await expect(page.getByTestId('messages').locator('strong', { hasText: 'rotating cage' })).toBeVisible();
    await expect(page.getByTestId('messages')).toContainText('Reasoning summary');
  });

  test('voice: "open YouTube" and diagnostics run locally; the core shows listening', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('mic').tap();
    await expect(page.locator('.core-stage')).toHaveAttribute('data-state', 'listening');
    await page.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say('Tourbillion, initiate system diagnostics.'));
    await expect(page.getByTestId('reply')).toContainText('Diagnostics initiated — mission');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: { text: string }[] }).__spoken.map((s) => s.text).join('|'))).toContain('Diagnostics initiated');
    await page.waitForFunction(() => !window.speechSynthesis.speaking);
    await expect(page.locator('.mic.speaking')).toHaveCount(0);

    await page.getByTestId('mic').tap();
    await page.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say('Tourbillion, open YouTube.'));
    await expect(page.locator('.topbar h1')).toHaveText('Browser');
    await expect(page.getByTestId('youtube-panel')).toBeVisible();
  });

  test('YouTube: entering a video URL plays through the official player and reports real state; blocked embeds offer Safari', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('nav-browser').tap();
    await page.getByTestId('address').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.getByTestId('address').press('Enter');
    await expect(page.getByTestId('yt-player')).toContainText('FAKE PLAYER dQw4w9WgXcQ');
    await expect(page.getByTestId('yt-player').locator('[data-host]')).toHaveAttribute('data-host', 'https://www.youtube-nocookie.com');
    await expect(page.getByTestId('yt-state')).toHaveText(/Playing/);

    await page.getByTestId('address').fill('youtu.be/blockedvid1');
    await page.getByTestId('address').press('Enter');
    await expect(page.getByTestId('yt-state')).toHaveText(/Unavailable/);
    await expect(page.getByTestId('yt-player')).toContainText('does not allow this video to be played in other apps');
    await expect(page.getByTestId('yt-player').getByRole('link', { name: /Open in Safari/ })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=blockedvid1');
  });

  test('browser: reader mode, in-app link navigation and history', async ({ page }) => {
    await signIn(page);
    const site = (await (await page.request.get('/__fake/site')).json()).base as string;
    await page.getByTestId('nav-browser').tap();
    // Choosing Reader on a blank tab applies to the next address entered.
    await page.getByRole('combobox', { name: 'Rendering mode' }).selectOption('reader');
    await page.getByTestId('address').fill(`${site}/article`);
    await page.getByTestId('address').press('Enter');
    await expect(page.getByTestId('reader')).toContainText('patented by Abraham-Louis Breguet');
    await page.getByTestId('reader').getByRole('link', { name: 'escapement' }).tap();
    await expect(page.getByTestId('reader')).toContainText('mechanical linkage');
    await page.getByRole('button', { name: 'Back' }).tap();
    await expect(page.getByTestId('reader')).toContainText('Breguet');
  });

  test('browser: live remote Chromium streams frames and taps navigate', async ({ page }) => {
    await signIn(page);
    const site = (await (await page.request.get('/__fake/site')).json()).base as string;
    await page.getByTestId('nav-browser').tap();
    await page.getByTestId('address').fill(`${site}/live`);
    await page.getByTestId('address').press('Enter');
    const img = page.getByTestId('live-view').locator('img');
    await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
    await expect(page.locator('.tab.on')).toContainText('Live fixture');
    const box = (await img.boundingBox())!;
    await page.touchscreen.tap(box.x + 60, box.y + 60);
    await expect(page.locator('.tab.on')).toContainText('Second page', { timeout: 20_000 });
  });

  test('approvals: a sensitive action waits for the owner, then runs', async ({ page }) => {
    await signIn(page);
    await queue(page, [
      { blocks: [{ type: 'text', text: 'I will remove it.' }, { type: 'tool_use', name: 'memory_delete', input: { id: 424242, reason: 'owner asked' } }], contains: 'forget memory 424242' },
      { blocks: [{ type: 'text', text: 'Done — that memory did not exist, so nothing was removed.' }], contains: 'not found' },
    ]);
    await page.getByTestId('command-input').fill('Please forget memory 424242');
    await page.getByTestId('command-input').press('Enter');
    const card = page.getByTestId('approval-card').first();
    await expect(card).toContainText('Delete memory #424242');
    await expect(page.getByTestId('approval-dock')).toContainText('1 approval waiting');
    await card.getByRole('button', { name: 'Approve' }).tap();
    await expect(page.getByTestId('reply')).toContainText('nothing was removed', { timeout: 20_000 });
    await expect(page.getByTestId('approval-dock')).toHaveCount(0);
  });

  test('projects: upload a zip from Files, deploy The Spider, review issues and the mission', async ({ page }) => {
    const { zipSync, strToU8 } = await import('fflate');
    const zip = zipSync({
      'demo-main/package.json': strToU8(JSON.stringify({ name: 'demo', scripts: { test: 'node -e "console.log(1)"' } })),
      'demo-main/src/index.js': strToU8('function run(x) {\n  return eval(x);\n}\nmodule.exports = run;\n'),
    });
    await signIn(page);
    await page.getByTestId('nav-projects').tap();
    await page.locator('input[type=file]').setInputFiles({ name: 'demo-main.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
    await page.getByRole('button', { name: 'Add', exact: true }).tap();
    await expect(page.locator('.panel', { has: page.getByRole('heading', { name: 'Files', exact: true }) })).toContainText('src/index.js');
    await page.getByTestId('nav-spider').tap();
    await page.getByRole('button', { name: 'Deploy the Spider' }).tap();
    const mission = page.getByTestId('spider-mission');
    await expect(mission).toContainText('Detected issues', { timeout: 30_000 });
    await expect(mission).toContainText('Dynamic code execution');
    await expect(mission).toContainText('src/index.js:2');
    await expect(mission).toContainText('Technical report');
    await page.getByTestId('nav-missions').tap();
    await page.locator('[data-testid^=mission-]').first().tap();
    await expect(page.getByTestId('mission-view')).toContainText('Verification');
  });

  test('sound: every synthesised sound renders through Web Audio without errors', async ({ page }) => {
    const errors = await signIn(page);
    await page.getByTestId('nav-settings').tap();
    for (const name of ['startup', 'activate', 'listen', 'thinking', 'deploy', 'complete', 'warning', 'error', 'shutdown']) {
      await page.getByRole('button', { name, exact: true }).tap();
    }
    await page.waitForTimeout(400);
    expect(errors).toEqual([]);
  });

  test('settings: switching the core to 2D takes effect', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('nav-settings').tap();
    await page.getByRole('tab', { name: '2D' }).tap();
    await page.getByTestId('nav-command').tap();
    await expect(page.locator('.core-stage')).toHaveAttribute('data-engine', '2d');
    await page.getByTestId('nav-settings').tap();
    await page.getByRole('tab', { name: 'Auto' }).tap();
  });

  test('network loss shows an offline banner and recovers', async ({ page, context }) => {
    await signIn(page);
    await context.setOffline(true);
    await expect(page.locator('.offline')).toContainText('offline');
    await context.setOffline(false);
    await expect(page.locator('.offline')).toHaveCount(0);
    await expect(page.getByTestId('ws-chip')).toContainText('LINK');
  });

  test('PWA: manifest, icons and an offline-capable app shell', async ({ page, context, request }) => {
    const manifest = await (await request.get('/manifest.webmanifest')).json();
    expect(manifest).toMatchObject({ name: 'TOURBILLION CORE', display: 'standalone', start_url: '/' });
    for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
    expect((await request.get('/icons/apple-touch-icon.png')).ok()).toBe(true);
    await signIn(page);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null || navigator.serviceWorker?.ready.then(() => true));
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle('TOURBILLION CORE');
    await expect(page.locator('#root')).not.toBeEmpty();
    await context.setOffline(false);
  });

  test('@portrait layout: core on top, panels below, no horizontal scrolling', async ({ page }) => {
    await signIn(page);
    const core = (await page.locator('.core-stage').boundingBox())!;
    const status = (await page.locator('.panel', { hasText: 'System status' }).boundingBox())!;
    expect(core.y).toBeLessThan(status.y);
    expect(core.height).toBeGreaterThan(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const id of ['spider', 'browser', 'research', 'apps', 'missions', 'memory', 'settings']) {
      await page.getByTestId(`nav-${id}`).tap();
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), id).toBeLessThanOrEqual(0);
    }
  });
});
