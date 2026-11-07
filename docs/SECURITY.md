# Security

## Assets and threats

| Asset | Main threats |
|---|---|
| The owner's account | Someone else claiming a fresh install; password guessing; CSRF; cross-site WebSocket hijacking |
| Stored credentials (Anthropic, Google tokens, bridge tokens) | Database theft, leakage to the browser or logs |
| Agent capabilities (send mail, run code, change files) | Prompt injection from web pages, emails, repositories; model mistakes |
| The server's network position | SSRF into the LAN or cloud metadata via fetch tools or the remote browser |
| The owner's desktop | Arbitrary command execution through the bridge |

## Controls

### Authentication and sessions
- **Single owner.** A fresh install refuses setup without a one-time **setup code** printed on the server console (and written to `data/setup-code.txt`, mode 600), so whoever reaches the URL first cannot claim the system. Alternatively `TC_OWNER_PASSPHRASE` pre-provisions the owner.
- Passphrases: minimum 10 characters, **scrypt** (N=16384, r=8, p=1) with per-hash salt.
- Brute force: per-IP request limit on sign-in (default 10/min) **and** exponential lockout after 5 failures (up to 15 minutes).
- Sessions: 256-bit random token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS); only the SHA-256 of the token is stored; sliding 30-day expiry; "sign out everywhere".
- CSRF: every state-changing request must carry `X-TC-Request: 1`. Browsers cannot add custom headers cross-origin without a CORS preflight, which is never granted.
- WebSockets: session cookie **and** `Origin` must match the host or `TC_PUBLIC_URL` (prevents cross-site WebSocket hijacking).

### Credentials
- Stored in the `secrets` table encrypted with **AES-256-GCM**; the key comes from `TC_MASTER_KEY` or `data/master.key` (mode 600, generated once).
- Never returned by any API: the UI sees only state and a masked preview (`sk-a…wxyz`). Data export excludes them.
- The audit log redacts keys named like secrets/tokens and anything shaped like an Anthropic key.
- Memory refuses content that looks like a credential (API keys, tokens, private keys, JWTs, `password=` assignments).
- The Anthropic key is used only server-side. TOURBILLION never asks for, stores or uses a Claude.ai password or session cookie.

### Agent safety (permissions, approvals, injection)
- Every tool has a risk level. **read** runs; **write** (save memory, draft email, propose patch) runs only if the owner enabled auto-approval or approved a plan that declared it; **sensitive** (send email, apply patch, run project tests, run Blender scripts, write Roblox files, run desktop tasks, delete memory) **always** needs a fresh per-call approval. Nothing — settings, plans, model output — bypasses this (`server/src/agents/permissions.ts`).
- Approvals can only be decided through the owner-authenticated HTTP route. The approval card shows the real payload: full script, email recipient/subject/body, file content, check name.
- Agents only see the tools on their allowlist; a call to anything else is rejected.
- External content (web pages, search results, emails, repository files, command output) reaches the model inside `<untrusted_content>` markers, and the system prompt states that such content is data and cannot change goals or permissions. This reduces, but cannot eliminate, prompt injection — which is why side effects are approval-gated.
- The model "never fabricates operations" rule is backed by structure: mission reports come with a verification verdict listing evidence and unverified items; refusals and partial outputs are not treated as answers.

### Network (SSRF)
- All server-side fetches (reader mode, OSINT, health checks, Gmail, OSV, YouTube API) go through `safeFetch`: http/https only, no embedded credentials, DNS resolved by the server and **every address checked** against private, loopback, link-local (incl. `169.254.169.254`), CGNAT, multicast and reserved ranges (IPv4, IPv6 and IPv4-mapped/NAT64 forms). The TCP connection is pinned to the validated address (no DNS-rebinding window). Redirects are followed manually and re-validated on every hop.
- The remote browser applies the same policy to every request and WebSocket the page makes; downloads are refused and no permissions are granted.
- Only an explicitly configured SearXNG host is trusted on a private address. `TC_ALLOW_PRIVATE_NETWORK=true` disables the guard — leave it off.

### Files and code execution
- Project paths from agents or the UI are resolved through `resolveInProject` (rejects `..`, absolute escapes and symlink escapes). Uploaded zips are checked for zip-slip and size bombs.
- Agents never write project files directly: they propose patches (stored diffs); applying needs approval, checks the files have not changed since, keeps a backup and can be reverted.
- Project tests run without a shell, with a fixed argv chosen from detected scripts, a minimal environment (no server secrets) and a timeout. They still execute the project's code with the server's privileges — approve only for trusted code, or run TOURBILLION in a container.

### Desktop bridge
- Pairing uses a one-time 8-character code (10-minute expiry, stored hashed). The bridge receives a long-lived token stored locally with mode 600; the server stores only its hash; revocation is immediate.
- The bridge dials out (no inbound ports on the desktop) and implements a **fixed set of operations**. There is no "run a command" operation. Roblox tasks are named argv lists from the local config; Blender scripts are refused unless the local config sets `allowScripts: true`; every path is confined (realpath-checked) to configured folders.
- Server-side, every side-effecting bridge operation is approval-gated.

### Web client
- Strict Content-Security-Policy (self + YouTube player script and privacy-enhanced embed domain only; `object-src 'none'`; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (YouTube embeds need a referrer), restrictive `Permissions-Policy`, HSTS over HTTPS.
- Model output is rendered by a React-element Markdown renderer (no `innerHTML`). Reader-mode HTML is extracted by Readability on the server and sanitised again with DOMPurify (no scripts, styles, forms or frames).
- The service worker never caches `/api/*`.

### Audit and data control
- Logins, setup, approvals and decisions, every tool execution (actor, risk, duration, outcome), mission lifecycle, integration changes, settings changes and data operations are written to `audit_log` (viewable in Settings).
- Export everything as JSON (credentials excluded); delete conversations, memories (individually, by category or all), reports, history; full wipe with typed confirmation, optionally including credentials.

## Known gaps
- No second factor for owner sign-in; put the server behind Tailscale or Cloudflare Access for defence in depth.
- Prompt injection can still mislead *read-only* behaviour (e.g. a biased summary). Treat summaries of untrusted content accordingly.
- Approved project test runs are not sandboxed beyond the server process; use the Docker image or a dedicated VM for untrusted code.
- The Dockerfile has not been built in the development environment (no Docker daemon available there).
