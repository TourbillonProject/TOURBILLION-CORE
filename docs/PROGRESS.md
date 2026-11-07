# Progress, feature checklist and known limitations

Legend: ✅ implemented and tested here · 🟡 implemented, verified only partially here (reason given) · ⬜ not done

## Phases

| Phase | Status | Notes |
|---|---|---|
| 1 Foundation | ✅ | Monorepo, server, auth, PWA shell, navigation (12 sections), Command Center |
| 2 Visual core | ✅ | Three.js organism, 7 states, adaptive resolution, automatic + manual 2D fallback, static mode |
| 3 Claude intelligence | 🟡 | Fully built and tested against a protocol double; needs your API key for a genuine response |
| 4 Agent network | ✅ | Six agents, orchestrated missions, delegation, The Spider |
| 5 Browser and research | 🟡 | Reader + live Chromium + YouTube player + OSINT tested with local fixtures; public sites unreachable from the build environment |
| 6 Application integrations | 🟡 | Blender (real), Roblox file ops and tasks, bridge, Gmail against an API double; real Google account and Roblox Studio not available here |
| 7 Voice and audio | 🟡 | Implemented; tested with simulated speech APIs; real Safari dictation and voices need the iPad |
| 8 Autonomous execution | ✅ | Planning, approvals, monitoring, verification, cancellation, recovery, audit |
| 9 Testing and optimisation | 🟡 | 56 server + 7 unit + 13 e2e tests; Safari/WebKit and real iPad performance not measurable here |
| 10 Delivery | ✅ | Source, docs, setup, environment, security, testing report, this checklist |

## Feature checklist

### Command Center
- ✅ Central 3D core with state reactions (listening, thinking, researching, executing, speaking, error, idle)
- ✅ Voice activation control (push-to-talk, interruptible speech) and text command input
- ✅ Agent activity, system status, active missions, research activity, connected apps, notifications, execution history
- ✅ Collapsible navigation; every navigation element works (e2e)
- ✅ Approval dock visible in every section

### Intelligence
- ✅ Secure key connection: connect, test, status, masked preview, disconnect, invalid/expired key errors
- ✅ Streaming conversations with reasoning summaries, tool chips, inline approvals, cancel
- ✅ Context: time, project focus, memories, finished missions; append-only history
- ✅ Refusal handling and server-side fallback; typed API error messages
- ✅ Provider abstraction
- 🟡 Genuine Claude responses — needs your key

### Memory
- ✅ 8 categories, FTS5 search, project scope, create/edit/delete/bulk delete, conversation summaries to memory, credential refusal, export

### Agents and missions
- ✅ Core Intelligence, The Spider, Research, Development Engineer, System Operator, Creative Intelligence
- ✅ Missions with request, interpretation, plan, permissions, agent, status, steps, verification, report
- ✅ States: pending, planning, awaiting approval, running, completed, failed, cancelled; cancel; retry; restart recovery
- ✅ Playbooks: Spider inspection, OSINT report, diagnostics, service health, inbox digest, Blender preview
- ✅ Automations (interval/daily) that create normal missions

### The Spider
- ✅ Project import: zip upload, git URL, server folder (allowlisted)
- ✅ Structure map, dependency audit (OSV / npm audit), static security scan with visible suppressions
- ✅ Approval-gated tests/checks with results; patches with diff, apply, conflict detection, revert
- ✅ Spider console: current task, live file stream, progress, issues, changes, tests, history

### Browser and YouTube
- ✅ Tabs, address bar (URL or search), back/forward/reload, history, open in Safari, AI summary
- ✅ Reader mode (redirects, sanitised article, in-app links)
- ✅ Live remote Chromium (frames, tap, scroll, keyboard, popups as tabs, SSRF policy)
- 🟡 YouTube: official player with real state + blocked-embed fallback verified with a stand-in API; youtube.com itself unreachable here
- ✅ YouTube search via Data API (if key) or the live browser

### Research / OSINT
- ✅ DNS, RDAP, CT logs, Wayback, tech stack, reverse DNS, GitHub, NVD + CISA KEV, OSV, Wikipedia
- ✅ Scope + authorisation confirmation; classification; sources; timestamps; timeline; Markdown export
- ✅ Agent-driven research with `record_finding`; optional Claude synthesis labelled as inference
- ✅ Web search via SearXNG or Brave; optional Anthropic web search (billed, opt-in)

### Integrations
- ✅ Integration manager with state, permissions, last success, last error, test, disconnect
- 🟡 Gmail (OAuth + PKCE, search, read, draft, labels, approval-gated send) — verified against an API double
- ✅ Desktop bridge: pairing, revocation, outbound connection, local allowlist
- ✅ Blender (real Blender 5.2.3 in tests): scene info, approved scripts, renders
- 🟡 Roblox Studio: Rojo project files, backups, named tasks — Studio itself not available on Linux
- ✅ GitHub, YouTube Data API, SearXNG, Brave connectors

### Voice and sound
- 🟡 Speech recognition and British-English speech, wake phrase, local intents, clarification for ambiguous commands — tested with simulated APIs
- ✅ Original synthesised sounds: startup, activation, listening, thinking, deployment, completion, warning, error, shutdown; volume and mute; silent-switch aware

### Security
- ✅ See [SECURITY.md](SECURITY.md); 16 dedicated tests

## Known limitations

1. **No genuine Claude output was observed during development** (no API key available in the build environment). Everything up to the wire protocol is tested.
2. **Safari/WebKit not tested.** iPad behaviour was emulated in Chromium. Real-device items: Web Audio unlock, speech recognition availability in Home-Screen mode (historically restricted on iOS — the app falls back to text with a message), the frame rate of the 3D core on the A12 (adaptive fallback exists).
3. **Voice** is push-to-talk; a web app cannot listen in the background or when the iPad is locked.
4. **Live browser video** has no audio and a low frame rate by design; real playback goes to the native YouTube player or Safari. Sites may treat the server's headless Chromium as a bot (captchas, consent walls).
5. **YouTube embeds** the owner disabled cannot be played in-app (handled with an Open-in-Safari fallback).
6. **Roblox Studio** has no automation API; the integration manages Rojo project files and named command-line tasks.
7. **Project tests** run with the server's privileges after approval; isolate the server for untrusted code.
8. **Docker image** written but not built in the development environment.
9. **Single owner** only; no multi-user accounts; no second factor (use Tailscale / Cloudflare Access).
10. **OSINT sources** have rate limits (crt.sh is slow and sometimes unavailable; NVD and GitHub limit unauthenticated use).

## Open tasks (next steps)

- Run the owner verification checklist in [TESTING.md](TESTING.md) on the iPad with a real API key.
- Build and publish the Docker image; add a CI workflow running the three test suites.
- Optional: MCP connector support (Anthropic `mcp_servers`) for additional services.
- Optional: cloud text-to-speech / speech-to-text provider for consistent voice quality across devices.
- Optional: per-project container sandbox for approved test runs.
- Optional: publish `tourbillion-bridge` to npm for one-line installation.
