import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isPrivateAddress, NetworkPolicyError, resolveAllowed, safeFetch } from '../src/security/net.js';
import { gateFor } from '../src/agents/permissions.js';
import { detectSecret } from '../src/memory/service.js';
import { fixtureServer, makeApp, PASS, type TestApp } from './helpers.js';

describe('first-run setup and sign-in', () => {
  let dir: string;
  let built: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sec-'));
    built = await buildApp({ dataDir: dir, ownerPassphrase: null, browser: { enabled: false, executablePath: null, maxTabs: 1, proxy: null } });
  });
  afterAll(() => built.close());
  const post = (url: string, payload: object, headers: Record<string, string> = { 'x-tc-request': '1' }) => built.app.inject({ method: 'POST', url, headers, payload });

  it('requires the one-time setup code before an owner can be created', async () => {
    const state = (await built.app.inject({ url: '/api/auth/state' })).json();
    expect(state.setupRequired).toBe(true);
    const code = fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8').trim();
    expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect((await post('/api/auth/setup', { setupCode: 'WRONG-CODE0', passphrase: PASS })).statusCode).toBe(403);
    expect((await post('/api/auth/setup', { setupCode: code, passphrase: 'short' })).statusCode).toBe(400);
    const ok = await post('/api/auth/setup', { setupCode: code, passphrase: PASS });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/tc_session=.+HttpOnly.+SameSite=Lax/i);
    expect(fs.existsSync(path.join(dir, 'setup-code.txt'))).toBe(false);
    expect((await post('/api/auth/setup', { setupCode: code, passphrase: PASS })).statusCode).toBe(409);
  });

  it('rejects requests without the CSRF header and locks out brute force', async () => {
    expect((await post('/api/auth/login', { passphrase: PASS }, {})).statusCode).toBe(403);
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/login', { passphrase: 'wrong' })).statusCode).toBe(401);
    const locked = await post('/api/auth/login', { passphrase: PASS });
    expect(locked.statusCode).toBe(429);
  });

  it('stores only a hash of the passphrase and of session tokens', () => {
    const owner = built.ctx.db.get<{ passphrase_hash: string }>('SELECT passphrase_hash FROM owner');
    expect(owner!.passphrase_hash).toMatch(/^scrypt\$/);
    expect(owner!.passphrase_hash).not.toContain(PASS);
    const s = built.ctx.db.get<{ id: string }>('SELECT id FROM sessions');
    expect(s!.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('API protection', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await makeApp({ projectRoots: [] });
  });
  afterAll(() => app.close());

  it('every owner route requires a session', async () => {
    const routes = ['/api/system/status', '/api/settings', '/api/conversations', '/api/memory', '/api/missions', '/api/approvals', '/api/projects', '/api/integrations', '/api/audit', '/api/data/export', '/api/browser/history', '/api/research/reports', '/api/bridge', '/api/automations'];
    for (const url of routes) expect((await app.app.inject({ url })).statusCode, url).toBe(401);
    expect((await app.app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('state-changing requests need the verification header even with a valid session', async () => {
    const r = await app.app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: app.cookie }, payload: { soundVolume: 0.2 } });
    expect(r.statusCode).toBe(403);
    const approve = await app.app.inject({ method: 'POST', url: '/api/approvals/1', headers: { cookie: app.cookie }, payload: { approve: true } });
    expect(approve.statusCode).toBe(403);
  });

  it('sends a strict Content-Security-Policy and hardening headers', async () => {
    const r = await app.app.inject({ url: '/api/health' });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('frame-src https://www.youtube-nocookie.com');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('data export never includes credentials', async () => {
    app.ctx.secrets.set('anthropic.api_key', 'sk-ant-api03-secretsecretsecretsecret');
    const r = await app.req('GET', '/api/data/export');
    expect(JSON.stringify(r.json)).not.toContain('secretsecret');
    expect(r.json.secrets).toBeUndefined();
  });

  it('rejects WebSocket connections from other origins (cross-site WebSocket hijacking)', async () => {
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as AddressInfo).port;
    const tryWs = (origin: string) =>
      new Promise<{ code: number; hello: boolean }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { cookie: app.cookie, origin } });
        let hello = false;
        ws.on('message', (m) => {
          if (String(m).includes('"hello"')) {
            hello = true;
            ws.close(1000);
          }
        });
        ws.on('close', (code) => resolve({ code, hello }));
      });
    const evil = await tryWs('https://evil.example');
    expect(evil.hello).toBe(false);
    expect(evil.code).toBe(4401);
    const good = await tryWs(`http://127.0.0.1:${port}`);
    expect(good.hello).toBe(true);
  });

  it('confines project file access to the project (traversal and symlinks)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-proj-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    fs.symlinkSync('/etc', path.join(root, 'etc-link'));
    app.ctx.config.projectRoots.push(root);
    const p = app.ctx.projects.addLocal('traversal', root);
    expect(() => app.ctx.projects.resolveInProject(p, '../../etc/passwd')).toThrow(/outside the project/);
    expect(() => app.ctx.projects.resolveInProject(p, 'etc-link/passwd')).toThrow(/outside the project/);
    expect(app.ctx.projects.resolveInProject(p, 'a.txt')).toBe(path.join(fs.realpathSync(root), 'a.txt'));
    const r = await app.req('GET', `/api/projects/${p.id}/file?path=${encodeURIComponent('../../../etc/hostname')}`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('path_escape');
  });

  it('refuses local projects outside the configured roots', () => {
    expect(() => app.ctx.projects.addLocal('etc', '/etc')).toThrow(/not under an allowed project root/);
  });

  it('blocks zip-slip archive entries', () => {
    const zip = zipSync({ 'ok.txt': strToU8('fine'), '../../evil.txt': strToU8('pwned') });
    expect(() => app.ctx.projects.addFromZip('slip', zip)).toThrow(/Unsafe path/);
  });
});

describe('network guard (SSRF)', () => {
  it('classifies private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe'.replace('a9fe:a9fe', '169.254.169.254')]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses private targets, internal names, non-http schemes and embedded credentials', async () => {
    const policy = { allowPrivateNetwork: false };
    await expect(resolveAllowed('127.0.0.1', policy)).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(resolveAllowed('169.254.169.254', policy)).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(resolveAllowed('localhost', policy)).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(resolveAllowed('metadata.internal', policy)).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(safeFetch('file:///etc/passwd', { policy })).rejects.toThrow(/Only http and https/);
    await expect(safeFetch('https://user:pw@example.com/', { policy })).rejects.toThrow(/credentials/);
  });

  it('re-validates every redirect hop', async () => {
    const fx = await fixtureServer({
      '/to-metadata': () => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, body: '' }),
      '/to-localhost': () => ({ status: 301, headers: { location: 'http://localhost/admin' }, body: '' }),
      '/ok': () => ({ body: 'fine' }),
    });
    // Trust only the fixture's address; anything it redirects to must pass the policy on its own.
    const policy = { allowPrivateNetwork: false, trustedHosts: ['127.0.0.1'] };
    expect((await safeFetch(`${fx.base}/ok`, { policy })).text()).toBe('fine');
    await expect(safeFetch(`${fx.base}/to-metadata`, { policy })).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(safeFetch(`${fx.base}/to-localhost`, { policy })).rejects.toBeInstanceOf(NetworkPolicyError);
    await fx.close();
  });
});

describe('permission gate', () => {
  it('reads run, writes need opt-in or plan approval, sensitive always asks', () => {
    expect(gateFor('read', 'x', false, [])).toBe('allow');
    expect(gateFor('write', 'memory_save', false, [])).toBe('approval');
    expect(gateFor('write', 'memory_save', true, [])).toBe('allow');
    expect(gateFor('write', 'memory_save', false, ['memory_save'])).toBe('allow');
    expect(gateFor('sensitive', 'gmail_send_draft', true, ['gmail_send_draft'])).toBe('approval');
  });

  it('detects credentials in text', () => {
    expect(detectSecret('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('GitHub token');
    expect(detectSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('Private key');
    expect(detectSecret('password: hunter2!')).toBe('password assignment');
    expect(detectSecret('Keenan likes Blender and tea')).toBeNull();
  });
});
