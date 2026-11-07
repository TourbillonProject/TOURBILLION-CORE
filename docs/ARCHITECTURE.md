# Architecture

## Overview

```
┌──────────────────────── iPad (Safari / PWA) ────────────────────────┐
│ React 19 + TypeScript · Three.js core (lazy) · Web Speech · Web Audio│
│ Store mirrors server state; every action is an authenticated HTTP call│
└───────────────┬──────────────────────────────┬───────────────────────┘
                │ HTTPS (REST)                 │ WSS: /api/ws (events), /api/browser/live/ws/:tab (JPEG frames + input)
┌───────────────▼──────────────────────────────▼───────────────────────┐
│ Fastify server (Node 22)                                             │
│  security: auth/sessions · CSRF header · CSP · rate limits · SSRF    │
│  AIService ──▶ AnthropicProvider (official SDK, streaming)           │
│  ConversationService ─┐                                              │
│  TaskEngine ──────────┼─▶ AgentRunner (persistent tool loop)         │
│  (missions/playbooks) │      └─▶ ToolRegistry ─▶ permission gate ─▶ ApprovalService
│  Memory (FTS5) · Projects/Patches/Analyzers (Spider) · Research/OSINT│
│  BrowserService (reader + LiveBrowser/Playwright) · Gmail · BridgeHub│
│  Automations · Notifications · AuditLog · IntegrationRegistry        │
│  SQLite (node:sqlite, WAL) · AES-256-GCM secret store                │
└───────────────▲──────────────────────────────────────────────────────┘
                │ outbound WSS (token)
┌───────────────┴──────────── desktop bridge (Mac/PC) ─────────────────┐
│ fixed operations · local allowlist · Blender -b · Rojo files · tasks │
└──────────────────────────────────────────────────────────────────────┘
```

## Directory structure

```
shared/src/index.ts        Types shared by server, web and bridge (agents, missions, events, protocol)
server/
  src/main.ts              Entry point (prints the first-run setup code)
  src/app.ts               Wires every service and route; used by main and by tests
  src/config.ts            Environment configuration
  src/db.ts                node:sqlite wrapper + append-only migrations
  src/security/            auth (owner, sessions), crypto (scrypt, AES-GCM), secrets, net (SSRF-guarded fetch)
  src/services/            event bus, audit log, settings, notifications, integration registry
  src/ai/                  provider interface, Anthropic provider, AIService
  src/agents/              agent definitions & prompts, permission gate, AgentRunner (tool loop)
  src/tools/               tool registry and every tool (memory, system, web, OSINT, Spider, Gmail, bridge)
  src/tasks/               mission engine, approvals, deterministic playbooks
  src/intelligence/        conversations with Core Intelligence
  src/memory/              long-term memory with FTS5 and credential refusal
  src/spider/              projects (upload/git/local), analysers, patches
  src/browser/             reader mode, live remote Chromium, YouTube helpers
  src/research/            OSINT modules and reports
  src/integrations/        Gmail (OAuth + REST), desktop bridge hub
  src/automations/         scheduled missions
  src/routes/              HTTP routes (auth, system, intelligence, workspace)
  src/ws.ts                authenticated event WebSocket with Origin check
  test/                    55+ integration tests, Messages-API double, fixtures
web/
  src/App.tsx              shell: auth, navigation, top bar, boot sequence
  src/core/                Three.js core, 2D fallback, state parameters, state derivation
  src/sections/            Command Center, Intelligence, Agents, Spider, Browser, Research, Projects,
                           Missions, Automations, Connected Apps, Memory, Settings
  src/components/          UI kit, safe Markdown, approvals, command bar, icons
  src/lib/                 API client, store, realtime events, command intents
  src/voice/ · src/audio/  speech recognition/synthesis; synthesised sound engine
  public/                  manifest, service worker, icons
  e2e/                     Playwright iPad suite and harness
bridge/
  src/cli.ts · client.ts   pairing, connection, dispatch
  src/ops.ts               Blender / Roblox / file operations with path confinement
  test/blender-shim.py     test-only `blender` CLI over the bpy module
docs/                      setup, environment, architecture, security, testing, decisions, progress
```

## Key flows

### A conversational turn
1. `POST /api/conversations/:id/messages` → `ConversationService.send` appends the owner's message (with a `<context>` block: time, project focus, retrieved memories, finished mission results) and starts a run. It returns immediately.
2. `AgentRunner.execute` loads the transcript, streams a turn from Claude, forwards text/thinking deltas as events, appends the assistant content **unchanged** (thinking blocks included).
3. Tool calls go through the permission gate. Read tools run; low-risk writes run if auto-approved; sensitive tools create an approval and the run pauses with its state persisted.
4. When the owner decides (HTTP route), the run resumes exactly where it stopped. If the iPad disconnects, the turn still completes; the client resynchronises on reconnect.

### A mission
`pending → planning → [awaiting_approval] → running ⇄ awaiting_approval → completed | failed`, any non-terminal state → `cancelled`.
- **Agent missions**: Claude produces a plan with structured output (interpretation, steps, required permissions, success criteria). Plans with side effects wait for approval; approved write-level tools are pre-approved, sensitive ones still ask per call. After execution the agent verifies its work against the criteria (structured verdict) — the verdict, evidence and unverified items are stored.
- **Playbooks**: deterministic pipelines (Spider inspection, OSINT report, diagnostics, health checks, inbox digest, Blender preview) that use the same tools, gate and audit, and work without an AI key; Claude adds synthesis when connected.
- On restart, in-flight missions are marked interrupted (retry available); missions waiting for approval stay resumable.

### Live browser
The server runs Chromium via Playwright. A viewer socket starts a CDP screencast (JPEG frames sized to the iPad viewport). Taps, drags and keys come back over the same socket. Every request from the page is checked by the SSRF guard. Popups become tabs; idle tabs are reclaimed.

## Data model (SQLite)

`owner`, `sessions`, `audit_log`, `settings`, `secrets` (encrypted), `notifications`, `integrations`, `projects`, `conversations`, `transcripts` (append-only provider messages), `runs` (loop state, pending tool calls, token usage), `memories` + `memories_fts`, `tasks`, `task_steps`, `approvals`, `artifacts` (reports, test runs, renders, findings), `patches`, `bridges`, `bridge_pairings`, `oauth_states`, `automations`, `browse_history`.

## Dependencies and why

| Package | Purpose |
|---|---|
| `fastify` + `@fastify/{cookie,rate-limit,websocket,multipart,static}` | HTTP server, sessions, rate limiting, WebSockets, zip uploads, serving the PWA |
| `@anthropic-ai/sdk` | Official Claude client (streaming, typed errors, beta features) |
| `zod` | Input validation for every route and tool (and JSON Schema for Claude tools) |
| `@mozilla/readability` + `linkedom` | Reader-mode article extraction without a full DOM implementation |
| `fflate` | Zip extraction for uploaded projects (with zip-slip checks) |
| `diff` | Unified diffs for proposed patches |
| `ws` | WebSocket client for the desktop bridge |
| `playwright-core` (optional) | Drives Chromium for the live remote browser |
| `react`, `react-dom` | UI |
| `three` | 3D core (loaded lazily, split into its own chunk) |
| `dompurify` | Second sanitisation pass for reader-mode HTML in the browser |
| `@fontsource-variable/oxanium`, `…/jetbrains-mono` | Self-hosted fonts (work offline, no third-party requests) |
| Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `@playwright/test`, `esbuild`, `tsx` | Build and test |

Deliberately **not** used: LangGraph/LangChain (the mission engine is small and explicit), a separate database server (SQLite is enough for one owner), native SQLite addons (`node:sqlite` is built in), UI component kits.
