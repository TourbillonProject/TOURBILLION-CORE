import { useEffect, useMemo, useState } from 'react';
import { AGENT_IDS, TERMINAL_TASK_STATUSES } from '@tc/shared';
import { Dot, INTEGRATION_LABEL, Panel, integrationDot } from '../../components/ui';
import { AgentComms, AreaChart, Legend, MissionTimeline, Sparkline, Topology, type CommAgent, type Series, type TopoNode } from '../../components/viz';
import { useStore } from '../../lib/store';
import { api } from '../../lib/api';
import { ago, bytes } from '../../lib/format';
import { rate, type OpenSheet } from './util';
import { APP_SHORT } from './AppsGrid';

/** Telemetry-backed analytics. Each chart states its source; unavailable data is labelled, never simulated. */

function useTimes() {
  const telemetry = useStore((s) => s.telemetry);
  return useMemo(() => ({ telemetry, times: telemetry.map((t) => Date.parse(t.at)) }), [telemetry]);
}

const pct = (v: number) => `${v.toFixed(1)}%`;
const perMin = (v: number) => `${Math.round(v)}/min`;

export function PerformancePanel() {
  const { telemetry, times } = useTimes();
  const series: Series[] = useMemo(
    () => [
      { key: 'cpu', label: 'CPU', color: '#2ee6ff', values: telemetry.map((t) => t.cpu.percent), format: pct },
      { key: 'ram', label: 'RAM', color: '#8f7bff', values: telemetry.map((t) => t.memory.percent), format: pct },
    ],
    [telemetry],
  );
  const lag = useMemo(() => telemetry.map((t) => t.process.eventLoopLagMs), [telemetry]);
  const latest = telemetry.at(-1);
  return (
    <Panel title="Performance" idx="P1" actions={<Legend series={series} />}>
      <AreaChart series={series} times={times} max={100} />
      <div className="row between tiny muted chart-foot">
        <span>Host CPU and memory · 2 s samples · last {Math.round((telemetry.length * 2) / 60)} min</span>
        <span className="mono">loop lag {latest?.process.eventLoopLagMs == null ? 'n/a' : `${latest.process.eventLoopLagMs.toFixed(1)} ms`}</span>
      </div>
      <Sparkline values={lag} color="#1ff2d2" height={22} label="Event-loop lag" />
    </Panel>
  );
}

export function AIActivityPanel() {
  const { telemetry, times } = useTimes();
  const series: Series[] = useMemo(
    () => [
      { key: 'ai', label: 'AI turns', color: '#8f7bff', values: telemetry.map((t) => t.app.aiTurnsPerMin), format: perMin },
      { key: 'tools', label: 'Tool calls', color: '#2ee6ff', values: telemetry.map((t) => t.app.toolCallsPerMin), format: perMin },
      { key: 'events', label: 'Events', color: '#1ff2d2', values: telemetry.map((t) => t.app.eventsPerMin), format: perMin },
    ],
    [telemetry],
  );
  const latest = telemetry.at(-1);
  return (
    <Panel title="AI activity" idx="P2" actions={<Legend series={series} />}>
      <AreaChart series={series} times={times} />
      <div className="row between tiny muted chart-foot">
        <span>Rolling one-minute counts from the server</span>
        <span className="mono">{latest ? `${latest.app.activeRuns} run${latest.app.activeRuns === 1 ? '' : 's'} · ${latest.app.httpRequestsPerMin} req/min` : ''}</span>
      </div>
    </Panel>
  );
}

export function TrafficPanel() {
  const { telemetry, times } = useTimes();
  const meta = useStore((s) => s.telemetryMeta);
  const series: Series[] = useMemo(
    () => [
      { key: 'rx', label: 'Received', color: '#2ee6ff', values: telemetry.map((t) => t.network.rxBytesPerSec), format: rate },
      { key: 'tx', label: 'Sent', color: '#ffb648', values: telemetry.map((t) => t.network.txBytesPerSec), format: rate },
    ],
    [telemetry],
  );
  const unavailable = meta ? !meta.capabilities.network : false;
  const latest = telemetry.at(-1);
  return (
    <Panel title="Network traffic" idx="P3" actions={!unavailable && <Legend series={series} />}>
      {unavailable ? (
        <div className="chart-empty unavailable" style={{ height: 110 }}>
          Network counters are not available on this server host (no /proc/net/dev). Nothing is estimated.
        </div>
      ) : (
        <AreaChart series={series} times={times} />
      )}
      <div className="row between tiny muted chart-foot">
        <span>{unavailable ? 'Source: unavailable' : `Source: ${latest?.network.source ?? '/proc/net/dev'} (all interfaces except loopback)`}</span>
        {!unavailable && <span className="mono">↓ {rate(latest?.network.rxBytesPerSec ?? null)} · ↑ {rate(latest?.network.txBytesPerSec ?? null)}</span>}
      </div>
    </Panel>
  );
}

export function MemoryPanel() {
  const { telemetry, times } = useTimes();
  const count = useStore((s) => s.status?.memory.count ?? 0);
  const [cats, setCats] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    api.get<{ total: number; byCategory: Record<string, number> }>('/api/memory/stats').then((r) => setCats(r.byCategory)).catch(() => setCats(null));
  }, [count]);
  const series: Series[] = useMemo(
    () => [
      { key: 'rss', label: 'Process RSS', color: '#8f7bff', values: telemetry.map((t) => t.process.rssBytes), format: bytes },
      { key: 'heap', label: 'JS heap', color: '#2ee6ff', values: telemetry.map((t) => t.process.heapUsedBytes), format: bytes },
    ],
    [telemetry],
  );
  const entries = Object.entries(cats ?? {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const latest = telemetry.at(-1);
  return (
    <Panel title="Memory" idx="P4" actions={<Legend series={series} />}>
      <AreaChart series={series} times={times} height={84} />
      <div className="row between tiny muted chart-foot">
        <span>Server process memory</span>
        <span className="mono">{latest?.storage.dbBytes != null ? `database ${bytes(latest.storage.dbBytes)}` : ''}</span>
      </div>
      <div className="tiny muted label" style={{ marginTop: 8 }}>LONG-TERM MEMORY · {count} item{count === 1 ? '' : 's'}</div>
      {entries.length === 0 && <div className="tiny muted">{cats ? 'No memories stored yet.' : 'Loading…'}</div>}
      <div className="bars">
        {entries.map(([k, n]) => (
          <div key={k} className="bar-row">
            <span className="tiny ellipsis">{k}</span>
            <span className="bar"><i style={{ width: `${(n / max) * 100}%` }} /></span>
            <span className="tiny mono">{n}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function HealthPanel({ open }: { open: OpenSheet }) {
  const integrations = useStore((s) => s.integrations);
  const ws = useStore((s) => s.ws);
  const link = useStore((s) => s.link);
  const avg = link.history.length ? Math.round(link.history.reduce((a, b) => a + b, 0) / link.history.length) : null;
  return (
    <Panel title="Connection health" idx="P5">
      <div className="list">
        <div className="list-item clickable health" onClick={() => open({ kind: 'link' })}>
          <Dot kind={ws === 'live' ? 'live' : ws === 'connecting' ? 'warn' : 'err'} pulse={ws === 'live'} />
          <span className="small" style={{ flex: 1 }}>Realtime link</span>
          <span className="spark-mini"><Sparkline values={link.history} height={18} label="Link round-trip time" /></span>
          <span className="tiny mono">{link.latencyMs == null ? 'no link' : `${link.latencyMs} ms`}{avg != null ? ` · avg ${avg}` : ''}</span>
        </div>
        {integrations.map((i) => (
          <div key={i.id} className="list-item clickable health" onClick={() => open({ kind: 'integration', id: i.id })} title={i.lastError ?? undefined}>
            <Dot kind={integrationDot(i.state)} />
            <span className="small ellipsis" style={{ flex: 1 }}>{APP_SHORT[i.id] ?? i.name}</span>
            <span className="tiny muted ellipsis" style={{ maxWidth: '45%' }}>{INTEGRATION_LABEL[i.state]}{i.lastSuccessAt ? ` · ${ago(i.lastSuccessAt)}` : ''}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function TopologyPanel({ open }: { open: OpenSheet }) {
  const integrations = useStore((s) => s.integrations);
  const status = useStore((s) => s.status);
  const ws = useStore((s) => s.ws);
  const linkMs = useStore((s) => s.link.latencyMs);
  const nodes: TopoNode[] = useMemo(() => {
    const st = (id: string): TopoNode['state'] => {
      const i = integrations.find((x) => x.id === id);
      return i ? integrationDot(i.state) : 'off';
    };
    const short: Record<string, string> = { claude: 'Claude', browser: 'Browser', youtube: 'YouTube', search: 'Search', github: 'GitHub', gmail: 'Gmail', bridge: 'Bridge', blender: 'Blender', roblox: 'Roblox' };
    const device: TopoNode = { id: 'device', label: 'This device', state: ws === 'live' ? 'live' : ws === 'connecting' ? 'warn' : 'err', detail: linkMs == null ? 'no link' : `${linkMs} ms round trip` };
    const database: TopoNode = { id: 'database', label: 'Database', state: status ? (status.db.ok ? 'ok' : 'err') : 'off' };
    const app = (id: string, parent?: string): TopoNode | null => {
      const i = integrations.find((x) => x.id === id);
      return i ? { id, label: short[id], state: st(id), detail: INTEGRATION_LABEL[i.state], parent } : null;
    };
    // Clockwise from the top; this order puts the bridge lower-left so its applications have room outside it.
    const ring = [device, app('claude'), app('browser'), app('search'), app('youtube'), database, app('bridge'), app('github'), app('gmail')];
    const list = [{ id: 'server', label: 'CORE', state: ws === 'live' ? 'live' : 'err' } as TopoNode, ...ring, app('blender', 'bridge'), app('roblox', 'bridge')].filter((n): n is TopoNode => !!n);
    return list;
  }, [integrations, status, ws, linkMs]);
  return (
    <Panel title="Network topology" idx="P6">
      <Topology
        nodes={nodes}
        onSelect={(id) => {
          if (id === 'server' || id === 'device' || id === 'database') open({ kind: 'link' });
          else if (id === 'claude') open({ kind: 'ai' });
          else open({ kind: 'integration', id });
        }}
      />
      <div className="row tiny muted topo-key">
        <span><i className="k live" /> live</span>
        <span><i className="k ok" /> connected</span>
        <span><i className="k warn" /> configured · untested</span>
        <span><i className="k err" /> error</span>
        <span><i className="k off" /> not configured</span>
      </div>
    </Panel>
  );
}

export function CommsPanel({ open }: { open: OpenSheet }) {
  const agents = useStore((s) => s.agents);
  const activity = useStore((s) => s.activity);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const data: CommAgent[] = useMemo(
    () =>
      AGENT_IDS.map((id) => {
        const a = agents.find((x) => x.id === id);
        const events = activity.filter((x) => x.agent === id && now - x.at < 60_000).length;
        return { id, code: a?.code ?? '', name: a?.name ?? id, busy: !!a && a.status !== 'idle' && a.status !== 'error', events, error: a?.status === 'error' };
      }),
    [agents, activity, now],
  );
  const total = data.reduce((n, a) => n + a.events, 0);
  return (
    <Panel title="Agent communication" idx="P7">
      <AgentComms agents={data} onSelect={(id) => open({ kind: 'agent', id: id as (typeof AGENT_IDS)[number] })} />
      <div className="tiny muted chart-foot">{total ? `${total} agent event${total === 1 ? '' : 's'} in the last minute` : 'No agent activity in the last minute.'} Links brighten with real activity; packets move only while an agent is working.</div>
    </Panel>
  );
}

export function TimelinePanel({ open }: { open: OpenSheet }) {
  const tasks = useStore((s) => s.tasks);
  const items = useMemo(
    () =>
      Object.values(tasks)
        .sort((a, b) => b.id - a.id)
        .slice(0, 10)
        .map((t) => ({ id: t.id, label: t.title, start: Date.parse(t.startedAt ?? t.createdAt), end: TERMINAL_TASK_STATUSES.includes(t.status) ? Date.parse(t.finishedAt ?? t.updatedAt) : null, status: t.status })),
    [tasks],
  );
  return (
    <Panel title="Mission timeline" idx="P8">
      <MissionTimeline items={items} onSelect={(id) => open({ kind: 'mission', id })} />
    </Panel>
  );
}
