import type { SectionId } from '@tc/shared';
import { useState } from 'react';
import type { ApprovalRecord } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { navigate, setState, toast, useStore } from '../lib/store';
import { sound } from '../audio/sound';
import { ago } from '../lib/format';
import { Json, Sheet } from './ui';
import { Icon } from './icons';

/** Renders exactly what will happen, so the owner approves the real action. */
function ApprovalDetail({ a }: { a: ApprovalRecord }) {
  const input = (a.input ?? {}) as Record<string, unknown>;
  if (a.tool === 'mission.plan') {
    const plan = input as { interpretation?: string; steps?: { title: string; risk?: string; tools?: string[] }[]; requiredPermissions?: { tool: string; risk: string; reason: string }[]; successCriteria?: string[] };
    return (
      <div className="stack small">
        {plan.interpretation && <div>{plan.interpretation}</div>}
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {plan.steps?.map((s, i) => (
            <li key={i}>
              {s.title} {s.risk && s.risk !== 'read' && <span className={`badge ${s.risk === 'sensitive' ? 'red' : 'amber'}`}>{s.risk}</span>}
            </li>
          ))}
        </ol>
        {!!plan.requiredPermissions?.length && (
          <div>
            <div className="tiny muted">Permissions requested</div>
            {plan.requiredPermissions.map((p, i) => (
              <div key={i} className="tiny">
                <span className={`badge ${p.risk === 'sensitive' ? 'red' : 'amber'}`}>{p.risk}</span> <span className="mono">{p.tool}</span> — {p.reason}
              </div>
            ))}
            <div className="tiny muted" style={{ marginTop: 4 }}>Approving the plan pre-approves its low-risk writes. Sensitive actions will still ask individually.</div>
          </div>
        )}
      </div>
    );
  }
  if (a.tool === 'blender_run_script') return (<><div className="tiny muted">Python script to run in Blender on your computer:</div><pre>{String(input.script ?? '')}</pre></>);
  if (a.tool === 'gmail_send_draft') return (<div className="small stack"><div><b>To:</b> {String(input.to)}</div><div><b>Subject:</b> {String(input.subject)}</div><pre>{String(input.bodyPreview ?? '')}</pre></div>);
  if (a.tool === 'roblox_write_file') return (<><div className="tiny muted">Write <span className="mono">{String(input.path)}</span> — {String(input.purpose ?? '')}</div><pre>{String(input.content ?? '').slice(0, 20000)}</pre></>);
  if (a.tool === 'run_project_check') return <div className="small">Runs the project’s own check <span className="mono">{String(input.checkId)}</span> on the server. This executes code from the project — only approve for projects you trust.</div>;
  return <Json value={a.input} />;
}

export function ApprovalCard({ a, compact }: { a: ApprovalRecord; compact?: boolean }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await api.post(`/api/approvals/${a.id}`, { approve, note: note || undefined });
      sound.play(approve ? 'activate' : 'tap');
      setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
    } catch (err) {
      toast('error', 'Approval failed', errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`approval ${a.risk === 'sensitive' ? 'sensitive' : ''}`} data-testid="approval-card">
      <div className="row between nowrap" style={{ marginBottom: 6 }}>
        <div className="row nowrap" style={{ minWidth: 0 }}>
          <span className={`badge ${a.risk === 'sensitive' ? 'red' : 'amber'}`}>{a.risk}</span>
          <b className="small ellipsis">{a.summary}</b>
        </div>
        <span className="tiny muted">{ago(a.createdAt)}</span>
      </div>
      {!compact && (
        <div style={{ margin: '8px 0' }}>
          <ApprovalDetail a={a} />
        </div>
      )}
      <div className="row">
        {!compact && <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Optional note to the agent" value={note} onChange={(e) => setNote(e.target.value)} />}
        <button className="btn danger" disabled={busy} onClick={() => decide(false)}>
          <Icon name="close" size={18} /> Deny
        </button>
        <button className="btn primary" disabled={busy} onClick={() => decide(true)}>
          <Icon name="check" size={18} /> Approve
        </button>
        {a.taskId && compact && (
          <button className="btn ghost sm" onClick={() => navigate('missions', String(a.taskId))}>
            Mission #{a.taskId}
          </button>
        )}
      </div>
    </div>
  );
}

/** Floating dock: pending approvals are always one tap away, in every section. */
export function ApprovalDock() {
  const approvals = useStore((s) => s.approvals);
  const [open, setOpen] = useState(false);
  if (!approvals.length) return null;
  return (
    <>
      <div className="approval-dock">
        <button className="btn warn" onClick={() => setOpen(true)} data-testid="approval-dock">
          <Icon name="shield" size={18} /> {approvals.length} approval{approvals.length > 1 ? 's' : ''} waiting
        </button>
      </div>
      {open && (
        <Sheet title="Approvals required" onClose={() => setOpen(false)}>
          <div className="stack">
            <div className="small muted">Agents cannot perform these actions until you decide. Nothing here runs automatically.</div>
            {approvals.map((a) => (
              <ApprovalCard key={a.id} a={a} />
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.toastId}
          className={`toast ${t.level} ${t.link ? 'clickable' : ''}`}
          onClick={() => {
            if (!t.link) return;
            const [sec, param] = t.link.split('/');
            navigate(sec as SectionId, param ?? null);
            setState((s) => ({ toasts: s.toasts.filter((x) => x.toastId !== t.toastId) }));
          }}
        >
          <span className="toast-bar" />
          <b>{t.title}</b>
          {t.body && <div className="small">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}
