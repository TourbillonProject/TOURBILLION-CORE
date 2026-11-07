import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
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
  TelemetrySample,
  GraphicsQuality,
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
  graphicsQuality: GraphicsQuality;
  soundCategories: SoundCategories;
  ambientSound: boolean;
  ambientVolume: number;
  bootSequence: boolean;
}

export interface SoundCategories {
  interface: boolean;
  notifications: boolean;
  missions: boolean;
  alerts: boolean;
  ai: boolean;
}

export interface TelemetryMeta {
  intervalMs: number;
  host: { platform: string; cpuModel: string; cores: number; node: string };
  capabilities: { network: boolean; eventLoop: boolean };
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
  /** Command for the Browser section; kept until the section mounts and consumes it. */
  browserCommand: (BrowserCommand & { nonce: number }) | null;
  /** Real server measurements (2 s samples, newest last). */
  telemetry: TelemetrySample[];
  telemetryMeta: TelemetryMeta | null;
  /** Round-trip time of the realtime link, measured with ping/pong (ms, newest last). */
  link: { latencyMs: number | null; history: number[] };
  /** performance.now() when the cinematic boot sequence started; null when not playing. */
  bootSeq: number | null;
  /** Time (Date.now()) of the latest mission completion — drives the core's success state. */
  successAt: number;
}

export type BrowserCommand = { kind: 'open_url'; url: string; mode?: 'auto' | 'live' | 'reader' } | { kind: 'open_youtube'; query?: string; videoId?: string };

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
  browserCommand: null,
  telemetry: [],
  telemetryMeta: null,
  link: { latencyMs: null, history: [] },
  bootSeq: null,
  successAt: 0,
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

/**
 * Selectors must return existing references (or primitives). Derive filtered
 * arrays in the component with useMemo — a selector that builds a new array
 * on every call makes React re-render forever.
 */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(initial));
}

const EMPTY: never[] = [];
export function emptyArray<T>(): T[] {
  return EMPTY as T[];
}

// ---- routing (hash based: #/section/param) ----------------------------------

export function navigate(section: SectionId, param: string | null = null) {
  const hash = `#/${section}${param ? `/${encodeURIComponent(param)}` : ''}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  const apply = () => setState({ section, sectionParam: param });
  // Section changes morph with a short View Transition where supported (not in performance mode or with reduced motion).
  const doc = typeof document === 'undefined' ? null : (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } });
  if (doc?.startViewTransition && section !== state.section && doc.documentElement.dataset.motion === 'full') {
    const root = doc.documentElement;
    try {
      // The transition name is only present while morphing (it would otherwise make .content a containing block).
      root.classList.add('vt');
      const vt = doc.startViewTransition(() => flushSync(apply));
      void vt.finished.finally(() => root.classList.remove('vt'));
      return;
    } catch {
      root.classList.remove('vt');
    }
  }
  apply();
}

export function readHash(valid: readonly string[]): { section: SectionId; param: string | null } {
  const m = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?$/);
  if (m && valid.includes(m[1])) return { section: m[1] as SectionId, param: m[2] ? decodeURIComponent(m[2]) : null };
  return { section: 'command', param: null };
}

// ---- helpers ------------------------------------------------------------------

let toastSeq = 0;
export function toast(level: NotificationRecord['level'], title: string, body = '', link: string | null = null) {
  const t = { id: -1, level, title, body, link, read: false, createdAt: new Date().toISOString(), toastId: ++toastSeq };
  setState((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((x) => x.toastId !== t.toastId) })), level === 'error' ? 8000 : 5000);
}

let commandSeq = 0;
/** Opens the Browser and hands it a command (works even before its code has loaded). */
export function sendBrowserCommand(cmd: BrowserCommand) {
  setState({ browserCommand: { ...cmd, nonce: ++commandSeq } });
  navigate('browser');
}

export function upsertTask(t: TaskRecord) {
  setState((s) => ({ tasks: { ...s.tasks, [t.id]: { ...t, steps: [] } } }));
}
