import type { AgentId, AgentRuntimeStatus, TaskRecord, TaskStep } from '@tc/shared';
import { TERMINAL_TASK_STATUSES } from '@tc/shared';

/** What a click in the Command Center opens. */
export type SheetTarget =
  | { kind: 'ai' }
  | { kind: 'integration'; id: string }
  | { kind: 'mission'; id: number }
  | { kind: 'link' }
  | { kind: 'agent'; id: AgentId };

export type OpenSheet = (t: SheetTarget) => void;

/**
 * Mission progress from real data only. With a plan, the bar reflects tool
 * results against planned steps (capped below 100 % until the mission ends);
 * without one it is indeterminate rather than an invented percentage.
 */
export function missionProgress(t: TaskRecord, steps: TaskStep[]): { pct: number | null; label: string } {
  if (TERMINAL_TASK_STATUSES.includes(t.status)) return { pct: 100, label: t.status === 'completed' ? 'Completed' : t.status === 'failed' ? 'Failed' : 'Cancelled' };
  const planned = t.plan?.steps.length ?? 0;
  const results = steps.filter((s) => s.kind === 'tool_result').length;
  if (t.status === 'running' && planned > 0) return { pct: Math.min(95, Math.max(4, (results / planned) * 100)), label: `${results} tool result${results === 1 ? '' : 's'} · ${planned} planned step${planned === 1 ? '' : 's'}` };
  const phase: Record<string, string> = { pending: 'Queued', planning: 'Planning…', awaiting_approval: 'Waiting for your approval', running: results ? `Running · ${results} tool result${results === 1 ? '' : 's'}` : 'Running…' };
  return { pct: null, label: phase[t.status] ?? t.status };
}

export const AGENT_STATUS_LABEL: Record<AgentRuntimeStatus, string> = {
  idle: 'Idle',
  planning: 'Planning',
  working: 'Working',
  waiting: 'Awaiting approval',
  error: 'Error',
};

export function duration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso) return '—';
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export const rate = (bps: number | null) => (bps == null ? 'n/a' : bps < 1024 ? `${Math.round(bps)} B/s` : bps < 1024 ** 2 ? `${(bps / 1024).toFixed(1)} KB/s` : `${(bps / 1024 ** 2).toFixed(2)} MB/s`);
