import { useState } from 'react';
import type { AgentId } from '@tc/shared';
import { navigate, useStore } from '../lib/store';
import { Dot, Panel, StatusBadge } from '../components/ui';
import { NewMission } from './Missions';
import { ago } from '../lib/format';

export default function Agents() {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const activity = useStore((s) => s.activity);
  const [deploy, setDeploy] = useState<AgentId | null>(null);
  return (
    <div>
      <h2 className="section-title">Agent network</h2>
      <p className="section-sub">Six specialists coordinated by Core Intelligence through one orchestrator: a shared mission queue, a single permission gate and one audit trail. Agents cannot grant themselves permissions.</p>
      {deploy && <div style={{ marginBottom: 14 }}><NewMission agent={deploy} onClose={() => setDeploy(null)} /></div>}
      <div className="grid auto">
        {agents.map((a) => {
          const recent = Object.values(tasks).filter((t) => t.agent === a.id).sort((x, y) => y.id - x.id).slice(0, 3);
          const last = [...activity].reverse().find((x) => x.agent === a.id);
          return (
            <Panel key={a.id} title={a.name} idx={a.code.replace('AGENT ', '')} actions={<span className="chip"><Dot kind={a.status === 'error' ? 'err' : a.status === 'waiting' ? 'warn' : a.status === 'idle' ? 'off' : 'live'} pulse={a.status === 'working' || a.status === 'planning'} />{a.status.toUpperCase()}</span>}>
              <div className="small muted" style={{ marginBottom: 8 }}>{a.role}</div>
              <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                {a.responsibilities.map((r) => <li key={r}>{r}</li>)}
              </ul>
              <details style={{ marginBottom: 8 }}>
                <summary className="tiny muted" style={{ cursor: 'pointer' }}>{a.tools.length} tools</summary>
                <div className="row" style={{ gap: 4, marginTop: 6 }}>{a.tools.map((t) => <span key={t} className="badge">{t}</span>)}</div>
              </details>
              {last && <div className="tiny mono" style={{ color: 'var(--cyan)', marginBottom: 6 }}>▸ {last.label ?? last.kind} · {ago(new Date(last.at).toISOString())}</div>}
              {recent.length > 0 && (
                <div className="list" style={{ marginBottom: 8 }}>
                  {recent.map((t) => (
                    <div key={t.id} className="list-item clickable" style={{ minHeight: 36 }} onClick={() => navigate('missions', String(t.id))}>
                      <span className="small ellipsis" style={{ flex: 1 }}>#{t.id} {t.title}</span>
                      <StatusBadge status={t.status} />
                    </div>
                  ))}
                </div>
              )}
              <div className="row">
                {a.id !== 'core' && <button className="btn sm primary" onClick={() => setDeploy(a.id)}>Deploy</button>}
                {a.id === 'core' && <button className="btn sm" onClick={() => navigate('intelligence')}>Converse</button>}
                {a.id === 'spider' && <button className="btn sm" onClick={() => navigate('spider')}>Spider console</button>}
                {a.id === 'research' && <button className="btn sm" onClick={() => navigate('research')}>Research desk</button>}
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
