import os from 'node:os';
import fs from 'node:fs';
import WebSocket from 'ws';
import type { BridgeHello, BridgeRequest, BridgeResponse } from '@tc/shared';
import { BRIDGE_PROTOCOL_VERSION } from '@tc/shared';
import type { BridgeConfig } from './config.js';
import { blenderVersion, dispatch } from './ops.js';

export const BRIDGE_VERSION = '0.1.0';

/** Exchanges a one-time pairing code for a long-lived bridge token. */
export async function pair(server: string, code: string): Promise<string> {
  const res = await fetch(`${server.replace(/\/$/, '')}/api/bridge/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, hostname: os.hostname() }),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
  if (!res.ok || !data.token) throw new Error(`Pairing failed: ${data.message ?? `HTTP ${res.status}`}`);
  return data.token;
}

export async function hello(cfg: BridgeConfig): Promise<BridgeHello> {
  const version = await blenderVersion(cfg).catch(() => null);
  return {
    type: 'hello',
    protocol: BRIDGE_PROTOCOL_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    capabilities: {
      fs: { roots: cfg.roots },
      blender: { available: !!version, version, scriptsAllowed: cfg.blender.allowScripts },
      roblox: { available: !!cfg.roblox.projectDir && fs.existsSync(cfg.roblox.projectDir), projectDir: cfg.roblox.projectDir, tasks: Object.keys(cfg.roblox.tasks) },
    },
  };
}

/** Maintains the outbound connection to the server, reconnecting with backoff. */
export function connect(cfg: BridgeConfig, log: (m: string) => void = console.log): { close: () => void; ready: Promise<void> } {
  if (!cfg.token) throw new Error('This bridge is not paired. Run: tourbillion-bridge pair --server <url> --code <code>');
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const url = `${cfg.server.replace(/\/$/, '').replace(/^http/, 'ws')}/api/bridge/ws`;

  const open = () => {
    ws = new WebSocket(url, { headers: { authorization: `Bearer ${cfg.token}` } });
    ws.on('open', async () => {
      retry = 0;
      log(`Connected to ${cfg.server}`);
      ws!.send(JSON.stringify(await hello(cfg)));
      resolveReady();
    });
    ws.on('message', async (raw) => {
      let req: BridgeRequest;
      try {
        req = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (req.type !== 'request') return;
      const started = Date.now();
      let res: BridgeResponse;
      try {
        const result = req.op === 'hello' ? await hello(cfg) : await dispatch(cfg, req.op, req.params ?? {});
        res = { type: 'response', id: req.id, ok: true, result };
      } catch (err) {
        res = { type: 'response', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      log(`${req.op} → ${res.ok ? 'ok' : `error: ${res.error}`} (${Date.now() - started} ms)`);
      ws?.send(JSON.stringify(res));
    });
    ws.on('close', (code, reason) => {
      if (stopped) return;
      if (code === 4401 || code === 4403) {
        log(`Server refused this bridge (${code} ${reason}). Pair again.`);
        stopped = true;
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      log(`Disconnected (${code}). Reconnecting in ${Math.round(delay / 1000)} s…`);
      setTimeout(open, delay);
    });
    ws.on('error', (e) => log(`Connection error: ${e.message}`));
  };
  open();
  return {
    ready,
    close: () => {
      stopped = true;
      ws?.close();
    },
  };
}
