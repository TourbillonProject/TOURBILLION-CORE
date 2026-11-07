import { useEffect, useState } from 'react';
import { AGENT_IDS, TERMINAL_TASK_STATUSES, type AgentId, type ApprovalRecord, type TaskRecord, type TaskStep } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { navigate, toast, useStore } from '../lib/store';
import { ActionButton, Diff, Empty, Field, Json, Panel, Seg, StatusBadge } from '../components/ui';
import { ApprovalCard } from '../components/Approvals';
import { Markdown } from '../components/Markdown';
import { clock, dateTime, ago } from '../lib/format';

interface MissionDetail extends TaskRecord {
  params: Record<string, unknown>;
  artifacts: { id: number; kind: string; title: string; createdAt: string; data: unknown }[];
  approvals: ApprovalRecord[];
  patches: { id: number; title: string; status: string; files: { path: string; diff: string }[] }[];
  usage: Record<string, number> | null;
}

export default function Missions() {
  const param = useStore((s) => s.sectionParam);
  const tasks = useStore((s) => s.tasks);
  const [filter, setFilter] = useState<'active' | 'all'>('all');
  const [showNew, setShowNew] = useState(false);
  const list = Object.values(tasks)
    .filter((t) => filter === 'all' || !TERMINAL_TASK_STATUSES.includes(t.status))
    .sort((a, b) => b.id - a.id);
  const selected = param && /^\d+$/.test(param) ? Number(param) : null;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', alignItems: 'start' }}>
      <Panel title="Missions" idx="MS" actions={<button className="btn sm primary" onClick={() => setShowNew(true)}>New</button>}>
        <div style={{ marginBottom: 8 }}>
          <Seg value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }]} />
        </div>
        {list.length === 0 && <Empty>No missions.</Empty>}
        <div className="list">
          {list.map((t) => (
            <div key={t.id} className={`list-item clickable ${t.id === selected ? 'selected' : ''}`} onClick={() => navigate('missions', String(t.id))} data-testid={`mission-${t.id}`}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small ellipsis">#{t.id} {t.title}</div>
                <div className="tiny muted">{t.agent} · {t.kind === 'playbook' ? t.playbook : 'AI mission'} · {ago(t.updatedAt)}</div>
              </div>
              <StatusBadge status={t.status} />
            </div>
          ))}
        </div>
      </Panel>
      <div className="stack">
        {showNew && <NewMission onClose={() => setShowNew(false)} />}
        {selected ? <MissionView key={selected} id={selected} /> : !showNew && <Panel><Empty>Select a mission, or create one.</Empty></Panel>}
      </div>
    </div>
  );
}

export function NewMission({ onClose, agent: initialAgent }: { onClose: () => void; agent?: AgentId }) {
  const [agent, setAgent] = useState<AgentId>(initialAgent ?? 'research');
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState('');
  const [projectId, setProjectId] = useState<number | ''>('');
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([]);
  const ai = useStore((s) => s.integrations.find((i) => i.id === 'claude')?.state);
  useEffect(() => {
    api.get<{ id: number; name: string }[]>('/api/projects').then(setProjects).catch(() => {});
  }, []);
  return (
    <Panel title="New AI mission" idx="+">
      {ai === 'not_configured' && <div className="small" style={{ color: 'var(--amber)', marginBottom: 8 }}>Claude is not connected: AI missions cannot be planned. Playbook missions (Spider inspection, OSINT reports, diagnostics) work without it.</div>}
      <div className="stack">
        <Field label="Agent">
          <select className="select" value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
            {AGENT_IDS.filter((a) => a !== 'core').map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short mission name" /></Field>
        <Field label="Request"><textarea className="textarea" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="What should the agent do? Include scope and the result you expect." /></Field>
        {(agent === 'spider' || agent === 'developer') && (
          <Field label="Project">
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose a project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <div className="row">
          <ActionButton className="btn primary" disabled={!title.trim() || request.trim().length < 3} onClick={async () => {
            try {
              const t = await api.post<TaskRecord>('/api/missions', { agent, title, request, projectId: projectId || null });
              onClose();
              navigate('missions', String(t.id));
            } catch (err) {
              toast('error', 'Mission not created', errMsg(err));
            }
          }}>Deploy agent</ActionButton>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
        <div className="tiny muted">The agent plans first. Plans with side effects wait for your approval; sensitive actions always ask individually.</div>
      </div>
    </Panel>
  );
}

function MissionView({ id }: { id: number }) {
  const [m, setM] = useState<MissionDetail | null>(null);
  const live = useStore((s) => s.tasks[id]);
  const liveSteps = useStore((s) => s.taskSteps[id]);
  const approvals = useStore((s) => s.approvals.filter((a) => a.taskId === id));
  const load = () => api.get<MissionDetail>(`/api/missions/${id}`).then(setM).catch((e) => toast('error', 'Could not load mission', errMsg(e)));
  useEffect(() => {
    void load();
  }, [id, live?.status, live?.updatedAt]);
  if (!m) return <Panel><Empty>Loading…</Empty></Panel>;
  const steps: TaskStep[] = m.steps.length >= (liveSteps?.length ?? 0) ? m.steps : liveSteps ?? m.steps;
  const status = live?.status ?? m.status;
  const terminal = TERMINAL_TASK_STATUSES.includes(status);
  const planSteps = m.plan?.steps ?? [];
  return (
    <div className="stack" data-testid="mission-view">
      <Panel title={`Mission #${m.id}`} idx="MV" actions={
        <div className="row">
          <StatusBadge status={status} />
          {!terminal && <ActionButton className="btn sm danger" onClick={() => api.post(`/api/missions/${id}/cancel`, {})}>Cancel</ActionButton>}
          {terminal && <ActionButton className="btn sm" onClick={async () => { const t = await api.post<TaskRecord>(`/api/missions/${id}/retry`, {}); navigate('missions', String(t.id)); }}>Retry</ActionButton>}
        </div>
      }>
        <div className="stack small">
          <div className="display" style={{ fontSize: 17 }}>{m.title}</div>
          <div className="row tiny muted"><span>Agent: <b className="mono">{m.agent}</b></span><span>Type: {m.kind === 'playbook' ? `playbook ${m.playbook}` : 'AI mission'}</span><span>Created {dateTime(m.createdAt)}</span>{m.finishedAt && <span>Finished {dateTime(m.finishedAt)}</span>}</div>
          <div><div className="tiny muted">Request</div><div style={{ whiteSpace: 'pre-wrap' }}>{m.request}</div></div>
          {m.interpretation && <div><div className="tiny muted">Interpretation</div>{m.interpretation}</div>}
          {m.error && <div style={{ color: 'var(--red)' }}>{m.error}</div>}
          {m.usage && <div className="tiny muted mono">Tokens: {m.usage.inputTokens ?? 0} in · {m.usage.outputTokens ?? 0} out · cache read {m.usage.cacheReadTokens ?? 0}{m.usage.webSearches ? ` · web searches ${m.usage.webSearches}` : ''}</div>}
        </div>
      </Panel>
      {approvals.map((a) => <ApprovalCard key={a.id} a={a} />)}
      {m.plan && (
        <Panel title="Execution plan" idx="PL">
          <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
            {planSteps.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s.title} {s.risk && s.risk !== 'read' && <span className={`badge ${s.risk === 'sensitive' ? 'red' : 'amber'}`}>{s.risk}</span>}{s.detail && <div className="tiny muted">{s.detail}</div>}</li>)}
          </ol>
          {m.plan.requiredPermissions.length > 0 && <div className="tiny" style={{ marginTop: 8 }}>Required permissions: {m.plan.requiredPermissions.map((p) => `${p.tool} (${p.risk})`).join(', ')}</div>}
          {m.plan.successCriteria.length > 0 && <div className="tiny muted" style={{ marginTop: 4 }}>Success criteria: {m.plan.successCriteria.join(' · ')}</div>}
        </Panel>
      )}
      <Panel title="Execution steps" idx="ST">
        <div className="timeline">
          {steps.map((s, i) => (
            <div key={i} className={`tl-item ${s.kind}`}>
              <div className="tiny mono muted">{clock(s.at)} · {s.kind}</div>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{s.message}</div>
            </div>
          ))}
          {!terminal && <div className="tl-item"><span className="dot live pulse" /> <span className="tiny muted">In progress…</span></div>}
        </div>
      </Panel>
      {m.verification && (
        <Panel title="Verification" idx="VF">
          <div className="row" style={{ marginBottom: 6 }}><span className={`badge ${m.verification.outcome === 'succeeded' ? 'green' : m.verification.outcome === 'failed' ? 'red' : 'amber'}`}>{m.verification.outcome}</span><span className="small">{m.verification.summary}</span></div>
          {m.verification.evidence.length > 0 && <div className="tiny"><b>Evidence:</b><ul style={{ margin: '2px 0', paddingLeft: 18 }}>{m.verification.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
          {m.verification.unverified.length > 0 && <div className="tiny" style={{ color: 'var(--amber)' }}><b>Unverified:</b> {m.verification.unverified.join(' · ')}</div>}
        </Panel>
      )}
      {m.report && <Panel title="Final report" idx="RP"><Markdown text={m.report} /></Panel>}
      {m.patches.filter(Boolean).length > 0 && (
        <Panel title="Proposed changes" idx="PT">
          {m.patches.filter(Boolean).map((p) => (
            <div key={p.id} className="stack" style={{ marginBottom: 10 }}>
              <div className="row between"><b className="small">Patch #{p.id}: {p.title}</b><span className="badge">{p.status}</span></div>
              {p.files.map((f) => <Diff key={f.path} text={f.diff} />)}
            </div>
          ))}
        </Panel>
      )}
      {m.artifacts.filter((a) => a.kind !== 'spider_report' && a.kind !== 'osint_report').length > 0 && (
        <Panel title="Artifacts" idx="AR">
          {m.artifacts.filter((a) => a.kind !== 'spider_report' && a.kind !== 'osint_report').map((a) => (
            <details key={a.id} style={{ marginBottom: 6 }}>
              <summary className="small" style={{ cursor: 'pointer' }}>{a.kind}: {a.title}</summary>
              {a.kind === 'render' && (a.data as { previewBase64?: string }).previewBase64 ? <img alt="Render preview" style={{ maxWidth: '100%', borderRadius: 8 }} src={`data:image/png;base64,${(a.data as { previewBase64: string }).previewBase64}`} /> : <Json value={a.data} />}
            </details>
          ))}
        </Panel>
      )}
      {m.artifacts.some((a) => a.kind === 'osint_report') && <button className="btn" onClick={() => navigate('research', `report:${m.artifacts.find((a) => a.kind === 'osint_report')!.id}`)}>Open research report</button>}
    </div>
  );
}
