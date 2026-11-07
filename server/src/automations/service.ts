import { z } from 'zod';
import type { Database } from '../db.js';
import { nowIso, parseJson } from '../db.js';
import type { TaskEngine } from '../tasks/engine.js';
import type { AuditLog } from '../services/core.js';
import { AGENT_IDS } from '@tc/shared';

/**
 * Automations: scheduled missions. A schedule only *creates* a mission; the
 * mission still goes through the same planning, permission gate and approval
 * flow as one the owner started by hand. Nothing sensitive runs unattended.
 */

export const scheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(15).max(10_080) }),
  z.object({ type: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), utcOffsetMinutes: z.number().int().min(-720).max(840).default(0) }),
]);

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('playbook'), playbook: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}), title: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('mission'), agent: z.enum(AGENT_IDS), request: z.string().min(3).max(4000), title: z.string().min(1).max(120) }),
]);

export type Schedule = z.infer<typeof scheduleSchema>;
export type AutomationAction = z.infer<typeof actionSchema>;

export interface Automation {
  id: number;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  action: AutomationAction;
  lastRunAt: string | null;
  lastTaskId: number | null;
  nextRunAt: string | null;
  createdAt: string;
}

export function nextRun(schedule: Schedule, from: Date): Date {
  if (schedule.type === 'interval') return new Date(from.getTime() + schedule.minutes * 60_000);
  const [h, m] = schedule.time.split(':').map(Number);
  // Wall-clock time at the given UTC offset.
  const local = new Date(from.getTime() + schedule.utcOffsetMinutes * 60_000);
  const candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - schedule.utcOffsetMinutes * 60_000);
  return candidate.getTime() > from.getTime() ? candidate : new Date(candidate.getTime() + 86_400_000);
}

export class AutomationService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database,
    private tasks: TaskEngine,
    private audit: AuditLog,
  ) {}

  start() {
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private row(r: { id: number; name: string; enabled: number; schedule: string; action: string; last_run_at: string | null; last_task_id: number | null; next_run_at: string | null; created_at: string }): Automation {
    return {
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      schedule: parseJson(r.schedule, { type: 'interval', minutes: 60 } as Schedule),
      action: parseJson(r.action, {} as AutomationAction),
      lastRunAt: r.last_run_at,
      lastTaskId: r.last_task_id,
      nextRunAt: r.next_run_at,
      createdAt: r.created_at,
    };
  }

  list(): Automation[] {
    return this.db.all<Parameters<AutomationService['row']>[0]>('SELECT * FROM automations ORDER BY id').map((r) => this.row(r));
  }

  get(id: number): Automation | null {
    const r = this.db.get<Parameters<AutomationService['row']>[0]>('SELECT * FROM automations WHERE id = ?', id);
    return r ? this.row(r) : null;
  }

  create(input: { name: string; schedule: Schedule; action: AutomationAction; enabled?: boolean }): Automation {
    if (input.action.kind === 'playbook' && !this.tasks.listPlaybooks().some((p) => p.id === (input.action as { playbook: string }).playbook)) throw new Error('Unknown playbook');
    const now = new Date();
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO automations(name, enabled, schedule, action, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.name.slice(0, 120),
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.schedule),
      JSON.stringify(input.action),
      nextRun(input.schedule, now).toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    this.audit.record('owner', 'automation.created', 'ok', input.name);
    return this.get(lastInsertRowid)!;
  }

  setEnabled(id: number, enabled: boolean) {
    const a = this.get(id);
    if (!a) throw new Error('Automation not found');
    this.db.run('UPDATE automations SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, enabled ? nextRun(a.schedule, new Date()).toISOString() : null, nowIso(), id);
    return this.get(id)!;
  }

  delete(id: number) {
    this.db.run('DELETE FROM automations WHERE id = ?', id);
    this.audit.record('owner', 'automation.deleted', 'ok', String(id));
  }

  runNow(id: number) {
    const a = this.get(id);
    if (!a) throw new Error('Automation not found');
    return this.fire(a);
  }

  private fire(a: Automation) {
    const action = a.action;
    const task =
      action.kind === 'playbook'
        ? this.tasks.create({ title: action.title, request: `Automation “${a.name}”`, agent: this.tasks.listPlaybooks().find((p) => p.id === action.playbook)?.agent ?? 'operator', playbook: action.playbook, params: action.params })
        : this.tasks.create({ title: action.title, request: action.request, agent: action.agent });
    const now = new Date();
    this.db.run('UPDATE automations SET last_run_at = ?, last_task_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?', now.toISOString(), task.id, nextRun(a.schedule, now).toISOString(), now.toISOString(), a.id);
    this.audit.record('system', 'automation.fired', 'ok', a.name, { taskId: task.id });
    return task;
  }

  tick(now = new Date()) {
    for (const a of this.list()) {
      if (!a.enabled || !a.nextRunAt || Date.parse(a.nextRunAt) > now.getTime()) continue;
      try {
        this.fire(a);
      } catch (err) {
        this.audit.record('system', 'automation.fired', 'error', a.name, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
