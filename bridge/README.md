# tourbillion-bridge

Connects a Mac or PC to TOURBILLION CORE so its agents can work with **Blender** and **Roblox Studio** projects on that computer. The iPad cannot run either application; the bridge runs them (or their files) where they live.

## How it works

- The bridge **dials out** to your TOURBILLION server over a WebSocket — no ports are opened on your computer.
- It implements a **fixed set of operations** (below). There is no "run any command" operation.
- Its local config file is its own allowlist: which folders it may touch, whether Blender scripts may run, and which named project tasks exist.
- On the server, every operation with side effects waits for your approval in TOURBILLION before it is sent.

## Install

Requires Node.js 22+.

```bash
git clone https://github.com/TourbillonProject/TOURBILLION-CORE.git
cd TOURBILLION-CORE
npm install && npm run build -w bridge
node bridge/dist/bridge.js init
```

Edit `~/.tourbillion-bridge/config.json`:

```json
{
  "server": "https://tourbillion.example.com",
  "name": "Studio Mac",
  "roots": ["/Users/keenan/Documents/Blender"],
  "blender": {
    "path": "/Applications/Blender.app/Contents/MacOS/Blender",
    "allowScripts": true,
    "timeoutSec": 600
  },
  "roblox": {
    "projectDir": "/Users/keenan/Roblox/Atlas",
    "tasks": {
      "lint": ["selene", "src"],
      "build": ["rojo", "build", "-o", "build.rbxlx"]
    },
    "timeoutSec": 300
  }
}
```

In TOURBILLION: **Connected Apps → Desktop bridge → Pair a computer**. Then:

```bash
node bridge/dist/bridge.js pair --server https://tourbillion.example.com --code ABCD-EFGH
node bridge/dist/bridge.js start          # keep running (e.g. as a login item / launchd / systemd service)
node bridge/dist/bridge.js status         # what this bridge offers
```

The token is stored in the config file with permissions 600. Revoke a bridge any time in Connected Apps.

## Operations

| Operation | What it does | Approval on the server |
|---|---|---|
| `blender.version` | `blender --version` | — |
| `blender.scene_info` | Opens a `.blend` in background mode and returns objects, materials, camera, frame range, engine, resolution | read |
| `blender.run_script` | Runs a bpy script in background mode (`-b … --python`), optionally saving to a `.blend`. **Refused unless `allowScripts` is true.** | sensitive (the full script is shown) |
| `blender.render` | Renders a still (PNG) at a chosen resolution percentage; Cycles is capped at 32 samples on CPU | write |
| `roblox.list` / `roblox.read` | Lists / reads files in `projectDir` | read |
| `roblox.write` | Writes `.lua`, `.luau`, `.json`, `.toml`, `.md`, `.txt` files; the previous version is backed up to `.tourbillion-backups/` | sensitive |
| `roblox.run_task` | Runs one of the named `tasks` (exact argv, no shell, timeout) | sensitive |
| `fs.list` / `fs.read` / `fs.write` | Files inside `roots` | read / read / — (not exposed to agents) |

Every path is resolved inside the configured folders with symlinks resolved, so `../` or links cannot escape.

### Roblox Studio

Studio has no automation API. Use [Rojo](https://rojo.space): `rojo serve` plus the Rojo Studio plugin keeps Studio in sync with the files the bridge edits.

### Blender scripts

Scripts run with your user's permissions inside Blender's Python. Keep `allowScripts` false unless you want TOURBILLION to build or modify scenes, and read the script on the approval card before approving.
