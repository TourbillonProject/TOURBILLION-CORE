import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import { makeApp, waitFor, PASS, type TestApp } from './helpers.js';
import { startFakeAnthropic, type FakeAnthropic } from './fake-anthropic.js';

let app: TestApp;
let fake: FakeAnthropic;

beforeAll(async () => {
  fake = await startFakeAnthropic();
  app = await makeApp({ anthropic: { apiKey: fake.key, baseUrl: fake.url, defaultModel: 'claude-opus-5-5' } });
});
afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('Telemetry (real measurements)', () => {
  it('reports host CPU, memory, process, network capability and app activity', async () => {
    await app.req('GET', '/api/system/status'); // generate an HTTP request
    app.ctx.telemetry.sample();
    const r = await app.req('GET', '/api/system/telemetry');
    expect(r.status).toBe(200);
    expect(r.json.intervalMs).toBe(2000);
    expect(r.json.host.cores).toBe(os.cpus().length);
    expect(r.json.capabilities.network).toBe(fs.existsSync('/proc/net/dev'));
    const s = r.json.history.at(-1);
    expect(s.memory.totalBytes).toBe(os.totalmem());
    expect(s.memory.percent).toBeGreaterThan(0);
    expect(s.memory.percent).toBeLessThanOrEqual(100);
    expect(s.process.rssBytes).toBeGreaterThan(10_000_000);
    expect(s.cpu.cores).toBe(os.cpus().length);
    if (s.cpu.percent !== null) expect(s.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(s.app.httpRequestsPerMin).toBeGreaterThan(0);
    expect(s.storage.dbBytes).toBeGreaterThan(0);
    // Network is either measured or explicitly unavailable — never invented.
    if (r.json.capabilities.network) expect(s.network.source).toContain('/proc/net/dev');
    else expect(s.network.rxBytesPerSec).toBeNull();
  });

  it('keeps a bounded history', () => {
    for (let i = 0; i < 200; i++) app.ctx.telemetry.sample();
    expect(app.ctx.telemetry.snapshot().history.length).toBe(180);
  });

  it('records real AI turn latency, first-token time and tokens for diagnostics', async () => {
    const before = (await app.req('GET', '/api/ai/diagnostics')).json;
    expect(before).toMatchObject({ provider: 'Anthropic Claude', model: 'claude-opus-5-5', turnsSinceStart: 0, lastLatencyMs: null });
    fake.queue.push({ blocks: [{ type: 'thinking', thinking: 'quick' }, { type: 'text', text: 'Pong.' }] });
    const c = await app.req('POST', '/api/conversations', {});
    await app.req('POST', `/api/conversations/${c.json.id}/messages`, { text: 'Ping' });
    await waitFor(() => app.req('GET', `/api/conversations/${c.json.id}`), (r) => !r.json.busy);
    const d = (await app.req('GET', '/api/ai/diagnostics')).json;
    expect(d.turnsSinceStart).toBe(1);
    expect(d.lastLatencyMs).toBeGreaterThanOrEqual(0);
    expect(d.lastFirstTokenMs).not.toBeNull();
    expect(d.tokensToday.input).toBe(120);
    expect(d.tokensToday.output).toBe(42);
    app.ctx.telemetry.sample();
    expect(app.ctx.telemetry.latest()!.app.aiTurnsPerMin).toBe(1);
  });
});

describe('Agent roster and Security Intelligence', () => {
  it('lists seven agents numbered 01–07 in order', async () => {
    const agents = (await app.req('GET', '/api/agents')).json as { id: string; code: string; name: string }[];
    expect(agents.map((a) => `${a.code} ${a.name}`)).toEqual([
      'AGENT 01 Core Intelligence',
      'AGENT 02 The Spider',
      'AGENT 03 Research Intelligence',
      'AGENT 04 Development Engineer',
      'AGENT 05 Creative Operations',
      'AGENT 06 Security Intelligence',
      'AGENT 07 System Operator',
    ]);
  });

  it('reviews the system’s own security posture from real configuration and audit data', async () => {
    // Produce a real failed sign-in in the audit log.
    await app.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-tc-request': '1' }, payload: { passphrase: 'definitely wrong' } });
    await app.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-tc-request': '1' }, payload: { passphrase: PASS } });
    const m = await app.req('POST', '/api/missions', { playbook: 'security.posture', params: { days: 1 } });
    expect(m.json.agent).toBe('security');
    const done = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status));
    expect(done.json.status).toBe('completed');
    const findings = done.json.artifacts.find((a: { kind: string }) => a.kind === 'security_posture').data.findings as { severity: string; area: string; finding: string }[];
    // Test config enables private-network access for fixtures: correctly flagged as high.
    expect(findings).toContainEqual(expect.objectContaining({ severity: 'high', area: 'Network' }));
    expect(findings.find((f) => f.area === 'Sign-in' && f.severity !== 'ok')?.finding).toMatch(/1 failed sign-in/);
    expect(findings).toContainEqual(expect.objectContaining({ area: 'Transport', severity: 'medium' }));
    expect(done.json.report).toContain('Security posture review');
  });

  it('accepts the new presentation and sound settings and rejects invalid values', async () => {
    const ok = await app.req('PATCH', '/api/settings', { graphicsQuality: 'cinematic', ambientSound: true, ambientVolume: 0.3, soundCategories: { interface: false, notifications: true, missions: true, alerts: true, ai: true }, bootSequence: false });
    expect(ok.json).toMatchObject({ graphicsQuality: 'cinematic', ambientSound: true, bootSequence: false, soundCategories: { interface: false } });
    expect((await app.req('PATCH', '/api/settings', { graphicsQuality: 'ultra' })).status).toBe(400);
  });
});
