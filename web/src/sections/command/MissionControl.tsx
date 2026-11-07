import { useMemo, useState } from 'react';
import type { TaskRecord } from '@tc/shared';
import { TERMINAL_TASK_STATUSES } from '@tc/shared';
import { Panel, StatusBadge } from '../../components/ui';
import { ApprovalCard } from '../../components/Approvals';
import { Progress } from '../../components/viz';
import { emptyArray, navigate, useStore } from '../../lib/store';
import { ago, clock } from '../../lib/format';
import { duration, missionProgress, type OpenSheet } from './util';

type Tab = 'active' | 'completed' | 'failed' | 'approvals';

const TONE: Record<string, 'cyan' | 'green' | 'red' | 'amber' | 'violet'> = { running: 'cyan', planning: 'violet', awaiting_approval: 'amber', pending: 'cyan', completed: 'green', failed: 'red', cancelled: 'amber' };

/** Mission control: live missions by outcome, approvals, and the latest execution log lines. */
export function MissionControl({ open }: { open: OpenSheet }) {
  const tasks = useStore((s) => s.tasks);
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const taskSteps = useStore((s) => s.taskSteps);
  const [tab, setTab] = useState<Tab>('active');
  const groups = useMemo(() => {
    const all = Object.values(tasks).sort((a, b) => b.id - a.id);
    return {
      active: all.filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status)),
      completed: all.filter((t) => t.status === 'completed'),
      failed: all.filter((t) => t.status === 'failed' || t.status === 'cancelled'),
    };
  }, [tasks]);
  const log = useMemo(
    () =>
      Object.entries(taskSteps)
        .flatMap(([id, steps]) => steps.slice(-6).map((s) => ({ id: Number(id), ...s })))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 6),
    [taskSteps],
  );
  const code = (t: TaskRecord) => agents.find((a) => a.id === t.agent)?.code.replace('AGENT ', '') ?? '··';
  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: 'active', label: 'Active', n: groups.active.length },
    { id: 'completed', label: 'Completed', n: groups.completed.length },
    { id: 'failed', label: 'Failed', n: groups.failed.length },
    { id: 'approvals', label: 'Approvals', n: approvals.length },
  ];
  const list = tab === 'approvals' ? [] : groups[tab];

  return (
    <Panel title="Mission control" idx="02" className="mission-control" actions={<button className="btn ghost sm" onClick={() => navigate('missions')}>All</button>}>
      <div className="mtabs" role="tablist" aria-label="Missions by state">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`mtab ${tab === t.id ? 'on' : ''} ${t.id === 'approvals' && t.n ? 'attn' : ''}`} onClick={() => setTab(t.id)}>
            <span className="n">{t.n}</span>
            <span className="l">{t.label}</span>
          </button>
        ))}
        <span className="mtab-ink" style={{ transform: `translateX(${tabs.findIndex((t) => t.id === tab) * 100}%)` }} />
      </div>
      <div className="mlist" key={tab}>
        {tab === 'approvals' && approvals.length === 0 && <div className="empty">Nothing is waiting for your approval.</div>}
        {tab === 'approvals' && approvals.map((a) => <ApprovalCard key={a.id} a={a} compact />)}
        {tab !== 'approvals' && list.length === 0 && <div className="empty">{tab === 'active' ? 'No active missions.' : tab === 'completed' ? 'No completed missions yet.' : 'No failed missions.'}</div>}
        {list.slice(0, 12).map((t, i) => {
          const steps = taskSteps[t.id] ?? emptyArray();
          const prog = missionProgress(t, steps.length ? steps : t.steps);
          return (
            <div key={t.id} className={`mission ${t.status}`} style={{ animationDelay: `${i * 40}ms` }} onClick={() => open({ kind: 'mission', id: t.id })} data-testid={`cc-mission-${t.id}`}>
              <div className="row nowrap between">
                <span className="small ellipsis"><span className="mono muted">#{t.id}</span> {t.title}</span>
                <StatusBadge status={t.status} />
              </div>
              <Progress pct={prog.pct} tone={TONE[t.status]} label={prog.label} />
              <div className="row nowrap between tiny muted">
                <span className="ellipsis">AGENT {code(t)} · {prog.label}</span>
                <span className="mono">{TERMINAL_TASK_STATUSES.includes(t.status) ? duration(t.startedAt ?? t.createdAt, t.finishedAt) : ago(t.updatedAt)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {log.length > 0 && (
        <div className="mlog" aria-label="Latest execution log">
          <div className="tiny muted label">EXECUTION LOG</div>
          {log.map((l, i) => (
            <div key={`${l.id}-${l.at}-${i}`} className={`mlog-line ${l.kind}`} onClick={() => open({ kind: 'mission', id: l.id })}>
              <span className="mono muted">{clock(l.at)}</span> <span className="mono">#{l.id}</span> <span className="ellipsis">{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
