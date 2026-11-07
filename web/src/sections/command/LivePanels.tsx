import { useMemo } from 'react';
import { AGENT_IDS, type AgentInfo } from '@tc/shared';
import { Panel } from '../../components/ui';
import { navigate, useStore } from '../../lib/store';
import { AGENT_STATUS_LABEL, type OpenSheet } from './util';

/** Real-time stream of agent activity events as they arrive over the WebSocket (newest first). */
export function EventStream() {
  const activity = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const rows = useMemo(() => [...activity].reverse().slice(0, 24), [activity]);
  const code = (id: string) => agents.find((a) => a.id === id)?.code.replace('AGENT ', '') ?? '··';
  return (
    <Panel title="Event stream" idx="1B" className="event-stream">
      {rows.length === 0 && <div className="empty small">Waiting for agent events — they appear here the moment Claude or an agent acts.</div>}
      <div className="estream" role="log" aria-live="off">
        {rows.map((e) => (
          <div key={`${e.at}-${e.agent}-${e.kind}`} className={`ev ${e.kind}`} onClick={() => e.taskId && navigate('missions', String(e.taskId))}>
            <span className="t mono">{new Date(e.at).toLocaleTimeString('en-GB')}</span>
            <span className="a mono">{code(e.agent)}</span>
            <span className="k">{e.kind}</span>
            <span className="l ellipsis">{e.label ?? ''}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Compact roster in the hero: which agents are working right now (actual server status). */
export function AgentPulse({ open }: { open: OpenSheet }) {
  const agents = useStore((s) => s.agents);
  const activity = useStore((s) => s.activity);
  const ordered = useMemo(() => AGENT_IDS.map((id) => agents.find((a) => a.id === id)).filter((a): a is AgentInfo => !!a), [agents]);
  const working = ordered.filter((a) => a.status !== 'idle').length;
  return (
    <Panel title="Agents" idx="2B" className="agent-pulse" actions={<span className="tiny muted mono">{working ? `${working} active` : 'all idle'}</span>}>
      <div className="list">
        {ordered.map((a) => {
          const last = [...activity].reverse().find((x) => x.agent === a.id && Date.now() - x.at < 30_000);
          return (
            <div key={a.id} className={`pulse-row ${a.status}`} onClick={() => open({ kind: 'agent', id: a.id })} data-testid={`pulse-${a.id}`}>
              <span className="agent-code mono sm">{a.code.replace('AGENT ', '')}</span>
              <span className="small ellipsis name">{a.name}</span>
              <span className="tiny muted ellipsis what">{last?.label ?? (a.currentTaskId ? `#${a.currentTaskId}` : '')}</span>
              <span className={`agent-status ${a.status}`} title={AGENT_STATUS_LABEL[a.status]}><i /></span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
