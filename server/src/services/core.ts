import { EventEmitter } from 'node:events';
import type { NotificationRecord, ServerEvent } from '@tc/shared';
import type { Database } from '../db.js';
import { nowIso, parseJson } from '../db.js';

/** In-process pub/sub. The WebSocket hub forwards every event to signed-in clients. */
export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  emit(event: ServerEvent) {
    this.emitter.emit('event', event);
  }
  on(fn: (e: ServerEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}

/** Append-only audit trail of security-relevant and side-effecting actions. */
export class AuditLog {
  constructor(private db: Database) {}

  record(actor: string, action: string, outcome: 'ok' | 'denied' | 'error' | 'pending', target?: string | null, detail?: unknown) {
    this.db.run(
      'INSERT INTO audit_log(at, actor, action, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)',
      nowIso(),
      actor,
      action,
      target ?? null,
      outcome,
      detail === undefined ? null : JSON.stringify(redact(detail)).slice(0, 8000),
    );
  }

  list(limit = 200, before?: number) {
    const rows = before
      ? this.db.all<AuditRow>('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?', before, limit)
      : this.db.all<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
    return rows.map((r) => ({ ...r, detail: parseJson(r.detail, null) }));
  }
}

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  outcome: string;
  detail: string | null;
}

const SECRET_KEYS = /(api[_-]?key|secret|token|password|passphrase|authorization|cookie|refresh)/i;

/** Strips anything that looks like a credential before it reaches logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[redacted]');
  }
  return value;
}

/** JSON key/value settings with typed defaults. */
export interface Settings {
  ownerName: string;
  aiModel: string;
  aiEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  aiWebSearch: boolean; // Anthropic server-side web search (billed per search)
  autoApproveWrites: boolean; // low-risk "write" tools (e.g. saving a memory) run without asking
  voiceName: string | null;
  voiceRate: number;
  voicePitch: number;
  wakePhrase: string;
  soundEnabled: boolean;
  soundVolume: number;
  coreRenderMode: 'auto' | '3d' | '2d' | 'static';
  batterySaver: boolean;
  speakResponses: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ownerName: 'Keenan',
  aiModel: 'claude-opus-5-5',
  aiEffort: 'medium',
  aiWebSearch: false,
  autoApproveWrites: true,
  voiceName: null,
  voiceRate: 0.98,
  voicePitch: 0.9,
  wakePhrase: 'Tourbillion',
  soundEnabled: true,
  soundVolume: 0.6,
  coreRenderMode: 'auto',
  batterySaver: false,
  speakResponses: true,
};

export class SettingsStore {
  constructor(
    private db: Database,
    private defaults: Settings,
  ) {}

  all(): Settings {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    const out: Record<string, unknown> = { ...this.defaults };
    for (const r of rows) {
      if (r.key in this.defaults) out[r.key] = parseJson(r.value, (this.defaults as unknown as Record<string, unknown>)[r.key]);
    }
    return out as unknown as Settings;
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.all()[key];
  }

  update(patch: Partial<Settings>) {
    const now = nowIso();
    this.db.tx(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in this.defaults)) continue;
        this.db.run(
          'INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          k,
          JSON.stringify(v),
          now,
        );
      }
    });
  }
}

export class Notifications {
  constructor(
    private db: Database,
    private bus: EventBus,
  ) {}

  push(level: NotificationRecord['level'], title: string, body: string, link: string | null = null): NotificationRecord {
    const createdAt = nowIso();
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO notifications(level, title, body, link, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      level,
      title,
      body.slice(0, 2000),
      link,
      createdAt,
    );
    const n: NotificationRecord = { id: lastInsertRowid, level, title, body, link, read: false, createdAt };
    this.bus.emit({ type: 'notification', notification: n });
    return n;
  }

  list(limit = 50): NotificationRecord[] {
    return this.db
      .all<{ id: number; level: NotificationRecord['level']; title: string; body: string; link: string | null; read: number; created_at: string }>(
        'SELECT * FROM notifications ORDER BY id DESC LIMIT ?',
        limit,
      )
      .map((r) => ({ id: r.id, level: r.level, title: r.title, body: r.body, link: r.link, read: !!r.read, createdAt: r.created_at }));
  }

  markRead(id?: number) {
    if (id) this.db.run('UPDATE notifications SET read = 1 WHERE id = ?', id);
    else this.db.run('UPDATE notifications SET read = 1');
  }

  clear() {
    this.db.run('DELETE FROM notifications');
  }
}
