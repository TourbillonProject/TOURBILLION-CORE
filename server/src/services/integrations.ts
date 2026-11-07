import type { IntegrationState, IntegrationStatus } from '@tc/shared';
import type { Database } from '../db.js';
import { nowIso, parseJson } from '../db.js';
import type { EventBus } from './core.js';

/**
 * Integration manager. Each connector registers a descriptor that knows how to
 * compute its live status and how to test itself. Last success / last error
 * are persisted so the UI can show history across restarts.
 *
 * Rule: a connector is only reported as `connected` after a successful test.
 */
export interface IntegrationDescriptor {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  requires: string[];
  /** Is enough configuration present to attempt a connection? */
  isConfigured(): boolean;
  /** Extra non-secret details for the UI. */
  details?(): Record<string, unknown>;
  /** Performs a real round-trip. Throw with a helpful message on failure. */
  test?(): Promise<Record<string, unknown> | void>;
  disconnect?(): Promise<void> | void;
  /** If set, the connection is live by nature (e.g. an open bridge socket). */
  liveState?(): IntegrationState | null;
  canConnect?: boolean;
}

export class IntegrationRegistry {
  private items = new Map<string, IntegrationDescriptor>();

  constructor(
    private db: Database,
    private bus: EventBus,
  ) {}

  register(d: IntegrationDescriptor) {
    this.items.set(d.id, d);
  }

  get(id: string) {
    return this.items.get(id);
  }

  private row(id: string) {
    return this.db.get<{ state: IntegrationState; last_success_at: string | null; last_error: string | null; details: string }>(
      'SELECT state, last_success_at, last_error, details FROM integrations WHERE id = ?',
      id,
    );
  }

  private save(id: string, state: IntegrationState, lastSuccessAt: string | null, lastError: string | null, details: Record<string, unknown>) {
    this.db.run(
      `INSERT INTO integrations(id, state, last_success_at, last_error, details, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, last_success_at = excluded.last_success_at, last_error = excluded.last_error, details = excluded.details, updated_at = excluded.updated_at`,
      id,
      state,
      lastSuccessAt,
      lastError,
      JSON.stringify(details),
      nowIso(),
    );
  }

  status(id: string): IntegrationStatus {
    const d = this.items.get(id);
    if (!d) throw new Error(`Unknown integration ${id}`);
    const row = this.row(id);
    const configured = d.isConfigured();
    let state: IntegrationState;
    const live = d.liveState?.() ?? null;
    if (!configured) state = 'not_configured';
    else if (live) state = live;
    else if (row && (row.state === 'connected' || row.state === 'error' || row.state === 'disconnected')) state = row.state;
    else state = 'configured';
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      state,
      permissions: d.permissions,
      lastSuccessAt: row?.last_success_at ?? null,
      lastError: row?.last_error ?? null,
      details: { ...parseJson<Record<string, unknown>>(row?.details, {}), ...(d.details?.() ?? {}) },
      requires: d.requires,
      canConnect: d.canConnect ?? !!d.test,
      canDisconnect: !!d.disconnect,
    };
  }

  list(): IntegrationStatus[] {
    return [...this.items.keys()].map((id) => this.status(id));
  }

  /** Records the outcome of a real operation (used by connectors after API calls too). */
  markSuccess(id: string, details: Record<string, unknown> = {}) {
    const row = this.row(id);
    this.save(id, 'connected', nowIso(), null, { ...parseJson<Record<string, unknown>>(row?.details, {}), ...details });
    this.bus.emit({ type: 'integration.updated', integration: this.status(id) });
  }

  markError(id: string, error: string) {
    const row = this.row(id);
    this.save(id, 'error', row?.last_success_at ?? null, error.slice(0, 1000), parseJson(row?.details, {}));
    this.bus.emit({ type: 'integration.updated', integration: this.status(id) });
  }

  markDisconnected(id: string) {
    const row = this.row(id);
    this.save(id, 'disconnected', row?.last_success_at ?? null, null, {});
    this.bus.emit({ type: 'integration.updated', integration: this.status(id) });
  }

  async test(id: string): Promise<IntegrationStatus> {
    const d = this.items.get(id);
    if (!d) throw new Error(`Unknown integration ${id}`);
    if (!d.isConfigured()) throw new Error(`${d.name} is not configured. Requires: ${d.requires.join(', ')}`);
    if (!d.test) return this.status(id);
    try {
      const details = (await d.test()) ?? {};
      this.markSuccess(id, details);
    } catch (err) {
      this.markError(id, err instanceof Error ? err.message : String(err));
    }
    return this.status(id);
  }

  async disconnect(id: string): Promise<IntegrationStatus> {
    const d = this.items.get(id);
    if (!d?.disconnect) throw new Error('This integration cannot be disconnected here');
    await d.disconnect();
    this.markDisconnected(id);
    return this.status(id);
  }
}
