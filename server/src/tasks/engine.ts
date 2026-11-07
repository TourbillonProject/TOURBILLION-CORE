import type { z } from 'zod';
import type { AgentId, Risk, TaskKind, TaskPlan, TaskRecord, TaskStatus, TaskStep, TaskVerification } from '@tc/shared';
import { TERMINAL_TASK_STATUSES } from '@tc/shared';
import type { Ctx } from '../context.js';
import { nowIso, parseJson } from '../db.js';
import type { AgentRunner, RunOwner } from '../agents/runner.js';
import { gateFor } from '../agents/permissions.js';
import { truncate, type ToolOutput } from '../tools/registry.js';
import { publicApproval } from './approvals.js';

/**
 * Mission (task) execution engine.
 *
 *   pending → planning → [awaiting_approval] → running ⇄ awaiting_approval → completed | failed
 *                                     any non-terminal state → cancelled
 *
 * Two kinds of mission share the same lifecycle, permission gate, audit trail
 * and cancellation:
 *  - agent:    Claude plans (structured output), the owner approves the plan
 *              when it involves side effects, the agent executes with tools,
 *              then verifies its own work against the success criteria.
 *  - playbook: a deterministic pipeline written in code (e.g. The Spider's
 *              project inspection, an OSINT domain report, diagnostics). These
 *              do real work without an AI key; Claude adds synthesis when connected.
 */

export interface PlaybookContext {
  ctx: Ctx;
  task: TaskRecord;
  params: Record<string, unknown>;
  signal: AbortSignal;
  step: (message: string, data?: unknown, kind?: TaskStep['kind']) => void;
  tool: (name: string, input: unknown) => Promise<ToolOutput>;
  artifact: (kind: string, title: string, data: unknown) => number;
  /** Optional Claude synthesis; resolves null when no AI provider is connected. */
  synthesize: (instruction: string, material: string) => Promise<string | null>;
  fileEvent: (path: string) => void;
}

export interface PlaybookResult {
  report: string;
  verification: TaskVerification;
}

export interface Playbook<S extends z.ZodType = z.ZodType> {
  id: string;
  title: string;
  agent: AgentId;
  description: string;
  params: S;
  plan: (params: z.infer<S>, ctx: Ctx) => TaskPlan;
  /** Owner must approve the plan before the mission starts. */
  requiresPlanApproval?: (params: z.infer<S>) => boolean;
  run: (pc: PlaybookContext & { params: z.infer<S> }) => Promise<PlaybookResult>;
}

interface TaskRow {
  id: number;
  title: string;
  kind: TaskKind;
  playbook: string | null;
  params: string;
  request: string;
  agent: AgentId;
  status: TaskStatus;
  interpretation: string | null;
  plan: string | null;
  verification: string | null;
  report: string | null;
  error: string | null;
  project_id: number | null;
  conversation_id: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretation', 'steps', 'requiredPermissions', 'successCriteria'],
  properties: {
    interpretation: { type: 'string', description: 'What the owner is asking for, in one or two sentences.' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'tools', 'risk'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string', enum: ['read', 'write', 'sensitive'] },
        },
      },
    },
    requiredPermissions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'risk', 'reason'],
        properties: { tool: { type: 'string' }, risk: { type: 'string', enum: ['read', 'write', 'sensitive'] }, reason: { type: 'string' } },
      },
    },
    successCriteria: { type: 'array', items: { type: 'string' } },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'evidence', 'unverified'],
  properties: {
    outcome: { type: 'string', enum: ['succeeded', 'partial', 'failed', 'unverified'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Concrete tool results that show each criterion was met.' },
    unverified: { type: 'array', items: { type: 'string' }, description: 'Criteria or claims that could not be confirmed.' },
  },
};

const MAX_CONCURRENT = 2;

export class TaskEngine {
  private playbooks = new Map<string, Playbook>();
  private running = new Map<number, AbortController>();
  private queue: number[] = [];

  constructor(
    private ctx: Ctx,
    private runner: AgentRunner,
  ) {
    ctx.approvals.onDecision((a) => {
      if (!a.taskId) return;
      const task = this.get(a.taskId);
      if (!task || task.status !== 'awaiting_approval') return;
      if (a.tool === 'mission.plan') {
        if (a.status === 'approved') {
          this.step(task.id, 'approval', 'Plan approved by the owner.');
          this.enqueue(task.id);
        } else {
          this.finish(task.id, 'cancelled', { error: `Plan ${a.status} by the owner${a.note ? `: ${a.note}` : ''}.` });
        }
        return;
      }
      // Tool-level approval for an agent run: resume when nothing else is pending.
      if (task.kind === 'agent' && a.runId) {
        this.step(task.id, 'approval', `${a.status === 'approved' ? 'Approved' : a.status === 'denied' ? 'Denied' : 'Expired'}: ${a.summary}`);
        const stillPending = this.ctx.approvals.list('pending').some((p) => p.runId === a.runId);
        if (!stillPending) this.enqueue(task.id);
      }
    });
  }

  registerPlaybook(p: Playbook) {
    this.playbooks.set(p.id, p as Playbook);
  }

  listPlaybooks() {
    return [...this.playbooks.values()].map((p) => ({ id: p.id, title: p.title, agent: p.agent, description: p.description }));
  }

  // ---- records ------------------------------------------------------------

  private toRecord(r: TaskRow): TaskRecord {
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      playbook: r.playbook,
      request: r.request,
      agent: r.agent,
      status: r.status,
      interpretation: r.interpretation,
      plan: parseJson<TaskPlan | null>(r.plan, null),
      steps: [],
      verification: parseJson<TaskVerification | null>(r.verification, null),
      report: r.report,
      error: r.error,
      projectId: r.project_id,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    };
  }

  get(id: number, withSteps = false): TaskRecord | null {
    const r = this.ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!r) return null;
    const t = this.toRecord(r);
    if (withSteps) t.steps = this.steps(id);
    return t;
  }

  params(id: number): Record<string, unknown> {
    return parseJson(this.ctx.db.get<{ params: string }>('SELECT params FROM tasks WHERE id = ?', id)?.params, {});
  }

  list(filter: { status?: TaskStatus | 'active'; agent?: AgentId; projectId?: number; limit?: number } = {}): TaskRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status === 'active') where.push("status NOT IN ('completed','failed','cancelled')");
    else if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.agent) {
      where.push('agent = ?');
      params.push(filter.agent);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    return this.ctx.db
      .all<TaskRow>(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, filter.limit ?? 100)
      .map((r) => this.toRecord(r));
  }

  steps(id: number): TaskStep[] {
    return this.ctx.db
      .all<{ at: string; kind: TaskStep['kind']; message: string; data: string | null }>('SELECT at, kind, message, data FROM task_steps WHERE task_id = ? ORDER BY id', id)
      .map((s) => ({ at: s.at, kind: s.kind, message: s.message, data: parseJson(s.data, undefined) }));
  }

  step(taskId: number, kind: TaskStep['kind'], message: string, data?: unknown) {
    const step: TaskStep = { at: nowIso(), kind, message: message.slice(0, 4000), data };
    this.ctx.db.run(
      'INSERT INTO task_steps(task_id, at, kind, message, data) VALUES (?, ?, ?, ?, ?)',
      taskId,
      step.at,
      kind,
      step.message,
      data === undefined ? null : JSON.stringify(data).slice(0, 100_000),
    );
    this.ctx.bus.emit({ type: 'task.step', taskId, step });
  }

  private update(id: number, patch: Partial<Record<keyof TaskRow, unknown>>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.ctx.db.run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k as keyof TaskRow]), nowIso(), id);
    const t = this.get(id);
    if (t) this.ctx.bus.emit({ type: 'task.updated', task: t });
  }

  private setStatus(id: number, status: TaskStatus) {
    const t = this.get(id);
    if (!t) return;
    const agentStatus = status === 'planning' ? 'planning' : status === 'running' ? 'working' : status === 'awaiting_approval' ? 'waiting' : 'idle';
    this.ctx.agents.setStatus(t.agent, agentStatus, TERMINAL_TASK_STATUSES.includes(status) ? null : id);
    this.update(id, { status, ...(status === 'running' && !t.startedAt ? { started_at: nowIso() } : {}) });
  }

  private finish(id: number, status: 'completed' | 'failed' | 'cancelled', patch: { report?: string; error?: string; verification?: TaskVerification } = {}) {
    const t = this.get(id);
    if (!t || TERMINAL_TASK_STATUSES.includes(t.status)) return;
    this.update(id, {
      status,
      finished_at: nowIso(),
      ...(patch.report !== undefined ? { report: patch.report } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.verification ? { verification: JSON.stringify(patch.verification) } : {}),
    });
    this.ctx.agents.setStatus(t.agent, status === 'failed' ? 'error' : 'idle', null);
    if (status === 'failed') setTimeout(() => this.ctx.agents.setStatus(t.agent, 'idle', null), 15_000).unref?.();
    this.step(id, status === 'completed' ? 'verification' : status === 'failed' ? 'error' : 'info', `Mission ${status}.${patch.error ? ` ${patch.error}` : ''}`);
    this.ctx.audit.record('system', `mission.${status}`, status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'denied', `#${id} ${t.title}`);
    this.ctx.notifications.push(status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'info', `Mission #${id} ${status}`, t.title, `missions/${id}`);
    if (t.conversationId) {
      const final = this.get(id)!;
      this.ctx.conversations.notice(t.conversationId, `Mission #${id} (${t.agent}) ${status}: ${t.title}${final.verification ? ` — ${final.verification.outcome}` : ''}${final.error ? ` — ${final.error}` : ''}`);
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  create(input: {
    title: string;
    request: string;
    agent: AgentId;
    kind?: TaskKind;
    playbook?: string;
    params?: Record<string, unknown>;
    projectId?: number | null;
    conversationId?: number | null;
    start?: boolean;
  }): TaskRecord {
    const kind = input.kind ?? (input.playbook ? 'playbook' : 'agent');
    let params = input.params ?? {};
    if (kind === 'playbook') {
      const pb = this.playbooks.get(input.playbook ?? '');
      if (!pb) throw new Error(`Unknown playbook ${input.playbook}`);
      const parsed = pb.params.safeParse(params);
      if (!parsed.success) throw new Error(`Invalid parameters: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      params = parsed.data as Record<string, unknown>;
    }
    const now = nowIso();
    const { lastInsertRowid } = this.ctx.db.run(
      `INSERT INTO tasks(title, kind, playbook, params, request, agent, status, project_id, conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      input.title.slice(0, 200),
      kind,
      input.playbook ?? null,
      JSON.stringify(params),
      input.request.slice(0, 20_000),
      input.agent,
      input.projectId ?? null,
      input.conversationId ?? null,
      now,
      now,
    );
    const id = lastInsertRowid;
    this.step(id, 'info', `Mission created and assigned to ${this.ctx.agents.get(input.agent).name}.`);
    this.ctx.audit.record('owner', 'mission.created', 'ok', `#${id} ${input.title}`, { agent: input.agent, kind, playbook: input.playbook });
    this.ctx.bus.emit({ type: 'task.updated', task: this.get(id)! });
    if (input.start !== false) this.enqueue(id);
    return this.get(id)!;
  }

  private enqueue(id: number) {
    if (this.running.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
    this.pump();
  }

  private pump() {
    while (this.running.size < MAX_CONCURRENT && this.queue.length) {
      const id = this.queue.shift()!;
      const abort = new AbortController();
      this.running.set(id, abort);
      void this.process(id, abort.signal).finally(() => {
        this.running.delete(id);
        this.pump();
      });
    }
  }

  cancel(id: number): TaskRecord | null {
    const t = this.get(id);
    if (!t) return null;
    if (TERMINAL_TASK_STATUSES.includes(t.status)) return t;
    this.queue = this.queue.filter((q) => q !== id);
    this.running.get(id)?.abort();
    this.ctx.approvals.expireFor({ taskId: id });
    this.finish(id, 'cancelled', { error: 'Cancelled by the owner.' });
    return this.get(id);
  }

  retry(id: number): TaskRecord {
    const t = this.get(id);
    if (!t) throw new Error('Mission not found');
    return this.create({
      title: t.title,
      request: t.request,
      agent: t.agent,
      kind: t.kind,
      playbook: t.playbook ?? undefined,
      params: this.params(id),
      projectId: t.projectId,
      conversationId: t.conversationId,
    });
  }

  /** On boot: missions that were mid-flight cannot continue in-process. */
  recover() {
    this.runner.recoverInterrupted();
    for (const t of this.list({ status: 'active', limit: 1000 })) {
      if (t.status === 'pending') {
        this.enqueue(t.id);
        continue;
      }
      if (t.status === 'awaiting_approval') {
        const run = this.taskRun(t.id);
        const planWaiting = this.ctx.approvals.list('pending').some((a) => a.taskId === t.id && a.tool === 'mission.plan');
        if (planWaiting || (t.kind === 'agent' && run?.status === 'awaiting_approval')) continue; // resumable
      }
      this.finish(t.id, 'failed', { error: 'Interrupted by a server restart. Use Retry to run it again.' });
      this.ctx.approvals.expireFor({ taskId: t.id });
    }
  }

  private taskRun(taskId: number) {
    const row = this.ctx.db.get<{ id: string }>("SELECT id FROM runs WHERE owner_kind = 'task' AND owner_id = ? ORDER BY created_at DESC LIMIT 1", taskId);
    return row ? this.runner.getRun(row.id) : undefined;
  }

  activeCount() {
    return this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')")?.n ?? 0;
  }

  // ---- processing -------------------------------------------------------------

  private async process(id: number, signal: AbortSignal) {
    const t = this.get(id);
    if (!t || TERMINAL_TASK_STATUSES.includes(t.status)) return;
    try {
      if (t.kind === 'playbook') await this.processPlaybook(t, signal);
      else await this.processAgent(t, signal);
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      this.step(id, 'error', message);
      this.finish(id, 'failed', { error: message });
    }
  }

  private needsPlanApproval(plan: TaskPlan): Risk | null {
    const risks = [...plan.requiredPermissions.map((p) => p.risk), ...plan.steps.map((s) => s.risk ?? 'read')];
    if (risks.includes('sensitive')) return 'sensitive';
    if (risks.includes('write')) return 'write';
    return null;
  }

  private requestPlanApproval(t: TaskRecord, plan: TaskPlan, risk: Risk) {
    this.setStatus(t.id, 'awaiting_approval');
    const a = this.ctx.approvals.create({
      taskId: t.id,
      tool: 'mission.plan',
      risk,
      summary: `Approve the plan for mission #${t.id}: ${t.title}`,
      input: plan,
    });
    this.step(t.id, 'approval', 'Waiting for the owner to approve the plan.', { approvalId: a.id, approval: publicApproval(a) });
  }

  private async processAgent(t: TaskRecord, signal: AbortSignal) {
    const owner: RunOwner = { kind: 'task', id: t.id };
    const agent = this.ctx.agents.get(t.agent);
    let run = this.taskRun(t.id);

    if (!t.plan) {
      if (!this.ctx.ai.isReady()) throw new Error('Claude is not connected, so this agent mission cannot be planned. Connect Claude in Connected Apps, or use a playbook mission.');
      this.setStatus(t.id, 'planning');
      this.ctx.bus.emit({ type: 'activity', agent: t.agent, kind: 'thinking', label: 'Planning', taskId: t.id });
      this.step(t.id, 'model', `${agent.name} is planning.`);
      const toolList = agent.tools.map((n) => {
        const d = this.ctx.tools.get(n);
        return `- ${n} [${d ? this.ctx.tools.riskOf(d, {}) : '?'}]: ${d?.description.split('.')[0] ?? ''}`;
      });
      const result = await this.ctx.ai.turn({
        system: `${agent.prompt}\n\nYou are now planning a mission. Produce an execution plan as JSON. Only use tools from this list:\n${toolList.join('\n')}`,
        messages: [{ role: 'user', content: this.brief(t) }],
        tools: [],
        outputSchema: PLAN_SCHEMA,
        effort: 'medium',
        maxTokens: 16000,
        signal,
      });
      if (result.stopReason === 'refusal') throw new Error('The model declined to plan this mission.');
      let plan: TaskPlan;
      try {
        plan = JSON.parse(result.text) as TaskPlan;
      } catch {
        throw new Error('The planner did not return a valid plan.');
      }
      plan.steps = plan.steps.map((s) => ({ ...s, tools: (s.tools ?? []).filter((x) => agent.tools.includes(x)) }));
      this.update(t.id, { plan: JSON.stringify(plan), interpretation: plan.interpretation });
      this.step(t.id, 'model', `Plan ready: ${plan.steps.length} step(s).`, plan);
      const risk = this.needsPlanApproval(plan);
      if (risk) return this.requestPlanApproval(this.get(t.id)!, plan, risk);
    }

    const fresh = this.get(t.id)!;
    const plan = fresh.plan!;
    this.setStatus(t.id, 'running');
    const preApproved = plan.requiredPermissions.filter((p) => p.risk === 'write').map((p) => p.tool);
    if (!run) {
      const runId = this.runner.createRun(owner, t.agent);
      this.runner.append(
        owner,
        'user',
        [{ type: 'text', text: `${this.brief(fresh)}\n\nApproved plan:\n${JSON.stringify(plan, null, 2)}\n\nExecute the plan now. Report concisely at the end.` }],
        runId,
      );
      run = this.runner.getRun(runId);
    }
    const hooks = {
      onTool: (tool: string, status: string, summary: string) => this.step(t.id, status === 'started' ? 'tool' : 'tool_result', `${tool} ${status}: ${summary}`),
      onActivity: (kind: import('@tc/shared').ActivityKind, label?: string) => this.ctx.bus.emit({ type: 'activity', agent: t.agent, kind, label, taskId: t.id }),
    };
    // A logged verification step means we are resuming inside the verification pass.
    const verifying = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ? AND kind = 'verification'", t.id)!.n > 0;
    const outcome = await this.runner.execute(run!.id, { signal, hooks, projectId: t.projectId, preApprovedTools: preApproved, maxIterations: 40, outputSchema: verifying ? VERIFY_SCHEMA : undefined });
    if (outcome.status === 'cancelled' || signal.aborted) return;
    if (outcome.status === 'awaiting_approval') {
      this.setStatus(t.id, 'awaiting_approval');
      this.step(t.id, 'approval', `Waiting for approval (${outcome.approvalIds.length}).`);
      return;
    }
    if (outcome.status === 'error') return this.finish(t.id, 'failed', { error: outcome.error });
    if (outcome.status === 'refused') return this.finish(t.id, 'failed', { error: outcome.text });

    if (verifying) return this.completeWithVerification(t.id, outcome.text);

    // Verification pass: same run, structured output.
    this.update(t.id, { report: outcome.text });
    this.step(t.id, 'verification', 'Verifying results against the success criteria.');
    this.runner.append(
      owner,
      'user',
      [
        {
          type: 'text',
          text: `Verification step. Check your work against the success criteria:\n${plan.successCriteria.map((c) => `- ${c}`).join('\n')}\nUse tools again only if needed to confirm. Cite concrete tool results as evidence. Anything you could not confirm goes in "unverified". Respond with the JSON verdict.`,
        },
      ],
      run!.id,
    );
    const v = await this.runner.execute(run!.id, { signal, hooks, projectId: t.projectId, preApprovedTools: preApproved, maxIterations: 12, outputSchema: VERIFY_SCHEMA });
    if (v.status === 'cancelled' || signal.aborted) return;
    if (v.status === 'awaiting_approval') {
      this.setStatus(t.id, 'awaiting_approval');
      return;
    }
    if (v.status !== 'completed') {
      return this.finish(t.id, 'completed', {
        verification: { outcome: 'unverified', summary: v.status === 'error' ? v.error : 'Verification did not complete.', evidence: [], unverified: plan.successCriteria },
      });
    }
    this.completeWithVerification(t.id, v.text);
  }

  private completeWithVerification(id: number, json: string) {
    let verification: TaskVerification;
    try {
      verification = JSON.parse(json) as TaskVerification;
    } catch {
      verification = { outcome: 'unverified', summary: 'The verification response was not valid JSON.', evidence: [], unverified: [] };
    }
    this.step(id, 'verification', `Verification: ${verification.outcome} — ${verification.summary}`, verification);
    this.finish(id, verification.outcome === 'failed' ? 'failed' : 'completed', {
      verification,
      ...(verification.outcome === 'failed' ? { error: verification.summary } : {}),
    });
  }

  private brief(t: TaskRecord): string {
    const project = t.projectId ? this.ctx.projects.get(t.projectId) : null;
    const mem = this.ctx.memory.contextFor(t.request, t.projectId);
    return [
      `<context>\nMission #${t.id}: ${t.title}\nServer time: ${new Date().toISOString()}\n${project ? `Assigned project: #${project.id} ${project.name}` : 'No project assigned.'}\n</context>`,
      mem.block ?? '',
      `Owner's request:\n${t.request}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async processPlaybook(t: TaskRecord, signal: AbortSignal) {
    const pb = this.playbooks.get(t.playbook ?? '');
    if (!pb) throw new Error(`Unknown playbook ${t.playbook}`);
    const params = this.params(t.id);

    if (!t.plan) {
      this.setStatus(t.id, 'planning');
      const plan = pb.plan(params as never, this.ctx);
      this.update(t.id, { plan: JSON.stringify(plan), interpretation: plan.interpretation });
      this.step(t.id, 'info', `Plan: ${plan.steps.map((s) => s.title).join(' → ')}`, plan);
      if (pb.requiresPlanApproval?.(params as never)) {
        const risk = this.needsPlanApproval(plan) ?? 'write';
        return this.requestPlanApproval(this.get(t.id)!, plan, risk);
      }
    }

    this.setStatus(t.id, 'running');
    const task = this.get(t.id)!;
    const pc: PlaybookContext = {
      ctx: this.ctx,
      task,
      params,
      signal,
      step: (message, data, kind = 'info') => this.step(t.id, kind, message, data),
      tool: (name, input) => this.playbookTool(task, name, input, signal),
      artifact: (kind, title, data) =>
        this.ctx.db.run('INSERT INTO artifacts(task_id, project_id, kind, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?)', t.id, t.projectId, kind, title, JSON.stringify(data), nowIso())
          .lastInsertRowid,
      synthesize: async (instruction, material) => {
        if (!this.ctx.ai.isReady()) return null;
        this.ctx.bus.emit({ type: 'activity', agent: t.agent, kind: 'thinking', label: 'Synthesising', taskId: t.id });
        const r = await this.ctx.ai.turn({
          system: this.ctx.agents.get(t.agent).prompt,
          messages: [{ role: 'user', content: `${instruction}\n\n<untrusted_content source="collected material">\n${truncate(material, 150_000)}\n</untrusted_content>` }],
          tools: [],
          effort: 'medium',
          maxTokens: 16000,
          signal,
        });
        return r.stopReason === 'refusal' ? null : r.text;
      },
      fileEvent: (path) => this.ctx.bus.emit({ type: 'spider.file', taskId: t.id, path }),
    };
    this.ctx.bus.emit({ type: 'activity', agent: t.agent, kind: 'executing', label: pb.title, taskId: t.id });
    const result = await pb.run(pc as never);
    if (signal.aborted) return;
    this.update(t.id, { report: result.report });
    this.step(t.id, 'verification', `Verification: ${result.verification.outcome} — ${result.verification.summary}`, result.verification);
    this.finish(t.id, result.verification.outcome === 'failed' ? 'failed' : 'completed', {
      report: result.report,
      verification: result.verification,
      ...(result.verification.outcome === 'failed' ? { error: result.verification.summary } : {}),
    });
    this.ctx.bus.emit({ type: 'activity', agent: t.agent, kind: 'idle', taskId: t.id });
  }

  /** Tool call from a playbook: same permission gate; waits in-process for approval. */
  private async playbookTool(task: TaskRecord, name: string, input: unknown, signal: AbortSignal): Promise<ToolOutput> {
    const tool = this.ctx.tools.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.issues[0]?.message}`);
    const unavailable = tool.unavailable?.(this.ctx);
    if (unavailable) return { content: `Unavailable: ${unavailable}`, isError: true };
    const risk = this.ctx.tools.riskOf(tool, parsed.data);
    const summary = tool.summarize(parsed.data as never);
    const plan = task.plan;
    const preApproved = plan ? plan.requiredPermissions.filter((p) => p.risk === 'write').map((p) => p.tool) : [];
    if (gateFor(risk, name, this.ctx.settings.get('autoApproveWrites'), preApproved) === 'approval') {
      const a = this.ctx.approvals.create({ taskId: task.id, tool: name, risk, summary: `${this.ctx.agents.get(task.agent).name}: ${summary}`, input: parsed.data });
      this.setStatus(task.id, 'awaiting_approval');
      this.step(task.id, 'approval', `Waiting for approval: ${summary}`, { approvalId: a.id });
      const decided = await this.ctx.approvals.waitFor(a.id, signal);
      this.setStatus(task.id, 'running');
      if (decided.status !== 'approved') {
        this.step(task.id, 'approval', `Not approved (${decided.status}): ${summary}`);
        return { content: `Owner ${decided.status} this action.`, isError: true, data: { denied: true } };
      }
      this.step(task.id, 'approval', `Approved: ${summary}`);
    }
    this.step(task.id, 'tool', `${name}: ${summary}`);
    this.ctx.bus.emit({ type: 'activity', agent: task.agent, kind: tool.activity ?? 'executing', label: summary, taskId: task.id });
    const started = Date.now();
    try {
      const out = await tool.run(parsed.data as never, {
        ctx: this.ctx,
        agent: task.agent,
        taskId: task.id,
        conversationId: task.conversationId,
        projectId: task.projectId,
        signal,
        log: (m, d) => this.step(task.id, 'info', m, d),
      });
      this.ctx.audit.record(`agent:${task.agent}`, `tool.${name}`, out.isError ? 'error' : 'ok', summary, { risk, ms: Date.now() - started, taskId: task.id });
      this.step(task.id, 'tool_result', `${name} ${out.isError ? 'failed' : 'finished'} (${Date.now() - started} ms)`);
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.audit.record(`agent:${task.agent}`, `tool.${name}`, 'error', summary, { risk, error: message, taskId: task.id });
      this.step(task.id, 'error', `${name} failed: ${message}`);
      return { content: `Tool error: ${message}`, isError: true };
    }
  }
}
