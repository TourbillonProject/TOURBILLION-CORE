import { useEffect, useState } from 'react';
import { AGENT_IDS, type AgentId, type TaskRecord } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { navigate, toast } from '../lib/store';
import { ActionButton, Empty, Field, Panel, Seg } from '../components/ui';
import { dateTime } from '../lib/format';

interface Automation {
  id: number;
  name: string;
  enabled: boolean;
  schedule: { type: 'interval'; minutes: number } | { type: 'daily'; time: string; utcOffsetMinutes: number };
  action: { kind: 'playbook'; playbook: string; title: string; params: Record<string, unknown> } | { kind: 'mission'; agent: AgentId; request: string; title: string };
  lastRunAt: string | null;
  lastTaskId: number | null;
  nextRunAt: string | null;
}

export default function Automations() {
  const [list, setList] = useState<Automation[]>([]);
  const [playbooks, setPlaybooks] = useState<{ id: string; title: string; description: string }[]>([]);
  const [name, setName] = useState('');
  const [sType, setSType] = useState<'interval' | 'daily'>('daily');
  const [minutes, setMinutes] = useState(60);
  const [time, setTime] = useState('08:00');
  const [kind, setKind] = useState<'playbook' | 'mission'>('playbook');
  const [playbook, setPlaybook] = useState('system.diagnostics');
  const [params, setParams] = useState('{}');
  const [agent, setAgent] = useState<AgentId>('operator');
  const [request, setRequest] = useState('');
  const load = () => api.get<Automation[]>('/api/automations').then(setList);
  useEffect(() => {
    void load();
    api.get<typeof playbooks>('/api/playbooks').then(setPlaybooks);
  }, []);

  const create = async () => {
    try {
      let parsed: Record<string, unknown> = {};
      if (kind === 'playbook') parsed = JSON.parse(params || '{}');
      await api.post('/api/automations', {
        name,
        schedule: sType === 'interval' ? { type: 'interval', minutes } : { type: 'daily', time, utcOffsetMinutes: -new Date().getTimezoneOffset() },
        action: kind === 'playbook' ? { kind, playbook, params: parsed, title: name } : { kind, agent, request, title: name },
      });
      setName('');
      setRequest('');
      void load();
      toast('success', 'Automation created');
    } catch (err) {
      toast('error', 'Automation not created', errMsg(err));
    }
  };

  return (
    <div className="stack">
      <div>
        <h2 className="section-title">Automations</h2>
        <p className="section-sub">Scheduled missions. A schedule only creates the mission — planning, permissions and approvals work exactly as if you started it yourself, so nothing sensitive happens unattended.</p>
      </div>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Panel title="Scheduled" idx="AU">
          {list.length === 0 && <Empty>No automations yet.</Empty>}
          <div className="list">
            {list.map((a) => (
              <div key={a.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="small"><b>{a.name}</b> {!a.enabled && <span className="badge">paused</span>}</div>
                  <div className="tiny muted">{a.schedule.type === 'interval' ? `Every ${a.schedule.minutes} min` : `Daily at ${a.schedule.time}`} · {a.action.kind === 'playbook' ? a.action.playbook : `${a.action.agent} mission`}</div>
                  <div className="tiny muted">Next: {dateTime(a.nextRunAt)} · Last: {dateTime(a.lastRunAt)} {a.lastTaskId && <button className="btn ghost sm" onClick={() => navigate('missions', String(a.lastTaskId))}>#{a.lastTaskId}</button>}</div>
                </div>
                <div className="row">
                  <ActionButton className="btn sm" onClick={async () => { const t = await api.post<TaskRecord>(`/api/automations/${a.id}/run`, {}); navigate('missions', String(t.id)); }}>Run now</ActionButton>
                  <ActionButton className="btn sm" onClick={async () => { await api.patch(`/api/automations/${a.id}`, { enabled: !a.enabled }); void load(); }}>{a.enabled ? 'Pause' : 'Resume'}</ActionButton>
                  <ActionButton className="btn sm danger" onClick={async () => { await api.del(`/api/automations/${a.id}`); void load(); }}>Delete</ActionButton>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="New automation" idx="+">
          <div className="stack">
            <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning diagnostics" /></Field>
            <Seg value={sType} onChange={setSType} options={[{ value: 'daily', label: 'Daily' }, { value: 'interval', label: 'Interval' }]} />
            {sType === 'daily' ? <Field label="Time (this iPad's time zone)"><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field> : <Field label="Every (minutes, min 15)"><input className="input" type="number" min={15} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></Field>}
            <Seg value={kind} onChange={setKind} options={[{ value: 'playbook', label: 'Playbook' }, { value: 'mission', label: 'AI mission' }]} />
            {kind === 'playbook' ? (
              <>
                <Field label="Playbook">
                  <select className="select" value={playbook} onChange={(e) => setPlaybook(e.target.value)}>
                    {playbooks.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </Field>
                <div className="tiny muted">{playbooks.find((p) => p.id === playbook)?.description}</div>
                <Field label="Parameters (JSON)"><textarea className="textarea mono" value={params} onChange={(e) => setParams(e.target.value)} placeholder='e.g. {"urls":["https://example.com"]}' /></Field>
              </>
            ) : (
              <>
                <Field label="Agent"><select className="select" value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>{AGENT_IDS.filter((a) => a !== 'core').map((a) => <option key={a}>{a}</option>)}</select></Field>
                <Field label="Request"><textarea className="textarea" value={request} onChange={(e) => setRequest(e.target.value)} /></Field>
              </>
            )}
            <ActionButton className="btn primary" disabled={!name.trim() || (kind === 'mission' && request.trim().length < 3)} onClick={create}>Create</ActionButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}
