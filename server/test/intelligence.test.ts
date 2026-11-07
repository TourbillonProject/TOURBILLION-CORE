import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, waitFor, type TestApp } from './helpers.js';
import { startFakeAnthropic, type FakeAnthropic } from './fake-anthropic.js';

/**
 * Claude integration through the real SDK against a local Messages-API
 * double (no real key exists in CI). Verifies connection UX, streaming chat,
 * request shape, memory retrieval, tool loops, approval gating, refusals,
 * and the full agent-mission lifecycle.
 */

let app: TestApp;
let fake: FakeAnthropic;

beforeAll(async () => {
  fake = await startFakeAnthropic();
  app = await makeApp({ anthropic: { apiKey: null, baseUrl: fake.url, defaultModel: 'claude-opus-5-5' } });
});
afterAll(async () => {
  await app.close();
  await fake.close();
});

async function conversation() {
  const c = await app.req('POST', '/api/conversations', {});
  return c.json.id as number;
}

async function turnDone(cid: number) {
  return waitFor(() => app.req('GET', `/api/conversations/${cid}`), (r) => !r.json.busy, 20_000, 'turn to finish');
}

describe('Claude connection', () => {
  it('reports not configured before a key is added', async () => {
    const r = await app.req('GET', '/api/ai/status');
    expect(r.json.integration.state).toBe('not_configured');
    const send = await app.req('POST', `/api/conversations/${await conversation()}/messages`, { text: 'hello' });
    expect(send.status).toBe(409);
    expect(send.json.error).toBe('ai_not_connected');
  });

  it('rejects malformed keys and reports a real 401 for a wrong key', async () => {
    expect((await app.req('POST', '/api/ai/key', { apiKey: 'not-a-key-at-all-xxxxxxxx' })).status).toBe(400);
    const bad = await app.req('POST', '/api/ai/key', { apiKey: 'sk-ant-wrong-key-000000000000000000' });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.integration.state).toBe('error');
    expect(bad.json.integration.lastError).toMatch(/401|rejected/i);
  });

  it('connects with a valid key, stores it encrypted and never returns it', async () => {
    const r = await app.req('POST', '/api/ai/key', { apiKey: fake.key });
    expect(r.json.ok).toBe(true);
    expect(r.json.integration.state).toBe('connected');
    const status = await app.req('GET', '/api/ai/status');
    expect(status.json.keyPreview).toBe('sk-a…ghij');
    expect(JSON.stringify(status.json)).not.toContain(fake.key);
    const row = app.ctx.db.get<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE name = 'anthropic.api_key'");
    expect(row?.ciphertext).toBeTruthy();
    expect(row!.ciphertext).not.toContain('sk-ant');
  });
});

describe('Conversations', () => {
  it('streams a reply, sends a well-formed request, and injects relevant memory', async () => {
    await app.req('POST', '/api/memory', { category: 'project', title: 'Atlas engine', content: 'Project Atlas uses Godot 4 and targets the iPad.' });
    fake.queue.push({ blocks: [{ type: 'thinking', thinking: 'The owner asks about Atlas; memory says Godot.' }, { type: 'text', text: 'Atlas is built on Godot 4, according to your notes.' }] });
    const events: string[] = [];
    const off = app.ctx.bus.on((e) => events.push(e.type));
    const cid = await conversation();
    const send = await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'Which engine does Atlas use?' });
    expect(send.status).toBe(200);
    const done = await turnDone(cid);
    off();
    const msgs = done.json.messages;
    expect(msgs.at(-1).role).toBe('assistant');
    expect(msgs.at(-1).text).toBe('Atlas is built on Godot 4, according to your notes.');
    expect(msgs.at(-1).thinking).toContain('memory says Godot');
    expect(events).toContain('chat.delta');
    expect(events).toContain('chat.thinking');
    expect(events).toContain('chat.done');

    const req = fake.requests.at(-1)!;
    expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.stream).toBe(true);
    expect(req.body.fallbacks).toBe('default');
    expect(req.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(req.body.output_config.effort).toBe('medium');
    expect(req.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.body.system[0].text).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no volatile timestamp in the cached prefix
    expect(req.body.tools.every((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming === true)).toBe(true);
    const userText = JSON.stringify(req.body.messages.at(-1).content);
    expect(userText).toContain('memory_context');
    expect(userText).toContain('Godot 4');
  });

  it('replays prior turns byte-for-byte (append-only history, thinking preserved)', async () => {
    const cid = await conversation();
    fake.queue.push({ blocks: [{ type: 'thinking', thinking: 'first thought' }, { type: 'text', text: 'One.' }] });
    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'Count to one.' });
    await turnDone(cid);
    fake.queue.push({ blocks: [{ type: 'text', text: 'Two.' }] });
    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'Now two.' });
    await turnDone(cid);
    const second = fake.requests.at(-1)!.body.messages;
    expect(second).toHaveLength(3);
    expect(second[1].role).toBe('assistant');
    expect(second[1].content[0]).toMatchObject({ type: 'thinking', thinking: 'first thought', signature: 'sig_fake' });
  });

  it('runs a tool loop: auto-approved low-risk write, then answers', async () => {
    const cid = await conversation();
    fake.queue.push({ blocks: [{ type: 'text', text: 'Noting that.' }, { type: 'tool_use', name: 'memory_save', input: { category: 'preference', title: 'Tea', content: 'Keenan prefers Earl Grey.' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Saved memory'), blocks: [{ type: 'text', text: 'Saved: you prefer Earl Grey.' }] });
    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'Remember I prefer Earl Grey.' });
    const done = await turnDone(cid);
    expect(done.json.messages.at(-1).text).toBe('Saved: you prefer Earl Grey.');
    const mem = await app.req('GET', '/api/memory?q=Earl%20Grey');
    expect(mem.json[0].title).toBe('Tea');
    // The tool_result went back in a single user message.
    const last = fake.requests.at(-1)!.body.messages.at(-1);
    expect(last.role).toBe('user');
    expect(last.content[0].type).toBe('tool_result');
  });

  it('pauses on a sensitive tool until the owner decides; denial is reported to the model', async () => {
    const m = await app.req('POST', '/api/memory', { category: 'lesson', title: 'Old note', content: 'Something obsolete.' });
    const cid = await conversation();
    fake.queue.push({ blocks: [{ type: 'tool_use', name: 'memory_delete', input: { id: m.json.id, reason: 'owner asked' } }] });
    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'Delete the old note.' });
    const pending = await waitFor(() => app.req('GET', '/api/approvals?status=pending'), (r) => r.json.some((a: { conversationId: number }) => a.conversationId === cid), 10_000, 'approval');
    const approval = pending.json.find((a: { conversationId: number }) => a.conversationId === cid);
    expect(approval.tool).toBe('memory_delete');
    expect(approval.risk).toBe('sensitive');
    // Nothing happened yet.
    expect((await app.req('GET', `/api/memory?category=lesson`)).json.some((x: { id: number }) => x.id === m.json.id)).toBe(true);

    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('denied'), blocks: [{ type: 'text', text: 'Understood — I left the note in place.' }] });
    const decided = await app.req('POST', `/api/approvals/${approval.id}`, { approve: false, note: 'keep it' });
    expect(decided.json.status).toBe('denied');
    const done = await turnDone(cid);
    expect(done.json.messages.at(-1).text).toBe('Understood — I left the note in place.');
    expect((await app.req('GET', `/api/memory?category=lesson`)).json.some((x: { id: number }) => x.id === m.json.id)).toBe(true);
    const audit = await app.req('GET', '/api/audit?limit=50');
    expect(audit.json.some((a: { action: string }) => a.action === 'approval.denied')).toBe(true);
  });

  it('executes the sensitive tool only after approval', async () => {
    const m = await app.req('POST', '/api/memory', { category: 'lesson', title: 'Delete me', content: 'Temporary.' });
    const cid = await conversation();
    fake.queue.push({ blocks: [{ type: 'tool_use', name: 'memory_delete', input: { id: m.json.id } }] });
    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'Delete it.' });
    const pending = await waitFor(() => app.req('GET', '/api/approvals?status=pending'), (r) => r.json.some((a: { conversationId: number }) => a.conversationId === cid));
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('deleted'), blocks: [{ type: 'text', text: 'Deleted.' }] });
    await app.req('POST', `/api/approvals/${pending.json.find((a: { conversationId: number }) => a.conversationId === cid).id}`, { approve: true });
    const done = await turnDone(cid);
    expect(done.json.messages.at(-1).text).toBe('Deleted.');
    expect((await app.req('GET', '/api/memory?category=lesson')).json.some((x: { id: number }) => x.id === m.json.id)).toBe(false);
  });

  it('handles a refusal without treating partial output as an answer', async () => {
    const cid = await conversation();
    fake.queue.push({ blocks: [{ type: 'text', text: 'Partial…' }], stop_reason: 'refusal' });
    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'something declined' });
    const done = await turnDone(cid);
    const last = done.json.messages.at(-1);
    expect(last.role).toBe('notice');
    expect(last.text).toMatch(/declined/);
    expect(done.json.messages.some((x: { text: string }) => x.text === 'Partial…')).toBe(false);
  });

  it('refuses to store credentials as memories', async () => {
    const r = await app.req('POST', '/api/memory', { category: 'preference', title: 'key', content: 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz' });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('secret_content');
  });
});

describe('Agent missions', () => {
  it('plans, waits for plan approval, executes with tools, verifies, and completes', async () => {
    fake.queue.push({
      when: (b) => !!b.output_config?.format && JSON.stringify(b.output_config.format).includes('successCriteria'),
      blocks: [{ type: 'text', text: JSON.stringify({ interpretation: 'Record the decision to use SQLite.', steps: [{ title: 'Save decision', detail: 'memory_save', tools: ['memory_save'], risk: 'write' }], requiredPermissions: [{ tool: 'memory_save', risk: 'write', reason: 'store the decision' }], successCriteria: ['Decision stored in memory'] }) }],
    });
    // Mission runs with autoApproveWrites off to prove plan approval pre-approves declared writes.
    await app.req('PATCH', '/api/settings', { autoApproveWrites: false });
    const created = await app.req('POST', '/api/missions', { agent: 'research', title: 'Record DB decision', request: 'Store our decision: SQLite first, PostgreSQL later.' });
    expect(created.status).toBe(200);
    const id = created.json.id;
    const waiting = await waitFor(() => app.req('GET', `/api/missions/${id}`), (r) => r.json.status === 'awaiting_approval', 15_000, 'plan approval');
    expect(waiting.json.plan.successCriteria).toEqual(['Decision stored in memory']);
    const planApproval = waiting.json.approvals.find((a: { tool: string }) => a.tool === 'mission.plan');
    expect(planApproval).toBeTruthy();

    fake.queue.push({ when: (b) => !b.output_config?.format && JSON.stringify(b.messages).includes('Approved plan'), blocks: [{ type: 'tool_use', name: 'memory_save', input: { category: 'decision', title: 'Database', content: 'SQLite first, PostgreSQL later.' } }] });
    fake.queue.push({ when: (b) => !b.output_config?.format && JSON.stringify(b.messages).includes('Saved memory'), blocks: [{ type: 'text', text: 'Stored the database decision as a memory.' }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.output_config?.format ?? {}).includes('unverified'), blocks: [{ type: 'text', text: JSON.stringify({ outcome: 'succeeded', summary: 'Decision saved.', evidence: ['memory_save returned Saved memory'], unverified: [] }) }] });
    await app.req('POST', `/api/approvals/${planApproval.id}`, { approve: true });
    const done = await waitFor(() => app.req('GET', `/api/missions/${id}`), (r) => ['completed', 'failed'].includes(r.json.status), 20_000, 'mission completion');
    expect(done.json.status).toBe('completed');
    expect(done.json.verification.outcome).toBe('succeeded');
    expect(done.json.report).toBe('Stored the database decision as a memory.');
    expect(done.json.steps.map((s: { kind: string }) => s.kind)).toEqual(expect.arrayContaining(['info', 'model', 'approval', 'tool', 'tool_result', 'verification']));
    expect((await app.req('GET', '/api/memory?category=decision')).json[0].content).toContain('SQLite first');
    await app.req('PATCH', '/api/settings', { autoApproveWrites: true });
  });

  it('cancels a mission waiting for approval and expires its approvals', async () => {
    fake.queue.push({
      when: (b) => JSON.stringify(b.output_config?.format ?? {}).includes('successCriteria'),
      blocks: [{ type: 'text', text: JSON.stringify({ interpretation: 'Send an email.', steps: [{ title: 'Send', detail: '', tools: ['gmail_send_draft'], risk: 'sensitive' }], requiredPermissions: [{ tool: 'gmail_send_draft', risk: 'sensitive', reason: 'send' }], successCriteria: ['Sent'] }) }],
    });
    const created = await app.req('POST', '/api/missions', { agent: 'operator', title: 'Email', request: 'Send the weekly email.' });
    const id = created.json.id;
    await waitFor(() => app.req('GET', `/api/missions/${id}`), (r) => r.json.status === 'awaiting_approval');
    const c = await app.req('POST', `/api/missions/${id}/cancel`, {});
    expect(c.json.status).toBe('cancelled');
    const m = await app.req('GET', `/api/missions/${id}`);
    expect(m.json.approvals.every((a: { status: string }) => a.status === 'expired')).toBe(true);
  });

  it('Core delegates to a specialist, and the result flows back into the conversation', async () => {
    const cid = await conversation();
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('Research the history of the tourbillon') && !JSON.stringify(b.messages).includes('tool_result'), blocks: [{ type: 'tool_use', name: 'delegate_mission', input: { agent: 'research', title: 'Tourbillon history', request: 'Summarise the invention of the tourbillon with sources.' } }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('assigned to research'), blocks: [{ type: 'text', text: 'Research Intelligence is on it.' }] });
    // The research agent's own mission: plan (read-only, so no plan approval), execute, verify.
    fake.queue.push({ when: (b) => JSON.stringify(b.output_config?.format ?? {}).includes('successCriteria') && JSON.stringify(b.messages).includes('invention of the tourbillon'), blocks: [{ type: 'text', text: JSON.stringify({ interpretation: 'Summarise the invention.', steps: [{ title: 'Summarise', detail: '', tools: [], risk: 'read' }], requiredPermissions: [], successCriteria: ['Summary written'] }) }] });
    fake.queue.push({ when: (b) => !b.output_config?.format && JSON.stringify(b.messages).includes('Approved plan') && JSON.stringify(b.messages).includes('invention of the tourbillon'), blocks: [{ type: 'text', text: 'Invented by Abraham-Louis Breguet, patented 1801 (source-reported).' }] });
    fake.queue.push({ when: (b) => JSON.stringify(b.output_config?.format ?? {}).includes('unverified') && JSON.stringify(b.messages).includes('invention of the tourbillon'), blocks: [{ type: 'text', text: JSON.stringify({ outcome: 'unverified', summary: 'No sources were fetched in this mission.', evidence: [], unverified: ['Patent date'] }) }] });

    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'Research the history of the tourbillon.' });
    await turnDone(cid);
    const missions = await waitFor(() => app.req('GET', '/api/missions'), (r) => r.json.some((m: { conversationId: number }) => m.conversationId === cid), 10_000, 'delegated mission');
    const mission = missions.json.find((m: { conversationId: number }) => m.conversationId === cid);
    expect(mission.agent).toBe('research');
    const done = await waitFor(() => app.req('GET', `/api/missions/${mission.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 20_000, 'research mission');
    expect(done.json.verification.outcome).toBe('unverified'); // honest: no sources were actually fetched
    const conv = await app.req('GET', `/api/conversations/${cid}`);
    expect(conv.json.messages.at(-1)).toMatchObject({ role: 'notice' });
    expect(conv.json.messages.at(-1).text).toContain(`Mission #${mission.id} (research) completed`);

    // On the owner's next message, Core receives the mission result as context.
    fake.queue.push({ when: (b) => JSON.stringify(b.messages).includes('mission_updates'), blocks: [{ type: 'text', text: 'The research is back: Breguet, 1801 — not yet verified against sources.' }] });
    await app.req('POST', `/api/conversations/${cid}/messages`, { text: 'What did they find?' });
    const after = await turnDone(cid);
    expect(after.json.messages.at(-1).text).toContain('not yet verified');
    expect(JSON.stringify(fake.requests.at(-1)!.body.messages.at(-1))).toContain('Breguet, patented 1801');
  });

  it('marks in-flight missions as interrupted after a restart', async () => {
    const t = app.ctx.tasks.create({ title: 'Ghost', request: 'x', agent: 'research', start: false });
    app.ctx.db.run("UPDATE tasks SET status = 'running', plan = ? WHERE id = ?", JSON.stringify({ interpretation: '', steps: [], requiredPermissions: [], successCriteria: [] }), t.id);
    app.ctx.tasks.recover();
    const after = app.ctx.tasks.get(t.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/restart/);
  });
});
