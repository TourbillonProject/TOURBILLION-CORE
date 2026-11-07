import type { AgentInfo, ApprovalRecord, IntegrationStatus, NotificationRecord, ServerEvent, SystemStatus, TaskRecord } from '@tc/shared';
import { TERMINAL_TASK_STATUSES } from '@tc/shared';
import { api } from './api';
import { getState, navigate, sendBrowserCommand, setState, toast, upsertTask } from './store';
import { sound } from '../audio/sound';

/**
 * Realtime link to the server. Reconnects with backoff, resynchronises full
 * state after every (re)connection so nothing is missed while the iPad was
 * asleep or off Wi-Fi, and turns events into store updates and sounds.
 */

let ws: WebSocket | null = null;
let retry = 0;
let timer: number | null = null;
let stopped = false;

export async function resync() {
  const [status, agents, tasks, approvals, notifications, integrations] = await Promise.all([
    api.get<SystemStatus>('/api/system/status'),
    api.get<AgentInfo[]>('/api/agents'),
    api.get<TaskRecord[]>('/api/missions?limit=60'),
    api.get<ApprovalRecord[]>('/api/approvals?status=pending'),
    api.get<NotificationRecord[]>('/api/notifications'),
    api.get<IntegrationStatus[]>('/api/integrations'),
  ]);
  const map: Record<number, TaskRecord> = {};
  for (const t of tasks) map[t.id] = t;
  setState({ status, agents, tasks: map, approvals, notifications, integrations });
}

export function connect() {
  stopped = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setState({ ws: 'connecting' });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    retry = 0;
    setState({ ws: 'live' });
    resync().catch(() => {});
  };
  sock.onmessage = (ev) => {
    try {
      handle(JSON.parse(String(ev.data)) as ServerEvent);
    } catch {
      /* ignore malformed */
    }
  };
  sock.onclose = (ev) => {
    ws = null;
    setState({ ws: 'offline' });
    if (ev.code === 4401) {
      window.dispatchEvent(new CustomEvent('tc:unauthenticated'));
      return;
    }
    if (stopped) return;
    const delay = Math.min(15_000, 800 * 2 ** retry++) + Math.random() * 400;
    if (!opened && retry === 1) sound.play('warning');
    timer = window.setTimeout(connect, delay);
  };
  sock.onerror = () => sock.close();
}

export function disconnect() {
  stopped = true;
  if (timer) clearTimeout(timer);
  ws?.close();
}

// Reconnect immediately when the iPad wakes or rejoins a network.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    setState({ online: true });
    retry = 0;
    connect();
  });
  window.addEventListener('offline', () => setState({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getState().auth.authenticated) {
      retry = 0;
      connect();
    }
  });
}

function handle(e: ServerEvent) {
  switch (e.type) {
    case 'activity':
      setState((s) => ({ activity: [...s.activity.filter((a) => Date.now() - a.at < 60_000).slice(-60), { agent: e.agent, kind: e.kind, label: e.label, taskId: e.taskId, at: Date.now() }] }));
      if (e.kind === 'error') sound.play('error');
      break;
    case 'agent.status':
      setState((s) => ({ agents: s.agents.map((a) => (a.id === e.agent ? { ...a, status: e.status, currentTaskId: e.taskId, lastActiveAt: new Date().toISOString() } : a)) }));
      break;
    case 'task.updated': {
      const prev = getState().tasks[e.task.id];
      upsertTask(e.task);
      if (!prev && e.task.status === 'pending') sound.play('deploy');
      if (prev && prev.status !== e.task.status && TERMINAL_TASK_STATUSES.includes(e.task.status)) {
        sound.play(e.task.status === 'completed' ? 'complete' : e.task.status === 'failed' ? 'error' : 'warning');
      }
      break;
    }
    case 'task.step':
      setState((s) => ({ taskSteps: { ...s.taskSteps, [e.taskId]: [...(s.taskSteps[e.taskId] ?? []), e.step].slice(-300) } }));
      break;
    case 'approval.created':
      setState((s) => ({ approvals: [e.approval, ...s.approvals.filter((a) => a.id !== e.approval.id)] }));
      sound.play('warning');
      break;
    case 'approval.updated':
      setState((s) => ({ approvals: e.approval.status === 'pending' ? s.approvals.map((a) => (a.id === e.approval.id ? e.approval : a)) : s.approvals.filter((a) => a.id !== e.approval.id) }));
      break;
    case 'chat.delta':
    case 'chat.thinking':
    case 'chat.tool':
    case 'chat.done': {
      setState((s) => {
        const cur = s.chat[e.conversationId];
        const base = cur && cur.turnId === e.turnId ? cur : { turnId: e.turnId, text: '', thinking: '', tools: [], done: false };
        const next = { ...base };
        if (e.type === 'chat.delta') next.text += e.text;
        if (e.type === 'chat.thinking') next.thinking += e.text;
        if (e.type === 'chat.tool') next.tools = [...next.tools, { tool: e.tool, status: e.status, summary: e.summary }];
        if (e.type === 'chat.done') next.done = true;
        return { chat: { ...s.chat, [e.conversationId]: next } };
      });
      if (e.type === 'chat.done') window.dispatchEvent(new CustomEvent('tc:chat-done', { detail: e }));
      break;
    }
    case 'notification':
      setState((s) => ({ notifications: [e.notification, ...s.notifications].slice(0, 100) }));
      if (e.notification.level !== 'warning') toast(e.notification.level, e.notification.title, e.notification.body);
      break;
    case 'integration.updated':
      setState((s) => ({ integrations: s.integrations.some((i) => i.id === e.integration.id) ? s.integrations.map((i) => (i.id === e.integration.id ? e.integration : i)) : [...s.integrations, e.integration] }));
      break;
    case 'system.status':
      setState({ status: e.status });
      break;
    case 'spider.file':
      setState((s) => ({ spiderFiles: { ...s.spiderFiles, [e.taskId]: [...(s.spiderFiles[e.taskId] ?? []), e.path].slice(-40) } }));
      break;
    case 'ui.command':
      if (e.command.kind === 'navigate') navigate(e.command.section);
      else if (e.command.kind === 'open_url') sendBrowserCommand({ kind: 'open_url', url: e.command.url, mode: e.command.mode });
      else sendBrowserCommand({ kind: 'open_youtube', query: e.command.query, videoId: e.command.videoId });
      break;
    case 'hello':
      break;
  }
}
