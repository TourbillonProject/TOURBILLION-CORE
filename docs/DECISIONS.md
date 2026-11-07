# Decision record

Each entry: decision — why — consequences.

### D1. Rebrand to TOURBILLION CORE
The project formerly known as NEXUS → JARVIS → KEENAN CORE is now **TOURBILLION CORE** (owner: Keenan). The tourbillon — a watch escapement mounted in a rotating cage — informs the visual identity (orbital cages around a core) and the sound palette (escapement-like ticks, bell tones). Default wake phrase "Tourbillion", with common speech-recognition variants ("tour billion", "tourbillon") accepted.

### D2. Server + PWA, not an iPad-only app
The iPad 8th generation cannot run Node.js, a headless browser, Blender or Roblox Studio. One server does the work; the iPad runs a PWA. The server runs anywhere you control (home server, Mac, VPS). Consequence: HTTPS hosting is required (see SETUP.md).

### D3. Fastify + TypeScript, single process
Small, fast, good validation, rate-limit and WebSocket plugins. One process keeps deployment trivial for a single owner. No microservices.

### D4. SQLite through Node's built-in `node:sqlite`
No database server to run and no native addon to compile on the host. FTS5 (BM25) powers memory search. Requires Node 22.13+. The module prints an "experimental" warning; it is loaded after a narrowly scoped warning filter.

### D5. Claude through the official SDK with a manual, persistent agent loop
The SDK's tool runner is the default for most agents, but here a run can pause for an owner approval for minutes or days and must survive restarts. The loop persists every message (append-only, thinking blocks replayed unchanged) and the pending tool calls, and resumes exactly. Streaming everywhere; adaptive thinking with *summarized* display (real reasoning progress, not a fake spinner); `fallbacks: "default"` for refusals; stable cached system prompt with volatile context in the user turn.

### D6. Default model `claude-opus-5-5`, effort `medium`
The current most capable default; effort is user-adjustable per the owner's cost preference. Anthropic server-side web search is off by default because it is billed per search.

### D7. Provider abstraction kept thin
`AIProvider` interface (`server/src/ai/types.ts`) with one implementation. Messages are stored in Anthropic's block format because replaying thinking blocks byte-for-byte matters; another provider would translate at its boundary.

### D8. Missions: two kinds, one lifecycle
*Agent missions* (Claude plans, executes, verifies) and *playbooks* (deterministic pipelines). Playbooks give real capability without an API key and make results reproducible; both share the permission gate, approvals, audit trail and cancellation. LangGraph was considered and not adopted: the state machine is small and explicit.

### D9. Three-level permission model
read / write / sensitive. Sensitive actions always need a fresh per-call approval; plan approval can pre-approve only write-level tools. This is the main defence against prompt injection, because it does not depend on the model behaving.

### D10. Browser: reader mode + live remote Chromium + native YouTube player
An `<iframe>` cannot show most sites (framing is blocked) and a rewriting proxy breaks modern sites. A real Chromium on the server streamed via the DevTools screencast gives genuine navigation (including youtube.com). Video in a JPEG stream has no audio and a low frame rate, so playback is handed to the iPad's own player via YouTube's official IFrame Player API, which reports real state; blocked embeds fall back to Safari.

### D11. Plain Three.js instead of React Three Fiber
Direct control over the render loop, adaptive resolution, frame capping, pausing when hidden and context-loss handling, with fewer dependencies. Three.js is code-split and loaded only when the Command Center needs it. Glow is faked with additive fresnel shaders — no post-processing on an A12 GPU.

### D12. Original, synthesised sound
All sounds are generated live with Web Audio (FM bells, filtered-noise ticks, sine swells, a generated reverb). No third-party audio assets, so no licensing questions; tiny payload; respects the iPad silent switch.

### D13. Web Speech API for voice
Safari's speech recognition (Siri dictation) and speech synthesis need no extra service or key. Limitations accepted: push-to-talk rather than always-on listening; quality depends on installed voices. A cloud speech provider can be added later behind the same `voice.ts` interface.

### D14. Desktop bridge that dials out, with a local allowlist
No inbound ports on the owner's computer; fixed operations only; the local config decides folders, whether Blender scripts may run, and which named tasks exist. Roblox Studio is integrated through project files with Rojo live-sync because Studio has no automation API.

### D15. OSINT: passive, public, classified
Only legitimate public sources, no scanning or authentication bypass, no person-targeted research (emails refused; RDAP personal contacts withheld). Every finding carries a classification, source URL and timestamp.

### D16. Single owner, setup code
The system has exactly one user. A one-time setup code on the server console prevents someone else from claiming a freshly deployed instance.

### D17. Test against doubles where the network is closed, real software where possible
The development environment could not reach public APIs and had no Anthropic key. Tests use protocol-accurate doubles for those, and real software for everything available (Chromium, Blender via bpy, npm, git). The testing report states exactly which is which.
