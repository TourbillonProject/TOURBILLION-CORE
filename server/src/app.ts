import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { APP_VERSION, loadConfig, type AppConfig } from './config.js';
import { Database } from './db.js';
import type { Ctx } from './context.js';
import { AuthService, requireAuth } from './security/auth.js';
import { Cipher } from './security/crypto.js';
import { NetworkPolicyError } from './security/net.js';
import { SecretStore } from './security/secrets.js';
import { AuditLog, DEFAULT_SETTINGS, EventBus, Notifications, SettingsStore } from './services/core.js';
import { IntegrationRegistry } from './services/integrations.js';
import { AIService } from './ai/service.js';
import { ProviderError, ProviderNotConfiguredError } from './ai/types.js';
import { MemoryService, SecretContentError } from './memory/service.js';
import { ToolRegistry } from './tools/registry.js';
import { coreTools } from './tools/core-tools.js';
import { bridgeTools, gmailTools, osintTools, spiderTools } from './tools/domain-tools.js';
import { AgentRegistry } from './agents/registry.js';
import { AgentRunner } from './agents/runner.js';
import { ApprovalService } from './tasks/approvals.js';
import { TaskEngine } from './tasks/engine.js';
import { PLAYBOOKS } from './tasks/playbooks.js';
import { ConversationService } from './intelligence/conversations.js';
import { ProjectService, PathEscapeError } from './spider/projects.js';
import { PatchService } from './spider/patches.js';
import { BrowserService } from './browser/service.js';
import { ResearchService } from './research/service.js';
import { GmailService } from './integrations/gmail.js';
import { BridgeHub } from './integrations/bridge.js';
import { AutomationService } from './automations/service.js';
import { registerAuthRoutes, registerAccountRoutes, isHttpsRequest } from './routes/auth.js';
import { registerSystemRoutes, systemStatus } from './routes/system.js';
import { registerIntelligenceRoutes } from './routes/intelligence.js';
import { registerSelfAuthRoutes, registerWorkspaceRoutes } from './routes/workspace.js';
import { registerClientSocket } from './ws.js';
import { securityHeaders } from './http/security-headers.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: Ctx;
  close: () => Promise<void>;
}

/** Wires every service together. Used by main.ts and by the test-suite. */
export async function buildApp(overrides: Partial<AppConfig> = {}, opts: { logger?: boolean; dbFile?: string } = {}): Promise<BuiltApp> {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(opts.dbFile ?? path.join(config.dataDir, 'tourbillion.db'));
  const cipher = Cipher.fromConfig(config.masterKey, config.dataDir);
  const secrets = new SecretStore(db, cipher);
  const bus = new EventBus();
  const audit = new AuditLog(db);
  const settings = new SettingsStore(db, { ...DEFAULT_SETTINGS, ownerName: config.ownerName, aiModel: config.anthropic.defaultModel });
  const notifications = new Notifications(db, bus);
  const integrations = new IntegrationRegistry(db, bus);
  const auth = new AuthService(db, config.dataDir, config.sessionDays, config.ownerPassphrase);
  const net = { allowPrivateNetwork: config.allowPrivateNetwork };

  const ctx = { config, db, cipher, secrets, auth, bus, audit, settings, notifications, integrations, net, startedAt: Date.now() } as Ctx;
  ctx.ai = new AIService(config, secrets, settings, integrations);
  ctx.memory = new MemoryService(db);
  ctx.tools = new ToolRegistry();
  ctx.tools.register(...coreTools(), ...osintTools(), ...spiderTools(), ...gmailTools(), ...bridgeTools());
  ctx.agents = new AgentRegistry(bus);
  ctx.approvals = new ApprovalService(db, bus, audit, notifications);
  ctx.projects = new ProjectService(db, config);
  ctx.patches = new PatchService(db, ctx.projects, config.dataDir);
  ctx.browser = new BrowserService(config, db, net, secrets, integrations);
  ctx.research = new ResearchService(config, db, net, secrets, integrations);
  ctx.gmail = new GmailService(config, db, secrets, net, integrations);
  ctx.bridge = new BridgeHub(db, bus, audit, integrations);
  const runner = new AgentRunner(ctx);
  ctx.conversations = new ConversationService(ctx, runner);
  ctx.tasks = new TaskEngine(ctx, runner);
  for (const p of PLAYBOOKS) ctx.tasks.registerPlaybook(p);
  ctx.automations = new AutomationService(db, ctx.tasks, audit);

  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 60 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: config.rateLimitPerMinute, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
  app.addHook('onRequest', securityHeaders((req) => isHttpsRequest(req, config.trustProxy)));

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validation?: unknown };
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') });
    if (err instanceof ProviderNotConfiguredError) return reply.code(409).send({ error: 'ai_not_connected', message: err.message });
    if (err instanceof ProviderError) return reply.code(err.kind === 'auth' ? 401 : err.kind === 'rate_limit' ? 429 : 502).send({ error: `ai_${err.kind}`, message: err.message });
    if (err instanceof NetworkPolicyError) return reply.code(400).send({ error: 'network_policy', message: err.message });
    if (err instanceof SecretContentError) return reply.code(422).send({ error: 'secret_content', message: err.message });
    if (err instanceof PathEscapeError) return reply.code(400).send({ error: 'path_escape', message: err.message });
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : 'request_error', message: e.message || 'Unexpected error' });
  });

  // Public
  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION }));
  registerAuthRoutes(app, ctx);
  registerSelfAuthRoutes(app, ctx);
  const sockets = registerClientSocket(app, ctx);
  ctx.clientCount = sockets.count;

  // Owner-only API
  await app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth(auth));
    registerAccountRoutes(secured, ctx);
    registerSystemRoutes(secured, ctx);
    registerIntelligenceRoutes(secured, ctx);
    registerWorkspaceRoutes(secured, ctx);
  });

  // Static PWA (production build)
  if (fs.existsSync(path.join(config.webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
      setHeaders: (res, filePath) => {
        if (/[\\/]assets[\\/]/.test(filePath)) res.header('cache-control', 'public, max-age=31536000, immutable');
        else res.header('cache-control', 'no-cache');
        if (filePath.endsWith('.webmanifest')) res.header('content-type', 'application/manifest+json');
      },
    });
    app.get('/*', async (req, reply) => {
      const url = req.url.split('?')[0];
      if (url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'No such endpoint' });
      const file = path.join(config.webDistDir, url);
      if (url !== '/' && file.startsWith(config.webDistDir) && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(url.slice(1));
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({ name: 'TOURBILLION CORE API', version: APP_VERSION, note: 'Web client not built. Run `npm run build` or use the Vite dev server.' }));
  }

  // Background: recovery, browser probe, automations, periodic status
  ctx.tasks.recover();
  void ctx.browser.live.probe();
  ctx.automations.start();
  const statusTimer = setInterval(() => bus.emit({ type: 'system.status', status: systemStatus(ctx) }), 30_000);
  statusTimer.unref();

  return {
    app,
    ctx,
    close: async () => {
      clearInterval(statusTimer);
      ctx.automations.stop();
      await ctx.browser.live.closeAll();
      await app.close();
      db.close();
    },
  };
}
