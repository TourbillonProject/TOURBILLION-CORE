/**
 * Types shared between the TOURBILLION CORE server, web client and desktop bridge.
 * Keep this file dependency-free: it is imported by all three packages.
 */

export const SYSTEM_NAME = 'TOURBILLION CORE';
export const OWNER_NAME_DEFAULT = 'Keenan';

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

// Order defines the agent numbers (01–07) and their positions around the core.
export const AGENT_IDS = ['core', 'spider', 'research', 'developer', 'creative', 'security', 'operator'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentInfo {
  id: AgentId;
  code: string; // "AGENT 01"
  name: string;
  role: string;
  responsibilities: string[];
  tools: string[];
  status: AgentRuntimeStatus;
  currentTaskId: number | null;
  lastActiveAt: string | null;
}

export type AgentRuntimeStatus = 'idle' | 'planning' | 'working' | 'waiting' | 'error';

// ---------------------------------------------------------------------------
// Tasks / missions
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'pending',
  'planning',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

export type TaskKind = 'agent' | 'playbook';

export type Risk = 'read' | 'write' | 'sensitive';

export interface PlanStep {
  title: string;
  detail?: string;
  agent?: AgentId;
  tools?: string[];
  risk?: Risk;
}

export interface TaskPlan {
  interpretation: string;
  steps: PlanStep[];
  requiredPermissions: { tool: string; risk: Risk; reason: string }[];
  successCriteria: string[];
}

export interface TaskStep {
  at: string;
  kind: 'info' | 'tool' | 'tool_result' | 'approval' | 'error' | 'model' | 'verification';
  message: string;
  data?: unknown;
}

export interface TaskVerification {
  outcome: 'succeeded' | 'partial' | 'failed' | 'unverified';
  summary: string;
  evidence: string[];
  unverified: string[];
}

export interface TaskRecord {
  id: number;
  title: string;
  kind: TaskKind;
  playbook: string | null;
  request: string;
  agent: AgentId;
  status: TaskStatus;
  interpretation: string | null;
  plan: TaskPlan | null;
  steps: TaskStep[];
  verification: TaskVerification | null;
  report: string | null;
  error: string | null;
  projectId: number | null;
  conversationId: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRecord {
  id: number;
  taskId: number | null;
  conversationId: number | null;
  tool: string;
  risk: Risk;
  summary: string;
  input: unknown;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MEMORY_CATEGORIES = [
  'preference',
  'project',
  'conversation',
  'mission',
  'documentation',
  'decision',
  'tool_usage',
  'lesson',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: 'User preferences',
  project: 'Project information',
  conversation: 'Previous conversations',
  mission: 'Active missions',
  documentation: 'Technical documentation',
  decision: 'Important decisions',
  tool_usage: 'Tool usage history',
  lesson: 'Lessons learned',
};

export interface MemoryRecord {
  id: number;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  projectId: number | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Research / OSINT
// ---------------------------------------------------------------------------

export type FindingClass = 'verified_fact' | 'source_reported' | 'inference' | 'unverified';

export const FINDING_CLASS_LABELS: Record<FindingClass, string> = {
  verified_fact: 'Verified fact',
  source_reported: 'Source-reported claim',
  inference: 'Inference',
  unverified: 'Unverified',
};

export interface Finding {
  module: string;
  title: string;
  detail: string;
  classification: FindingClass;
  sourceUrl: string | null;
  collectedAt: string;
  data?: unknown;
  /** ISO date of the event the finding describes (for timelines), when known. */
  eventDate?: string | null;
}

export type ResearchTargetType = 'domain' | 'ip' | 'url' | 'github_repo' | 'cve' | 'package' | 'organization' | 'topic';

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export type IntegrationState = 'not_configured' | 'configured' | 'connected' | 'error' | 'disconnected';

export interface IntegrationStatus {
  id: string;
  name: string;
  description: string;
  state: IntegrationState;
  permissions: string[];
  lastSuccessAt: string | null;
  lastError: string | null;
  details: Record<string, unknown>;
  requires: string[];
  canConnect: boolean;
  canDisconnect: boolean;
}

// ---------------------------------------------------------------------------
// Desktop bridge protocol (server <-> desktop computer)
// ---------------------------------------------------------------------------

export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeOp =
  | 'hello'
  | 'fs.list'
  | 'fs.read'
  | 'fs.write'
  | 'blender.version'
  | 'blender.scene_info'
  | 'blender.run_script'
  | 'blender.render'
  | 'roblox.list'
  | 'roblox.read'
  | 'roblox.write'
  | 'roblox.run_task';

export interface BridgeRequest {
  type: 'request';
  id: string;
  op: BridgeOp;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BridgeHello {
  type: 'hello';
  protocol: number;
  bridgeVersion: string;
  hostname: string;
  platform: string;
  capabilities: {
    fs: { roots: string[] };
    blender: { available: boolean; version: string | null; scriptsAllowed: boolean };
    roblox: { available: boolean; projectDir: string | null; tasks: string[] };
  };
}

// ---------------------------------------------------------------------------
// Realtime events (server -> client over WebSocket)
// ---------------------------------------------------------------------------

export type ActivityKind = 'thinking' | 'responding' | 'tool' | 'research' | 'executing' | 'error' | 'idle';

export type ServerEvent =
  | { type: 'hello'; serverTime: string; version: string }
  | { type: 'activity'; agent: AgentId; kind: ActivityKind; label?: string; taskId?: number | null; conversationId?: number | null }
  | { type: 'agent.status'; agent: AgentId; status: AgentRuntimeStatus; taskId: number | null }
  | { type: 'task.updated'; task: TaskRecord }
  | { type: 'task.step'; taskId: number; step: TaskStep }
  | { type: 'approval.created'; approval: ApprovalRecord }
  | { type: 'approval.updated'; approval: ApprovalRecord }
  | { type: 'chat.delta'; conversationId: number; turnId: string; text: string }
  | { type: 'chat.thinking'; conversationId: number; turnId: string; text: string }
  | { type: 'chat.tool'; conversationId: number; turnId: string; tool: string; status: 'started' | 'finished' | 'awaiting_approval' | 'denied' | 'error'; summary?: string }
  | { type: 'chat.done'; conversationId: number; turnId: string; status: 'completed' | 'awaiting_approval' | 'cancelled' | 'error'; error?: string }
  | { type: 'notification'; notification: NotificationRecord }
  | { type: 'integration.updated'; integration: IntegrationStatus }
  | { type: 'ui.command'; command: UiCommand }
  | { type: 'spider.file'; taskId: number; path: string }
  | { type: 'system.status'; status: SystemStatus }
  | { type: 'telemetry'; sample: TelemetrySample };

export type UiCommand =
  | { kind: 'open_url'; url: string; mode?: 'auto' | 'live' | 'reader' }
  | { kind: 'open_youtube'; query?: string; videoId?: string }
  | { kind: 'navigate'; section: SectionId };

export interface NotificationRecord {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface SystemStatus {
  version: string;
  uptimeSec: number;
  ai: { provider: string; state: IntegrationState; model: string };
  browser: { engine: 'playwright' | 'reader-only'; available: boolean; detail: string };
  bridge: { connected: number };
  tasks: { active: number; awaitingApproval: number };
  memory: { count: number };
  db: { ok: boolean };
}

// ---------------------------------------------------------------------------
// Telemetry (real measurements from the server host; null = unavailable here)
// ---------------------------------------------------------------------------

export interface TelemetrySample {
  at: string;
  cpu: { percent: number | null; cores: number; load1: number | null };
  memory: { totalBytes: number; usedBytes: number; percent: number };
  process: { rssBytes: number; heapUsedBytes: number; eventLoopLagMs: number | null };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null; source: string | null };
  app: {
    httpRequestsPerMin: number;
    wsClients: number;
    eventsPerMin: number;
    aiTurnsPerMin: number;
    toolCallsPerMin: number;
    activeRuns: number;
  };
  storage: { dbBytes: number | null; memories: number };
}

export interface AIDiagnostics {
  provider: string;
  model: string;
  state: IntegrationState;
  effort: string;
  lastLatencyMs: number | null;
  lastFirstTokenMs: number | null;
  lastError: string | null;
  turnsSinceStart: number;
  errorsSinceStart: number;
  tokensToday: { input: number; output: number; cacheRead: number; webSearches: number };
  activeRuns: number;
  lastTurnAt: string | null;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export const SECTIONS = [
  'command',
  'intelligence',
  'agents',
  'spider',
  'browser',
  'research',
  'projects',
  'missions',
  'automations',
  'apps',
  'memory',
  'settings',
] as const;
export type SectionId = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<SectionId, string> = {
  command: 'Command Center',
  intelligence: 'Intelligence',
  agents: 'Agents',
  spider: 'The Spider',
  browser: 'Browser',
  research: 'Research / OSINT',
  projects: 'Projects',
  missions: 'Missions',
  automations: 'Automations',
  apps: 'Connected Apps',
  memory: 'Memory',
  settings: 'Settings',
};

// ---------------------------------------------------------------------------
// Core visual states (client)
// ---------------------------------------------------------------------------

export type CoreState = 'idle' | 'listening' | 'thinking' | 'researching' | 'executing' | 'speaking' | 'error' | 'success';

export type GraphicsQuality = 'cinematic' | 'balanced' | 'performance';
