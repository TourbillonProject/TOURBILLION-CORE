import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ServerEvent, TelemetrySample } from '@tc/shared';
import type { Database } from '../db.js';
import type { EventBus } from './core.js';

/**
 * Real telemetry from the host running TOURBILLION. Nothing is simulated:
 * a value the platform cannot provide is reported as `null` and the UI
 * labels it "unavailable".
 *
 *  - CPU: busy share across all cores from os.cpus() time deltas
 *  - Memory: os.totalmem / os.freemem; process RSS and V8 heap
 *  - Event-loop lag: perf_hooks histogram (mean per interval)
 *  - Network: byte counters from /proc/net/dev (Linux); unavailable elsewhere
 *  - App activity: HTTP requests, bus events, AI turns and tool calls in the last minute
 */
export class Telemetry {
  private history: TelemetrySample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastCpu = os.cpus().map((c) => c.times);
  private lastNet: { rx: number; tx: number; at: number } | null = null;
  private loop = monitorEventLoopDelay({ resolution: 20 });
  private http: number[] = [];
  private events: number[] = [];
  private aiTurns: number[] = [];
  private toolCalls: number[] = [];
  readonly intervalMs = 2000;
  readonly capacity = 180; // six minutes

  constructor(
    private db: Database,
    private bus: EventBus,
    private dataDir: string,
    private clientCount: () => number,
  ) {
    this.loop.enable();
    bus.on((e: ServerEvent) => {
      if (e.type === 'telemetry') return;
      const now = Date.now();
      this.events.push(now);
      if (e.type === 'chat.tool' && e.status === 'started') this.toolCalls.push(now);
      if (e.type === 'task.step' && e.step.kind === 'tool') this.toolCalls.push(now);
    });
  }

  countHttpRequest() {
    this.http.push(Date.now());
  }

  countAiTurn() {
    this.aiTurns.push(Date.now());
  }

  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.loop.disable();
  }

  snapshot() {
    return {
      intervalMs: this.intervalMs,
      host: { platform: `${os.platform()} ${os.release()}`, cpuModel: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, node: process.version },
      capabilities: { network: fs.existsSync('/proc/net/dev'), eventLoop: true },
      history: this.history,
    };
  }

  latest(): TelemetrySample | null {
    return this.history.at(-1) ?? null;
  }

  private perMinute(list: number[], now: number): number {
    while (list.length && now - list[0] > 60_000) list.shift();
    return list.length;
  }

  private cpuPercent(): number | null {
    const cur = os.cpus().map((c) => c.times);
    if (!cur.length || cur.length !== this.lastCpu.length) {
      this.lastCpu = cur;
      return null;
    }
    let idle = 0;
    let total = 0;
    cur.forEach((t, i) => {
      const p = this.lastCpu[i];
      const d = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + (t.idle - p.idle);
      total += d;
      idle += t.idle - p.idle;
    });
    this.lastCpu = cur;
    if (total <= 0) return null;
    return Math.max(0, Math.min(100, (1 - idle / total) * 100));
  }

  private network(now: number): { rx: number | null; tx: number | null } {
    try {
      const text = fs.readFileSync('/proc/net/dev', 'utf8');
      let rx = 0;
      let tx = 0;
      for (const line of text.split('\n').slice(2)) {
        const m = line.trim().match(/^([^:]+):\s*(.*)$/);
        if (!m || m[1] === 'lo') continue;
        const f = m[2].split(/\s+/).map(Number);
        rx += f[0] ?? 0;
        tx += f[8] ?? 0;
      }
      const prev = this.lastNet;
      this.lastNet = { rx, tx, at: now };
      if (!prev) return { rx: null, tx: null };
      const dt = (now - prev.at) / 1000;
      return { rx: Math.max(0, (rx - prev.rx) / dt), tx: Math.max(0, (tx - prev.tx) / dt) };
    } catch {
      return { rx: null, tx: null };
    }
  }

  private dbBytes(): number | null {
    let total = 0;
    let found = false;
    for (const f of ['tourbillion.db', 'tourbillion.db-wal']) {
      try {
        total += fs.statSync(path.join(this.dataDir, f)).size;
        found = true;
      } catch {
        /* not present */
      }
    }
    return found ? total : null;
  }

  sample(): TelemetrySample {
    const now = Date.now();
    const total = os.totalmem();
    const used = total - os.freemem();
    const mem = process.memoryUsage();
    const net = this.network(now);
    const lagNs = this.loop.mean;
    this.loop.reset();
    const activeRuns = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")?.n ?? 0;
    const memories = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memories')?.n ?? 0;
    const s: TelemetrySample = {
      at: new Date(now).toISOString(),
      cpu: { percent: this.cpuPercent(), cores: os.cpus().length, load1: os.platform() === 'win32' ? null : os.loadavg()[0] },
      memory: { totalBytes: total, usedBytes: used, percent: (used / total) * 100 },
      process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, eventLoopLagMs: Number.isFinite(lagNs) && lagNs > 0 ? lagNs / 1e6 : null },
      network: { rxBytesPerSec: net.rx, txBytesPerSec: net.tx, source: fs.existsSync('/proc/net/dev') ? 'host interfaces (/proc/net/dev)' : null },
      app: {
        httpRequestsPerMin: this.perMinute(this.http, now),
        wsClients: this.clientCount(),
        eventsPerMin: this.perMinute(this.events, now),
        aiTurnsPerMin: this.perMinute(this.aiTurns, now),
        toolCallsPerMin: this.perMinute(this.toolCalls, now),
        activeRuns,
      },
      storage: { dbBytes: this.dbBytes(), memories },
    };
    this.history.push(s);
    if (this.history.length > this.capacity) this.history.shift();
    if (this.clientCount() > 0) this.bus.emit({ type: 'telemetry', sample: s });
    return s;
  }
}
