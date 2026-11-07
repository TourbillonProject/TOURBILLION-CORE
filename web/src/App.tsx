import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AGENT_IDS, SECTIONS, SECTION_LABELS, type SectionId } from '@tc/shared';
import { api } from './lib/api';
import { connect, disconnect } from './lib/events';
import { getState, navigate, readHash, setState, toast, useStore, type Settings } from './lib/store';
import { AuthScreen } from './auth/Auth';
import { Icon, Logo, SECTION_ICON } from './components/icons';
import { ApprovalDock, Toasts } from './components/Approvals';
import { Dot, INTEGRATION_LABEL, Sheet } from './components/ui';
import { Ambient } from './components/Ambient';
import { SignalBars } from './components/viz';
import { useGraphicsQuality } from './core/CoreView';
import { DiagnosticsSheet } from './sections/command/Diagnostics';
import type { SheetTarget } from './sections/command/util';
import { sound } from './audio/sound';
import { voice } from './voice/voice';
import { greeting, ago, clock } from './lib/format';
import { say } from './lib/commands';
import { CommandCenter } from './sections/CommandCenter';

// Sections other than the Command Center load on demand (smaller first paint on the iPad).
const Intelligence = lazy(() => import('./sections/Intelligence'));
const Agents = lazy(() => import('./sections/Agents'));
const Spider = lazy(() => import('./sections/Spider'));
const Browser = lazy(() => import('./sections/Browser'));
const Research = lazy(() => import('./sections/Research'));
const Projects = lazy(() => import('./sections/Projects'));
const Missions = lazy(() => import('./sections/Missions'));
const Automations = lazy(() => import('./sections/Automations'));
const Apps = lazy(() => import('./sections/Apps'));
const Memory = lazy(() => import('./sections/Memory'));
const SettingsSection = lazy(() => import('./sections/Settings'));

const VIEWS: Record<SectionId, React.ComponentType> = {
  command: CommandCenter,
  intelligence: Intelligence,
  agents: Agents,
  spider: Spider,
  browser: Browser,
  research: Research,
  projects: Projects,
  missions: Missions,
  automations: Automations,
  apps: Apps,
  memory: Memory,
  settings: SettingsSection,
};

export function App() {
  const auth = useStore((s) => s.auth);

  useEffect(() => {
    api
      .get<{ setupRequired: boolean; authenticated: boolean }>('/api/auth/state')
      .then((s) => setState({ auth: { checked: true, setupRequired: s.setupRequired, authenticated: s.authenticated } }))
      .catch(() => setState({ auth: { checked: true, setupRequired: false, authenticated: false }, ws: 'offline' }));
    const onUnauth = () => {
      disconnect();
      setState((s) => ({ auth: { ...s.auth, authenticated: false } }));
    };
    window.addEventListener('tc:unauthenticated', onUnauth);
    return () => window.removeEventListener('tc:unauthenticated', onUnauth);
  }, []);

  if (!auth.checked) return <div className="boot"><Logo size={72} /><div className="sub">Connecting…</div></div>;
  if (!auth.authenticated) return <AuthScreen setupRequired={auth.setupRequired} />;
  return <Shell />;
}

function Shell() {
  const section = useStore((s) => s.section);
  const navOpen = useStore((s) => s.navOpen);
  const approvals = useStore((s) => s.approvals);
  const online = useStore((s) => s.online);
  const ws = useStore((s) => s.ws);
  const booted = useStore((s) => s.booted);
  const bootSeq = useStore((s) => s.bootSeq);
  const settings = useStore((s) => s.settings);
  const quality = useGraphicsQuality();
  const contentRef = useRef<HTMLElement>(null);

  // Each section opens at its top (the scroll container is shared).
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [section]);

  useEffect(() => {
    const sync = () => {
      const h = readHash(SECTIONS);
      setState({ section: h.section, sectionParam: h.param });
    };
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    // OAuth return (?section=apps&gmail=…)
    const q = new URLSearchParams(location.search);
    if (q.get('section')) {
      navigate(q.get('section') as SectionId);
      if (q.get('gmail') === 'connected') toast('success', 'Gmail connected');
      if (q.get('gmail') === 'error') toast('error', 'Gmail connection failed', q.get('reason') ?? '');
      history.replaceState(null, '', `${location.pathname}${location.hash}`);
    }
    api.get<Settings>('/api/settings').then((s) => setState({ settings: s }));
    connect();
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
      disconnect();
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    sound.configure(settings.soundEnabled, settings.soundVolume, settings.soundCategories);
    sound.setAmbient(settings.ambientSound, settings.ambientVolume);
  }, [settings?.soundEnabled, settings?.soundVolume, settings?.soundCategories, settings?.ambientSound, settings?.ambientVolume]);

  // Global motion/quality flags for CSS (glass, glows and entrance animations scale with the tier).
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.quality = quality;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => (root.dataset.motion = mq.matches || quality === 'performance' ? 'reduced' : 'full');
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, [quality]);

  const View = VIEWS[section];
  const navIndex = SECTIONS.indexOf(section);
  return (
    <>
      <Ambient quality={quality} />
      <div className={`shell ${bootSeq != null ? 'booting' : ''}`}>
        <nav className={`nav ${navOpen ? 'open' : ''}`} aria-label="Sections">
          <div className="nav-brand">
            <Logo />
            <div className="wordmark">TOURBILLION<br />CORE</div>
          </div>
          <div className="nav-items">
            <span className="nav-ink" style={{ transform: `translateY(${navIndex * 46}px)` }} aria-hidden="true" />
            {SECTIONS.map((id, i) => (
              <button key={id} className={`nav-item ${section === id ? 'active' : ''}`} style={{ ['--i' as string]: i }} onClick={() => { sound.play('tap'); navigate(id); }} aria-current={section === id ? 'page' : undefined} title={SECTION_LABELS[id]} data-testid={`nav-${id}`}>
                <Icon name={SECTION_ICON[id]} />
                <span className="label">{SECTION_LABELS[id]}</span>
                {id === 'missions' && approvals.length > 0 && <span className="count">{approvals.length}</span>}
              </button>
            ))}
          </div>
          <button className="nav-item nav-toggle" onClick={() => setState({ navOpen: !navOpen })} aria-label={navOpen ? 'Collapse navigation' : 'Expand navigation'} aria-expanded={navOpen}>
            <Icon name="menu" />
            <span className="label">Collapse</span>
          </button>
        </nav>
        <div className="main">
          <TopBar />
          {(!online || ws === 'offline') && (
            <div className="offline" role="status">
              {!online ? 'This iPad is offline. TOURBILLION will reconnect automatically.' : 'Connection to the server lost — reconnecting… Work in progress continues on the server.'}
            </div>
          )}
          <main ref={contentRef} className={`content ${section === 'browser' ? 'flush' : ''} ${section === 'command' ? 'cc-scroll' : ''}`}>
            <Suspense fallback={<div className="empty"><span className="holo-loader inline"><span className="ring a" /><span className="ring b" /></span> Loading…</div>}>
              <View />
            </Suspense>
          </main>
        </div>
      </div>
      <ApprovalDock />
      <Toasts />
      {(!booted || bootSeq != null) && <BootOverlay />}
    </>
  );
}

function TopBar() {
  const section = useStore((s) => s.section);
  const ws = useStore((s) => s.ws);
  const status = useStore((s) => s.status);
  const notifications = useStore((s) => s.notifications);
  const latest = useStore((s) => s.telemetry.at(-1));
  const linkMs = useStore((s) => s.link.latencyMs);
  const owner = useStore((s) => s.settings?.ownerName);
  const [now, setNow] = useState(new Date());
  const [open, setOpen] = useState(false);
  const [diag, setDiag] = useState<SheetTarget | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const unread = notifications.filter((n) => !n.read).length;
  const ai = status?.ai.state;
  const cpu = latest?.cpu.percent ?? null;
  const mem = latest?.memory.percent ?? null;
  return (
    <header className="topbar">
      <div className="tb-id">
        <h1>{SECTION_LABELS[section]}</h1>
        <div className="tb-sub">TOURBILLION CORE{owner ? ` · ${owner}` : ''}</div>
      </div>
      <span className="spacer" />
      {latest && (
        <div className="tb-perf" title="Server host load (live telemetry)">
          <span className="meter"><span className="k">CPU</span><span className="bar"><i style={{ width: `${cpu ?? 0}%` }} /></span><span className="v">{cpu == null ? 'n/a' : `${Math.round(cpu)}%`}</span></span>
          <span className="meter"><span className="k">MEM</span><span className="bar violet"><i style={{ width: `${mem ?? 0}%` }} /></span><span className="v">{mem == null ? 'n/a' : `${Math.round(mem)}%`}</span></span>
        </div>
      )}
      <button className={`chip link ${ws}`} title="Realtime link to the server — open link diagnostics" data-testid="ws-chip" onClick={() => setDiag({ kind: 'link' })}>
        <SignalBars ms={ws === 'live' ? linkMs : null} /> {ws === 'live' ? 'LINK' : ws === 'connecting' ? 'LINKING' : 'OFFLINE'}
        {ws === 'live' && linkMs != null && <span className="lat">{linkMs}ms</span>}
      </button>
      <button className="chip" title={`Claude: ${ai ? INTEGRATION_LABEL[ai] : 'unknown'} — open AI diagnostics`} onClick={() => setDiag({ kind: 'ai' })}>
        <Dot kind={ai === 'connected' ? 'ok' : ai === 'error' ? 'err' : ai === 'configured' ? 'warn' : 'off'} pulse={ai === 'connected'} /> CLAUDE
        {status && <span className="model">{status.ai.model}</span>}
      </button>
      <span className="clock" aria-label="Time">
        <span className="t">{clock(now.toISOString())}</span>
        <span className="d">{now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}</span>
      </span>
      <button className={`btn ghost icon bell ${unread ? 'unread' : ''}`} onClick={() => setOpen(true)} aria-label={`Notifications (${unread} unread)`} style={{ position: 'relative' }}>
        <Icon name="bell" />
        {unread > 0 && <span className="badge amber" key={unread} style={{ position: 'absolute', top: 4, right: 0, height: 16, padding: '0 4px' }}>{unread}</span>}
      </button>
      {diag && <DiagnosticsSheet target={diag} onClose={() => setDiag(null)} open={setDiag} />}
      {open && (
        <Sheet
          title="Notifications"
          onClose={() => {
            setOpen(false);
            void api.post('/api/notifications/read', {});
            setState((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
          }}
        >
          <div className="list">
            {notifications.length === 0 && <div className="empty">No notifications.</div>}
            {notifications.map((n) => (
              <div key={n.id} className={`list-item ${n.link ? 'clickable' : ''} ${n.read ? '' : 'unread'}`} onClick={() => {
                if (n.link) {
                  const [sec, param] = n.link.split('/');
                  navigate(sec as SectionId, param ?? null);
                  setOpen(false);
                }
              }}>
                <Dot kind={n.level === 'error' ? 'err' : n.level === 'warning' ? 'warn' : n.level === 'success' ? 'ok' : 'live'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="small"><b>{n.title}</b></div>
                  <div className="tiny muted ellipsis">{n.body}</div>
                </div>
                <span className="tiny muted">{ago(n.createdAt)}</span>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </header>
  );
}

/** Length of the full boot choreography (ms): materialisation, panels, indicators, greeting. */
const BOOT_MS = 4600;

/**
 * Boot: the INITIALISE tap unlocks audio and speech on iPadOS (they require a
 * user gesture), then the skippable sequence plays — background, particles,
 * core materialisation, rings one by one, panels, indicators, live readiness
 * lines read from the server — and settles into idle.
 */
function BootOverlay() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.status);
  const ws = useStore((s) => s.ws);
  const agents = useStore((s) => s.agents);
  const integrations = useStore((s) => s.integrations);
  const booted = useStore((s) => s.booted);
  const bootSeq = useStore((s) => s.bootSeq);
  const [quick] = useState(() => {
    try {
      return sessionStorage.getItem('tc.booted') === '1';
    } catch {
      return false;
    }
  });

  const greet = () => {
    const name = settings?.ownerName ?? 'Keenan';
    const st = currentStatus();
    const aiReady = st?.ai.state === 'connected' || st?.ai.state === 'configured';
    const line = aiReady
      ? `${greeting()}, ${name}. TOURBILLION CORE systems are online. Intelligence services are ready. What shall we work on?`
      : `${greeting()}, ${name}. TOURBILLION CORE systems are online. Intelligence services are standing by — Claude is not connected yet.`;
    say(line, 'system', true);
  };

  const initialise = async () => {
    await sound.unlock();
    voice.prime();
    try {
      sessionStorage.setItem('tc.booted', '1');
    } catch {
      /* ignore */
    }
    if (quick) {
      setState({ booted: true });
      return;
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cinematic = (settings?.bootSequence ?? true) && !reduced;
    setState({ booted: true, bootSeq: cinematic ? performance.now() : null });
    sound.play('startup');
    setTimeout(greet, cinematic ? 2600 : 900);
  };

  useEffect(() => {
    if (bootSeq == null) return;
    const t = setTimeout(() => setState({ bootSeq: null }), Math.max(0, BOOT_MS - (performance.now() - bootSeq)));
    return () => clearTimeout(t);
  }, [bootSeq]);

  useEffect(() => {
    if (!quick || booted) return;
    // After a reload in the same session, any first tap unlocks audio silently.
    const once = () => void initialise();
    window.addEventListener('pointerdown', once, { once: true });
    return () => window.removeEventListener('pointerdown', once);
  });

  if (bootSeq != null) {
    const aiState = status?.ai.state;
    const lines: { k: string; v: string; ok: boolean }[] = [
      { k: 'Server link', v: ws === 'live' ? 'live' : ws === 'connecting' ? 'linking…' : 'offline', ok: ws === 'live' },
      { k: 'Claude', v: aiState ? INTEGRATION_LABEL[aiState] : 'checking…', ok: aiState === 'connected' || aiState === 'configured' },
      { k: 'Agents', v: agents.length ? `${agents.length} of ${AGENT_IDS.length} registered` : 'loading…', ok: agents.length === AGENT_IDS.length },
      { k: 'Integrations', v: integrations.length ? `${integrations.filter((i) => i.state === 'connected').length} connected · ${integrations.length} known` : 'loading…', ok: integrations.length > 0 },
      { k: 'Missions', v: status ? `${status.tasks.active} active · ${status.tasks.awaitingApproval} awaiting approval` : 'loading…', ok: !!status },
    ];
    return (
      <div className="boot sequence" data-testid="boot-sequence">
        <div className="boot-lines" aria-live="polite">
          {lines.map((l, i) => (
            <div key={l.k} className={`boot-line ${l.ok ? 'ok' : ''}`} style={{ animationDelay: `${2.9 + i * 0.16}s` }}>
              <span className="k">{l.k}</span>
              <span className="v">{l.v}</span>
            </div>
          ))}
        </div>
        <button className="btn ghost sm boot-skip" onClick={() => setState({ bootSeq: null })} data-testid="boot-skip">
          Skip
        </button>
      </div>
    );
  }
  if (quick) return null;
  return (
    <div className="boot" data-testid="boot">
      <div className="boot-mark">
        <Logo size={120} />
        <span className="boot-ring" />
      </div>
      <div className="title">TOURBILLION CORE</div>
      <div className="sub">Personal AI operating environment</div>
      <button className="btn primary initialise magnetic" onClick={() => void initialise()} data-testid="initialise">
        INITIALISE
      </button>
      <div className="tiny muted" style={{ maxWidth: 360 }}>Tapping enables sound and voice. Audio respects your iPad’s silent switch.</div>
    </div>
  );
}

/** Latest server status at the moment of the greeting (not a render-time snapshot). */
function currentStatus() {
  return getState().status;
}
