import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Local bridge configuration. This file is the bridge's own allowlist: the
 * server can only ask for operations this file permits, inside folders it
 * lists. Stored with 0600 permissions because it holds the bridge token.
 */
export interface BridgeConfig {
  server: string;
  token: string | null;
  name: string;
  /** Folders the bridge may read/write (Blender projects etc.). */
  roots: string[];
  blender: {
    path: string; // Blender executable
    allowScripts: boolean; // run arbitrary (approved) bpy scripts
    timeoutSec: number;
  };
  roblox: {
    projectDir: string | null; // Rojo project root
    /** Named tasks the server may run, mapped to an exact argv. No shell. */
    tasks: Record<string, string[]>;
    timeoutSec: number;
  };
}

export function defaultConfigPath(): string {
  return process.env.TOURBILLION_BRIDGE_CONFIG ?? path.join(os.homedir(), '.tourbillion-bridge', 'config.json');
}

export function defaultBlenderPath(): string {
  if (process.platform === 'darwin') return '/Applications/Blender.app/Contents/MacOS/Blender';
  if (process.platform === 'win32') return 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
  return 'blender';
}

export function template(): BridgeConfig {
  return {
    server: 'https://your-tourbillion-server.example',
    token: null,
    name: os.hostname(),
    roots: [path.join(os.homedir(), 'Documents', 'Blender')],
    blender: { path: defaultBlenderPath(), allowScripts: false, timeoutSec: 600 },
    roblox: {
      projectDir: null,
      tasks: { lint: ['selene', 'src'], build: ['rojo', 'build', '-o', 'build.rbxlx'] },
      timeoutSec: 300,
    },
  };
}

export function loadConfig(file = defaultConfigPath()): BridgeConfig {
  if (!fs.existsSync(file)) throw new Error(`No bridge config at ${file}. Run: tourbillion-bridge init`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BridgeConfig>;
  const t = template();
  return {
    ...t,
    ...raw,
    blender: { ...t.blender, ...(raw.blender ?? {}) },
    roblox: { ...t.roblox, ...(raw.roblox ?? {}), tasks: raw.roblox?.tasks ?? t.roblox.tasks },
    roots: (raw.roots ?? t.roots).map((r) => path.resolve(r.replace(/^~(?=$|\/)/, os.homedir()))),
  };
}

export function saveConfig(cfg: BridgeConfig, file = defaultConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}
