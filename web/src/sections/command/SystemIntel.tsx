import { useMemo } from 'react';
import { Dot, INTEGRATION_LABEL, Panel, integrationDot } from '../../components/ui';
import { AnimatedNumber, RingGauge, Sparkline } from '../../components/viz';
import { navigate, useStore } from '../../lib/store';
import { bytes } from '../../lib/format';
import { rate, uptime, type OpenSheet } from './util';

type Kind = 'ok' | 'warn' | 'err' | 'off' | 'live';

/**
 * System intelligence: every value is read from the server (status +
 * telemetry). Anything the host cannot measure says so instead of guessing.
 */
export function SystemIntel({ open }: { open: OpenSheet }) {
  const status = useStore((s) => s.status);
  const ws = useStore((s) => s.ws);
  const telemetry = useStore((s) => s.telemetry);
  const meta = useStore((s) => s.telemetryMeta);
  const latest = telemetry.at(-1);
  const cpuSeries = useMemo(() => telemetry.slice(-90).map((t) => t.cpu.percent), [telemetry]);
  const memSeries = useMemo(() => telemetry.slice(-90).map((t) => t.memory.percent), [telemetry]);

  const rows: { k: string; v: React.ReactNode; d: Kind; onClick?: () => void; title?: string }[] = status
    ? [
        { k: 'Server', v: <>{ws === 'live' ? 'Online' : ws === 'connecting' ? 'Linking' : 'Unreachable'} · up {uptime(status.uptimeSec)}</>, d: ws === 'live' ? 'live' : 'err', onClick: () => open({ kind: 'link' }), title: `Version ${status.version}` },
        { k: 'Claude', v: INTEGRATION_LABEL[status.ai.state], d: integrationDot(status.ai.state), onClick: () => open({ kind: 'ai' }) },
        { k: 'Model', v: status.ai.model, d: 'off', onClick: () => open({ kind: 'ai' }) },
        { k: 'Browser', v: status.browser.available ? 'Chromium' : 'Reader only', d: status.browser.available ? 'ok' : 'warn', onClick: () => open({ kind: 'integration', id: 'browser' }), title: status.browser.detail },
        { k: 'Bridge', v: status.bridge.connected ? `${status.bridge.connected} connected` : 'None', d: status.bridge.connected ? 'ok' : 'off', onClick: () => open({ kind: 'integration', id: 'bridge' }) },
        { k: 'Missions', v: <AnimatedNumber value={status.tasks.active} />, d: status.tasks.active ? 'live' : 'off', onClick: () => navigate('missions') },
        { k: 'Approvals', v: <AnimatedNumber value={status.tasks.awaitingApproval} />, d: status.tasks.awaitingApproval ? 'warn' : 'off', onClick: () => navigate('missions') },
        { k: 'Memories', v: <AnimatedNumber value={status.memory.count} />, d: 'off', onClick: () => navigate('memory') },
        { k: 'Database', v: <>{status.db.ok ? 'OK' : 'Error'}{latest?.storage.dbBytes != null ? ` · ${bytes(latest.storage.dbBytes)}` : ''}</>, d: status.db.ok ? 'ok' : 'err' },
      ]
    : [];

  const net = latest?.network;
  return (
    <Panel title="System intelligence" idx="01" className="sysintel">
      {!status && <div className="empty">Waiting for the server…</div>}
      <div className="gauges">
        <RingGauge value={latest?.cpu.percent == null ? null : latest.cpu.percent / 100} label="CPU" sub={latest ? (latest.cpu.percent == null ? 'measuring…' : `${latest.cpu.cores} cores`) : 'no data'} />
        <RingGauge value={latest ? latest.memory.percent / 100 : null} label="RAM" sub={latest ? bytes(latest.memory.usedBytes) : 'no data'} color="var(--violet)" />
      </div>
      <div className="netline mono tiny">
        <span><span className="muted">NET</span> {meta && !meta.capabilities.network ? <span className="muted">not measurable here</span> : <>↓ {rate(net?.rxBytesPerSec ?? null)} ↑ {rate(net?.txBytesPerSec ?? null)}</>}</span>
        <span><span className="muted">LOOP</span> {latest?.process.eventLoopLagMs == null ? 'n/a' : `${latest.process.eventLoopLagMs.toFixed(1)} ms`}</span>
      </div>
      <div className="spark-row" title="CPU (cyan) and RAM (violet), last 3 minutes">
        <Sparkline values={cpuSeries} max={100} label="CPU trend" />
        <Sparkline values={memSeries} max={100} color="var(--violet)" label="RAM trend" />
      </div>
      <div className="list kv-list">
        {rows.map((r) => (
          <div key={r.k} className={`list-item kv ${r.onClick ? 'clickable' : ''}`} onClick={r.onClick} title={r.title}>
            <Dot kind={r.d} pulse={r.d === 'live'} />
            <span className="small muted k">{r.k}</span>
            <span className="small mono ellipsis v">{r.v}</span>
          </div>
        ))}
      </div>
      {meta && status && <div className="tiny muted mono foot">v{status.version} · {meta.host.platform.split(' ')[0]} · Node {meta.host.node.replace(/^v/, '')} · {meta.intervalMs / 1000}s samples</div>}
    </Panel>
  );
}
