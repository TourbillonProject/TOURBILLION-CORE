import { useSyncExternalStore } from 'react';
import type {
  ActivityKind,
  AgentId,
  AgentInfo,
  ApprovalRecord,
  IntegrationStatus,
  NotificationRecord,
  SectionId,
  SystemStatus,
  TaskRecord,
  TaskStep,
} from '@tc/shared';

/**
 * Minimal global store (useSyncExternalStore). Holds the live mirror of
 * server state fed by the WebSocket, plus local UI state.
 */

export interface Settings {
  ownerName: string;
  aiModel: string;
  aiEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  aiWebSearch: boolean;
  autoApproveWrites: boolean;
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

export interface ActivityEntry {
  agent: AgentId;
  kind: ActivityKind;
  label?: string;
  taskId?: number | null;
  at: number;
}

export interface ChatStream {
  turnId: string;
  text: string;
  thinking: string;
  tools: { tool: string; status: string; summary?: string }[];
  done: boolean;
}

export interface State {
  auth: { checked: boolean; setupRequired: boolean; authenticated: boolean };
  ws: 'connecting' | 'live' | 'offline';
  online: boolean;
  section: SectionId;
  sectionParam: string | null;
  navOpen: boolean;
  settings: Settings | null;
  status: SystemStatus | null;
  agents: AgentInfo[];
  tasks: Record<number, TaskRecord>;
  taskSteps: Record<number, TaskStep[]>;
  approvals: ApprovalRecord[];
  notifications: NotificationRecord[];
  toasts: (NotificationRecord & { toastId: number })[];
  integrations: IntegrationStatus[];
  activity: ActivityEntry[];
  chat: Record<number, ChatStream>;
  spiderFiles: Record<number, string[]>;
  voice: { listening: boolean; speaking: boolean; interim: string; level: number };
  booted: boolean;
  reply: { text: string; from: 'core' | 'system'; at: number; conversationId: number | null; pending: boolean } | null;
  commandConversationId: number | null;
}

const initial: State = {
  auth: { checked: false, setupRequired: false, authenticated: false },
  ws: 'connecting',
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  section: 'command',
  sectionParam: null,
  navOpen: false,
  settings: null,
  status: null,
  agents: [],
  tasks: {},
  taskSteps: {},
  approvals: [],
  notifications: [],
  toasts: [],
  integrations: [],
  activity: [],
  chat: {},
  spiderFiles: {},
  voice: { listening: false, speaking: false, interim: '', level: 0 },
  booted: false,
  reply: null,
  commandConversationId: null,
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(initial));
}

// ---- routing (hash based: #/section/param) ----------------------------------

export function navigate(section: SectionId, param: string | null = null) {
  const hash = `#/${section}${param ? `/${encodeURIComponent(param)}` : ''}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  setState({ section, sectionParam: param });
}

export function readHash(valid: readonly string[]): { section: SectionId; param: string | null } {
  const m = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?$/);
  if (m && valid.includes(m[1])) return { section: m[1] as SectionId, param: m[2] ? decodeURIComponent(m[2]) : null };
  return { section: 'command', param: null };
}

// ---- helpers ------------------------------------------------------------------

let toastSeq = 0;
export function toast(level: NotificationRecord['level'], title: string, body = '') {
  const t = { id: -1, level, title, body, link: null, read: false, createdAt: new Date().toISOString(), toastId: ++toastSeq };
  setState((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((x) => x.toastId !== t.toastId) })), level === 'error' ? 8000 : 5000);
}

export function upsertTask(t: TaskRecord) {
  setState((s) => ({ tasks: { ...s.tasks, [t.id]: { ...t, steps: [] } } }));
}
