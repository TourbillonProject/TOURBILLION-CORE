import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AIDiagnostics, SystemStatus } from '@tc/shared';
import type { Ctx } from '../context.js';
import { APP_VERSION } from '../config.js';
import { maskSecret } from '../security/crypto.js';
import { ANTHROPIC_SECRET } from '../ai/service.js';

const settingsPatch = z
  .object({
    ownerName: z.string().min(1).max(60),
    aiModel: z.string().regex(/^claude-[a-z0-9-]+$/).max(60),
    aiEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    aiWebSearch: z.boolean(),
    autoApproveWrites: z.boolean(),
    voiceName: z.string().max(120).nullable(),
    voiceRate: z.number().min(0.5).max(1.5),
    voicePitch: z.number().min(0.5).max(1.5),
    wakePhrase: z.string().min(2).max(40),
    soundEnabled: z.boolean(),
    soundVolume: z.number().min(0).max(1),
    coreRenderMode: z.enum(['auto', '3d', '2d', 'static']),
    batterySaver: z.boolean(),
    speakResponses: z.boolean(),
    graphicsQuality: z.enum(['cinematic', 'balanced', 'performance']),
    soundCategories: z.object({ interface: z.boolean(), notifications: z.boolean(), missions: z.boolean(), alerts: z.boolean(), ai: z.boolean() }),
    ambientSound: z.boolean(),
    ambientVolume: z.number().min(0).max(1),
    bootSequence: z.boolean(),
  })
  .partial();

export function systemStatus(ctx: Ctx): SystemStatus {
  const claude = ctx.integrations.status('claude');
  let dbOk = true;
  try {
    ctx.db.get('SELECT 1');
  } catch {
    dbOk = false;
  }
  return {
    version: APP_VERSION,
    uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
    ai: { provider: 'Anthropic Claude', state: claude.state, model: ctx.ai.model() },
    browser: { engine: ctx.browser.live.availability.available ? 'playwright' : 'reader-only', available: ctx.browser.live.availability.available, detail: ctx.browser.live.availability.detail },
    bridge: { connected: ctx.bridge.connectedCount() },
    tasks: { active: ctx.tasks.activeCount(), awaitingApproval: ctx.approvals.pendingCount() },
    memory: { count: ctx.memory.count() },
    db: { ok: dbOk },
  };
}

export function registerSystemRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/system/status', async () => systemStatus(ctx));
  app.get('/api/system/telemetry', async () => ctx.telemetry.snapshot());

  app.get('/api/ai/diagnostics', async (): Promise<AIDiagnostics> => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const t = ctx.db.get<{ i: number | null; o: number | null; c: number | null; w: number | null }>(
      `SELECT SUM(json_extract(usage, '$.inputTokens')) AS i, SUM(json_extract(usage, '$.outputTokens')) AS o,
              SUM(json_extract(usage, '$.cacheReadTokens')) AS c, SUM(json_extract(usage, '$.webSearches')) AS w
       FROM runs WHERE updated_at >= ?`,
      today.toISOString(),
    );
    const claude = ctx.integrations.status('claude');
    return {
      provider: 'Anthropic Claude',
      model: ctx.ai.model(),
      state: claude.state,
      effort: ctx.settings.get('aiEffort'),
      lastLatencyMs: ctx.ai.stats.lastLatencyMs,
      lastFirstTokenMs: ctx.ai.stats.lastFirstTokenMs,
      lastError: ctx.ai.stats.lastError ?? claude.lastError,
      turnsSinceStart: ctx.ai.stats.turns,
      errorsSinceStart: ctx.ai.stats.errors,
      tokensToday: { input: t?.i ?? 0, output: t?.o ?? 0, cacheRead: t?.c ?? 0, webSearches: t?.w ?? 0 },
      activeRuns: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")?.n ?? 0,
      lastTurnAt: ctx.ai.stats.lastTurnAt,
    };
  });

  app.get('/api/settings', async () => ctx.settings.all());
  app.patch('/api/settings', async (req) => {
    const patch = settingsPatch.parse(req.body);
    ctx.settings.update(patch);
    ctx.audit.record('owner', 'settings.update', 'ok', null, patch);
    return ctx.settings.all();
  });

  app.get('/api/notifications', async () => ctx.notifications.list(100));
  app.post('/api/notifications/read', async (req) => {
    const b = z.object({ id: z.number().int().optional() }).parse(req.body ?? {});
    ctx.notifications.markRead(b.id);
    return { ok: true };
  });
  app.delete('/api/notifications', async () => {
    ctx.notifications.clear();
    return { ok: true };
  });

  app.get('/api/audit', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), before: z.coerce.number().int().optional() }).parse(req.query);
    return ctx.audit.list(q.limit, q.before);
  });

  // ---- AI connection -------------------------------------------------------
  app.get('/api/ai/status', async () => {
    const key = ctx.secrets.get(ANTHROPIC_SECRET) ?? ctx.config.anthropic.apiKey;
    return {
      integration: ctx.integrations.status('claude'),
      keySource: ctx.ai.keySource(),
      keyPreview: key ? maskSecret(key) : null,
      model: ctx.ai.model(),
      billingNote: 'Claude.ai subscriptions (Pro/Max) do not cover API usage. The Anthropic API is billed separately per token through console.anthropic.com.',
    };
  });

  app.post('/api/ai/key', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ apiKey: z.string().min(20).max(300).regex(/^sk-ant-[A-Za-z0-9_-]+$/, 'That does not look like an Anthropic API key (sk-ant-…).') }).parse(req.body);
    ctx.ai.setKey(b.apiKey);
    ctx.audit.record('owner', 'ai.key_set', 'ok', 'anthropic', { preview: maskSecret(b.apiKey) });
    const status = await ctx.integrations.test('claude');
    if (status.state !== 'connected') {
      // Keep the key so the owner can retry after fixing billing etc., but report the real error.
      return reply.code(200).send({ ok: false, integration: status });
    }
    return { ok: true, integration: status };
  });

  app.delete('/api/ai/key', async () => {
    const status = await ctx.integrations.disconnect('claude');
    ctx.audit.record('owner', 'ai.key_removed', 'ok', 'anthropic');
    return { ok: true, integration: status };
  });

  app.post('/api/ai/test', async () => ctx.integrations.test('claude'));

  // ---- Data export / deletion ----------------------------------------------
  app.get('/api/data/export', async (_req, reply) => {
    const tables = ['conversations', 'transcripts', 'memories', 'tasks', 'task_steps', 'approvals', 'artifacts', 'patches', 'projects', 'automations', 'notifications', 'browse_history', 'audit_log', 'settings', 'integrations'];
    const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), system: 'TOURBILLION CORE', version: APP_VERSION, note: 'Credentials (secrets table) are intentionally excluded.' };
    for (const t of tables) out[t] = ctx.db.all(`SELECT * FROM ${t}`); // spider-ignore: fixed table list
    ctx.audit.record('owner', 'data.export', 'ok');
    reply.header('content-disposition', `attachment; filename="tourbillion-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return out;
  });

  app.post('/api/data/wipe', async (req) => {
    const b = z.object({ confirm: z.literal('DELETE EVERYTHING'), includeCredentials: z.boolean().default(false) }).parse(req.body);
    const tables = ['transcripts', 'runs', 'approvals', 'task_steps', 'artifacts', 'patches', 'tasks', 'conversations', 'memories', 'automations', 'notifications', 'browse_history'];
    ctx.db.tx(() => {
      for (const t of tables) ctx.db.run(`DELETE FROM ${t}`); // spider-ignore: fixed table list
      if (b.includeCredentials) ctx.db.run('DELETE FROM secrets');
    });
    ctx.audit.record('owner', 'data.wipe', 'ok', null, { includeCredentials: b.includeCredentials });
    return { ok: true };
  });
}
