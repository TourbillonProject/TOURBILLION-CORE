import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentId, AIDiagnostics, IntegrationStatus, TaskRecord } from '@tc/shared';
import { TERMINAL_TASK_STATUSES } from '@tc/shared';
import { ActionButton, Dot, INTEGRATION_LABEL, Sheet, StatusBadge, integrationDot } from '../../components/ui';
import { AnimatedNumber, HoloLoader, Progress, Sparkline } from '../../components/viz';
import { STATE_LABEL, coreStats } from '../../core/params';
import { useCoreState } from '../../core/useCoreState';
import { emptyArray, navigate, setState, toast, useStore } from '../../lib/store';
import { api, errMsg } from '../../lib/api';
import { ago, clock, dateTime } from '../../lib/format';
import { AGENT_STATUS_LABEL, duration, missionProgress, uptime, type SheetTarget } from './util';
import { AppGlyph, APP_SHORT } from './AppsGrid';

export function DiagnosticsSheet({ target, onClose, open }: { target: SheetTarget; onClose: () => void; open: (t: SheetTarget) => void }) {
  switch (target.kind) {
    case 'ai':
      return <AIDiag onClose={onClose} />;
    case 'integration':
      return <IntegrationDiag id={target.id} onClose={onClose} open={open} />;
    case 'mission':
      return <MissionDiag id={target.id} onClose={onClose} />;
    case 'link':
      return <LinkDiag onClose={onClose} />;
    case 'agent':
      return <AgentDiag id={target.id} onClose={onClose} open={open} />;
  }
}

function KV({ k, children, tone }: { k: string; children: ReactNode; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <div className={`kv-tile ${tone ?? ''}`}>
      <div className="tiny muted label">{k}</div>
      <div className="mono small">{children}</div>
    </div>
  );
}

const ms = (v: number | null) => (v == null ? 'none yet' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

function AIDiag({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<AIDiagnostics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [stats, setStats] = useState({ ...coreStats });
  const state = useCoreState();
  useEffect(() => {
    const load = () =>
      api
        .get<AIDiagnostics>('/api/ai/diagnostics')
        .then((x) => {
          setD(x);
          setErr(null);
        })
        .catch((e) => setErr(errMsg(e)));
    void load();
    const a = setInterval(load, 4000);
    const b = setInterval(() => setStats({ ...coreStats }), 1000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, []);
  return (
    <Sheet title="AI core diagnostics" onClose={onClose} wide>
      <div className="diag" data-testid="ai-diagnostics">
        <div className="diag-head">
          <span className={`core-orb ${state}`} />
          <div>
            <div className="display">TOURBILLION CORE · {STATE_LABEL[state]}</div>
            <div className="tiny muted">Live state derived from voice, chat streams, agent events and missions.</div>
          </div>
        </div>
        {err && <div className="diag-err">Diagnostics unavailable: {err}</div>}
        {!d && !err && <HoloLoader label="Reading diagnostics…" />}
        {d && (
          <>
            <div className="tiny muted label">INTELLIGENCE</div>
            <div className="kv-grid">
              <KV k="Provider">{d.provider}</KV>
              <KV k="Model">{d.model}</KV>
              <KV k="Connection" tone={d.state === 'connected' ? 'ok' : d.state === 'error' ? 'err' : 'warn'}>{INTEGRATION_LABEL[d.state]}</KV>
              <KV k="Reasoning effort">{d.effort}</KV>
              <KV k="Last response time">{ms(d.lastLatencyMs)}</KV>
              <KV k="Time to first token">{ms(d.lastFirstTokenMs)}</KV>
              <KV k="Turns since start"><AnimatedNumber value={d.turnsSinceStart} /></KV>
              <KV k="Errors since start" tone={d.errorsSinceStart ? 'warn' : undefined}><AnimatedNumber value={d.errorsSinceStart} /></KV>
              <KV k="Active runs"><AnimatedNumber value={d.activeRuns} /></KV>
              <KV k="Last turn">{d.lastTurnAt ? `${clock(d.lastTurnAt)} · ${ago(d.lastTurnAt)}` : 'none yet'}</KV>
            </div>
            <div className="tiny muted label">TOKENS TODAY (UTC)</div>
            <div className="kv-grid">
              <KV k="Input"><AnimatedNumber value={d.tokensToday.input} format={(n) => Math.round(n).toLocaleString('en-GB')} /></KV>
              <KV k="Output"><AnimatedNumber value={d.tokensToday.output} format={(n) => Math.round(n).toLocaleString('en-GB')} /></KV>
              <KV k="Cache reads"><AnimatedNumber value={d.tokensToday.cacheRead} format={(n) => Math.round(n).toLocaleString('en-GB')} /></KV>
              <KV k="Web searches"><AnimatedNumber value={d.tokensToday.webSearches} /></KV>
            </div>
            {d.lastError && <div className="diag-err">Last error: {d.lastError}</div>}
          </>
        )}
        <div className="tiny muted label">CORE RENDERER (THIS DEVICE)</div>
        <div className="kv-grid">
          <KV k="Engine">{stats.engine === '3d' ? 'WebGL 3D' : stats.engine === '2d' ? 'Canvas 2D' : 'Static'}</KV>
          <KV k="Graphics quality">{stats.quality}</KV>
          <KV k="Frame rate">{stats.fps ? `${stats.fps} fps` : 'measuring…'}</KV>
          <KV k="Pixel ratio">{stats.pixelRatio.toFixed(2)}</KV>
          <KV k="Bloom">{stats.bloom ? 'on' : 'off'}</KV>
          <KV k="Particles">{stats.particles.toLocaleString('en-GB')}</KV>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => { onClose(); navigate('intelligence'); }}>Open Intelligence</button>
          <button className="btn sm ghost" onClick={() => { onClose(); navigate('settings'); }}>Graphics & AI settings</button>
        </div>
      </div>
    </Sheet>
  );
}

function IntegrationDiag({ id, onClose, open }: { id: string; onClose: () => void; open: (t: SheetTarget) => void }) {
  const i = useStore((s) => s.integrations.find((x) => x.id === id));
  if (!i) {
    return (
      <Sheet title="Integration" onClose={onClose}>
        <div className="empty">Unknown integration.</div>
      </Sheet>
    );
  }
  const test = async () => {
    try {
      const s = await api.post<IntegrationStatus>(`/api/integrations/${id}/test`, {});
      setState((st) => ({ integrations: st.integrations.map((x) => (x.id === id ? s : x)) }));
      toast(s.state === 'connected' ? 'success' : 'warning', `${APP_SHORT[id] ?? s.name}: ${INTEGRATION_LABEL[s.state]}`, s.lastError ?? '');
    } catch (e) {
      toast('error', 'Test failed', errMsg(e));
    }
  };
  const details = Object.entries(i.details ?? {});
  return (
    <Sheet title={`${APP_SHORT[id] ?? i.name} diagnostics`} onClose={onClose}>
      <div className="diag" data-testid="integration-diagnostics">
        <div className="diag-head">
          <AppGlyph id={id} size={30} />
          <div style={{ minWidth: 0 }}>
            <div className="display">{i.name}</div>
            <div className="tiny muted">{i.description}</div>
          </div>
        </div>
        <div className="kv-grid">
          <KV k="State" tone={i.state === 'connected' ? 'ok' : i.state === 'error' ? 'err' : i.state === 'not_configured' ? undefined : 'warn'}>
            <Dot kind={integrationDot(i.state)} /> {INTEGRATION_LABEL[i.state]}
          </KV>
          <KV k="Last success">{i.lastSuccessAt ? `${dateTime(i.lastSuccessAt)} · ${ago(i.lastSuccessAt)}` : 'never'}</KV>
          <KV k="Requires">{i.requires.length ? i.requires.join(', ') : 'nothing further'}</KV>
          <KV k="Permissions">{i.permissions.length ? i.permissions.join(', ') : '—'}</KV>
        </div>
        {i.lastError && <div className="diag-err">Last error: {i.lastError}</div>}
        {details.length > 0 && (
          <>
            <div className="tiny muted label">DETAILS REPORTED BY THE SERVER</div>
            <div className="kv-grid">
              {details.map(([k, v]) => (
                <KV key={k} k={k}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</KV>
              ))}
            </div>
          </>
        )}
        <div className="row">
          {i.state !== 'not_configured' && <ActionButton className="btn sm primary" onClick={test}>Test connection</ActionButton>}
          {id === 'claude' && <button className="btn sm" onClick={() => open({ kind: 'ai' })}>AI diagnostics</button>}
          <button className="btn sm ghost" onClick={() => { onClose(); navigate('apps'); }}>Manage in Connected Apps</button>
        </div>
      </div>
    </Sheet>
  );
}

function MissionDiag({ id, onClose }: { id: number; onClose: () => void }) {
  const task = useStore((s) => s.tasks[id]);
  const live = useStore((s) => s.taskSteps[id]) ?? emptyArray();
  const [d, setD] = useState<TaskRecord | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<TaskRecord>(`/api/missions/${id}`).then(setD).catch((e) => setErr(errMsg(e)));
  }, [id, task?.status]);
  const t = d ?? task;
  const steps = useMemo(() => ((d?.steps.length ?? 0) >= live.length ? d?.steps ?? [] : live), [d, live]);
  if (!t) {
    return (
      <Sheet title={`Mission #${id}`} onClose={onClose}>
        {err ? <div className="diag-err">{err}</div> : <HoloLoader label="Loading mission…" />}
      </Sheet>
    );
  }
  const terminal = TERMINAL_TASK_STATUSES.includes(t.status);
  const prog = missionProgress({ ...t, status: task?.status ?? t.status }, steps);
  return (
    <Sheet title={`Mission #${id}`} onClose={onClose} wide>
      <div className="diag" data-testid="mission-history">
        <div className="row between nowrap">
          <div className="display ellipsis">{t.title}</div>
          <StatusBadge status={task?.status ?? t.status} />
        </div>
        <Progress pct={prog.pct} tone={t.status === 'failed' ? 'red' : t.status === 'completed' ? 'green' : 'cyan'} label={prog.label} />
        <div className="kv-grid">
          <KV k="Agent">{t.agent}</KV>
          <KV k="Created">{dateTime(t.createdAt)}</KV>
          <KV k="Started">{t.startedAt ? dateTime(t.startedAt) : 'not yet'}</KV>
          <KV k={terminal ? 'Duration' : 'Running for'}>{duration(t.startedAt ?? t.createdAt, terminal ? t.finishedAt ?? t.updatedAt : null)}</KV>
        </div>
        {t.plan && (
          <>
            <div className="tiny muted label">PLAN</div>
            <ol className="small plan">{t.plan.steps.map((s, i) => <li key={i}>{s.title}</li>)}</ol>
          </>
        )}
        <div className="tiny muted label">EXECUTION HISTORY · {steps.length} entr{steps.length === 1 ? 'y' : 'ies'}</div>
        <div className="timeline history">
          {steps.length === 0 && <div className="tiny muted">No steps recorded yet.</div>}
          {steps.map((s, i) => (
            <div key={i} className={`tl-item ${s.kind}`} style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}>
              <div className="tiny mono muted">{clock(s.at)} · {s.kind.replace('_', ' ')}</div>
              <div className="small">{s.message}</div>
            </div>
          ))}
          {!terminal && <div className="tl-item"><span className="dot live pulse" /> <span className="tiny muted">In progress…</span></div>}
        </div>
        {t.verification && <div className={`verify ${t.verification.outcome}`}><b>Verification: {t.verification.outcome}</b> — {t.verification.summary}</div>}
        {t.error && <div className="diag-err">{t.error}</div>}
        <div className="row">
          <button className="btn sm primary" onClick={() => { onClose(); navigate('missions', String(id)); }}>Open in Missions</button>
        </div>
      </div>
    </Sheet>
  );
}

function LinkDiag({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const link = useStore((s) => s.link);
  const status = useStore((s) => s.status);
  const meta = useStore((s) => s.telemetryMeta);
  const online = useStore((s) => s.online);
  const h = link.history;
  const stats = h.length ? { min: Math.min(...h), max: Math.max(...h), avg: Math.round(h.reduce((a, b) => a + b, 0) / h.length) } : null;
  return (
    <Sheet title="Server link diagnostics" onClose={onClose}>
      <div className="diag" data-testid="link-diagnostics">
        <div className="kv-grid">
          <KV k="Realtime link" tone={ws === 'live' ? 'ok' : ws === 'offline' ? 'err' : 'warn'}>{ws === 'live' ? 'Live (WebSocket)' : ws === 'connecting' ? 'Connecting' : 'Offline'}</KV>
          <KV k="Round trip now">{link.latencyMs == null ? 'n/a' : `${link.latencyMs} ms`}</KV>
          <KV k="Min / avg / max">{stats ? `${stats.min} / ${stats.avg} / ${stats.max} ms` : 'no samples yet'}</KV>
          <KV k="Device network">{online ? 'online' : 'offline'}</KV>
          <KV k="Server version">{status ? `v${status.version}` : '—'}</KV>
          <KV k="Server uptime">{status ? uptime(status.uptimeSec) : '—'}</KV>
          <KV k="Database" tone={status ? (status.db.ok ? 'ok' : 'err') : undefined}>{status ? (status.db.ok ? 'OK' : 'Error') : '—'}</KV>
          {meta && <KV k="Host">{meta.host.platform} · {meta.host.cores} cores · Node {meta.host.node}</KV>}
          {meta && <KV k="CPU model">{meta.host.cpuModel || 'not reported'}</KV>}
          {meta && <KV k="Network counters">{meta.capabilities.network ? 'available' : 'not available on this host'}</KV>}
        </div>
        <div className="tiny muted label">ROUND-TRIP HISTORY (PING EVERY 5 S)</div>
        <Sparkline values={h} height={40} label="Round-trip history" />
      </div>
    </Sheet>
  );
}

function AgentDiag({ id, onClose, open }: { id: AgentId; onClose: () => void; open: (t: SheetTarget) => void }) {
  const a = useStore((s) => s.agents.find((x) => x.id === id));
  const tasks = useStore((s) => s.tasks);
  const activity = useStore((s) => s.activity);
  const mine = useMemo(() => Object.values(tasks).filter((t) => t.agent === id).sort((x, y) => y.id - x.id).slice(0, 8), [tasks, id]);
  const events = useMemo(() => activity.filter((x) => x.agent === id).slice(-10).reverse(), [activity, id]);
  if (!a) {
    return (
      <Sheet title="Agent" onClose={onClose}>
        <div className="empty">Unknown agent.</div>
      </Sheet>
    );
  }
  return (
    <Sheet title={`${a.code} · ${a.name}`} onClose={onClose}>
      <div className="diag" data-testid="agent-diagnostics">
        <div className="tiny muted">{a.role}</div>
        <div className="kv-grid">
          <KV k="Status" tone={a.status === 'error' ? 'err' : a.status === 'waiting' ? 'warn' : a.status === 'idle' ? undefined : 'ok'}>{AGENT_STATUS_LABEL[a.status]}</KV>
          <KV k="Current mission">{a.currentTaskId ? `#${a.currentTaskId}` : 'none'}</KV>
          <KV k="Last active">{a.lastActiveAt ? `${clock(a.lastActiveAt)} · ${ago(a.lastActiveAt)}` : 'not since the server started'}</KV>
          <KV k="Tools">{a.tools.length}</KV>
        </div>
        <div className="tiny muted label">RECENT ACTIVITY (THIS SESSION)</div>
        {events.length === 0 && <div className="tiny muted">No activity events received yet.</div>}
        {events.map((e, i) => (
          <div key={i} className="tiny mono">{new Date(e.at).toLocaleTimeString('en-GB')} · {e.kind}{e.label ? ` — ${e.label}` : ''}</div>
        ))}
        <div className="tiny muted label">MISSIONS</div>
        {mine.length === 0 && <div className="tiny muted">None yet.</div>}
        <div className="list">
          {mine.map((t) => (
            <div key={t.id} className="list-item clickable" onClick={() => open({ kind: 'mission', id: t.id })}>
              <span className="small ellipsis" style={{ flex: 1 }}>#{t.id} {t.title}</span>
              <StatusBadge status={t.status} />
            </div>
          ))}
        </div>
        <div className="tiny muted label">RESPONSIBILITIES</div>
        <ul className="small">{a.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
        <div className="row">
          <button className="btn sm" onClick={() => { onClose(); navigate(id === 'spider' ? 'spider' : 'agents'); }}>Open {id === 'spider' ? 'The Spider' : 'Agents'}</button>
        </div>
      </div>
    </Sheet>
  );
}
