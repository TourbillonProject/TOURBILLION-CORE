# Setup, deployment and API configuration

TOURBILLION CORE has three parts:

1. **Server** (Node.js 22.13+) — intelligence, agents, browser engine, integrations, database. Runs on a computer you control: a home server, a Mac mini, a small VPS, or a NAS that runs Docker.
2. **Web app (PWA)** — served by the server; this is what the iPad opens.
3. **Desktop bridge** (optional) — runs on the Mac/PC that has Blender or Roblox Studio.

The iPad 8th generation cannot run Node.js, Chromium-as-a-service, Blender or Roblox Studio, so it is the control terminal and the server does the work.

```
 iPad (Safari / Home-Screen PWA) ──HTTPS + WSS──▶ TOURBILLION server ──▶ Anthropic API, Google, public data sources
                                                       ▲
                       desktop bridge (outbound WSS) ──┘   Blender · Roblox project files
```

## 1. Install and run

```bash
git clone https://github.com/TourbillonProject/TOURBILLION-CORE.git
cd TOURBILLION-CORE
npm install            # also installs playwright-core (optional dependency)
npx playwright-core install --with-deps chromium   # for the live remote browser (optional)
cp .env.example .env   # then edit
npm run build
npm start
```

On first start the console shows:

```
FIRST-RUN SETUP CODE:  ABCDE-FGHIJ
```

The code is also saved to `data/setup-code.txt`. Opening the app, you enter this code, your name and a passphrase (10+ characters). The code is single-use and deleted afterwards. Alternatively set `TC_OWNER_PASSPHRASE` before the first start.

### Docker

```bash
cp .env.example .env
docker compose up -d --build        # TOURBILLION + SearXNG
docker compose logs tourbillion | grep "SETUP CODE"
```

> The Dockerfile was written for this release but **could not be built in the development sandbox** (no Docker daemon). The non-Docker production build (`npm run build && npm start`) was verified.

## 2. HTTPS (required)

Safari only allows the service worker (offline PWA), microphone access and `Secure` cookies on HTTPS. Pick one:

- **Tailscale (simplest, private)** — install Tailscale on the server and the iPad, then `tailscale serve --bg 8787`. Use the `https://<machine>.<tailnet>.ts.net` address as `TC_PUBLIC_URL` and set `TC_TRUST_PROXY=true`. Nothing is exposed to the internet.
- **Caddy reverse proxy (public domain)**:
  ```
  tourbillion.example.com {
      reverse_proxy 127.0.0.1:8787
  }
  ```
  Set `TC_PUBLIC_URL=https://tourbillion.example.com` and `TC_TRUST_PROXY=true`.
- **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:8787`; consider Cloudflare Access in front for a second factor.

## 3. Install on the iPad

1. Open the HTTPS address in **Safari**.
2. Sign in, then tap **INITIALISE** (this unlocks sound and speech, which iPadOS only allows after a tap).
3. Share → **Add to Home Screen**. Launch from the Home Screen for full-screen standalone mode.
4. For the best voice: iPad Settings → Accessibility → Spoken Content → Voices → English (UK) → download *Daniel* or an *Enhanced* voice, then pick it in TOURBILLION → Settings → Voice.
5. For voice input: iPad Settings → General → Keyboard → enable **Dictation**, and allow microphone access when Safari asks.

## 4. Claude (Anthropic API)

1. Create an API key at <https://console.anthropic.com> (Settings → API keys) and add billing credit.
2. In TOURBILLION: **Connected Apps → Anthropic Claude → paste the key → Connect**. The server tests the key against the Models API before reporting "Connected".

Notes:
- **A Claude.ai Pro/Max subscription does not cover API usage**; the API is billed per token separately. TOURBILLION never asks for your Claude.ai password or session.
- The key is stored encrypted (AES-256-GCM) on the server. It is never returned to the browser; the UI shows only a masked preview.
- Default model `claude-opus-5-5`, effort `medium`; both are in Settings → Intelligence. Anthropic's server-side web search is off by default because it is billed per search — enabling it in Settings is your standing consent to that cost.
- Alternatively set `TC_ANTHROPIC_API_KEY` in the environment.

## 5. Gmail

1. Google Cloud Console → create a project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen**: External (or Internal for Workspace), add your Google account as a test user, add scope `https://www.googleapis.com/auth/gmail.modify`.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised redirect URI: `<TC_PUBLIC_URL>/api/integrations/gmail/callback`.
4. Set `TC_GOOGLE_CLIENT_ID`, `TC_GOOGLE_CLIENT_SECRET`, `TC_PUBLIC_URL`, restart, then **Connected Apps → Gmail → Connect with Google**.

What agents can do: search, read and summarise threads, create drafts, change labels. **Sending always waits for your approval**, and the approval card shows recipient, subject and body. There is no permanent-delete capability.

## 6. Search and research providers

| Provider | Purpose | Setup |
|---|---|---|
| SearXNG | In-app web search (self-hosted, private) | Included in `docker-compose.yml`, or `TC_SEARXNG_URL`. JSON output must be enabled (see `deploy/searxng/settings.yml`). Only that host is trusted on the private network. |
| Brave Search API | In-app web search (hosted) | Key from <https://brave.com/search/api/> → Connected Apps → Web search provider. |
| YouTube Data API v3 | Fast, official YouTube search | Google Cloud → enable *YouTube Data API v3* → API key → Connected Apps → YouTube. Without it, search reads youtube.com in the live browser. |
| GitHub | Higher rate limits for repository research | Fine-grained token with read-only public access → Connected Apps → GitHub. Works without a token at 60 requests/hour. |

DNS-over-HTTPS (dns.google), RDAP (rdap.org), crt.sh, the Wayback Machine, NVD, CISA KEV, OSV.dev and Wikipedia need no keys.

## 7. The Spider: adding projects

- **Upload a .zip** from the iPad Files app (GitHub "Download ZIP" works).
- **Git URL** (https, public or reachable without credentials).
- **Server folder**: list allowed parent folders in `TC_PROJECT_ROOTS`, then register a folder under one of them.

Running a project's tests executes that project's code on the server, so every run needs your approval. Only approve test runs for code you trust, or run TOURBILLION in a container.

## 8. Desktop bridge (Blender, Roblox Studio)

On the Mac/PC with Blender or Roblox Studio (Node.js 22+):

```bash
git clone https://github.com/TourbillonProject/TOURBILLION-CORE.git && cd TOURBILLION-CORE
npm install && npm run build -w bridge
node bridge/dist/bridge.js init          # writes ~/.tourbillion-bridge/config.json
```

Edit the config:

```json
{
  "roots": ["/Users/keenan/Documents/Blender"],
  "blender": { "path": "/Applications/Blender.app/Contents/MacOS/Blender", "allowScripts": true, "timeoutSec": 600 },
  "roblox": {
    "projectDir": "/Users/keenan/Roblox/Atlas",
    "tasks": { "lint": ["selene", "src"], "build": ["rojo", "build", "-o", "build.rbxlx"] },
    "timeoutSec": 300
  }
}
```

Then in TOURBILLION: **Connected Apps → Desktop bridge → Pair a computer**, and run the two commands it shows (`pair`, then `start`). See [bridge/README.md](../bridge/README.md).

Roblox Studio cannot be driven directly; use [Rojo](https://rojo.space) so file changes made through the bridge sync into Studio live.

## 9. Backups and updates

- Everything lives in `TC_DATA_DIR` (default `./data`): `tourbillion.db`, `master.key`, the project workspace and patch backups. Back up the whole folder; **without `master.key` (or `TC_MASTER_KEY`) stored credentials cannot be decrypted**.
- Update: `git pull && npm install && npm run build && npm start`. Database migrations run automatically.
