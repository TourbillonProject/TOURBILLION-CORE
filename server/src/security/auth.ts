import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { nowIso } from '../db.js';
import { hashPassphrase, randomToken, sha256, timingSafeEqualStr, verifyPassphrase } from './crypto.js';

export const SESSION_COOKIE = 'tc_session';
export const CSRF_HEADER = 'x-tc-request';

/**
 * Single-owner authentication.
 *
 * First run: there is no owner yet. To stop whoever reaches the server first
 * from claiming it, setup requires a one-time setup code that is printed to
 * the server console and written to <dataDir>/setup-code.txt. Alternatively
 * TC_OWNER_PASSPHRASE pre-provisions the owner.
 *
 * Sessions: 256-bit random token in an httpOnly cookie; only its SHA-256 is
 * stored. Sliding expiry. State-changing requests must carry the custom
 * X-TC-Request header (CSRF defence: browsers cannot add custom headers to
 * cross-origin requests without a CORS preflight, which we never grant).
 */
export class AuthService {
  private setupCode: string | null = null;
  private failures = new Map<string, { count: number; until: number }>();

  constructor(
    private db: Database,
    private dataDir: string,
    private sessionDays: number,
    ownerPassphrase: string | null,
  ) {
    if (!this.hasOwner() && ownerPassphrase) {
      this.setPassphrase(ownerPassphrase);
    }
  }

  hasOwner(): boolean {
    return !!this.db.get('SELECT 1 FROM owner WHERE id = 1');
  }

  /** Returns the setup code, generating and persisting it on first call. */
  ensureSetupCode(): string | null {
    if (this.hasOwner()) return null;
    if (this.setupCode) return this.setupCode;
    const file = path.join(this.dataDir, 'setup-code.txt');
    if (fs.existsSync(file)) {
      this.setupCode = fs.readFileSync(file, 'utf8').trim();
    } else {
      const raw = randomToken(9).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10).padEnd(10, 'X');
      this.setupCode = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(file, this.setupCode, { mode: 0o600 });
    }
    return this.setupCode;
  }

  verifySetupCode(code: string): boolean {
    const expected = this.ensureSetupCode();
    if (!expected) return false;
    return timingSafeEqualStr(code.trim().toUpperCase(), expected);
  }

  completeSetup(passphrase: string) {
    this.setPassphrase(passphrase);
    this.setupCode = null;
    const file = path.join(this.dataDir, 'setup-code.txt');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  setPassphrase(passphrase: string) {
    const hash = hashPassphrase(passphrase);
    const now = nowIso();
    this.db.run(
      `INSERT INTO owner(id, passphrase_hash, created_at, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET passphrase_hash = excluded.passphrase_hash, updated_at = excluded.updated_at`,
      hash,
      now,
      now,
    );
  }

  /** Brute-force throttle keyed by client IP: exponential lockout after 5 failures. */
  lockoutRemainingMs(ip: string): number {
    const f = this.failures.get(ip);
    if (!f) return 0;
    return Math.max(0, f.until - Date.now());
  }

  checkPassphrase(ip: string, passphrase: string): boolean {
    const row = this.db.get<{ passphrase_hash: string }>('SELECT passphrase_hash FROM owner WHERE id = 1');
    const ok = !!row && verifyPassphrase(passphrase, row.passphrase_hash);
    if (ok) {
      this.failures.delete(ip);
    } else {
      const f = this.failures.get(ip) ?? { count: 0, until: 0 };
      f.count += 1;
      if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60_000, 2 ** (f.count - 5) * 30_000);
      this.failures.set(ip, f);
    }
    return ok;
  }

  createSession(userAgent: string | undefined, ip: string): { token: string; expiresAt: Date } {
    const token = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionDays * 86_400_000);
    this.db.run(
      'INSERT INTO sessions(id, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(token),
      now.toISOString(),
      now.toISOString(),
      expiresAt.toISOString(),
      (userAgent ?? '').slice(0, 300),
      ip,
    );
    return { token, expiresAt };
  }

  /** Validates a session token; slides expiry at most once per hour. Returns the session id (hash). */
  validateSession(token: string | undefined): string | null {
    if (!token) return null;
    const id = sha256(token);
    const row = this.db.get<{ expires_at: string; last_seen_at: string }>('SELECT expires_at, last_seen_at FROM sessions WHERE id = ?', id);
    if (!row) return null;
    const now = Date.now();
    if (Date.parse(row.expires_at) < now) {
      this.db.run('DELETE FROM sessions WHERE id = ?', id);
      return null;
    }
    if (now - Date.parse(row.last_seen_at) > 3_600_000) {
      const expires = new Date(now + this.sessionDays * 86_400_000).toISOString();
      this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', new Date(now).toISOString(), expires, id);
    }
    return id;
  }

  revokeSession(sessionId: string) {
    this.db.run('DELETE FROM sessions WHERE id = ?', sessionId);
  }

  revokeAllSessions() {
    this.db.run('DELETE FROM sessions');
  }

  listSessions(current: string | null) {
    return this.db
      .all<{ id: string; created_at: string; last_seen_at: string; expires_at: string; user_agent: string; ip: string }>(
        'SELECT id, created_at, last_seen_at, expires_at, user_agent, ip FROM sessions ORDER BY last_seen_at DESC',
      )
      .map((s) => ({
        id: s.id.slice(0, 12),
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        userAgent: s.user_agent,
        ip: s.ip,
        current: s.id === current,
      }));
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionId: string | null;
  }
}

export function requireAuth(auth: AuthService) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const token = req.cookies?.[SESSION_COOKIE];
    const sid = auth.validateSession(token);
    if (!sid) {
      return reply.code(401).send({ error: 'unauthenticated', message: 'Sign in required.' });
    }
    req.sessionId = sid;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== '1') {
      return reply.code(403).send({ error: 'csrf', message: 'Missing request verification header.' });
    }
  };
}
