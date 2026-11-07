import { useEffect, useMemo, useState } from 'react';
import { TERMINAL_TASK_STATUSES, type TaskRecord, type TaskStep } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { emptyArray, navigate, toast, useStore } from '../lib/store';
import { ActionButton, Diff, Empty, Panel, Seg, StatusBadge } from '../components/ui';
import { ApprovalCard } from '../components/Approvals';
import { Markdown } from '../components/Markdown';
import { ago } from '../lib/format';

interface Project { id: number; name: string; sourceKind: string; lastScanAt: string | null }
interface ScanFinding { rule: string; title: string; severity: string; file: string; line: number; snippet: string; advice: string }
interface SpiderReport {
  overview?: { files: number; lines: number; languages: { language: string; lines: number }[] };
  scan?: { findings: ScanFinding[]; filesScanned: number };
  dependencies?: { deps?: unknown[]; osv?: { vulns: { id: string; package: string; version: string; summary: string; severity: string | null; fixed: string[]; url: string }[] }; npm?: { ok: boolean; error?: string } };
  checks?: { id: string; passed: boolean | null; summary: string }[];
}
interface Detail {
  id: number;
  status: TaskRecord['status'];
  report: string | null;
  plan: TaskRecord['plan'];
  steps: { at: string; kind: string; message: string }[];
  artifacts: { id: number; kind: string; title: string; data: unknown }[];
  patches: { id: number; title: string; status: string; description: string; files: { path: string; diff: string }[] }[];
}

const SEV = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_BADGE: Record<string, string> = { critical: 'red', high: 'red', medium: 'amber', low: 'cyan', info: '' };

export default function Spider() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | ''>('');
  const [runChecks, setRunChecks] = useState(false);
  const [aiReview, setAiReview] = useState(true);
  const [freeform, setFreeform] = useState('');
  const spiderTasks = Object.values(tasks).filter((t) => t.agent === 'spider').sort((a, b) => b.id - a.id);
  const [selected, setSelected] = useState<number | null>(null);
  const current = selected ?? spiderTasks[0]?.id ?? null;
  const spider = agents.find((a) => a.id === 'spider');

  useEffect(() => {
    api.get<Project[]>('/api/projects').then((p) => {
      setProjects(p);
      if (p.length && projectId === '') setProjectId(p[0].id);
    });
  }, []);

  return (
    <div className="stack">
      <div>
        <h2 className="section-title">The Spider</h2>
        <p className="section-sub">Autonomous engineering and defensive security. Inspects code you own or are authorised to review: structure, dependencies, vulnerability patterns, tests. It never touches files or runs code without your approval.</p>
      </div>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Panel title="Deploy inspection" idx="S1" actions={<span className="chip">{spider?.status.toUpperCase() ?? '—'}</span>}>
          {projects.length === 0 ? (
            <Empty>No projects yet. <button className="btn sm" onClick={() => navigate('projects')}>Add a project</button></Empty>
          ) : (
            <div className="stack">
              <select className="select" value={projectId} onChange={(e) => setProjectId(Number(e.target.value))} aria-label="Project">
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sourceKind}){p.lastScanAt ? ` — inspected ${ago(p.lastScanAt)}` : ''}</option>)}
              </select>
              <label className="check"><input type="checkbox" checked={runChecks} onChange={(e) => setRunChecks(e.target.checked)} /><span className="small">Also run the project’s tests/checks <span className="muted">(executes project code on the server — each run asks for approval)</span></span></label>
              <label className="check"><input type="checkbox" checked={aiReview} onChange={(e) => setAiReview(e.target.checked)} /><span className="small">Claude analyst review of the evidence <span className="muted">(skipped if Claude is not connected)</span></span></label>
              <ActionButton className="btn primary" disabled={!projectId} onClick={async () => {
                try {
                  const t = await api.post<TaskRecord>('/api/missions', { playbook: 'spider.inspect', params: { projectId, runChecks, aiReview }, title: `Spider: inspect ${projects.find((p) => p.id === projectId)?.name}` });
                  setSelected(t.id);
                } catch (err) {
                  toast('error', 'Could not deploy the Spider', errMsg(err));
                }
              }}>Deploy the Spider</ActionButton>
              <hr className="sep" />
              <div className="tiny muted">Free-form engineering mission (Claude plans and executes with the Spider’s tools):</div>
              <textarea className="textarea" value={freeform} onChange={(e) => setFreeform(e.target.value)} placeholder="e.g. Find why login fails on Safari and propose a fix" />
              <ActionButton className="btn violet" disabled={!projectId || freeform.trim().length < 5} onClick={async () => {
                try {
                  const t = await api.post<TaskRecord>('/api/missions', { agent: 'spider', title: freeform.slice(0, 80), request: freeform, projectId });
                  setFreeform('');
                  setSelected(t.id);
                } catch (err) {
                  toast('error', 'Mission not created', errMsg(err));
                }
              }}>Start AI mission</ActionButton>
            </div>
          )}
        </Panel>
        <Panel title="Execution history" idx="S2">
          {spiderTasks.length === 0 && <Empty>No Spider missions yet.</Empty>}
          <div className="list">
            {spiderTasks.slice(0, 12).map((t) => (
              <div key={t.id} className={`list-item clickable ${t.id === current ? 'selected' : ''}`} onClick={() => setSelected(t.id)}>
                <div style={{ flex: 1, minWidth: 0 }}><div className="small ellipsis">#{t.id} {t.title}</div><div className="tiny muted">{ago(t.updatedAt)}</div></div>
                <StatusBadge status={t.status} />
              </div>
            ))}
          </div>
        </Panel>
      </div>
      {current && <SpiderMission key={current} id={current} />}
    </div>
  );
}

function SpiderMission({ id }: { id: number }) {
  const task = useStore((s) => s.tasks[id]);
  const files = useStore((s) => s.spiderFiles[id]) ?? emptyArray<string>();
  const liveSteps = useStore((s) => s.taskSteps[id]) ?? emptyArray<TaskStep>();
  const allApprovals = useStore((s) => s.approvals);
  const approvals = useMemo(() => allApprovals.filter((a) => a.taskId === id), [allApprovals, id]);
  const [d, setD] = useState<Detail | null>(null);
  const [sev, setSev] = useState('low');
  const load = () => api.get<Detail>(`/api/missions/${id}`).then(setD).catch(() => {});
  useEffect(() => {
    void load();
  }, [id, task?.status, task?.updatedAt]);
  const report = useMemo(() => d?.artifacts.find((a) => a.kind === 'spider_report')?.data as SpiderReport | undefined, [d]);
  const tests = d?.artifacts.filter((a) => a.kind === 'test_run') ?? [];
  const steps = (d?.steps.length ?? 0) >= liveSteps.length ? d?.steps ?? [] : liveSteps;
  const total = d?.plan?.steps.length ?? 0;
  const done = steps.filter((s) => s.kind === 'tool_result').length;
  const terminal = task ? TERMINAL_TASK_STATUSES.includes(task.status) : true;
  const currentStep = [...steps].reverse().find((s) => s.kind === 'tool' || s.kind === 'info');
  const findings = (report?.scan?.findings ?? []).filter((f) => SEV.indexOf(f.severity) <= SEV.indexOf(sev));

  return (
    <div className="stack" data-testid="spider-mission">
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Panel title={`Current task · #${id}`} idx="S3" actions={task && <StatusBadge status={task.status} />}>
          <div className="small" style={{ marginBottom: 8 }}>{task?.title}</div>
          <div className="progress" aria-label="Analysis progress"><div style={{ width: `${terminal ? 100 : total ? Math.min(95, (done / total) * 100) : 10}%` }} /></div>
          <div className="tiny muted mono" style={{ margin: '6px 0' }}>{terminal ? 'Finished' : currentStep?.message ?? 'Starting…'}</div>
          {approvals.map((a) => <ApprovalCard key={a.id} a={a} />)}
        </Panel>
        <Panel title="Files being inspected" idx="S4">
          <div className="filestream">{files.length === 0 ? <div className="muted">{terminal ? 'Inspection complete.' : 'Waiting for the first file…'}</div> : files.slice(-14).map((f, i) => <div key={i}>{f}</div>)}</div>
        </Panel>
      </div>
      {report && (
        <Panel title="Detected issues" idx="S5" actions={<Seg value={sev} onChange={setSev} options={[{ value: 'high', label: 'High+' }, { value: 'medium', label: 'Med+' }, { value: 'low', label: 'Low+' }, { value: 'info', label: 'All' }]} />}>
          <div className="row tiny muted" style={{ marginBottom: 8 }}>
            <span>{report.overview?.files ?? 0} files · {report.overview?.lines?.toLocaleString('en-GB') ?? 0} lines</span>
            <span>{report.scan?.filesScanned ?? 0} scanned</span>
            <span>{report.dependencies?.deps?.length ?? 0} dependencies</span>
            <span>{report.dependencies?.osv ? `${report.dependencies.osv.vulns.length} known vulnerabilities (OSV)` : `vulnerability DB: ${report.dependencies?.npm?.ok ? 'npm audit' : 'unreachable'}`}</span>
          </div>
          {(report.dependencies?.osv?.vulns.length ?? 0) > 0 && (
            <div className="table-wrap" style={{ marginBottom: 10 }}>
              <table className="data"><thead><tr><th>Package</th><th>Advisory</th><th>Fixed in</th></tr></thead><tbody>
                {report.dependencies!.osv!.vulns.slice(0, 30).map((v, i) => <tr key={i}><td className="mono">{v.package}@{v.version}</td><td><a href={v.url} target="_blank" rel="noopener noreferrer">{v.id}</a> {v.summary}</td><td className="mono">{v.fixed.join(', ') || '—'}</td></tr>)}
              </tbody></table>
            </div>
          )}
          {findings.length === 0 ? <Empty>No pattern-matched leads at this severity.</Empty> : (
            <div className="table-wrap">
              <table className="data"><thead><tr><th>Severity</th><th>Issue</th><th>Location</th></tr></thead><tbody>
                {findings.slice(0, 80).map((f, i) => (
                  <tr key={i}>
                    <td><span className={`badge ${SEV_BADGE[f.severity]}`}>{f.severity}</span></td>
                    <td><div className="small">{f.title}</div><div className="tiny mono muted">{f.snippet}</div><div className="tiny muted">{f.advice}</div></td>
                    <td className="mono tiny">{f.file}:{f.line}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
          <div className="tiny muted" style={{ marginTop: 6 }}>Static findings are pattern matches (leads), not confirmed vulnerabilities. The report below separates likely issues from false positives when Claude reviewed them.</div>
        </Panel>
      )}
      {tests.length > 0 && (
        <Panel title="Test results" idx="S6">
          {tests.map((t) => {
            const r = t.data as { command: string; exitCode: number | null; passed: boolean; durationMs: number; stdout: string; stderr: string; timedOut: boolean };
            return (
              <details key={t.id} style={{ marginBottom: 8 }} open={!r.passed}>
                <summary className="row" style={{ cursor: 'pointer' }}><span className={`badge ${r.passed ? 'green' : 'red'}`}>{r.passed ? 'passed' : 'failed'}</span><span className="mono small">{r.command}</span><span className="tiny muted">exit {String(r.exitCode)} · {r.durationMs} ms{r.timedOut ? ' · timed out' : ''}</span></summary>
                <pre>{(r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : '')).slice(-8000)}</pre>
              </details>
            );
          })}
        </Panel>
      )}
      {(d?.patches.length ?? 0) > 0 && (
        <Panel title="Proposed changes" idx="S7">
          {d!.patches.map((p) => (
            <div key={p.id} className="stack" style={{ marginBottom: 12 }}>
              <div className="row between"><b className="small">Patch #{p.id}: {p.title}</b><span className="badge">{p.status}</span></div>
              {p.description && <div className="small muted">{p.description}</div>}
              {p.files.map((f) => <Diff key={f.path} text={f.diff} />)}
              <div className="row">
                {p.status === 'proposed' && <ActionButton className="btn primary sm" onClick={async () => { try { await api.post(`/api/patches/${p.id}/apply`, {}); toast('success', 'Patch applied'); void load(); } catch (e) { toast('error', 'Apply failed', errMsg(e)); } }}>Apply</ActionButton>}
                {p.status === 'proposed' && <ActionButton className="btn sm" onClick={async () => { await api.post(`/api/patches/${p.id}/reject`, {}); void load(); }}>Reject</ActionButton>}
                {p.status === 'applied' && <ActionButton className="btn sm warn" onClick={async () => { await api.post(`/api/patches/${p.id}/revert`, {}); toast('info', 'Patch reverted'); void load(); }}>Revert</ActionButton>}
              </div>
            </div>
          ))}
        </Panel>
      )}
      {d?.report && <Panel title="Technical report" idx="S8"><Markdown text={d.report} /></Panel>}
    </div>
  );
}
