import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

export const PASS = 'correct horse battery staple';

export interface TestApp extends BuiltApp {
  dir: string;
  cookie: string;
  req: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any; headers: Record<string, unknown> }>;
}

/** Fresh app with its own temp data dir, an owner, and a signed-in session cookie. */
export async function makeApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-'));
  const built = await buildApp({
    dataDir: dir,
    ownerPassphrase: PASS,
    allowPrivateNetwork: true,
    rateLimitPerMinute: 100_000,
    browser: { enabled: false, executablePath: null, maxTabs: 4, proxy: null },
    ...overrides,
  });
  const login = await built.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-tc-request': '1' }, payload: { passphrase: PASS } });
  const setCookie = String(login.headers['set-cookie'] ?? '');
  const cookie = setCookie.split(';')[0];
  const req = async (method: string, url: string, body?: unknown) => {
    const r = await built.app.inject({ method: method as 'GET', url, headers: { cookie, 'x-tc-request': '1' }, ...(body !== undefined ? { payload: body as object } : {}) });
    let json: unknown = null;
    try {
      json = r.json();
    } catch {
      json = r.body;
    }
    return { status: r.statusCode, json, headers: r.headers as Record<string, unknown> };
  };
  return { ...built, dir, cookie, req };
}

export async function waitFor<T>(fn: () => T | Promise<T>, check: (v: T) => boolean, timeoutMs = 15_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  let last: T;
  for (;;) {
    last = await fn();
    if (check(last)) return last;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last).slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Tiny fixture HTTP server: route table of path → handler. */
export async function fixtureServer(routes: Record<string, (req: http.IncomingMessage, url: URL, body: string) => { status?: number; headers?: Record<string, string>; body: string | Buffer | object }>) {
  const hits: { method: string; path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      hits.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
      const key = Object.keys(routes).find((k) => (k.endsWith('*') ? url.pathname.startsWith(k.slice(0, -1)) : url.pathname === k));
      if (!key) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      const out = routes[key](req, url, body);
      const payload = typeof out.body === 'string' || Buffer.isBuffer(out.body) ? out.body : JSON.stringify(out.body);
      res.writeHead(out.status ?? 200, { 'content-type': typeof out.body === 'object' && !Buffer.isBuffer(out.body) ? 'application/json' : 'text/html; charset=utf-8', ...(out.headers ?? {}) });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}
