import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, pair } from '../../bridge/src/client.js';
import type { BridgeConfig } from '../../bridge/src/config.js';
import { nextRun } from '../src/automations/service.js';
import { fixtureServer, makeApp, waitFor, type TestApp } from './helpers.js';
import { startFakeAnthropic, type FakeAnthropic } from './fake-anthropic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Real Blender: a Python interpreter with the official `bpy` module (Blender as a module).
const BPY_PYTHON = process.env.TC_TEST_BPY_PYTHON ?? '';
const HAS_BLENDER = !!BPY_PYTHON && fs.existsSync(BPY_PYTHON);

let app: TestApp;
let fake: FakeAnthropic;
let google: Awaited<ReturnType<typeof fixtureServer>>;
let port: number;
const gmailSent: string[] = [];

beforeAll(async () => {
  fake = await startFakeAnthropic();
  google = await fixtureServer({
    '/token': (_r, _u, body) => {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code' || !p.get('code_verifier')) return { status: 400, body: { error: 'invalid_grant' } };
        return { body: { access_token: 'ya29.fake-access', refresh_token: '1//fake-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.modify' } };
      }
      return { body: { access_token: 'ya29.refreshed', expires_in: 3600 } };
    },
    '/gmail/users/me/profile': (req) => (req.headers.authorization?.startsWith('Bearer ya29') ? { body: { emailAddress: 'keenan@example.com', messagesTotal: 42 } } : { status: 401, body: {} }),
    '/gmail/users/me/messages': () => ({ body: { messages: [{ id: 'm1', threadId: 't1' }] } }),
    '/gmail/users/me/messages/m1': () => ({ body: { id: 'm1', threadId: 't1', snippet: 'Render farm quote attached', labelIds: ['INBOX', 'UNREAD'], payload: { headers: [{ name: 'From', value: 'Studio <studio@example.com>' }, { name: 'Subject', value: 'Quote' }, { name: 'Date', value: 'Fri, 6 Nov 2026 10:00:00 +0000' }, { name: 'To', value: 'keenan@example.com' }] } } }),
    '/gmail/users/me/drafts': (_r, _u, body) => {
      const raw = JSON.parse(body).message.raw as string;
      return { body: { id: 'd1', message: { id: 'm2', threadId: 't1' }, _raw: Buffer.from(raw, 'base64url').toString() } };
    },
    '/gmail/users/me/drafts/d1': () => ({ body: { id: 'd1', message: { id: 'm2', threadId: 't1', payload: { headers: [{ name: 'To', value: 'studio@example.com' }, { name: 'Subject', value: 'Re: Quote' }], mimeType: 'text/plain', body: { data: Buffer.from('Thanks — approved.').toString('base64url') } } } } }),
    '/gmail/users/me/drafts/send': (_r, _u, body) => {
      gmailSent.push(JSON.parse(body).id);
      return { body: { id: 'm2', threadId: 't1' } };
    },
  });
  app = await makeApp({
    publicUrl: 'https://tc.example',
    google: { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'secret' },
    anthropic: { apiKey: fake.key, baseUrl: fake.url, defaultModel: 'claude-opus-5-5' },
    endpoints: { googleOAuth: `${google.base}/auth`, googleToken: `${google.base}/token`, gmail: `${google.base}/gmail` } as never,
  });
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await google.close();
});

function scriptMission(plan: object) {
  fake.queue.push({ when: (b) => JSON.stringify(b.output_config?.format ?? {}).includes('successCriteria'), blocks: [{ type: 'text', text: JSON.stringify(plan) }] });
}
function scriptVerify(outcome = 'succeeded') {
  fake.queue.push({ when: (b) => JSON.stringify(b.output_config?.format ?? {}).includes('unverified'), blocks: [{ type: 'text', text: JSON.stringify({ outcome, summary: 'checked', evidence: ['tool results'], unverified: [] }) }] });
}
async function approvePending(taskId: number, tool: string) {
  const r = await waitFor(() => app.req('GET', `/api/missions/${taskId}`), (x) => x.json.approvals.some((a: { status: string; tool: string }) => a.status === 'pending' && a.tool === tool), 60_000, `approval for ${tool}`);
  const a = r.json.approvals.find((x: { status: string; tool: string }) => x.status === 'pending' && x.tool === tool);
  await app.req('POST', `/api/approvals/${a.id}`, { approve: true });
  return a;
}

describe('Gmail (OAuth + approval-gated sending)', () => {
  it('runs the OAuth authorisation-code flow with PKCE and state bound to the session', async () => {
    const start = await app.req('GET', '/api/integrations/gmail/start');
    const url = new URL(start.json.url);
    expect(url.origin + url.pathname).toBe(`${google.base}/auth`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://tc.example/api/integrations/gmail/callback');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify');
    const state = url.searchParams.get('state')!;
    // A forged state is rejected.
    const forged = await app.app.inject({ url: `/api/integrations/gmail/callback?code=good-code&state=forged`, headers: { cookie: app.cookie } });
    expect(forged.headers.location).toContain('gmail=error');
    const cb = await app.app.inject({ url: `/api/integrations/gmail/callback?code=good-code&state=${state}`, headers: { cookie: app.cookie } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/?section=apps&gmail=connected');
    const status = (await app.req('GET', '/api/integrations')).json.find((i: { id: string }) => i.id === 'gmail');
    expect(status.state).toBe('connected');
    expect(status.details.account).toBe('keenan@example.com');
    const row = app.ctx.db.get<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE name = 'gmail.tokens'");
    expect(row!.ciphertext).not.toContain('fake-refresh');
  });

  it('drafts automatically but sends only after the owner approves', async () => {
    scriptMission({ interpretation: 'Reply to the studio.', steps: [{ title: 'Read', detail: '', tools: ['gmail_search'], risk: 'read' }, { title: 'Draft', detail: '', tools: ['gmail_create_draft'], risk: 'write' }, { title: 'Send', detail: '', tools: ['gmail_send_draft'], risk: 'sensitive' }], requiredPermissions: [{ tool: 'gmail_send_draft', risk: 'sensitive', reason: 'send reply' }], successCriteria: ['Reply sent'] });
    const m = await app.req('POST', '/api/missions', { agent: 'operator', title: 'Reply to studio', request: 'Reply to the studio quote saying it is approved.' });
    await approvePending(m.json.id, 'mission.plan');
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Approved plan') && !JSON.stringify(b.messages).includes('tool_result'), blocks: [{ type: 'tool_use', name: 'gmail_search', input: { query: 'from:studio' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Render farm quote') && !JSON.stringify(b.messages).includes('Draft created'), blocks: [{ type: 'tool_use', name: 'gmail_create_draft', input: { to: 'studio@example.com', subject: 'Re: Quote', body: 'Thanks — approved.', threadId: 't1' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Draft created') && !JSON.stringify(b.messages).includes('Email sent'), blocks: [{ type: 'tool_use', name: 'gmail_send_draft', input: { draftId: 'd1', to: 'studio@example.com', subject: 'Re: Quote', bodyPreview: 'Thanks — approved.' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Email sent'), blocks: [{ type: 'text', text: 'Reply sent to the studio.' }] });
    scriptVerify();
    const approval = await approvePending(m.json.id, 'gmail_send_draft');
    expect(approval.risk).toBe('sensitive');
    expect(approval.input).toMatchObject({ to: 'studio@example.com', subject: 'Re: Quote' });
    const done = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 30_000, 'gmail mission');
    expect(done.json.status).toBe('completed');
    expect(gmailSent).toEqual(['d1']);
  });

  it('a denied send never reaches Gmail', async () => {
    scriptMission({ interpretation: 'Send.', steps: [{ title: 'Send', detail: '', tools: ['gmail_send_draft'], risk: 'sensitive' }], requiredPermissions: [{ tool: 'gmail_send_draft', risk: 'sensitive', reason: 'send' }], successCriteria: ['Sent'] });
    const m = await app.req('POST', '/api/missions', { agent: 'operator', title: 'Send again', request: 'Send draft d1.' });
    await approvePending(m.json.id, 'mission.plan');
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Send draft d1') && !JSON.stringify(b.messages).includes('tool_result'), blocks: [{ type: 'tool_use', name: 'gmail_send_draft', input: { draftId: 'd1', to: 'studio@example.com', subject: 'Re: Quote', bodyPreview: 'x' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('denied'), blocks: [{ type: 'text', text: 'Not sent: you declined.' }] });
    scriptVerify('failed');
    const r = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (x) => x.json.approvals.some((a: { status: string; tool: string }) => a.status === 'pending' && a.tool === 'gmail_send_draft'), 30_000);
    await app.req('POST', `/api/approvals/${r.json.approvals.find((a: { tool: string; status: string }) => a.tool === 'gmail_send_draft' && a.status === 'pending').id}`, { approve: false });
    await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (x) => ['completed', 'failed'].includes(x.json.status), 30_000);
    expect(gmailSent).toEqual(['d1']); // unchanged
  });
});

describe('Desktop bridge', () => {
  let bridge: ReturnType<typeof connect>;
  let roots: string;
  let roblox: string;
  let shim: string;

  beforeAll(async () => {
    roots = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-blender-'));
    roblox = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-roblox-'));
    fs.mkdirSync(path.join(roblox, 'src'));
    fs.writeFileSync(path.join(roblox, 'src', 'Main.server.luau'), 'print("hello from Roblox")\n');
    fs.writeFileSync(path.join(roblox, 'default.project.json'), JSON.stringify({ name: 'Atlas', tree: { $className: 'DataModel' } }));
    shim = path.join(roots, '..', `blender-shim-${process.pid}.sh`);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${BPY_PYTHON || 'false'}" "${path.join(HERE, '../../bridge/test/blender-shim.py')}" "$@"\n`, { mode: 0o755 });

    const pairing = await app.req('POST', '/api/bridge/pairing', { name: 'Studio Mac' });
    expect(pairing.json.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const server = `http://127.0.0.1:${port}`;
    await expect(pair(server, 'WRNG-CODE')).rejects.toThrow(/invalid or expired/);
    const token = await pair(server, pairing.json.code);
    expect(token).toMatch(/^tcb_/);
    await expect(pair(server, pairing.json.code)).rejects.toThrow(); // one-time
    const cfg: BridgeConfig = {
      server,
      token,
      name: 'Studio Mac',
      roots: [roots],
      blender: { path: shim, allowScripts: true, timeoutSec: 300 },
      roblox: { projectDir: roblox, tasks: { lint: [process.execPath, '-e', "console.log('lint: 0 problems')"] }, timeoutSec: 60 },
    };
    bridge = connect(cfg, () => {});
    await bridge.ready;
    await waitFor(() => app.req('GET', '/api/integrations'), (r) => r.json.find((i: { id: string }) => i.id === 'bridge')?.state === 'connected', 20_000, 'bridge connected');
  });
  afterAll(() => bridge?.close());

  it('reports capabilities and enforces the local allowlist', async () => {
    const list = (await app.req('GET', '/api/bridge')).json;
    expect(list[0]).toMatchObject({ name: 'Studio Mac', connected: true });
    expect(list[0].hello.capabilities.roblox).toMatchObject({ available: true, tasks: ['lint'] });
    await expect(app.ctx.bridge.request('roblox.read', { path: '../../etc/passwd' })).rejects.toThrow(/outside the allowed folders/);
    await expect(app.ctx.bridge.request('roblox.run_task', { task: 'rm -rf /' })).rejects.toThrow(/Unknown task/);
    await expect(app.ctx.bridge.request('roblox.write', { path: 'evil.sh', content: 'x' })).rejects.toThrow(/Only \.lua/);
    await expect(app.ctx.bridge.request('fs.read', { path: '/etc/hostname' })).rejects.toThrow(/outside the allowed folders/);
  });

  it('manages Roblox project files with backups and runs only named tasks', async () => {
    const files = (await app.ctx.bridge.request('roblox.list', {})) as { files: { path: string }[] };
    expect(files.files.map((f) => f.path).sort()).toEqual(['default.project.json', 'src/Main.server.luau']);
    const w = (await app.ctx.bridge.request('roblox.write', { path: 'src/Main.server.luau', content: 'print("updated by Creative Intelligence")\n' })) as { backup: string };
    expect(w.backup).toMatch(/^\.tourbillion-backups\//);
    expect(fs.readFileSync(path.join(roblox, 'src/Main.server.luau'), 'utf8')).toContain('updated by Creative Intelligence');
    expect(fs.readFileSync(path.join(roblox, w.backup), 'utf8')).toContain('hello from Roblox');
    const t = (await app.ctx.bridge.request('roblox.run_task', { task: 'lint' })) as { exitCode: number; stdout: string };
    expect(t).toMatchObject({ exitCode: 0, stdout: 'lint: 0 problems\n' });
  });

  it.skipIf(!HAS_BLENDER)('Creative Intelligence builds a real Blender scene (approval-gated script), inspects it, and renders a preview', async () => {
    const status = (await app.req('GET', '/api/integrations')).json.find((i: { id: string }) => i.id === 'blender');
    expect(status.state).toBe('connected');
    expect(status.details.version).toMatch(/^\d+\.\d+/);

    const script = [
      'import bpy',
      'bpy.ops.wm.read_factory_settings(use_empty=True)',
      'bpy.ops.mesh.primitive_torus_add(major_radius=1.0, minor_radius=0.08, location=(0, 0, 0))',
      'bpy.context.active_object.name = "TourbillonCage"',
      'bpy.ops.mesh.primitive_uv_sphere_add(radius=0.35)',
      'bpy.context.active_object.name = "Core"',
      'bpy.ops.object.camera_add(location=(0, -4, 1.2), rotation=(1.3, 0, 0))',
      'bpy.context.scene.camera = bpy.context.active_object',
      'bpy.ops.object.light_add(type="SUN", location=(2, -2, 4))',
      'bpy.context.scene.render.engine = "CYCLES"',
      'bpy.context.scene.cycles.samples = 8',
      'print("scene objects:", [o.name for o in bpy.data.objects])',
    ].join('\n');
    scriptMission({ interpretation: 'Build a tourbillon scene.', steps: [{ title: 'Build scene', detail: '', tools: ['blender_run_script'], risk: 'sensitive' }, { title: 'Inspect', detail: '', tools: ['blender_scene_info'], risk: 'read' }], requiredPermissions: [{ tool: 'blender_run_script', risk: 'sensitive', reason: 'runs Python in Blender' }], successCriteria: ['tourbillon.blend saved with a TourbillonCage object'] });
    const m = await app.req('POST', '/api/missions', { agent: 'creative', title: 'Tourbillon scene', request: 'Prepare a Blender scene with a tourbillon cage and core.' });
    await approvePending(m.json.id, 'mission.plan');
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Approved plan') && !JSON.stringify(b.messages).includes('tool_result'), blocks: [{ type: 'text', text: 'Building the scene.' }, { type: 'tool_use', name: 'blender_run_script', input: { script, saveAs: 'tourbillon.blend', purpose: 'Create the tourbillon scene' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Blender exit code') && !JSON.stringify(b.messages).includes('TourbillonCage\\",\\"type'), blocks: [{ type: 'tool_use', name: 'blender_scene_info', input: { blendFile: 'tourbillon.blend' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('frameRange'), blocks: [{ type: 'text', text: 'Scene saved with TourbillonCage and Core.' }] });
    scriptVerify();
    const approval = await approvePending(m.json.id, 'blender_run_script');
    expect(approval.input.script).toContain('TourbillonCage'); // the owner sees the exact script
    const done = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 180_000, 'blender mission');
    expect(done.json.status).toBe('completed');
    expect(fs.existsSync(path.join(roots, 'tourbillon.blend'))).toBe(true);

    const info = (await app.ctx.bridge.request('blender.scene_info', { blendFile: 'tourbillon.blend' }, 180_000)) as { objects: { name: string; type: string }[]; engine: string; blender: string };
    expect(info.objects.map((o) => o.name)).toEqual(expect.arrayContaining(['TourbillonCage', 'Core', 'Camera', 'Sun']));
    expect(info.engine).toBe('CYCLES');

    // Render preview playbook (writes a PNG → plan approval required).
    const pv = await app.req('POST', '/api/missions', { playbook: 'creative.blender_preview', params: { blendFile: 'tourbillon.blend', render: true } });
    await approvePending(pv.json.id, 'mission.plan');
    const rendered = await waitFor(() => app.req('GET', `/api/missions/${pv.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 300_000, 'render');
    expect(rendered.json.status).toBe('completed');
    const art = rendered.json.artifacts.find((a: { kind: string }) => a.kind === 'render');
    const png = Buffer.from(art.data.previewBase64, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(art.data.width).toBe(480);
    console.log(`[blender] ${info.blender}: rendered ${art.data.width}×${art.data.height} (${png.length} bytes) with ${art.data.engine}`);
    fs.writeFileSync(path.join(os.tmpdir(), 'tc-blender-render.png'), png);
  }, 400_000);

  it('reports a stopped bridge as disconnected (paired but offline)', async () => {
    bridge.close();
    await waitFor(() => app.ctx.bridge.connectedCount(), (n) => n === 0);
    const s = (await app.req('GET', '/api/integrations')).json.find((i: { id: string }) => i.id === 'bridge');
    expect(s.state).toBe('disconnected');
    await expect(app.ctx.bridge.request('roblox.list', {})).rejects.toThrow(/No desktop bridge is connected/);
  });

  it('revoking a bridge stops it reconnecting', async () => {
    const id = (await app.req('GET', '/api/bridge')).json[0].id;
    await app.req('DELETE', `/api/bridge/${id}`);
    expect((await app.req('GET', '/api/bridge')).json).toHaveLength(0);
  });
});

describe('Automations', () => {
  it('computes next runs for intervals and daily schedules in local time', () => {
    const from = new Date('2026-11-07T10:00:00Z');
    expect(nextRun({ type: 'interval', minutes: 90 }, from).toISOString()).toBe('2026-11-07T11:30:00.000Z');
    expect(nextRun({ type: 'daily', time: '08:30', utcOffsetMinutes: 0 }, from).toISOString()).toBe('2026-11-08T08:30:00.000Z');
    expect(nextRun({ type: 'daily', time: '12:00', utcOffsetMinutes: 60 }, from).toISOString()).toBe('2026-11-07T11:00:00.000Z');
  });

  it('fires a due automation as a normal mission', async () => {
    const a = await app.req('POST', '/api/automations', { name: 'Hourly diagnostics', schedule: { type: 'interval', minutes: 60 }, action: { kind: 'playbook', playbook: 'system.diagnostics', params: {}, title: 'Diagnostics' } });
    expect(a.status).toBe(200);
    app.ctx.automations.tick(new Date(Date.now() + 61 * 60_000));
    const after = (await app.req('GET', '/api/automations')).json[0];
    expect(after.lastTaskId).toBeTruthy();
    const t = await waitFor(() => app.req('GET', `/api/missions/${after.lastTaskId}`), (r) => ['completed', 'failed'].includes(r.json.status), 60_000, 'diagnostics');
    expect(t.json.report).toContain('System diagnostics');
    expect(t.json.report).toMatch(/Database: ok/);
    expect((await app.req('POST', '/api/automations', { name: 'too fast', schedule: { type: 'interval', minutes: 1 }, action: { kind: 'playbook', playbook: 'system.diagnostics', params: {}, title: 'x' } })).status).toBe(400);
  });
});
