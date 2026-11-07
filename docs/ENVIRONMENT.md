# Environment variables

All configuration is via environment variables (or a `.env` file loaded by your process manager / Docker). Source of truth: `server/src/config.ts`.

## Server

| Variable | Default | Purpose |
|---|---|---|
| `TC_HOST` | `0.0.0.0` | Interface to listen on. |
| `TC_PORT` / `PORT` | `8787` | HTTP port. |
| `TC_PUBLIC_URL` | — | Public HTTPS origin (e.g. `https://tourbillion.example.com`). Required for Gmail OAuth; also accepted as a WebSocket origin. |
| `TC_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers. Set `true` behind Caddy / nginx / Tailscale Serve so cookies are marked `Secure`. |
| `TC_DATA_DIR` | `./data` | Database, master key, project workspace, backups. |
| `TC_WEB_DIST` | `web/dist` | Built PWA to serve. |
| `TC_OWNER_NAME` | `Keenan` | Owner name used in greetings (editable in Settings). |
| `TC_OWNER_PASSPHRASE` | — | Pre-provision the owner instead of using the first-run setup code. |
| `TC_MASTER_KEY` | generated | 32-byte key (base64 or 64 hex chars) for encrypting stored credentials. If unset, generated once into `TC_DATA_DIR/master.key` (mode 600). |
| `TC_SESSION_DAYS` | `30` | Sliding session lifetime. |
| `TC_RATE_LIMIT_PER_MIN` | `600` | Global per-IP request limit. |
| `TC_AUTH_RATE_LIMIT_PER_MIN` | `10` | Per-IP limit on sign-in/setup requests (the passphrase lockout applies on top). |
| `TC_ALLOW_PRIVATE_NETWORK` | `false` | Let server-side fetches and the remote browser reach private/loopback/link-local addresses. **Leave off** unless the server is isolated; it disables the SSRF guard. |

## Claude

| Variable | Default | Purpose |
|---|---|---|
| `TC_ANTHROPIC_API_KEY` | — | API key (alternative to entering it in Connected Apps, where it is stored encrypted). |
| `TC_ANTHROPIC_MODEL` | `claude-opus-5-5` | Default model (changeable in Settings). |
| `TC_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API base URL (gateways). `ANTHROPIC_BASE_URL` is deliberately ignored. |

## Integrations

| Variable | Purpose |
|---|---|
| `TC_GOOGLE_CLIENT_ID`, `TC_GOOGLE_CLIENT_SECRET` | Google OAuth client (Web application) for Gmail. |
| `TC_YOUTUBE_API_KEY` | YouTube Data API v3 key (or enter in Connected Apps). |
| `TC_SEARXNG_URL` | SearXNG base URL with JSON output enabled. That single host is trusted even on a private address. |
| `TC_BRAVE_SEARCH_KEY` | Brave Search API key (or enter in Connected Apps). |
| `TC_GITHUB_TOKEN` | Read-only GitHub token (or enter in Connected Apps). |

## Remote browser

| Variable | Default | Purpose |
|---|---|---|
| `TC_BROWSER_ENABLED` | `true` | Enable the live remote Chromium. |
| `TC_BROWSER_EXECUTABLE` | Playwright's Chromium | Path to a Chromium/Chrome binary. |
| `TC_BROWSER_MAX_TABS` | `6` | Concurrent remote tabs (least-recently-used idle tab is evicted at the limit). |
| `TC_BROWSER_PROXY` | — | Outbound proxy for the remote browser, e.g. `http://proxy:3128`. |

## The Spider

| Variable | Purpose |
|---|---|
| `TC_PROJECT_ROOTS` | Comma-separated server folders under which existing directories may be registered as projects. |

## Endpoint overrides (testing / self-hosted mirrors)

`TC_ENDPOINT_DOH`, `TC_ENDPOINT_RDAP`, `TC_ENDPOINT_CRTSH`, `TC_ENDPOINT_WAYBACK`, `TC_ENDPOINT_GITHUB`, `TC_ENDPOINT_NVD`, `TC_ENDPOINT_OSV`, `TC_ENDPOINT_CISA_KEV`, `TC_ENDPOINT_WIKIPEDIA`, `TC_ENDPOINT_GOOGLE_OAUTH`, `TC_ENDPOINT_GOOGLE_TOKEN`, `TC_ENDPOINT_GMAIL`, `TC_ENDPOINT_YOUTUBE` — replace the default public endpoints. The test suites use these to point at local fixtures.

## Desktop bridge

| Variable | Purpose |
|---|---|
| `TOURBILLION_BRIDGE_CONFIG` | Path to the bridge config file (default `~/.tourbillion-bridge/config.json`). |

## Tests

| Variable | Purpose |
|---|---|
| `TC_TEST_BPY_PYTHON` | Python interpreter with the `bpy` module; enables the real-Blender integration test. |
| `E2E_PORT`, `E2E_CHROMIUM` | Port and Chromium path for the Playwright harness. |
