import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_IDS, MEMORY_CATEGORIES } from '@tc/shared';
import type { Ctx } from '../context.js';
import { publicApproval } from '../tasks/approvals.js';

const id = z.object({ id: z.coerce.number().int().positive() });

export function registerIntelligenceRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- Conversations -------------------------------------------------------
  app.get('/api/conversations', async () => ctx.conversations.list());
  app.post('/api/conversations', async (req) => {
    const b = z.object({ title: z.string().max(120).optional(), projectId: z.number().int().positive().nullable().optional() }).parse(req.body ?? {});
    return ctx.conversations.create(b.title, b.projectId ?? null);
  });
  app.get('/api/conversations/:id', async (req, reply) => {
    const { id: cid } = id.parse(req.params);
    const c = ctx.conversations.get(cid);
    if (!c) return reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
    const approvals = ctx.approvals.list('pending').filter((a) => a.conversationId === cid).map(publicApproval);
    return { ...c, messages: ctx.conversations.messages(cid), approvals };
  });
  app.patch('/api/conversations/:id', async (req) => {
    const { id: cid } = id.parse(req.params);
    const b = z.object({ title: z.string().min(1).max(120).optional(), projectId: z.number().int().positive().nullable().optional() }).parse(req.body);
    if (b.title) ctx.conversations.rename(cid, b.title);
    if (b.projectId !== undefined) ctx.conversations.setProject(cid, b.projectId);
    return ctx.conversations.get(cid);
  });
  app.delete('/api/conversations/:id', async (req) => {
    const { id: cid } = id.parse(req.params);
    ctx.conversations.delete(cid);
    ctx.audit.record('owner', 'conversation.deleted', 'ok', String(cid));
    return { ok: true };
  });
  app.post('/api/conversations/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id: cid } = id.parse(req.params);
    const b = z.object({ text: z.string().min(1).max(50_000) }).parse(req.body);
    return ctx.conversations.send(cid, b.text);
  });
  app.post('/api/conversations/:id/cancel', async (req) => {
    const { id: cid } = id.parse(req.params);
    return { cancelled: ctx.conversations.cancel(cid) };
  });
  app.post('/api/conversations/:id/summarize', async (req) => {
    const { id: cid } = id.parse(req.params);
    return ctx.conversations.summarizeToMemory(cid);
  });

  // ---- Memory ------------------------------------------------------------------
  app.get('/api/memory', async (req) => {
    const q = z.object({ q: z.string().max(500).optional(), category: z.enum(MEMORY_CATEGORIES).optional(), projectId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    if (q.q) return ctx.memory.search(q.q, { category: q.category, limit: q.limit, projectId: q.projectId ?? null });
    return ctx.memory.list({ category: q.category, projectId: q.projectId, limit: q.limit });
  });
  app.get('/api/memory/stats', async () => ({ total: ctx.memory.count(), byCategory: ctx.memory.stats() }));
  const memoryBody = z.object({ category: z.enum(MEMORY_CATEGORIES), title: z.string().min(1).max(200), content: z.string().min(1).max(20_000), tags: z.array(z.string().max(40)).max(20).optional(), projectId: z.number().int().positive().nullable().optional() });
  app.post('/api/memory', async (req) => {
    const b = memoryBody.parse(req.body);
    const m = ctx.memory.create({ ...b, source: 'owner' });
    ctx.audit.record('owner', 'memory.created', 'ok', `#${m.id}`);
    return m;
  });
  app.patch('/api/memory/:id', async (req, reply) => {
    const { id: mid } = id.parse(req.params);
    const b = memoryBody.partial().parse(req.body);
    const m = ctx.memory.update(mid, { ...b, projectId: b.projectId === undefined ? undefined : b.projectId });
    if (!m) return reply.code(404).send({ error: 'not_found', message: 'Memory not found' });
    return m;
  });
  app.delete('/api/memory/:id', async (req) => {
    const { id: mid } = id.parse(req.params);
    ctx.audit.record('owner', 'memory.deleted', 'ok', `#${mid}`);
    return { deleted: ctx.memory.delete(mid) };
  });
  app.delete('/api/memory', async (req) => {
    const q = z.object({ category: z.enum(MEMORY_CATEGORIES).optional(), confirm: z.literal('yes') }).parse(req.query);
    const n = ctx.memory.deleteAll(q.category);
    ctx.audit.record('owner', 'memory.deleted_bulk', 'ok', q.category ?? 'all', { count: n });
    return { deleted: n };
  });

  // ---- Agents, missions, approvals ------------------------------------------
  app.get('/api/agents', async () => ctx.agents.list());
  app.get('/api/playbooks', async () => ctx.tasks.listPlaybooks());

  app.get('/api/missions', async (req) => {
    const q = z.object({ status: z.string().optional(), agent: z.enum(AGENT_IDS).optional(), projectId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return ctx.tasks.list({ status: q.status as never, agent: q.agent, projectId: q.projectId, limit: q.limit });
  });
  app.post('/api/missions', async (req) => {
    const b = z
      .union([
        z.object({ playbook: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}), title: z.string().min(1).max(200).optional(), projectId: z.number().int().positive().nullable().optional() }),
        z.object({ agent: z.enum(AGENT_IDS), title: z.string().min(1).max(200), request: z.string().min(3).max(20_000), projectId: z.number().int().positive().nullable().optional() }),
      ])
      .parse(req.body);
    if ('playbook' in b) {
      const pb = ctx.tasks.listPlaybooks().find((p) => p.id === b.playbook);
      if (!pb) throw Object.assign(new Error('Unknown playbook'), { statusCode: 400 });
      const projectId = b.projectId ?? (typeof b.params.projectId === 'number' ? b.params.projectId : null);
      return ctx.tasks.create({ title: b.title ?? pb.title, request: `${pb.title}: ${JSON.stringify(b.params).slice(0, 500)}`, agent: pb.agent, playbook: b.playbook, params: b.params, projectId });
    }
    return ctx.tasks.create({ title: b.title, request: b.request, agent: b.agent, projectId: b.projectId ?? null });
  });
  app.get('/api/missions/:id', async (req, reply) => {
    const { id: tid } = id.parse(req.params);
    const t = ctx.tasks.get(tid, true);
    if (!t) return reply.code(404).send({ error: 'not_found', message: 'Mission not found' });
    const artifacts = ctx.db.all<{ id: number; kind: string; title: string; data: string; created_at: string }>('SELECT id, kind, title, data, created_at FROM artifacts WHERE task_id = ? ORDER BY id', tid).map((a) => ({ id: a.id, kind: a.kind, title: a.title, createdAt: a.created_at, data: JSON.parse(a.data) }));
    const approvals = ctx.db.all<{ id: number }>('SELECT id FROM approvals WHERE task_id = ? ORDER BY id', tid).map((a) => publicApproval(ctx.approvals.get(a.id)!));
    const patches = ctx.db.all<{ id: number }>('SELECT id FROM patches WHERE task_id = ? ORDER BY id', tid).map((p) => ctx.patches.get(p.id));
    const run = ctx.db.get<{ usage: string }>("SELECT usage FROM runs WHERE owner_kind = 'task' AND owner_id = ? ORDER BY created_at DESC LIMIT 1", tid);
    return { ...t, params: ctx.tasks.params(tid), artifacts, approvals, patches, usage: run ? JSON.parse(run.usage) : null };
  });
  app.post('/api/missions/:id/cancel', async (req) => {
    const { id: tid } = id.parse(req.params);
    ctx.audit.record('owner', 'mission.cancel', 'ok', `#${tid}`);
    return ctx.tasks.cancel(tid);
  });
  app.post('/api/missions/:id/retry', async (req) => {
    const { id: tid } = id.parse(req.params);
    return ctx.tasks.retry(tid);
  });

  app.get('/api/approvals', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired']).optional() }).parse(req.query);
    return ctx.approvals.list(q.status).map(publicApproval);
  });
  app.post('/api/approvals/:id', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id: aid } = id.parse(req.params);
    const b = z.object({ approve: z.boolean(), note: z.string().max(500).optional() }).parse(req.body);
    return publicApproval(ctx.approvals.decide(aid, b.approve, b.note ?? null, 'owner'));
  });

  // ---- Automations ------------------------------------------------------------
  app.get('/api/automations', async () => ctx.automations.list());
  app.post('/api/automations', async (req) => {
    const { scheduleSchema, actionSchema } = await import('../automations/service.js');
    const b = z.object({ name: z.string().min(1).max(120), schedule: scheduleSchema, action: actionSchema, enabled: z.boolean().optional() }).parse(req.body);
    return ctx.automations.create(b);
  });
  app.patch('/api/automations/:id', async (req) => {
    const { id: aid } = id.parse(req.params);
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    return ctx.automations.setEnabled(aid, b.enabled);
  });
  app.delete('/api/automations/:id', async (req) => {
    const { id: aid } = id.parse(req.params);
    ctx.automations.delete(aid);
    return { ok: true };
  });
  app.post('/api/automations/:id/run', async (req) => {
    const { id: aid } = id.parse(req.params);
    return ctx.automations.runNow(aid);
  });
}
