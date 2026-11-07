import { useEffect, useState } from 'react';
import { FINDING_CLASS_LABELS, type Finding, type FindingClass, type ResearchTargetType, type TaskRecord } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { navigate, toast, useStore } from '../lib/store';
import { ActionButton, Empty, Field, Panel, StatusBadge } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { ago, dateTime } from '../lib/format';

interface Module { id: string; title: string; description: string; targets: ResearchTargetType[] }
interface ReportSummary { id: number; taskId: number | null; title: string; createdAt: string; findings: number; purpose: string }
interface Report { id: number; target: string; targetType: ResearchTargetType; purpose: string; modules: { id: string; title: string; ok: boolean; error: string | null; sources: string[] }[]; findings: Finding[]; synthesis: string | null; createdAt: string }

const TYPES: { value: ResearchTargetType; label: string; placeholder: string }[] = [
  { value: 'domain', label: 'Domain', placeholder: 'example.com' },
  { value: 'ip', label: 'IP address', placeholder: '93.184.216.34' },
  { value: 'url', label: 'Website (tech stack)', placeholder: 'https://example.com' },
  { value: 'organization', label: 'Organisation', placeholder: 'Anthropic' },
  { value: 'github_repo', label: 'GitHub repository', placeholder: 'owner/name' },
  { value: 'cve', label: 'CVE', placeholder: 'CVE-2021-44228' },
  { value: 'package', label: 'Package version', placeholder: 'npm:lodash@4.17.20' },
  { value: 'topic', label: 'Topic', placeholder: 'Certificate Transparency' },
];

const CLASS_BADGE: Record<FindingClass, string> = { verified_fact: 'green', source_reported: 'cyan', inference: 'violet', unverified: 'amber' };

export default function Research() {
  const param = useStore((s) => s.sectionParam);
  const tasks = useStore((s) => s.tasks);
  const [type, setType] = useState<ResearchTargetType>('domain');
  const [target, setTarget] = useState(param && !param.startsWith('report:') ? param : '');
  const [purpose, setPurpose] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [modules, setModules] = useState<Module[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [ai, setAi] = useState(true);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [open, setOpen] = useState<number | null>(param?.startsWith('report:') ? Number(param.slice(7)) : null);
  const researchTasks = Object.values(tasks).filter((t) => t.playbook === 'research.osint').sort((a, b) => b.id - a.id);

  useEffect(() => {
    api.get<Module[]>(`/api/research/modules?type=${type}`).then((m) => {
      setModules(m);
      setChosen(m.map((x) => x.id));
    });
  }, [type]);
  const loadReports = () => api.get<ReportSummary[]>('/api/research/reports').then(setReports).catch(() => {});
  useEffect(() => {
    void loadReports();
  }, [researchTasks.filter((t) => t.status === 'completed').length]);

  const start = async () => {
    try {
      const v = await api.post<{ target: string }>('/api/research/validate', { type, target });
      const t = await api.post<TaskRecord>('/api/missions', { playbook: 'research.osint', params: { targetType: type, target: v.target, purpose, authorized: true, modules: chosen, aiSynthesis: ai }, title: `OSINT: ${v.target}` });
      toast('info', 'Research deployed', `Mission #${t.id}`);
    } catch (err) {
      toast('error', 'Cannot start research', errMsg(err));
    }
  };

  return (
    <div className="stack">
      <div>
        <h2 className="section-title">Research / OSINT</h2>
        <p className="section-sub">Passive research from legitimate public sources — DNS, registries, certificate logs, archives, public APIs and vulnerability databases. No scanning, no logins, no private accounts, and no research on private individuals.</p>
      </div>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Panel title="New investigation" idx="R1">
          <div className="stack">
            <Field label="Target type">
              <select className="select" value={type} onChange={(e) => setType(e.target.value as ResearchTargetType)}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Target"><input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={TYPES.find((t) => t.value === type)?.placeholder} autoCapitalize="off" data-testid="osint-target" /></Field>
            <Field label="Purpose and scope"><input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. vet a supplier's public web footprint" data-testid="osint-purpose" /></Field>
            <div>
              <div className="tiny muted" style={{ marginBottom: 4 }}>Modules</div>
              {modules.map((m) => (
                <label key={m.id} className="check" style={{ minHeight: 34, padding: '4px 0' }}>
                  <input type="checkbox" checked={chosen.includes(m.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))} />
                  <span className="small">{m.title} <span className="muted tiny">— {m.description}</span></span>
                </label>
              ))}
            </div>
            <label className="check"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /><span className="small">Analyst synthesis by Claude (labelled as inference)</span></label>
            <label className="check" data-testid="osint-authorize"><input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} /><span className="small"><b>I confirm</b> this research is authorised, within the stated scope, and limited to publicly available information.</span></label>
            <ActionButton className="btn primary" disabled={!authorized || !target.trim() || purpose.trim().length < 5 || chosen.length === 0} onClick={start}>Begin investigation</ActionButton>
          </div>
        </Panel>
        <div className="stack">
          <Panel title="Investigations" idx="R2">
            {researchTasks.length === 0 && <Empty>No investigations yet.</Empty>}
            <div className="list">
              {researchTasks.slice(0, 8).map((t) => (
                <div key={t.id} className="list-item clickable" onClick={() => navigate('missions', String(t.id))}>
                  <div style={{ flex: 1, minWidth: 0 }}><div className="small ellipsis">{t.title}</div><div className="tiny muted">{ago(t.updatedAt)}</div></div>
                  <StatusBadge status={t.status} />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Reports" idx="R3">
            {reports.length === 0 && <Empty>Completed investigations produce sourced reports here.</Empty>}
            <div className="list">
              {reports.map((r) => (
                <div key={r.id} className={`list-item clickable ${open === r.id ? 'selected' : ''}`} onClick={() => setOpen(r.id)}>
                  <div style={{ flex: 1, minWidth: 0 }}><div className="small ellipsis">{r.title}</div><div className="tiny muted">{r.findings} findings · {dateTime(r.createdAt)}</div></div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
      {open && <ReportView id={open} onDeleted={() => { setOpen(null); void loadReports(); }} />}
    </div>
  );
}

function ReportView({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const [r, setR] = useState<Report | null>(null);
  const [cls, setCls] = useState<FindingClass | 'all'>('all');
  useEffect(() => {
    api.get<Report>(`/api/research/reports/${id}`).then(setR).catch((e) => toast('error', 'Report unavailable', errMsg(e)));
  }, [id]);
  if (!r) return <Panel><Empty>Loading report…</Empty></Panel>;
  const shown = r.findings.filter((f) => cls === 'all' || f.classification === cls);
  const timeline = r.findings.filter((f) => f.eventDate).sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
  const counts = r.findings.reduce<Record<string, number>>((m, f) => ((m[f.classification] = (m[f.classification] ?? 0) + 1), m), {});
  return (
    <Panel title={`Report #${r.id} — ${r.target}`} idx="R4" actions={
      <div className="row">
        <a className="btn sm" href={`/api/research/reports/${id}/markdown`} download>Export .md</a>
        <button className="btn sm danger" onClick={async () => { if (confirm('Delete this report?')) { await api.del(`/api/research/reports/${id}`); onDeleted(); } }}>Delete</button>
      </div>
    }>
      <div className="small muted" style={{ marginBottom: 8 }}>{r.targetType} · purpose: {r.purpose} · compiled {dateTime(r.createdAt)}</div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={`btn sm ${cls === 'all' ? 'primary' : ''}`} onClick={() => setCls('all')}>All {r.findings.length}</button>
        {(Object.keys(FINDING_CLASS_LABELS) as FindingClass[]).map((c) => (
          <button key={c} className={`btn sm ${cls === c ? 'primary' : ''}`} onClick={() => setCls(c)}>{FINDING_CLASS_LABELS[c]} {counts[c] ?? 0}</button>
        ))}
      </div>
      {r.synthesis && (
        <div className="panel flat" style={{ marginBottom: 12, background: 'var(--violet-dim)' }}>
          <div className="row" style={{ marginBottom: 6 }}><span className="badge violet">Inference</span><b className="small">Analyst synthesis (Claude)</b></div>
          <Markdown text={r.synthesis} />
        </div>
      )}
      <div className="stack">
        {shown.map((f, i) => (
          <div key={i} className="panel flat" style={{ padding: 10 }} data-testid="finding">
            <div className="row between nowrap">
              <div className="row nowrap" style={{ minWidth: 0 }}><span className={`badge ${CLASS_BADGE[f.classification]}`}>{FINDING_CLASS_LABELS[f.classification]}</span><b className="small ellipsis">{f.title}</b></div>
              <span className="tiny muted mono">{f.module}</span>
            </div>
            <div className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{f.detail}</div>
            <div className="tiny muted">Source: {f.sourceUrl ? <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer">{f.sourceUrl}</a> : 'n/a'} · collected {dateTime(f.collectedAt)}</div>
          </div>
        ))}
      </div>
      {timeline.length > 0 && (
        <>
          <h3 className="display" style={{ fontSize: 13, letterSpacing: '.14em', margin: '16px 0 8px' }}>TIMELINE</h3>
          <div className="timeline">
            {timeline.map((f, i) => <div key={i} className="tl-item"><div className="tiny mono muted">{String(f.eventDate).slice(0, 10)}</div><div className="small">{f.title} <span className="muted">({f.module})</span></div></div>)}
          </div>
        </>
      )}
      <h3 className="display" style={{ fontSize: 13, letterSpacing: '.14em', margin: '16px 0 8px' }}>MODULES & SOURCES</h3>
      {r.modules.map((m) => (
        <div key={m.id} className="small" style={{ marginBottom: 6 }}>
          <span className={`badge ${m.ok ? 'green' : 'red'}`}>{m.ok ? 'ok' : 'failed'}</span> {m.title}{m.error ? ` — ${m.error}` : ''}
          <div className="tiny muted mono" style={{ wordBreak: 'break-all' }}>{m.sources.join('  ·  ')}</div>
        </div>
      ))}
    </Panel>
  );
}
