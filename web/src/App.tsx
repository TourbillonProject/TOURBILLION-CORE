import { lazy, Suspense, useEffect, useState } from 'react';
import { SECTIONS, SECTION_LABELS, type SectionId } from '@tc/shared';
import { api } from './lib/api';
import { connect, disconnect } from './lib/events';
import { navigate, readHash, setState, toast, useStore, type Settings } from './lib/store';
import { AuthScreen } from './auth/Auth';
import { Icon, Logo, SECTION_ICON } from './components/icons';
import { ApprovalDock, Toasts } from './components/Approvals';
import { Dot, Sheet } from './components/ui';
import { sound } from './audio/sound';
import { voice } from './voice/voice';
import { greeting, ago } from './lib/format';
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
  const settings = useStore((s) => s.settings);

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
    if (settings) sound.configure(settings.soundEnabled, settings.soundVolume);
  }, [settings?.soundEnabled, settings?.soundVolume]);

  const View = VIEWS[section];
  return (
    <>
      <div className="backdrop" />
      <div className="shell">
        <nav className={`nav ${navOpen ? 'open' : ''}`} aria-label="Sections">
          <div className="nav-brand">
            <Logo />
            <div className="wordmark">TOURBILLION<br />CORE</div>
          </div>
          {SECTIONS.map((id) => (
            <button key={id} className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={section === id ? 'page' : undefined} title={SECTION_LABELS[id]} data-testid={`nav-${id}`}>
              <Icon name={SECTION_ICON[id]} />
              <span className="label">{SECTION_LABELS[id]}</span>
              {id === 'missions' && approvals.length > 0 && <span className="count">{approvals.length}</span>}
            </button>
          ))}
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
          <main className={`content ${section === 'command' || section === 'browser' ? 'flush' : ''}`}>
            <Suspense fallback={<div className="empty">Loading…</div>}>
              <View />
            </Suspense>
          </main>
        </div>
      </div>
      <ApprovalDock />
      <Toasts />
      {!booted && <BootOverlay />}
    </>
  );
}

function TopBar() {
  const section = useStore((s) => s.section);
  const ws = useStore((s) => s.ws);
  const status = useStore((s) => s.status);
  const notifications = useStore((s) => s.notifications);
  const [now, setNow] = useState(new Date());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  const unread = notifications.filter((n) => !n.read).length;
  const ai = status?.ai.state;
  return (
    <header className="topbar">
      <h1>{SECTION_LABELS[section]}</h1>
      <span className="spacer" />
      <span className="chip" title="Realtime link to the server" data-testid="ws-chip">
        <Dot kind={ws === 'live' ? 'live' : ws === 'connecting' ? 'warn' : 'err'} pulse={ws === 'connecting'} /> {ws === 'live' ? 'LINK' : ws === 'connecting' ? 'LINKING' : 'OFFLINE'}
      </span>
      <span className="chip" title="Claude connection">
        <Dot kind={ai === 'connected' ? 'ok' : ai === 'error' ? 'err' : ai === 'configured' ? 'warn' : 'off'} /> CLAUDE
      </span>
      <span className="clock">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
      <button className="btn ghost icon" onClick={() => setOpen(true)} aria-label={`Notifications (${unread} unread)`} style={{ position: 'relative' }}>
        <Icon name="bell" />
        {unread > 0 && <span className="badge amber" style={{ position: 'absolute', top: 4, right: 0, height: 16, padding: '0 4px' }}>{unread}</span>}
      </button>
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
              <div key={n.id} className="list-item clickable" onClick={() => {
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

/** Boot sequence: the tap unlocks audio and speech on iPadOS (they require a user gesture). */
function BootOverlay() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.status);
  const [quick] = useState(() => {
    try {
      return sessionStorage.getItem('tc.booted') === '1';
    } catch {
      return false;
    }
  });

  const initialise = async () => {
    await sound.unlock();
    voice.prime();
    setState({ booted: true });
    try {
      sessionStorage.setItem('tc.booted', '1');
    } catch {
      /* ignore */
    }
    if (quick) return;
    sound.play('startup');
    const name = settings?.ownerName ?? 'Keenan';
    const aiReady = status?.ai.state === 'connected' || status?.ai.state === 'configured';
    const line = aiReady
      ? `${greeting()}, ${name}. TOURBILLION CORE systems are online. Intelligence services are ready. What shall we work on?`
      : `${greeting()}, ${name}. TOURBILLION CORE systems are online. Intelligence services are standing by — Claude is not connected yet.`;
    setTimeout(() => say(line, 'system', true), 900);
  };

  useEffect(() => {
    if (!quick) return;
    // After a reload in the same session, any first tap unlocks audio silently.
    const once = () => void initialise();
    window.addEventListener('pointerdown', once, { once: true });
    return () => window.removeEventListener('pointerdown', once);
  });

  if (quick) return null;
  return (
    <div className="boot" data-testid="boot">
      <Logo size={120} />
      <div className="title">TOURBILLION CORE</div>
      <div className="sub">Personal AI operating environment</div>
      <button className="btn primary initialise" onClick={() => void initialise()} data-testid="initialise">
        INITIALISE
      </button>
      <div className="tiny muted" style={{ maxWidth: 360 }}>Tapping enables sound and voice. Audio respects your iPad’s silent switch.</div>
    </div>
  );
}
