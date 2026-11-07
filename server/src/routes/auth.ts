import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../security/auth.js';

const passphraseSchema = z.string().min(10, 'Use at least 10 characters.').max(200);

export function isHttpsRequest(req: FastifyRequest, trustProxy: boolean) {
  if (req.protocol === 'https') return true;
  return trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx) {
  const setCookie = (req: FastifyRequest, reply: FastifyReply, token: string, expires: Date) => {
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      // Lax (not Strict) so the cookie survives the top-level redirect back from Google OAuth.
      sameSite: 'lax',
      secure: isHttpsRequest(req, ctx.config.trustProxy),
      expires,
    });
  };

  const requireCsrf = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers[CSRF_HEADER] !== '1') {
      reply.code(403).send({ error: 'csrf', message: 'Missing request verification header.' });
      return false;
    }
    return true;
  };

  app.get('/api/auth/state', async (req) => {
    const sid = ctx.auth.validateSession(req.cookies?.[SESSION_COOKIE]);
    const hasOwner = ctx.auth.hasOwner();
    if (!hasOwner) ctx.auth.ensureSetupCode();
    return {
      setupRequired: !hasOwner,
      authenticated: !!sid,
      ownerName: hasOwner && sid ? ctx.settings.get('ownerName') : null,
    };
  });

  app.post('/api/auth/setup', { config: { rateLimit: { max: ctx.config.authRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    if (ctx.auth.hasOwner()) return reply.code(409).send({ error: 'already_setup', message: 'This system already has an owner.' });
    const body = z.object({ setupCode: z.string().min(4).max(40), passphrase: passphraseSchema, ownerName: z.string().min(1).max(60).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: body.error.issues[0]?.message ?? 'Invalid input' });
    if (!ctx.auth.verifySetupCode(body.data.setupCode)) {
      ctx.audit.record('anonymous', 'auth.setup', 'denied', null, { ip: req.ip });
      return reply.code(403).send({ error: 'bad_setup_code', message: 'That setup code is not correct. Check the server console or data/setup-code.txt.' });
    }
    ctx.auth.completeSetup(body.data.passphrase);
    if (body.data.ownerName) ctx.settings.update({ ownerName: body.data.ownerName });
    const s = ctx.auth.createSession(req.headers['user-agent'], req.ip);
    setCookie(req, reply, s.token, s.expiresAt);
    ctx.audit.record('owner', 'auth.setup', 'ok', null, { ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: ctx.config.authRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    const body = z.object({ passphrase: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Passphrase required.' });
    const wait = ctx.auth.lockoutRemainingMs(req.ip);
    if (wait > 0) {
      return reply.code(429).send({ error: 'locked', message: `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` });
    }
    if (!ctx.auth.checkPassphrase(req.ip, body.data.passphrase)) {
      ctx.audit.record('anonymous', 'auth.login', 'denied', null, { ip: req.ip });
      return reply.code(401).send({ error: 'bad_credentials', message: 'Passphrase not recognised.' });
    }
    const s = ctx.auth.createSession(req.headers['user-agent'], req.ip);
    setCookie(req, reply, s.token, s.expiresAt);
    ctx.audit.record('owner', 'auth.login', 'ok', null, { ip: req.ip, ua: req.headers['user-agent'] });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    const sid = ctx.auth.validateSession(req.cookies?.[SESSION_COOKIE]);
    if (sid) ctx.auth.revokeSession(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    ctx.audit.record('owner', 'auth.logout', 'ok');
    return { ok: true };
  });
}

export function registerAccountRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/auth/sessions', async (req) => ctx.auth.listSessions(req.sessionId));

  app.post('/api/auth/sessions/revoke-all', async (req, reply) => {
    ctx.auth.revokeAllSessions();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    ctx.audit.record('owner', 'auth.revoke_all', 'ok');
    return { ok: true };
  });

  app.post('/api/auth/passphrase', async (req, reply) => {
    const body = z.object({ current: z.string(), next: passphraseSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: body.error.issues[0]?.message });
    if (!ctx.auth.checkPassphrase(req.ip, body.data.current)) {
      ctx.audit.record('owner', 'auth.change_passphrase', 'denied');
      return reply.code(401).send({ error: 'bad_credentials', message: 'Current passphrase is not correct.' });
    }
    ctx.auth.setPassphrase(body.data.next);
    ctx.audit.record('owner', 'auth.change_passphrase', 'ok');
    return { ok: true };
  });
}
