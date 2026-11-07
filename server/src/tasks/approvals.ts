import type { ApprovalRecord, ApprovalStatus, Risk } from '@tc/shared';
import type { Database } from '../db.js';
import { nowIso, parseJson } from '../db.js';
import type { AuditLog, EventBus, Notifications } from '../services/core.js';

interface ApprovalRow {
  id: number;
  task_id: number | null;
  conversation_id: number | null;
  run_id: string | null;
  tool_use_id: string | null;
  tool: string;
  risk: Risk;
  summary: string;
  input: string;
  status: ApprovalStatus;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ApprovalInternal extends ApprovalRecord {
  runId: string | null;
  toolUseId: string | null;
}

const toRecord = (r: ApprovalRow): ApprovalInternal => ({
  id: r.id,
  taskId: r.task_id,
  conversationId: r.conversation_id,
  runId: r.run_id,
  toolUseId: r.tool_use_id,
  tool: r.tool,
  risk: r.risk,
  summary: r.summary,
  input: parseJson(r.input, null),
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

/** Strips internal fields before an approval leaves the server. */
export function publicApproval(a: ApprovalInternal): ApprovalRecord {
  const { runId: _r, toolUseId: _t, ...pub } = a;
  return pub;
}

/**
 * Human-in-the-loop approvals. Only the authenticated owner can decide an
 * approval, through an HTTP route; no agent, tool or model output can.
 */
export class ApprovalService {
  private listeners = new Set<(a: ApprovalInternal) => void>();
  private waiters = new Map<number, (a: ApprovalInternal) => void>();

  constructor(
    private db: Database,
    private bus: EventBus,
    private audit: AuditLog,
    private notifications: Notifications,
  ) {}

  create(input: {
    taskId?: number | null;
    conversationId?: number | null;
    runId?: string | null;
    toolUseId?: string | null;
    tool: string;
    risk: Risk;
    summary: string;
    input: unknown;
  }): ApprovalInternal {
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO approvals(task_id, conversation_id, run_id, tool_use_id, tool, risk, summary, input, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      input.taskId ?? null,
      input.conversationId ?? null,
      input.runId ?? null,
      input.toolUseId ?? null,
      input.tool,
      input.risk,
      input.summary.slice(0, 1000),
      JSON.stringify(input.input ?? null).slice(0, 200_000),
      nowIso(),
    );
    const a = this.get(lastInsertRowid)!;
    this.audit.record('system', 'approval.requested', 'pending', input.tool, { approvalId: a.id, summary: a.summary, taskId: a.taskId });
    this.bus.emit({ type: 'approval.created', approval: publicApproval(a) });
    this.notifications.push('warning', 'Approval required', a.summary, a.taskId ? `missions/${a.taskId}` : 'missions');
    return a;
  }

  get(id: number): ApprovalInternal | null {
    const r = this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id);
    return r ? toRecord(r) : null;
  }

  findForToolUse(runId: string, toolUseId: string): ApprovalInternal | null {
    const r = this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE run_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1', runId, toolUseId);
    return r ? toRecord(r) : null;
  }

  list(status?: ApprovalStatus, limit = 100): ApprovalInternal[] {
    const rows = status
      ? this.db.all<ApprovalRow>('SELECT * FROM approvals WHERE status = ? ORDER BY id DESC LIMIT ?', status, limit)
      : this.db.all<ApprovalRow>('SELECT * FROM approvals ORDER BY id DESC LIMIT ?', limit);
    return rows.map(toRecord);
  }

  pendingCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0;
  }

  /** Called only from the owner-authenticated HTTP route (and expiry). */
  decide(id: number, approved: boolean, note: string | null, actor = 'owner'): ApprovalInternal {
    const cur = this.get(id);
    if (!cur) throw new Error('Approval not found');
    if (cur.status !== 'pending') throw new Error(`Approval already ${cur.status}`);
    const status: ApprovalStatus = approved ? 'approved' : 'denied';
    this.db.run('UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?', status, note, nowIso(), id);
    const a = this.get(id)!;
    this.audit.record(actor, approved ? 'approval.approved' : 'approval.denied', approved ? 'ok' : 'denied', a.tool, { approvalId: id, summary: a.summary, note });
    this.bus.emit({ type: 'approval.updated', approval: publicApproval(a) });
    this.waiters.get(id)?.(a);
    this.waiters.delete(id);
    for (const l of this.listeners) l(a);
    return a;
  }

  /** Expire all pending approvals belonging to a task or conversation run (on cancel). */
  expireFor(filter: { taskId?: number; runId?: string }) {
    const rows = filter.taskId
      ? this.db.all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' AND task_id = ?", filter.taskId)
      : this.db.all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' AND run_id = ?", filter.runId);
    for (const r of rows) {
      this.db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?", nowIso(), r.id);
      const a = this.get(r.id)!;
      this.bus.emit({ type: 'approval.updated', approval: publicApproval(a) });
      this.waiters.get(r.id)?.(a);
      this.waiters.delete(r.id);
    }
  }

  /** Resolves when the approval is decided (used by in-process playbooks). */
  waitFor(id: number, signal: AbortSignal): Promise<ApprovalInternal> {
    const cur = this.get(id);
    if (cur && cur.status !== 'pending') return Promise.resolve(cur);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(id, (a) => {
        signal.removeEventListener('abort', onAbort);
        resolve(a);
      });
    });
  }

  onDecision(fn: (a: ApprovalInternal) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
