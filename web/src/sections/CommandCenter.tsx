import { useEffect, useState } from 'react';
import { AGENT_IDS, TERMINAL_TASK_STATUSES, type SectionId } from '@tc/shared';
import { CoreView } from '../core/CoreView';
import { useCoreState } from '../core/useCoreState';
import { CommandBar } from '../components/CommandBar';
import { Markdown } from '../components/Markdown';
import { Dot, INTEGRATION_LABEL, Panel, StatusBadge, integrationDot } from '../components/ui';
import { ApprovalCard } from '../components/Approvals';
import { navigate, useStore } from '../lib/store';
import { api } from '../lib/api';
import { ago, clock } from '../lib/format';
import { voice } from '../voice/voice';

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  outcome: string;
}

export function CommandCenter() {
  const state = useCoreState();
  const reply = useStore((s) => s.reply);
  const chat = useStore((s) => (s.reply?.conversationId ? s.chat[s.reply.conversationId] : undefined));
  const approvals = useStore((s) => s.approvals);

  const liveText = reply?.pending ? chat?.text ?? '' : reply?.text ?? '';
  return (
    <div className="cc" data-testid="command-center">
      <div className="cc-col">
        <SystemStatusPanel />
        <AgentActivityPanel />
      </div>
      <div className="cc-center">
        <CoreView state={state} onTap={() => voice.speaking && voice.cancelSpeech()} />
        {(reply || approvals.length > 0) && (
          <div className="reply" aria-live="polite" data-testid="reply">
            {approvals.slice(0, 1).map((a) => (
              <div key={a.id} style={{ marginBottom: 10 }}>
                <ApprovalCard a={a} compact />
              </div>
            ))}
            {reply && (
              <>
                <div className="tiny muted mono" style={{ marginBottom: 4 }}>
                  {reply.from === 'core' ? 'CORE INTELLIGENCE' : 'SYSTEM'} · {clock(new Date(reply.at).toISOString())}
                  {reply.pending && chat && !chat.text && chat.tools.length > 0 && ` · ${chat.tools[chat.tools.length - 1].summary ?? chat.tools[chat.tools.length - 1].tool}`}
                </div>
                {reply.pending && !liveText ? <div className="small muted">{chat?.thinking ? 'Reasoning…' : 'Working…'}</div> : <Markdown text={liveText} />}
                {reply.conversationId && !reply.pending && (
                  <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => navigate('intelligence', String(reply.conversationId))}>
                    Open conversation
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <CommandBar />
      </div>
      <div className="cc-col">
        <MissionsPanel />
        <ResearchPanel />
        <AppsPanel />
        <NotificationsPanel />
        <HistoryPanel />
      </div>
    </div>
  );
}

function SystemStatusPanel() {
  const status = useStore((s) => s.status);
  const ws = useStore((s) => s.ws);
  const rows: [string, string, 'ok' | 'warn' | 'err' | 'off' | 'live'][] = status
    ? [
        ['Server link', ws === 'live' ? 'Live' : ws, ws === 'live' ? 'live' : 'err'],
        ['Claude', `${INTEGRATION_LABEL[status.ai.state]}`, integrationDot(status.ai.state)],
        ['Model', status.ai.model, 'off'],
        ['Browser engine', status.browser.available ? 'Remote Chromium' : 'Reader only', status.browser.available ? 'ok' : 'warn'],
        ['Desktop bridge', status.bridge.connected ? `${status.bridge.connected} connected` : 'None connected', status.bridge.connected ? 'ok' : 'off'],
        ['Active missions', String(status.tasks.active), status.tasks.active ? 'live' : 'off'],
        ['Awaiting approval', String(status.tasks.awaitingApproval), status.tasks.awaitingApproval ? 'warn' : 'off'],
        ['Memories', String(status.memory.count), 'off'],
        ['Database', status.db.ok ? 'OK' : 'Error', status.db.ok ? 'ok' : 'err'],
      ]
    : [];
  return (
    <Panel title="System status" idx="01">
      {!status && <div className="empty">Waiting for the server…</div>}
      <div className="list">
        {rows.map(([k, v, d]) => (
          <div key={k} className="list-item" style={{ minHeight: 34, padding: '6px 2px' }}>
            <Dot kind={d} />
            <span className="small muted" style={{ flex: 1 }}>{k}</span>
            <span className="small mono ellipsis" style={{ maxWidth: 140 }}>{v}</span>
          </div>
        ))}
      </div>
      {status && <div className="tiny muted mono" style={{ marginTop: 6 }}>v{status.version} · up {Math.floor(status.uptimeSec / 3600)}h {Math.floor((status.uptimeSec % 3600) / 60)}m</div>}
    </Panel>
  );
}

function AgentActivityPanel() {
  const agents = useStore((s) => s.agents);
  const activity = useStore((s) => s.activity);
  return (
    <Panel title="Agent activity" idx="02" actions={<button className="btn ghost sm" onClick={() => navigate('agents')}>All</button>}>
      <div className="list">
        {AGENT_IDS.map((id) => {
          const a = agents.find((x) => x.id === id);
          if (!a) return null;
          const last = [...activity].reverse().find((x) => x.agent === id && Date.now() - x.at < 30_000);
          const busy = a.status !== 'idle';
          return (
            <div key={id} className="list-item clickable" style={{ minHeight: 44 }} onClick={() => (a.currentTaskId ? navigate('missions', String(a.currentTaskId)) : navigate(id === 'spider' ? 'spider' : 'agents'))}>
              <Dot kind={a.status === 'error' ? 'err' : a.status === 'waiting' ? 'warn' : busy ? 'live' : 'off'} pulse={busy && a.status !== 'waiting'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small"><span className="mono muted">{a.code.replace('AGENT ', '')}</span> {a.name}</div>
                <div className="tiny muted ellipsis">{last?.label ?? (busy ? a.status : 'Idle')}</div>
              </div>
              {a.currentTaskId && <span className="badge cyan">#{a.currentTaskId}</span>}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function MissionsPanel() {
  const tasks = useStore((s) => s.tasks);
  const active = Object.values(tasks).filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status)).sort((a, b) => b.id - a.id);
  return (
    <Panel title="Active missions" idx="03" actions={<button className="btn ghost sm" onClick={() => navigate('missions')}>All</button>}>
      {active.length === 0 && <div className="empty">No active missions.</div>}
      <div className="list">
        {active.slice(0, 6).map((t) => (
          <div key={t.id} className="list-item clickable" onClick={() => navigate('missions', String(t.id))}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small ellipsis">#{t.id} {t.title}</div>
              <div className="tiny muted">{t.agent} · {ago(t.updatedAt)}</div>
            </div>
            <StatusBadge status={t.status} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ResearchPanel() {
  const tasks = useStore((s) => s.tasks);
  const activity = useStore((s) => s.activity);
  const research = Object.values(tasks).filter((t) => t.agent === 'research').sort((a, b) => b.id - a.id).slice(0, 3);
  const live = [...activity].reverse().filter((a) => a.kind === 'research' && Date.now() - a.at < 20_000).slice(0, 3);
  return (
    <Panel title="Research activity" idx="04" actions={<button className="btn ghost sm" onClick={() => navigate('research')}>Open</button>}>
      {live.map((a, i) => (
        <div key={i} className="tiny mono" style={{ color: 'var(--cyan)' }}>▸ {a.label}</div>
      ))}
      {research.length === 0 && live.length === 0 && <div className="empty">No research yet.</div>}
      <div className="list">
        {research.map((t) => (
          <div key={t.id} className="list-item clickable" onClick={() => navigate('missions', String(t.id))}>
            <div className="small ellipsis" style={{ flex: 1 }}>{t.title}</div>
            <StatusBadge status={t.status} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

function AppsPanel() {
  const integrations = useStore((s) => s.integrations);
  return (
    <Panel title="Connected apps" idx="05" actions={<button className="btn ghost sm" onClick={() => navigate('apps')}>Manage</button>}>
      <div className="row" style={{ gap: 6 }}>
        {integrations.map((i) => (
          <span key={i.id} className="chip" title={`${i.name}: ${INTEGRATION_LABEL[i.state]}${i.lastError ? ` — ${i.lastError}` : ''}`}>
            <Dot kind={integrationDot(i.state)} /> {i.name.replace(/ \(.*\)/, '').replace('Anthropic ', '')}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function NotificationsPanel() {
  const notifications = useStore((s) => s.notifications);
  return (
    <Panel title="Notifications" idx="06">
      {notifications.length === 0 && <div className="empty">All quiet.</div>}
      <div className="list">
        {notifications.slice(0, 5).map((n) => (
          <div key={n.id} className="list-item clickable" style={{ minHeight: 40 }} onClick={() => n.link && navigate(n.link.split('/')[0] as SectionId, n.link.split('/')[1] ?? null)}>
            <Dot kind={n.level === 'error' ? 'err' : n.level === 'warning' ? 'warn' : n.level === 'success' ? 'ok' : 'live'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small ellipsis">{n.title}</div>
              <div className="tiny muted ellipsis">{n.body}</div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function HistoryPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const tasks = useStore((s) => s.tasks);
  useEffect(() => {
    api.get<AuditRow[]>('/api/audit?limit=12').then(setRows).catch(() => {});
  }, [Object.keys(tasks).length]);
  return (
    <Panel title="Execution history" idx="07" actions={<button className="btn ghost sm" onClick={() => navigate('settings', 'audit')}>Audit log</button>}>
      {rows.length === 0 && <div className="empty">Nothing recorded yet.</div>}
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="list-item" style={{ minHeight: 34, padding: '5px 2px' }}>
            <Dot kind={r.outcome === 'ok' ? 'ok' : r.outcome === 'error' ? 'err' : r.outcome === 'denied' ? 'warn' : 'off'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="tiny mono ellipsis">{r.action}</div>
              <div className="tiny muted ellipsis">{r.actor}{r.target ? ` · ${r.target}` : ''}</div>
            </div>
            <span className="tiny muted">{ago(r.at)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
