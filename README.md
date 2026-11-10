# TOURBILLION CORE

A personal AI operating environment, operated from an iPad. One server runs the
intelligence, the agents, the browser and the integrations; the iPad runs a
Progressive Web App that is the command centre.

> Formerly NEXUS → JARVIS → KEENAN CORE. Owner: Keenan. Primary intelligence: Anthropic Claude.

## Quick start on a Mac

Download and unzip the project, then double-click **`Start TOURBILLION.command`**. It installs everything it needs on the first run, opens the app in your browser and copies the one-time setup code to the clipboard. Details: [docs/SETUP.md](docs/SETUP.md).

## What it does

| Area | What is real today |
|---|---|
| **Command Center** | Cinematic 3D AI core (Three.js) that reacts to genuine system events — idle, listening, thinking, researching, executing, speaking, error, success — with Cinematic / Balanced / Performance graphics and an automatic 2D fallback; live server telemetry (CPU, RAM, network, event loop) with charts, seven agent cards, mission control, network topology, agent communication, mission timeline, connected apps with diagnostics, notifications and execution history; a skippable boot sequence. |
| **Claude** | Official Anthropic SDK, streaming, adaptive thinking with visible reasoning summaries, server-side refusal fallback, prompt caching. API key stored encrypted on the server, never sent to the iPad. |
| **Agents** | Core Intelligence plus six specialists (The Spider, Research, Developer, Creative Operations, Security Intelligence, System Operator) coordinated through one mission engine: plan → approval → execute → verify → report, with cancellation, retries, restart recovery and a full audit trail. |
| **The Spider** | Inspects real code projects (zip upload, git clone, or server folder): structure, dependency vulnerabilities (OSV.dev / npm audit), static security leads, approval-gated test runs, reviewable patches with conflict detection and revert. |
| **Browser** | Reader mode (sanitised) and a **live remote Chromium** streamed to the iPad with touch, scroll and keyboard; tabs and history; AI page summaries; "Open in Safari" everywhere. |
| **YouTube** | `youtube.com` works in the live browser; videos play natively on the iPad via YouTube's official IFrame Player API, whose real state is shown; blocked embeds fall back to Safari / the YouTube app. |
| **Research / OSINT** | DNS, RDAP, Certificate Transparency, Wayback Machine, technology fingerprinting, GitHub, NVD + CISA KEV, OSV, Wikipedia. Every finding is classified (verified fact / source-reported / inference / unverified) with source URL and timestamp; timelines; Markdown export. |
| **Integrations** | Gmail (Google OAuth + PKCE; sending always needs approval), desktop bridge for **Blender** (background scripts, scene inspection, renders) and **Roblox Studio** projects (Rojo files, named tasks), GitHub, YouTube Data API, SearXNG / Brave search. |
| **Voice & sound** | Push-to-talk speech recognition, British-English speech with an interruptible voice, wake-phrase handling, instant local commands; an original sound identity synthesised live with Web Audio. |
| **Memory** | Searchable long-term memory (SQLite FTS5) across eight categories, project-scoped, retrieved before each turn; credentials are refused. |
| **Security** | Single owner with first-run setup code, scrypt, httpOnly sessions, CSRF header, CSP, rate limits, SSRF guard, path-traversal and zip-slip protection, encrypted secrets, approvals for every sensitive action, audit log, export and deletion. |

## Quick start (development)

Requirements: Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
npm run dev            # API on :8787 + Vite on :5173 (proxying /api)
```

The server prints a **first-run setup code** (also written to `data/setup-code.txt`).
Open http://localhost:5173, enter the code and choose a passphrase. Then open
**Connected Apps → Anthropic Claude** and paste an API key.

## Production

```bash
npm install
npm run build          # web PWA + server bundle + desktop bridge
npm start              # serves the PWA and API on TC_PORT (default 8787)
```

Put it behind HTTPS (required for the PWA, microphone and secure cookies) and
open it in Safari on the iPad → Share → **Add to Home Screen**. See
[docs/SETUP.md](docs/SETUP.md) for Docker, HTTPS options, Google OAuth, the
desktop bridge and every API key.

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — installation, deployment, API setup, iPad install, desktop bridge
- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — every environment variable
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design and directory structure
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and controls
- [docs/TESTING.md](docs/TESTING.md) — test report, acceptance criteria with evidence
- [docs/DECISIONS.md](docs/DECISIONS.md) — decision record
- [docs/PROGRESS.md](docs/PROGRESS.md) — phase status, feature checklist, known limitations, open tasks
- [bridge/README.md](bridge/README.md) — the desktop bridge

## Tests

```bash
npm test               # server integration tests + web unit tests
npm run test:e2e       # builds the PWA, then Playwright in iPad landscape + portrait
```

Set `TC_TEST_BPY_PYTHON` to a Python that has the `bpy` module to include the real-Blender test.
