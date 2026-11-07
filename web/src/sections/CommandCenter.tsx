import { useCallback, useEffect, useState } from 'react';
import type { SectionId } from '@tc/shared';
import { CoreView } from '../core/CoreView';
import { useCoreState } from '../core/useCoreState';
import { CommandBar } from '../components/CommandBar';
import { Markdown } from '../components/Markdown';
import { Dot, Panel, StatusBadge } from '../components/ui';
import { ApprovalCard } from '../components/Approvals';
import { navigate, useStore } from '../lib/store';
import { api } from '../lib/api';
import { ago, clock } from '../lib/format';
import { voice } from '../voice/voice';
import { SystemIntel } from './command/SystemIntel';
import { MissionControl } from './command/MissionControl';
import { AgentGrid } from './command/AgentGrid';
import { AppsGrid } from './command/AppsGrid';
import { AIActivityPanel, CommsPanel, HealthPanel, MemoryPanel, PerformancePanel, TimelinePanel, TopologyPanel, TrafficPanel } from './command/Analytics';
import { DiagnosticsSheet } from './command/Diagnostics';
import { AgentPulse, EventStream } from './command/LivePanels';
import type { SheetTarget } from './command/util';

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  outcome: string;
}

/**
 * Command Center: the core and the command line in the hero, flanked by
 * system intelligence and mission control; below, the agent network,
 * analytics, connected apps and logs. Every figure comes from the server.
 */
export function CommandCenter() {
  const state = useCoreState();
  const reply = useStore((s) => s.reply);
  const chat = useStore((s) => (s.reply?.conversationId ? s.chat[s.reply.conversationId] : undefined));
  const approvals = useStore((s) => s.approvals);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [trail, setTrail] = useState(0);
  const open = useCallback((t: SheetTarget) => setSheet(t), []);

  useEffect(() => {
    const onSent = () => setTrail((n) => n + 1);
    window.addEventListener('tc:command-sent', onSent);
    return () => window.removeEventListener('tc:command-sent', onSent);
  }, []);

  const liveText = reply?.pending ? chat?.text ?? '' : reply?.text ?? '';
  return (
    <div className="cc" data-testid="command-center">
      <div className="cc-hero">
        <div className="cc-col left boot-stagger" style={{ ['--i' as string]: 0 }}>
          <SystemIntel open={open} />
          <EventStream />
        </div>
        <div className="cc-center">
          <CoreView
            state={state}
            onTap={() => {
              // While speaking, a tap on the core silences it; otherwise it opens AI diagnostics.
              if (voice.speaking) voice.cancelSpeech();
              else open({ kind: 'ai' });
            }}
          />
          {trail > 0 && (
            <div className="cmd-trail" key={trail} aria-hidden="true">
              {Array.from({ length: 7 }, (_, i) => (
                <i key={i} style={{ left: `${44 + (i % 4) * 4}%`, animationDelay: `${i * 45}ms` }} />
              ))}
            </div>
          )}
          {(reply || approvals.length > 0) && (
            <div className="reply" aria-live="polite" data-testid="reply" key={reply?.at ?? 'approvals'}>
              {approvals.slice(0, 1).map((a) => (
                <div key={a.id} style={{ marginBottom: 10 }}>
                  <ApprovalCard a={a} compact />
                </div>
              ))}
              {reply && (
                <>
                  <div className="tiny muted mono reply-meta">
                    <span className={`src ${reply.from}`}>{reply.from === 'core' ? 'CORE INTELLIGENCE' : 'SYSTEM'}</span> · {clock(new Date(reply.at).toISOString())}
                    {reply.pending && chat && !chat.text && chat.tools.length > 0 && ` · ${chat.tools[chat.tools.length - 1].summary ?? chat.tools[chat.tools.length - 1].tool}`}
                  </div>
                  {reply.pending && !liveText ? (
                    <div className="small muted thinking-line">
                      <span className="dots"><i /><i /><i /></span>
                      {chat?.thinking ? 'Reasoning…' : 'Working…'}
                    </div>
                  ) : (
                    <Markdown text={liveText} />
                  )}
                  {reply.conversationId && !reply.pending && (
                    <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => navigate('intelligence', String(reply.conversationId))}>
                      Open conversation
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          <div className="boot-stagger" style={{ ['--i' as string]: 2 }}>
            <CommandBar />
          </div>
        </div>
        <div className="cc-col right boot-stagger" style={{ ['--i' as string]: 1 }}>
          <MissionControl open={open} />
          <AgentPulse open={open} />
        </div>
      </div>

      <section className="cc-band boot-stagger" style={{ ['--i' as string]: 3 }} aria-labelledby="band-agents">
        <h2 className="band-title" id="band-agents"><span className="idx">03</span> Agent network</h2>
        <AgentGrid open={open} />
      </section>

      <section className="cc-band boot-stagger" style={{ ['--i' as string]: 4 }} aria-labelledby="band-ops">
        <h2 className="band-title" id="band-ops"><span className="idx">04</span> Operations</h2>
        <div className="band-grid three">
          <TopologyPanel open={open} />
          <CommsPanel open={open} />
          <HealthPanel open={open} />
        </div>
      </section>

      <section className="cc-band boot-stagger" style={{ ['--i' as string]: 5 }} aria-labelledby="band-telemetry">
        <h2 className="band-title" id="band-telemetry"><span className="idx">05</span> Telemetry</h2>
        <div className="band-grid three">
          <PerformancePanel />
          <AIActivityPanel />
          <TrafficPanel />
        </div>
        <div className="band-grid two" style={{ marginTop: 14 }}>
          <TimelinePanel open={open} />
          <MemoryPanel />
        </div>
      </section>

      <section className="cc-band boot-stagger" style={{ ['--i' as string]: 6 }} aria-labelledby="band-apps">
        <h2 className="band-title" id="band-apps"><span className="idx">06</span> Connected apps <button className="btn ghost sm" onClick={() => navigate('apps')}>Manage</button></h2>
        <AppsGrid open={open} />
      </section>

      <section className="cc-band boot-stagger" style={{ ['--i' as string]: 7 }} aria-labelledby="band-logs">
        <h2 className="band-title" id="band-logs"><span className="idx">07</span> Logs</h2>
        <div className="band-grid three">
          <NotificationsPanel />
          <ResearchPanel open={open} />
          <HistoryPanel />
        </div>
      </section>

      {sheet && <DiagnosticsSheet target={sheet} onClose={() => setSheet(null)} open={open} />}
    </div>
  );
}

function ResearchPanel({ open }: { open: (t: SheetTarget) => void }) {
  const tasks = useStore((s) => s.tasks);
  const activity = useStore((s) => s.activity);
  const research = Object.values(tasks).filter((t) => t.agent === 'research').sort((a, b) => b.id - a.id).slice(0, 4);
  const live = [...activity].reverse().filter((a) => a.kind === 'research' && Date.now() - a.at < 20_000).slice(0, 3);
  return (
    <Panel title="Research activity" idx="L2" actions={<button className="btn ghost sm" onClick={() => navigate('research')}>Open</button>}>
      {live.map((a, i) => (
        <div key={i} className="tiny mono live-line">▸ {a.label}</div>
      ))}
      {research.length === 0 && live.length === 0 && <div className="empty">No research yet.</div>}
      <div className="list">
        {research.map((t) => (
          <div key={t.id} className="list-item clickable" onClick={() => open({ kind: 'mission', id: t.id })}>
            <div className="small ellipsis" style={{ flex: 1 }}>{t.title}</div>
            <StatusBadge status={t.status} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

function NotificationsPanel() {
  const notifications = useStore((s) => s.notifications);
  return (
    <Panel title="Notifications" idx="L1">
      {notifications.length === 0 && <div className="empty">All quiet.</div>}
      <div className="list">
        {notifications.slice(0, 6).map((n) => (
          <div key={n.id} className={`list-item ${n.link ? 'clickable' : ''}`} style={{ minHeight: 40 }} onClick={() => n.link && navigate(n.link.split('/')[0] as SectionId, n.link.split('/')[1] ?? null)}>
            <Dot kind={n.level === 'error' ? 'err' : n.level === 'warning' ? 'warn' : n.level === 'success' ? 'ok' : 'live'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small ellipsis">{n.title}</div>
              <div className="tiny muted ellipsis">{n.body}</div>
            </div>
            <span className="tiny muted">{ago(n.createdAt)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function HistoryPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const tasks = useStore((s) => s.tasks);
  const taskCount = Object.keys(tasks).length;
  useEffect(() => {
    api.get<AuditRow[]>('/api/audit?limit=12').then(setRows).catch(() => {});
  }, [taskCount]);
  return (
    <Panel title="Execution history" idx="L3" actions={<button className="btn ghost sm" onClick={() => navigate('settings', 'audit')}>Audit log</button>}>
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
