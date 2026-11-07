# Testing report

Date of this report: 2026-11-07. All numbers below come from runs in the development environment (Linux container, Node 22.23, Chromium 1243 via Playwright 1.63). Re-run with the commands at the end.

## Summary

| Suite | Command | Result |
|---|---|---|
| Type checking (shared, server, web, bridge) | `npm run typecheck` | **pass** |
| Server integration tests (Vitest) | `npm test -w server` | **62 / 62 pass** (with `TC_TEST_BPY_PYTHON` set; 61 + 1 skipped without it) |
| Web unit tests (command intents) | `npm test -w web` | **7 / 7 pass** |
| End-to-end, iPad landscape + portrait (Playwright, Chromium) | `npm run test:e2e` | **17 / 17 pass** |
| Production build | `npm run build && npm start` | **pass** — PWA, deep links and API served; service worker served `no-cache` |
| Docker image | `docker build .` | **not run** — no Docker daemon in the development environment |

## What the environment could and could not reach

The development container's network policy blocks almost every public host (it allows package registries and the Anthropic API host, but there was **no Anthropic API key** available). Therefore:

- **Claude** was tested through the *official SDK* against a local Messages-API double that speaks the real SSE wire protocol (`server/test/fake-anthropic.ts`). This verifies request shape, streaming, thinking blocks, tool use, refusals, structured output and the full agent loop — but **not** genuine model responses. A real key is needed for that; see "Owner verification checklist" below.
- **Public data sources** (DNS-over-HTTPS, RDAP, crt.sh, Wayback, NVD, CISA KEV, OSV, GitHub, Wikipedia, YouTube, Google) were replaced by local fixture servers returning their real response formats. Parsing, classification, redaction and reporting are the production code paths.
- **Real software that was available and used:** Chromium (live remote browser, end-to-end tests), **Blender 5.2.3** via the official `bpy` module (bridge test, real Cycles render), Node/npm (Spider test execution, `npm audit` fallback), `git`.
- **Safari / WebKit was not available.** The UI was tested in Chromium with iPad (gen 7) device emulation: viewport, touch events, user agent, landscape and portrait. Code is compiled for a Safari 15 baseline, but nothing replaces a run on the actual iPad.

## Acceptance criteria and evidence

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Interface works on iPad Safari | **Partially verified** | All 12 sections exercised with touch in iPad landscape & portrait emulation (`e2e/app.spec.ts`: "every navigation section works", "@portrait layout … no horizontal scrolling"). Not run on Safari/WebKit. |
| 2 | PWA installable where supported | **Partially verified** | Manifest (standalone, icons 180/192/512/maskable) fetched and validated; service worker takes control; app shell loads **offline** after reload ("PWA: manifest, icons and an offline-capable app shell"). Add-to-Home-Screen on iPadOS not performed. |
| 3 | Core responds to real system states | **Verified** | State derives from real events (`useCoreState.ts`). E2E: microphone tap → `data-state="listening"`; 2D fallback switch → `data-engine="2d"`. Server events for thinking/research/executing/error are emitted by the agent loop (asserted in `intelligence.test.ts`: `chat.thinking`, `chat.delta`, activity events). |
| 4 | Claude returns genuine AI responses | **Not verified (no key)** | Integration verified against the protocol double: correct model, adaptive thinking, `fallbacks: "default"` + beta header, cached system prompt, eager tool streaming, refusal handling, key encryption and masking (`intelligence.test.ts`, 14 tests). Needs one real conversation with your key. |
| 5 | Memory retrieves relevant project context | **Verified** | A stored project memory is injected into the next turn's `<memory_context>` ("streams a reply … injects relevant memory"); Claude-initiated `memory_save` persists and is searchable; credentials refused (422). |
| 6 | Agents receive and coordinate tasks | **Verified** | Mission lifecycle plan → plan approval → tools → verification → completed; Core delegates to Research and the result flows back into the conversation and the next turn's context ("Core delegates to a specialist…"); cancellation expires approvals; restart marks in-flight missions interrupted. |
| 7 | The Spider inspects and tests a real code project | **Verified** | Fixture project: structure, OSV advisory (lodash → CVE-2021-23337, fixed 4.17.21), static leads with file:line (`eval` at `src/app.js:3`), approval-gated `npm test` actually executed (exit 0, "1 passing"); failing `lint` reported as *partial*; denied run never executes; patch apply/revert/conflict. **This repository** inspected end-to-end: 135 files, 18,136 lines, 231 dependencies; leads were reviewed (see below). E2E: zip uploaded from "Files" → Spider → issues table → mission view. |
| 8 | Browser navigation works | **Verified** | Reader mode follows redirects, extracts article, strips scripts, absolutises links; in-app link navigation and Back (e2e). Live remote Chromium: JPEG frames streamed, touch tap navigates to the next page, Back works (server test + e2e). SSRF policy blocks private targets in both modes. |
| 9 | YouTube reachable through a supported route | **Partially verified** | URL parsing (watch, youtu.be, shorts, results). Player integration verified with a stand-in for YouTube's IFrame API: privacy-enhanced host, real state shown ("Playing"), blocked embed (error 150) shown honestly with an "Open in Safari / YouTube app" link. YouTube results extraction verified on a page with YouTube's `ytInitialData` format in real Chromium. youtube.com itself was unreachable here. |
| 10 | OSINT reports include sources | **Verified (fixture data)** | Domain report: every finding has classification, source URL and timestamp; registry personal data withheld (registrar kept); timeline and Markdown export; CVE lookup with CVSS + CISA KEV; tech-stack separates observed headers (fact) from fingerprints (inference); emails and unauthorised investigations rejected (400). |
| 11 | Connected applications execute supported operations | **Verified (Blender, Roblox ops, bridge); verified against API double (Gmail)** | **Real Blender 5.2.3**: Creative Intelligence mission → plan approval → script approval (owner sees the exact script) → bridge runs Blender → `tourbillion.blend` saved with `TourbillonCage`, `Core`, `Camera`, `Sun` → preview playbook renders 480×270 with Cycles → PNG artifact. Roblox: list, write with backup, named task run, allowlist refusals. Gmail: OAuth code flow with PKCE and session-bound state, draft, **send only after approval**, denied send never reaches the API. |
| 12 | Voice interaction where permissions permit | **Verified with simulated speech APIs** | Fake `SpeechRecognition`/`speechSynthesis` injected: "Tourbillion, initiate system diagnostics." → mission created and the reply spoken with an en-GB voice (*Daniel*); "Tourbillion, open YouTube." → YouTube panel; greeting spoken at boot. Real Safari dictation must be checked on the iPad. |
| 13 | Approval controls prevent unauthorised sensitive actions | **Verified** | Sensitive tools pause until decided; denial is reported to the model and nothing runs (memory delete, project tests, email send, Blender script); only the owner-authenticated route can decide; CSRF header required; plan approval never pre-approves sensitive tools (`gateFor` unit test). |
| 14 | Records task results and errors | **Verified** | Every mission stores steps, verification (outcome, evidence, unverified), report, artifacts and token usage; audit log entries for logins, approvals, tool executions, integration and data operations are asserted in tests. |

## Security tests (`server/test/security.test.ts`, 16 tests)

Setup code required and single-use; passphrase length; CSRF header enforced; brute-force lockout after 5 failures; only hashes stored for passphrase and sessions; every owner route returns 401 without a session; strict CSP and hardening headers; data export excludes credentials; WebSocket from a foreign Origin is refused (code 4401) while same-origin works; project path traversal and symlink escape refused; local projects outside `TC_PROJECT_ROOTS` refused; zip-slip archive refused; private/loopback/link-local/mapped IPv6 address classification; internal hostnames, non-HTTP schemes and URL credentials refused; **redirects re-validated** (trusted host → 169.254.169.254 or localhost is blocked); permission gate matrix; credential detection.

## Bugs found by the tests and fixed

1. The Spider skipped requested checks because check ids such as `npm:test` were split on `:` — and still reported success. Now checks come from detection directly, and "requested but not run" is reported as **partial**.
2. The desktop bridge was reported "connected" before its capability handshake arrived.
3. Lockfiles inflated line counts and data formats outranked code in language statistics.
4. Invalid research targets and playbook parameters returned HTTP 500 instead of 400.
5. The Spider's SQL rule matched ordinary words (`insert(`, `delete`), fake keys in tests ranked critical, and the rule file flagged itself — rules tightened, test-fixture secrets downgraded to *low*, visible `spider-ignore` suppressions added.
6. **UI crash:** store selectors that returned fresh arrays made React re-render forever and blanked the Intelligence, Missions and Spider views.
7. **Live browser:** pages opened by the server were also adopted as popups, so each tab used two slots and new tabs were closed at the limit. Now only true popups are adopted and the least-recently-used idle tab is evicted.
8. **Live browser:** the first screencast could fail mid-navigation (cold start) and leave the stream blank; idle pages never repainted. Now retried, with an immediate snapshot on attach/resize.
9. Voice/agent "open YouTube" was lost on the first visit because the Browser section had not loaded yet; commands are now queued in the store.
10. Switching a tab's mode didn't update its history entry, so Back returned to the wrong mode.

## The Spider's review of this repository

Final run: 16 leads (0 critical, 6 high, 3 medium, 6 low, 1 info). All reviewed:
- 6 × *SQL built with interpolation*: SQL composed only from constant fragments or fixed table/column lists, with values bound as parameters — safe. Task updates now additionally enforce a column allowlist. These lines are now annotated `spider-ignore` with the reason.
- *Hard-coded credential* in `deploy/searxng/settings.yml`: an intentional `change-me` placeholder, documented.
- *Raw HTML sink* in the reader view: content is Readability output re-sanitised with DOMPurify (no scripts, styles, forms, frames) under a strict CSP.
- Low/info: fake keys and intentionally vulnerable snippets inside test fixtures.

## Command Center evolution (telemetry, 3D core, motion) — what was verified

- **Telemetry is measured, not simulated** (`server/test/telemetry-security.test.ts`): host cores and total memory match `os`, memory percentage is in range, RSS and database size are real, HTTP and AI-turn counters move after real requests, network counters exist only where `/proc/net/dev` exists (otherwise `null`, and the UI says "not measurable on this host"), history is bounded at 180 samples.
- **AI diagnostics** record latency, first-token time and token usage from an actual (double-served) turn.
- **Seven agents** are listed 01–07 in order; Security Intelligence (06) runs a real posture review of TOURBILLION's own configuration and audit log, flagging the test configuration's private-network access as high risk and counting a real failed sign-in.
- **End-to-end** (`e2e/app.spec.ts`): the boot sequence plays after INITIALISE and can be skipped; the CPU gauge and the performance chart render from live samples; the link chip shows a measured round-trip time; seven agent cards show the actual idle status and expand to real responsibilities/tools; tapping the core opens AI diagnostics (provider, model, renderer engine); an integration opens its diagnostics; a completed mission opens its execution history with the verification result; the Performance quality tier reaches the core and the document; 1440×900, 1280×800 and 390×844 have no horizontal scrolling (plus the iPad landscape/portrait checks).
- **Visual review** with screenshots at 1440×900, iPad landscape/portrait and iPhone size: boot gate, materialisation, hero, every band below it, the diagnostics sheet, a mission completing (agent 06 lights, core enters "Complete" with an emerald wave), Cinematic vs Performance tiers and the 2D renderer. No console errors or warnings in any run.
- **Not measurable here:** real frame rate on the A12 iPad. The container renders WebGL in software (SwiftShader, ~6 fps), which is exactly the case the adaptive logic handles: bloom is dropped first, then resolution, then the core falls back to 2D. Check *AI diagnostics → Core renderer* on the iPad: Balanced should hold 45+ fps; if not, choose Performance.

## Owner verification checklist (needs your hardware and accounts)

1. On the iPad in Safari: sign in, tap INITIALISE, hear the greeting; add to Home Screen; relaunch offline and confirm the shell opens.
2. Connected Apps → Claude: add your API key → "Connected". Ask a question in Intelligence; confirm a streamed answer with a reasoning summary.
3. Hold the microphone: "Tourbillion, initiate system diagnostics." and "Tourbillion, open YouTube."
4. Browser: open `youtube.com` (live), search, tap a video, choose "Watch natively", confirm playback and audio.
5. Research: run a domain report on a domain you own; check sources and timestamps.
6. Pair your Mac/PC bridge; run "Blender: inspect and preview" on a real `.blend` file.
7. Connect Gmail; ask the Operator to draft a reply; approve or deny the send.
8. Command Center on the iPad: watch the boot sequence, tap the core and read *Frame rate* in AI diagnostics for each graphics tier (Settings → Visual core & graphics); enable the ambient soundscape and confirm it fades in quietly.

## Running the tests

```bash
npm run typecheck
npm test                                     # server + web unit tests
TC_TEST_BPY_PYTHON=/path/to/python-with-bpy npm test -w server   # include real Blender
npm run test:e2e                             # builds the PWA, starts a harness server, runs Playwright
```

To get a `bpy` interpreter: `python3 -m venv bpyenv && bpyenv/bin/pip install bpy` (the wheel must match the Python version; bpy 5.2 supports CPython 3.13).
