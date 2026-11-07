import crypto from 'node:crypto';
import type { ActivityKind, AgentId } from '@tc/shared';
import type { Ctx } from '../context.js';
import { nowIso, parseJson } from '../db.js';
import type { StoredMessage, ToolCall } from '../ai/types.js';
import { ProviderError } from '../ai/types.js';
import { truncate, wrapUntrusted, type ToolDef } from '../tools/registry.js';
import { gateFor } from './permissions.js';

/**
 * The agent execution loop (manual streaming loop over the Messages API).
 *
 * Why manual rather than the SDK tool runner: a run can pause for the owner's
 * approval for minutes or days, and must survive server restarts. Every
 * message is persisted append-only in `transcripts`; pending tool calls and
 * the results computed so far live on the `runs` row. Resuming replays the
 * transcript exactly as stored (thinking blocks included).
 */

export interface RunOwner {
  kind: 'conversation' | 'task';
  id: number;
}

export interface RunHooks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onTool?: (tool: string, status: 'started' | 'finished' | 'awaiting_approval' | 'denied' | 'error', summary: string) => void;
  onActivity?: (kind: ActivityKind, label?: string) => void;
}

export type RunOutcome =
  | { status: 'completed'; text: string }
  | { status: 'awaiting_approval'; approvalIds: number[] }
  | { status: 'cancelled' }
  | { status: 'refused'; text: string }
  | { status: 'error'; error: string };

interface PendingState {
  calls: ToolCall[];
  results: Record<string, { content: string; isError: boolean }>;
}

interface RunRow {
  id: string;
  owner_kind: 'conversation' | 'task';
  owner_id: number;
  agent: AgentId;
  status: string;
  pending: string | null;
  usage: string;
}

export interface ExecuteOptions {
  hooks?: RunHooks;
  signal: AbortSignal;
  maxIterations?: number;
  outputSchema?: Record<string, unknown>;
  projectId?: number | null;
  /** Tools the owner already approved as part of a mission plan (write-level only). */
  preApprovedTools?: string[];
}

const MAX_TOOL_OUTPUT = 60_000;

export class AgentRunner {
  constructor(private ctx: Ctx) {}

  // ---- transcript -------------------------------------------------------

  transcript(owner: RunOwner): StoredMessage[] {
    return this.ctx.db
      .all<{ role: 'user' | 'assistant'; content: string }>(
        "SELECT role, content FROM transcripts WHERE owner_kind = ? AND owner_id = ? AND role IN ('user','assistant') ORDER BY id",
        owner.kind,
        owner.id,
      )
      .map((r) => ({ role: r.role, content: parseJson<unknown[] | string>(r.content, []) }));
  }

  append(owner: RunOwner, role: 'user' | 'assistant' | 'notice', content: unknown[] | string, turnId: string | null, hidden = false) {
    this.ctx.db.run(
      'INSERT INTO transcripts(owner_kind, owner_id, role, content, turn_id, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      owner.kind,
      owner.id,
      role,
      JSON.stringify(content),
      turnId,
      hidden ? 1 : 0,
      nowIso(),
    );
  }

  /**
   * If the transcript ends with an assistant tool_use that never got results
   * (crash, cancellation, or a new owner message superseding an approval),
   * append error results so the history stays valid. Append-only: earlier
   * messages are never edited.
   */
  closeDangling(owner: RunOwner, reason: string) {
    const last = this.ctx.db.get<{ role: string; content: string }>(
      "SELECT role, content FROM transcripts WHERE owner_kind = ? AND owner_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1",
      owner.kind,
      owner.id,
    );
    if (!last || last.role !== 'assistant') return;
    const blocks = parseJson<{ type: string; id?: string }[]>(last.content, []);
    const uses = Array.isArray(blocks) ? blocks.filter((b) => b.type === 'tool_use' && b.id) : [];
    if (!uses.length) return;
    this.append(
      owner,
      'user',
      uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: reason, is_error: true })),
      null,
      true,
    );
  }

  // ---- runs -------------------------------------------------------------

  createRun(owner: RunOwner, agent: AgentId): string {
    const id = `run_${crypto.randomBytes(9).toString('base64url')}`;
    const now = nowIso();
    this.ctx.db.run(
      "INSERT INTO runs(id, owner_kind, owner_id, agent, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
      id,
      owner.kind,
      owner.id,
      agent,
      now,
      now,
    );
    return id;
  }

  getRun(id: string): RunRow | undefined {
    return this.ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  }

  private setRun(id: string, status: string, pending: PendingState | null, error: string | null = null) {
    this.ctx.db.run('UPDATE runs SET status = ?, pending = ?, error = ?, updated_at = ? WHERE id = ?', status, pending ? JSON.stringify(pending) : null, error, nowIso(), id);
  }

  private addUsage(id: string, u: Record<string, number>) {
    const row = this.getRun(id);
    const cur = parseJson<Record<string, number>>(row?.usage, {});
    for (const [k, v] of Object.entries(u)) cur[k] = (cur[k] ?? 0) + v;
    this.ctx.db.run('UPDATE runs SET usage = ? WHERE id = ?', JSON.stringify(cur), id);
  }

  /** Marks runs that were mid-flight when the process stopped. Awaiting-approval runs stay resumable. */
  recoverInterrupted(): number {
    return this.ctx.db.run("UPDATE runs SET status = 'interrupted', error = 'Server restarted while this run was executing.' WHERE status = 'running'").changes;
  }

  // ---- execution --------------------------------------------------------

  async execute(runId: string, opts: ExecuteOptions): Promise<RunOutcome> {
    const run = this.getRun(runId);
    if (!run) return { status: 'error', error: 'Run not found' };
    const owner: RunOwner = { kind: run.owner_kind, id: run.owner_id };
    const agent = this.ctx.agents.get(run.agent);
    const hooks = opts.hooks ?? {};
    this.setRun(runId, 'running', parseJson<PendingState | null>(run.pending, null));

    try {
      // 1. Resolve tool calls left pending by a previous approval pause.
      const pending = parseJson<PendingState | null>(run.pending, null);
      if (pending) {
        const waiting = await this.resolvePending(runId, owner, run.agent, pending, opts);
        if (waiting.length) {
          this.setRun(runId, 'awaiting_approval', pending);
          return { status: 'awaiting_approval', approvalIds: waiting };
        }
        this.appendToolResults(owner, runId, pending);
        this.setRun(runId, 'running', null);
      }

      const toolNames = agent.tools.filter((n) => {
        const t = this.ctx.tools.get(n);
        return t && !t.unavailable?.(this.ctx);
      });
      const tools = this.ctx.tools.specs(toolNames);
      const webSearch = agent.webSearch && this.ctx.settings.get('aiWebSearch');
      const system = `${agent.prompt}\n\nThe owner's name is ${this.ctx.settings.get('ownerName')}.`;

      for (let i = 0; i < (opts.maxIterations ?? 24); i++) {
        if (opts.signal.aborted) return this.cancelled(runId);
        hooks.onActivity?.('thinking');
        let sawText = false;
        const result = await this.ctx.ai.turn({
          system,
          messages: this.transcript(owner),
          tools,
          webSearch,
          outputSchema: opts.outputSchema,
          signal: opts.signal,
          onText: (d) => {
            if (!sawText) {
              sawText = true;
              hooks.onActivity?.('responding');
            }
            hooks.onText?.(d);
          },
          onThinking: (d) => hooks.onThinking?.(d),
          onServerTool: (name, input) => {
            hooks.onActivity?.('research', 'Web search');
            hooks.onTool?.(name, 'started', typeof input === 'object' && input && 'query' in input ? `Searching: ${(input as { query: string }).query}` : name);
          },
        });
        this.addUsage(runId, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
          webSearches: result.usage.webSearches,
        });

        if (result.stopReason === 'refusal') {
          // Partial output from a declined turn is discarded, not treated as an answer.
          const msg = `The model declined this request${result.refusal?.category ? ` (category: ${result.refusal.category})` : ''}.${result.refusal?.explanation ? ` ${result.refusal.explanation}` : ''}`;
          this.setRun(runId, 'completed', null, msg);
          return { status: 'refused', text: msg };
        }
        if (result.stopReason === 'max_tokens' && result.toolCalls.length) {
          this.setRun(runId, 'error', null, 'Model output was truncated mid tool call.');
          return { status: 'error', error: 'The response was cut off by the output limit before a tool call completed. Try a narrower request.' };
        }
        if (result.content.length) this.append(owner, 'assistant', result.content, runId);
        if (result.stopReason === 'pause_turn') continue;
        if (result.toolCalls.length === 0) {
          this.setRun(runId, 'completed', null);
          hooks.onActivity?.('idle');
          return { status: 'completed', text: result.text };
        }

        // 2. Execute this turn's tool calls through the permission gate.
        const state: PendingState = { calls: result.toolCalls, results: {} };
        const waiting = await this.resolvePending(runId, owner, run.agent, state, opts);
        if (waiting.length) {
          this.setRun(runId, 'awaiting_approval', state);
          hooks.onActivity?.('idle');
          return { status: 'awaiting_approval', approvalIds: waiting };
        }
        this.appendToolResults(owner, runId, state);
      }
      this.setRun(runId, 'error', null, 'Iteration limit reached');
      return { status: 'error', error: 'Stopped after reaching the step limit for one run. Ask me to continue if needed.' };
    } catch (err) {
      if (opts.signal.aborted || (err instanceof Error && err.name === 'APIUserAbortError')) return this.cancelled(runId);
      const message = err instanceof ProviderError || err instanceof Error ? err.message : String(err);
      this.setRun(runId, 'error', parseJson<PendingState | null>(this.getRun(runId)?.pending, null), message);
      hooks.onActivity?.('error', message);
      return { status: 'error', error: message };
    }
  }

  private cancelled(runId: string): RunOutcome {
    this.setRun(runId, 'cancelled', null);
    this.ctx.approvals.expireFor({ runId });
    return { status: 'cancelled' };
  }

  private appendToolResults(owner: RunOwner, runId: string, state: PendingState) {
    const blocks = state.calls.map((c) => ({
      type: 'tool_result',
      tool_use_id: c.id,
      content: state.results[c.id]?.content ?? 'No result.',
      ...(state.results[c.id]?.isError ? { is_error: true } : {}),
    }));
    this.append(owner, 'user', blocks, runId, true);
  }

  /** Runs every call that may run; returns ids of approvals still pending. */
  private async resolvePending(runId: string, owner: RunOwner, agentId: AgentId, state: PendingState, opts: ExecuteOptions): Promise<number[]> {
    const waiting: number[] = [];
    const agent = this.ctx.agents.get(agentId);
    for (const call of state.calls) {
      if (state.results[call.id]) continue;
      const tool = this.ctx.tools.get(call.name);
      if (!tool || !agent.tools.includes(call.name)) {
        state.results[call.id] = { content: `Tool "${call.name}" is not available to ${agent.name}.`, isError: true };
        continue;
      }
      const parsed = tool.schema.safeParse(call.input);
      if (!parsed.success) {
        state.results[call.id] = {
          content: JSON.stringify({ INVALID_INPUT: JSON.stringify(call.input).slice(0, 2000), issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }),
          isError: true,
        };
        continue;
      }
      const unavailable = tool.unavailable?.(this.ctx);
      if (unavailable) {
        state.results[call.id] = { content: `Unavailable: ${unavailable}`, isError: true };
        continue;
      }
      const risk = this.ctx.tools.riskOf(tool, parsed.data);
      const summary = safeSummary(tool, parsed.data);
      const gate = gateFor(risk, tool.name, this.ctx.settings.get('autoApproveWrites'), opts.preApprovedTools ?? []);
      if (gate === 'approval') {
        const existing = this.ctx.approvals.findForToolUse(runId, call.id);
        if (!existing) {
          const a = this.ctx.approvals.create({
            taskId: owner.kind === 'task' ? owner.id : null,
            conversationId: owner.kind === 'conversation' ? owner.id : null,
            runId,
            toolUseId: call.id,
            tool: tool.name,
            risk,
            summary: `${agent.name}: ${summary}`,
            input: parsed.data,
          });
          opts.hooks?.onTool?.(tool.name, 'awaiting_approval', summary);
          waiting.push(a.id);
          continue;
        }
        if (existing.status === 'pending') {
          waiting.push(existing.id);
          continue;
        }
        if (existing.status !== 'approved') {
          state.results[call.id] = {
            content: existing.status === 'denied' ? `The owner denied this action${existing.note ? `: ${existing.note}` : ''}. Do not retry it; continue without it or ask.` : 'This approval expired; the action did not run.',
            isError: true,
          };
          opts.hooks?.onTool?.(tool.name, 'denied', summary);
          continue;
        }
      }
      state.results[call.id] = await this.runTool(tool, parsed.data, owner, agentId, summary, risk, opts);
      // Persist progress so a crash mid-batch does not repeat completed side effects.
      this.setRun(runId, 'running', state);
    }
    return waiting;
  }

  private async runTool(tool: ToolDef, input: unknown, owner: RunOwner, agentId: AgentId, summary: string, risk: string, opts: ExecuteOptions) {
    const hooks = opts.hooks ?? {};
    hooks.onTool?.(tool.name, 'started', summary);
    hooks.onActivity?.(tool.activity ?? 'tool', summary);
    const started = Date.now();
    try {
      const out = await tool.run(input as never, {
        ctx: this.ctx,
        agent: agentId,
        taskId: owner.kind === 'task' ? owner.id : null,
        conversationId: owner.kind === 'conversation' ? owner.id : null,
        projectId: opts.projectId ?? null,
        signal: opts.signal,
        log: () => {},
      });
      this.ctx.audit.record(`agent:${agentId}`, `tool.${tool.name}`, out.isError ? 'error' : 'ok', summary, { risk, ms: Date.now() - started, owner });
      hooks.onTool?.(tool.name, out.isError ? 'error' : 'finished', summary);
      const text = truncate(out.content, MAX_TOOL_OUTPUT);
      return { content: out.untrusted ? wrapUntrusted(out.untrusted.source, text) : text, isError: !!out.isError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.audit.record(`agent:${agentId}`, `tool.${tool.name}`, 'error', summary, { risk, error: message, owner });
      hooks.onTool?.(tool.name, 'error', `${summary}: ${message}`);
      return { content: `Tool error: ${message}`, isError: true };
    }
  }
}

function safeSummary(tool: ToolDef, input: unknown): string {
  try {
    return tool.summarize(input as never);
  } catch {
    return tool.name;
  }
}
