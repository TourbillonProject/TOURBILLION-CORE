import type { Ctx } from '../context.js';
import { nowIso, parseJson } from '../db.js';
import { ProviderNotConfiguredError } from '../ai/types.js';
import type { AgentRunner, RunOwner } from '../agents/runner.js';

export interface DisplayMessage {
  id: number;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  thinking: string | null;
  tools: { name: string; input: unknown }[];
  turnId: string | null;
  createdAt: string;
}

interface ConversationRow {
  id: number;
  title: string;
  project_id: number | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Conversations with Core Intelligence. A turn runs server-side, independent
 * of the client connection: if the iPad drops off Wi-Fi mid-answer, the turn
 * still completes and is there when the app reconnects.
 */
export class ConversationService {
  private active = new Map<number, { runId: string; abort: AbortController }>();

  constructor(
    private ctx: Ctx,
    private runner: AgentRunner,
  ) {
    ctx.approvals.onDecision((a) => {
      if (!a.conversationId || !a.runId) return;
      const run = this.runner.getRun(a.runId);
      if (!run || run.status !== 'awaiting_approval') return;
      const stillPending = this.ctx.approvals.list('pending').some((p) => p.runId === a.runId);
      if (!stillPending) void this.continueRun(a.conversationId, a.runId);
    });
  }

  create(title = 'New conversation', projectId: number | null = null) {
    const now = nowIso();
    const { lastInsertRowid } = this.ctx.db.run(
      'INSERT INTO conversations(title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      title.slice(0, 120),
      projectId,
      now,
      now,
    );
    return this.get(lastInsertRowid)!;
  }

  get(id: number) {
    const r = this.ctx.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
    if (!r) return null;
    return { id: r.id, title: r.title, projectId: r.project_id, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at, busy: this.active.has(r.id) };
  }

  list(limit = 100) {
    return this.ctx.db
      .all<ConversationRow>('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?', limit)
      .map((r) => ({ id: r.id, title: r.title, projectId: r.project_id, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at, busy: this.active.has(r.id) }));
  }

  rename(id: number, title: string) {
    this.ctx.db.run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', title.slice(0, 120), nowIso(), id);
  }

  setProject(id: number, projectId: number | null) {
    this.ctx.db.run('UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?', projectId, nowIso(), id);
  }

  delete(id: number) {
    this.cancel(id);
    this.ctx.db.tx(() => {
      this.ctx.db.run("DELETE FROM transcripts WHERE owner_kind = 'conversation' AND owner_id = ?", id);
      this.ctx.db.run("DELETE FROM runs WHERE owner_kind = 'conversation' AND owner_id = ?", id);
      this.ctx.db.run('DELETE FROM conversations WHERE id = ?', id);
    });
  }

  messages(id: number): DisplayMessage[] {
    const rows = this.ctx.db.all<{ id: number; role: string; content: string; turn_id: string | null; hidden: number; created_at: string }>(
      "SELECT id, role, content, turn_id, hidden, created_at FROM transcripts WHERE owner_kind = 'conversation' AND owner_id = ? ORDER BY id",
      id,
    );
    const out: DisplayMessage[] = [];
    for (const r of rows) {
      if (r.hidden) continue;
      const content = parseJson<unknown>(r.content, []);
      if (r.role === 'notice') {
        out.push({ id: r.id, role: 'notice', text: typeof content === 'string' ? content : String((content as { text?: string }).text ?? ''), thinking: null, tools: [], turnId: r.turn_id, createdAt: r.created_at });
        continue;
      }
      const blocks = Array.isArray(content) ? (content as { type: string; text?: string; thinking?: string; name?: string; input?: unknown }[]) : [{ type: 'text', text: String(content) }];
      if (r.role === 'user') {
        const own = blocks.filter((b) => b.type === 'text' && !String(b.text).startsWith('<context')).map((b) => b.text).join('\n');
        out.push({ id: r.id, role: 'user', text: own, thinking: null, tools: [], turnId: r.turn_id, createdAt: r.created_at });
      } else {
        out.push({
          id: r.id,
          role: 'assistant',
          text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
          thinking: blocks.filter((b) => b.type === 'thinking' && b.thinking).map((b) => b.thinking).join('\n') || null,
          tools: blocks.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use').map((b) => ({ name: b.name ?? 'tool', input: b.input })),
          turnId: r.turn_id,
          createdAt: r.created_at,
        });
      }
    }
    return out;
  }

  notice(conversationId: number, text: string) {
    this.runner.append({ kind: 'conversation', id: conversationId }, 'notice', text, null);
    this.ctx.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', nowIso(), conversationId);
  }

  isBusy(id: number) {
    return this.active.has(id);
  }

  /** Starts a turn; returns immediately. Progress streams over the event bus. */
  send(conversationId: number, text: string): { turnId: string } {
    const conv = this.get(conversationId);
    if (!conv) throw new Error('Conversation not found');
    if (this.active.has(conversationId)) throw Object.assign(new Error('A response is already in progress for this conversation.'), { statusCode: 409 });
    if (!this.ctx.ai.isReady()) throw new ProviderNotConfiguredError();

    const owner: RunOwner = { kind: 'conversation', id: conversationId };
    // A new message supersedes any action still waiting for approval in this conversation.
    for (const a of this.ctx.approvals.list('pending')) {
      if (a.conversationId === conversationId && a.runId) this.ctx.approvals.expireFor({ runId: a.runId });
    }
    this.runner.closeDangling(owner, 'Not executed: superseded by a newer message from the owner.');

    const context = this.buildContext(conversationId, text, conv.projectId);
    const blocks: { type: 'text'; text: string }[] = [];
    if (context) blocks.push({ type: 'text', text: context });
    blocks.push({ type: 'text', text });
    const runId = this.runner.createRun(owner, 'core');
    this.runner.append(owner, 'user', blocks, runId);
    if (conv.title === 'New conversation') this.rename(conversationId, text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation');
    this.ctx.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', nowIso(), conversationId);
    void this.continueRun(conversationId, runId);
    return { turnId: runId };
  }

  cancel(conversationId: number): boolean {
    const a = this.active.get(conversationId);
    if (!a) return false;
    a.abort.abort();
    return true;
  }

  private buildContext(conversationId: number, text: string, projectId: number | null): string {
    const parts: string[] = [];
    const project = projectId ? this.ctx.projects.get(projectId) : null;
    parts.push(
      `<context note="System-provided context for this turn.">\nCurrent server time: ${new Date().toISOString()}\n${project ? `Project in focus: #${project.id} ${project.name} (${project.sourceKind})` : 'No project in focus.'}\nAI connected: yes. Desktop bridge: ${this.ctx.bridge.connectedCount() > 0 ? 'connected' : 'not connected'}. Gmail: ${this.ctx.gmail.isConnected() ? 'connected' : 'not connected'}.\n</context>`,
    );
    const mem = this.ctx.memory.contextFor(text, projectId);
    if (mem.block) parts.push(mem.block);
    const lastUser = this.ctx.db.get<{ created_at: string }>(
      "SELECT created_at FROM transcripts WHERE owner_kind = 'conversation' AND owner_id = ? AND role = 'user' AND hidden = 0 ORDER BY id DESC LIMIT 1",
      conversationId,
    );
    const updates = this.ctx.db.all<{ id: number; title: string; status: string; agent: string; report: string | null; error: string | null }>(
      'SELECT id, title, status, agent, report, error FROM tasks WHERE conversation_id = ? AND finished_at IS NOT NULL AND finished_at > ? ORDER BY id',
      conversationId,
      lastUser?.created_at ?? '1970',
    );
    if (updates.length) {
      parts.push(
        `<mission_updates note="Missions delegated from this conversation that finished since the owner's last message. Summarise faithfully.">\n${updates
          .map((u) => `Mission #${u.id} (${u.agent}) "${u.title}" — ${u.status}.\n${(u.report ?? u.error ?? '').slice(0, 3000)}`)
          .join('\n\n')}\n</mission_updates>`,
      );
    }
    return parts.join('\n');
  }

  private async continueRun(conversationId: number, runId: string) {
    if (this.active.has(conversationId)) return;
    const abort = new AbortController();
    this.active.set(conversationId, { runId, abort });
    const bus = this.ctx.bus;
    this.ctx.agents.setStatus('core', 'working', null);
    try {
      const outcome = await this.runner.execute(runId, {
        signal: abort.signal,
        projectId: this.get(conversationId)?.projectId ?? null,
        hooks: {
          onText: (text) => bus.emit({ type: 'chat.delta', conversationId, turnId: runId, text }),
          onThinking: (text) => bus.emit({ type: 'chat.thinking', conversationId, turnId: runId, text }),
          onTool: (tool, status, summary) => bus.emit({ type: 'chat.tool', conversationId, turnId: runId, tool, status, summary }),
          onActivity: (kind, label) => bus.emit({ type: 'activity', agent: 'core', kind, label, conversationId }),
        },
      });
      if (outcome.status === 'refused') this.notice(conversationId, outcome.text);
      if (outcome.status === 'error') this.notice(conversationId, `Error: ${outcome.error}`);
      if (outcome.status === 'cancelled') this.notice(conversationId, 'Response cancelled.');
      bus.emit({
        type: 'chat.done',
        conversationId,
        turnId: runId,
        status: outcome.status === 'refused' ? 'completed' : outcome.status === 'awaiting_approval' ? 'awaiting_approval' : outcome.status,
        error: outcome.status === 'error' ? outcome.error : undefined,
      });
      bus.emit({ type: 'activity', agent: 'core', kind: outcome.status === 'error' ? 'error' : 'idle', label: outcome.status === 'error' ? outcome.error : undefined, conversationId });
    } finally {
      this.active.delete(conversationId);
      this.ctx.agents.setStatus('core', 'idle', null);
      this.ctx.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', nowIso(), conversationId);
    }
  }

  /** Summarises a conversation into long-term memory (category: conversation). */
  async summarizeToMemory(conversationId: number) {
    const conv = this.get(conversationId);
    if (!conv) throw new Error('Conversation not found');
    const transcript = this.messages(conversationId)
      .filter((m) => m.role !== 'notice')
      .map((m) => `${m.role === 'user' ? 'Owner' : 'Assistant'}: ${m.text}`)
      .join('\n')
      .slice(-60_000);
    if (!transcript.trim()) throw new Error('Nothing to summarise yet.');
    const result = await this.ctx.ai.turn({
      system: 'You write compact, factual memory notes. Output only the note.',
      messages: [
        {
          role: 'user',
          content: `Summarise this conversation as a long-term memory note (max 180 words): decisions made, facts about the owner's projects and preferences, open threads. Omit pleasantries. Never include credentials.\n\n<transcript>\n${transcript}\n</transcript>`,
        },
      ],
      tools: [],
      effort: 'low',
      maxTokens: 4000,
    });
    if (result.stopReason === 'refusal' || !result.text.trim()) throw new Error('The model did not produce a summary.');
    this.ctx.db.run('UPDATE conversations SET summary = ? WHERE id = ?', result.text.trim(), conversationId);
    return this.ctx.memory.create({ category: 'conversation', title: `Conversation: ${conv.title}`, content: result.text.trim(), projectId: conv.projectId, source: `conversation:${conversationId}` });
  }
}
