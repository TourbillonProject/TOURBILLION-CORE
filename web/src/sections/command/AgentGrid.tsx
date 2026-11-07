import { useMemo, useState } from 'react';
import { AGENT_IDS, type AgentInfo } from '@tc/shared';
import { StatusBadge } from '../../components/ui';
import { Progress } from '../../components/viz';
import { Icon } from '../../components/icons';
import { emptyArray, navigate, useStore } from '../../lib/store';
import { ago, clock } from '../../lib/format';
import { AGENT_STATUS_LABEL, missionProgress, type OpenSheet } from './util';

/**
 * The seven agents with their *actual* runtime status from the server
 * (agent.status events) and their real current mission. Nothing here
 * animates as "working" unless the server says the agent is working.
 */
export function AgentGrid({ open }: { open: OpenSheet }) {
  const agents = useStore((s) => s.agents);
  const ordered = useMemo(() => AGENT_IDS.map((id) => agents.find((a) => a.id === id)).filter((a): a is AgentInfo => !!a), [agents]);
  if (ordered.length === 0) return <div className="empty">Waiting for the agent roster…</div>;
  return (
    <div className="agent-grid">
      {ordered.map((a, i) => (
        <AgentCard key={a.id} a={a} index={i} open={open} />
      ))}
      <NetworkSummary agents={ordered} />
    </div>
  );
}

/** Counts by actual runtime status (fills the eighth grid slot). */
function NetworkSummary({ agents }: { agents: AgentInfo[] }) {
  const tasks = useStore((s) => s.tasks);
  const count = (st: AgentInfo['status']) => agents.filter((a) => a.status === st).length;
  const running = Object.values(tasks).filter((t) => t.status === 'running' || t.status === 'planning').length;
  const cells: [string, number, string][] = [
    ['Working', count('working'), 'cyan'],
    ['Planning', count('planning'), 'violet'],
    ['Awaiting approval', count('waiting'), 'amber'],
    ['Error', count('error'), 'red'],
    ['Idle', count('idle'), ''],
  ];
  return (
    <article className="agent-card summary" style={{ animationDelay: `${agents.length * 60}ms` }}>
      <header className="row nowrap">
        <span className="agent-code mono">Σ</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="agent-name">Agent network</div>
          <div className="tiny muted">{agents.length} agents · {running} mission{running === 1 ? '' : 's'} in flight</div>
        </div>
      </header>
      <div className="summary-cells">
        {cells.map(([k, n, tone]) => (
          <div key={k} className={`cell ${tone} ${n ? 'on' : ''}`}>
            <span className="n mono">{n}</span>
            <span className="tiny muted">{k}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function AgentCard({ a, index, open }: { a: AgentInfo; index: number; open: OpenSheet }) {
  const [expanded, setExpanded] = useState(false);
  const task = useStore((s) => (a.currentTaskId ? s.tasks[a.currentTaskId] : undefined));
  const steps = useStore((s) => (a.currentTaskId ? s.taskSteps[a.currentTaskId] : undefined)) ?? emptyArray();
  const activity = useStore((s) => s.activity);
  const tasks = useStore((s) => s.tasks);
  const last = useMemo(() => [...activity].reverse().find((x) => x.agent === a.id), [activity, a.id]);
  const recent = useMemo(() => Object.values(tasks).filter((t) => t.agent === a.id).sort((x, y) => y.id - x.id).slice(0, 3), [tasks, a.id]);
  const prog = task ? missionProgress(task, steps.length ? steps : task.steps) : null;
  const liveLabel = last && Date.now() - last.at < 60_000 ? last.label ?? last.kind : null;
  const description = liveLabel ?? (a.status === 'idle' ? (a.lastActiveAt ? `Idle · last active ${ago(a.lastActiveAt)}` : 'Idle · no activity since the server started') : AGENT_STATUS_LABEL[a.status]);
  return (
    <article className={`agent-card ${a.status} ${expanded ? 'expanded' : ''}`} style={{ animationDelay: `${index * 60}ms` }} data-testid={`agent-card-${a.id}`}>
      <span className="energy" aria-hidden="true" />
      <header className="row nowrap" onClick={() => open({ kind: 'agent', id: a.id })} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open({ kind: 'agent', id: a.id })}>
        <span className="agent-code mono">{a.code.replace('AGENT ', '')}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="agent-name ellipsis">{a.name}</div>
          <div className="tiny muted ellipsis">{a.role}</div>
        </div>
        <span className={`agent-status ${a.status}`} aria-label={`Status: ${AGENT_STATUS_LABEL[a.status]}`}>
          <i />
          {AGENT_STATUS_LABEL[a.status]}
        </span>
      </header>
      <div className="agent-task">
        {task ? (
          <button className="link-btn small ellipsis" onClick={() => open({ kind: 'mission', id: task.id })}>
            <span className="mono muted">#{task.id}</span> {task.title}
          </button>
        ) : (
          <span className="small muted">No current mission</span>
        )}
      </div>
      <div className="tiny agent-activity ellipsis" title={description}>{description}</div>
      {prog ? <Progress pct={prog.pct} tone={a.status === 'waiting' ? 'amber' : a.status === 'error' ? 'red' : a.status === 'planning' ? 'violet' : 'cyan'} label={prog.label} /> : <div className="progress idle" aria-hidden="true"><div style={{ width: 0 }} /></div>}
      <footer className="row nowrap between">
        <span className="tiny muted mono">{a.lastActiveAt ? `LAST ${clock(a.lastActiveAt)}` : 'NO ACTIVITY YET'}</span>
        <button className="btn ghost sm expand" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} details for ${a.name}`}>
          Details <span className="chev"><Icon name="forward" size={14} /></span>
        </button>
      </footer>
      <div className="agent-details" aria-hidden={!expanded}>
        <div className="inner">
          <div className="tiny muted label">RESPONSIBILITIES</div>
          <ul className="tiny">{a.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
          <div className="tiny muted label">TOOLS · {a.tools.length}</div>
          <div className="tool-chips">{a.tools.slice(0, 10).map((t) => <span key={t} className="tchip">{t}</span>)}{a.tools.length > 10 && <span className="tchip">+{a.tools.length - 10}</span>}</div>
          <div className="tiny muted label">RECENT MISSIONS</div>
          {recent.length === 0 && <div className="tiny muted">None yet.</div>}
          {recent.map((t) => (
            <div key={t.id} className="row nowrap between recent" onClick={() => open({ kind: 'mission', id: t.id })}>
              <span className="tiny ellipsis">#{t.id} {t.title}</span>
              <StatusBadge status={t.status} />
            </div>
          ))}
          <button className="btn sm" onClick={() => navigate(a.id === 'spider' ? 'spider' : 'agents')}>Open {a.id === 'spider' ? 'The Spider' : 'agent view'}</button>
        </div>
      </div>
    </article>
  );
}
