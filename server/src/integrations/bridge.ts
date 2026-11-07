import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { BridgeHello, BridgeOp, BridgeRequest, BridgeResponse } from '@tc/shared';
import { BRIDGE_PROTOCOL_VERSION } from '@tc/shared';
import type { Database } from '../db.js';
import { nowIso, parseJson } from '../db.js';
import { randomToken, sha256 } from '../security/crypto.js';
import type { AuditLog, EventBus } from '../services/core.js';
import type { IntegrationRegistry } from '../services/integrations.js';

/**
 * Desktop bridge hub.
 *
 * The iPad cannot run Blender or Roblox Studio. The owner runs the small
 * `tourbillion-bridge` program on their desktop; it dials OUT to this server
 * over a WebSocket (no inbound ports on the desktop), authenticated by a
 * long-lived token obtained through a one-time pairing code.
 *
 * The bridge only implements a fixed set of operations, enforces its own
 * local allowlist (folders, Blender scripts on/off, named Roblox tasks), and
 * every side-effecting operation is approval-gated on the server first.
 * There is no "run arbitrary shell command" operation.
 */

interface BridgeConn {
  bridgeId: number;
  name: string;
  socket: WebSocket;
  hello: BridgeHello | null;
  connectedAt: string;
  pending: Map<string, { resolve: (r: BridgeResponse) => void; timer: NodeJS.Timeout }>;
}

export class BridgeHub {
  private conns = new Map<number, BridgeConn>();

  constructor(
    private db: Database,
    private bus: EventBus,
    private audit: AuditLog,
    private integrations: IntegrationRegistry,
  ) {
    integrations.register({
      id: 'bridge',
      name: 'Desktop bridge',
      description: 'Connects a Mac or PC so agents can operate Blender and Roblox Studio project files there.',
      permissions: ['Read/write files only inside folders you allow in the bridge config', 'Run Blender in background mode (scripts only if enabled locally)', 'Run named Roblox project tasks you define (e.g. rojo build, selene)'],
      requires: ['A paired computer running `tourbillion-bridge start`'],
      isConfigured: () => this.paired().length > 0,
      // "connected" only after the bridge has completed its capability handshake.
      liveState: () => ([...this.conns.values()].some((c) => c.hello) ? 'connected' : this.conns.size > 0 ? 'configured' : this.paired().length > 0 ? 'disconnected' : null),
      details: () => ({ connected: this.listConnected().map((c) => ({ name: c.name, hostname: c.hello?.hostname, platform: c.hello?.platform })), paired: this.paired().length }),
      test: async () => {
        const c = this.first();
        if (!c) throw new Error('No desktop bridge is connected right now.');
        const r = await this.request('hello', {}, 10_000);
        return { hostname: (r as BridgeHello).hostname };
      },
    });
    integrations.register({
      id: 'blender',
      name: 'Blender (via desktop bridge)',
      description: 'Scene inspection, approved Python scripts and renders using Blender on your computer.',
      permissions: ['Run Blender in background mode on the paired computer', 'Execute bpy scripts only after approval and only if enabled in the bridge config'],
      requires: ['Desktop bridge connected', 'Blender installed on that computer (blenderPath in bridge config)'],
      isConfigured: () => this.paired().length > 0,
      liveState: () => {
        const c = this.first();
        if (!c) return this.paired().length ? 'disconnected' : null;
        return c.hello?.capabilities.blender.available ? 'connected' : 'error';
      },
      details: () => ({ version: this.first()?.hello?.capabilities.blender.version ?? null, scriptsAllowed: this.first()?.hello?.capabilities.blender.scriptsAllowed ?? false }),
    });
    integrations.register({
      id: 'roblox',
      name: 'Roblox Studio project (via desktop bridge)',
      description: 'Manage Luau files of a Rojo project and run named tasks. Studio picks up file changes through Rojo live sync.',
      permissions: ['Read/write files inside the configured Roblox project folder', 'Run only the named tasks defined in the bridge config'],
      requires: ['Desktop bridge connected', 'robloxProjectDir set in bridge config (Rojo recommended)'],
      isConfigured: () => this.paired().length > 0,
      liveState: () => {
        const c = this.first();
        if (!c) return this.paired().length ? 'disconnected' : null;
        return c.hello?.capabilities.roblox.available ? 'connected' : 'error';
      },
      details: () => ({ projectDir: this.first()?.hello?.capabilities.roblox.projectDir ?? null, tasks: this.first()?.hello?.capabilities.roblox.tasks ?? [] }),
    });
  }

  // ---- pairing ------------------------------------------------------------

  createPairing(name: string): { code: string; expiresAt: string } {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.db.run('DELETE FROM bridge_pairings WHERE expires_at < ?', nowIso());
    this.db.run('INSERT INTO bridge_pairings(code_hash, name, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(code), name.slice(0, 60), nowIso(), expiresAt);
    this.audit.record('owner', 'bridge.pairing_created', 'ok', name);
    return { code, expiresAt };
  }

  redeemPairing(code: string, hostname: string): { token: string; bridgeId: number } {
    const row = this.db.get<{ name: string; expires_at: string }>('SELECT name, expires_at FROM bridge_pairings WHERE code_hash = ?', sha256(code.trim().toUpperCase()));
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      this.audit.record('bridge', 'bridge.pair', 'denied', hostname);
      throw new Error('Pairing code is invalid or expired.');
    }
    this.db.run('DELETE FROM bridge_pairings WHERE code_hash = ?', sha256(code.trim().toUpperCase()));
    const token = `tcb_${randomToken(32)}`;
    const { lastInsertRowid } = this.db.run('INSERT INTO bridges(name, token_hash, info, created_at) VALUES (?, ?, ?, ?)', row.name, sha256(token), JSON.stringify({ hostname }), nowIso());
    this.audit.record('bridge', 'bridge.pair', 'ok', `${row.name} (${hostname})`);
    return { token, bridgeId: lastInsertRowid };
  }

  paired() {
    return this.db.all<{ id: number; name: string; created_at: string; last_seen_at: string | null; info: string }>('SELECT id, name, created_at, last_seen_at, info FROM bridges WHERE revoked = 0 ORDER BY id');
  }

  listPaired() {
    return this.paired().map((b) => ({ id: b.id, name: b.name, createdAt: b.created_at, lastSeenAt: b.last_seen_at, info: parseJson(b.info, {}), connected: this.conns.has(b.id), hello: this.conns.get(b.id)?.hello ?? null }));
  }

  revoke(id: number) {
    this.db.run('UPDATE bridges SET revoked = 1 WHERE id = ?', id);
    this.conns.get(id)?.socket.close(4403, 'revoked');
    this.conns.delete(id);
    this.audit.record('owner', 'bridge.revoked', 'ok', String(id));
  }

  private authenticate(token: string | undefined): { id: number; name: string } | null {
    if (!token) return null;
    return this.db.get<{ id: number; name: string }>('SELECT id, name FROM bridges WHERE token_hash = ? AND revoked = 0', sha256(token)) ?? null;
  }

  // ---- connections ------------------------------------------------------

  connectedCount() {
    return this.conns.size;
  }

  listConnected() {
    return [...this.conns.values()];
  }

  first(): BridgeConn | null {
    return [...this.conns.values()].find((c) => c.hello) ?? this.conns.values().next().value ?? null;
  }

  capabilities() {
    return this.first()?.hello?.capabilities ?? null;
  }

  register(app: FastifyInstance) {
    app.get('/api/bridge/ws', { websocket: true }, (socket, req) => {
      const auth = String(req.headers.authorization ?? '');
      const bridge = this.authenticate(auth.startsWith('Bearer ') ? auth.slice(7) : undefined);
      if (!bridge) {
        socket.close(4401, 'unauthorized');
        return;
      }
      this.conns.get(bridge.id)?.socket.close(4409, 'replaced by a new connection');
      const conn: BridgeConn = { bridgeId: bridge.id, name: bridge.name, socket, hello: null, connectedAt: nowIso(), pending: new Map() };
      this.conns.set(bridge.id, conn);
      this.db.run('UPDATE bridges SET last_seen_at = ? WHERE id = ?', nowIso(), bridge.id);
      this.audit.record('bridge', 'bridge.connected', 'ok', bridge.name, { ip: req.ip });
      socket.on('message', (raw) => {
        let msg: BridgeHello | BridgeResponse;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'hello') {
          if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) {
            socket.close(4400, `protocol ${msg.protocol} unsupported; server speaks ${BRIDGE_PROTOCOL_VERSION}`);
            return;
          }
          conn.hello = msg;
          this.db.run('UPDATE bridges SET info = ? WHERE id = ?', JSON.stringify({ hostname: msg.hostname, platform: msg.platform, version: msg.bridgeVersion }), bridge.id);
          this.integrations.markSuccess('bridge', { hostname: msg.hostname });
          for (const id of ['bridge', 'blender', 'roblox']) this.bus.emit({ type: 'integration.updated', integration: this.integrations.status(id) });
        } else if (msg.type === 'response') {
          const p = conn.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            conn.pending.delete(msg.id);
            p.resolve(msg);
          }
        }
      });
      const ping = setInterval(() => socket.ping(), 25_000);
      socket.on('close', () => {
        clearInterval(ping);
        for (const p of conn.pending.values()) {
          clearTimeout(p.timer);
          p.resolve({ type: 'response', id: '', ok: false, error: 'Bridge disconnected' });
        }
        if (this.conns.get(bridge.id) === conn) this.conns.delete(bridge.id);
        this.db.run('UPDATE bridges SET last_seen_at = ? WHERE id = ?', nowIso(), bridge.id);
        for (const id of ['bridge', 'blender', 'roblox']) this.bus.emit({ type: 'integration.updated', integration: this.integrations.status(id) });
      });
    });
  }

  /** Sends an operation to the (first) connected bridge and awaits its response. */
  async request(op: BridgeOp, params: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    const conn = this.first();
    if (!conn) throw new Error('No desktop bridge is connected. Start `tourbillion-bridge start` on your computer.');
    const id = crypto.randomBytes(8).toString('hex');
    const req: BridgeRequest = { type: 'request', id, op, params };
    const res = await new Promise<BridgeResponse>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ type: 'response', id, ok: false, error: `Bridge did not answer within ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      conn.pending.set(id, { resolve, timer });
      conn.socket.send(JSON.stringify(req));
    });
    if (!res.ok) throw new Error(res.error ?? 'Bridge operation failed');
    return res.result;
  }
}
