/**
 * End-to-end harness: starts the real TOURBILLION server (serving the built
 * PWA) wired to a local Claude Messages-API double and a fixture website.
 * Tests script model turns through POST /__fake/queue.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../server/src/app.js';
import { startFakeAnthropic } from '../../server/test/fake-anthropic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 4173);
const SITE_PORT = PORT + 1;

const fake = await startFakeAnthropic();

const site = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const pages: Record<string, string> = {
    '/article': `<!doctype html><html><head><title>The Tourbillon</title></head><body><article><h1>The Tourbillon</h1><p>A tourbillon mounts the escapement in a rotating cage so that positional errors average out. It was patented by Abraham-Louis Breguet in 1801 and remains a showcase of fine watchmaking.</p><p>Read about the <a href="/escapement">escapement</a>. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation.</p></article></body></html>`,
    '/escapement': `<!doctype html><html><head><title>Escapement</title></head><body><article><h1>Escapement</h1><p>An escapement is a mechanical linkage in clocks and watches that gives impulses to the timekeeping element and periodically releases the gear train to move forward. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></article></body></html>`,
    '/live': `<!doctype html><html><head><title>Live fixture</title></head><body style="margin:0;background:#123"><a href="/live2" style="display:block;width:100%;height:300px;background:#0af;color:#000;font:40px sans-serif">TAP ME</a></body></html>`,
    '/live2': `<!doctype html><html><head><title>Second page</title></head><body><h1>Second page</h1></body></html>`,
  };
  const body = pages[url.pathname];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ?? 'not found');
});
await new Promise<void>((r) => site.listen(SITE_PORT, '127.0.0.1', r));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-e2e-'));
const { app, ctx } = await buildApp({
  dataDir,
  port: PORT,
  ownerPassphrase: 'tourbillion e2e passphrase',
  allowPrivateNetwork: true,
  rateLimitPerMinute: 100_000,
  authRateLimitPerMinute: 1000,
  webDistDir: path.resolve(here, '../dist'),
  anthropic: { apiKey: fake.key, baseUrl: fake.url, defaultModel: 'claude-opus-5-5' },
  browser: { enabled: true, executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', maxTabs: 4, proxy: null },
});

// Test-only control surface for the model double (never part of the real server).
app.post('/__fake/queue', async (req) => {
  const turns = req.body as { blocks: never[]; stop_reason?: never; contains?: string }[];
  for (const t of turns) fake.queue.push({ blocks: t.blocks, stop_reason: t.stop_reason, when: t.contains ? (b) => JSON.stringify(b.messages).includes(t.contains!) : undefined });
  return { queued: fake.queue.length };
});
app.get('/__fake/site', async () => ({ base: `http://127.0.0.1:${SITE_PORT}` }));

await app.listen({ port: PORT, host: '127.0.0.1' });
await ctx.integrations.test('claude');
console.log(`E2E server on http://127.0.0.1:${PORT} (site ${SITE_PORT}, data ${dataDir})`);
