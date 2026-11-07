import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { api, errMsg } from '../lib/api';
import { setState, toast, useStore, navigate } from '../lib/store';
import { Icon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Empty, Sheet } from '../components/ui';
import { LiveView } from './browser/LiveView';
import { YouTubePanel } from './browser/YouTube';
import { ago } from '../lib/format';

type Mode = 'home' | 'reader' | 'live' | 'youtube';
interface Tab {
  id: string;
  mode: Mode;
  url: string;
  title: string;
  history: { mode: Mode; url: string }[];
  index: number;
  liveTabId?: string;
  yt?: { query?: string | null; videoId?: string | null };
}
interface ReaderPage {
  kind: string;
  url: string;
  status: number;
  redirects: string[];
  title: string;
  byline: string | null;
  siteName: string | null;
  html: string | null;
  text: string;
  links: { href: string; text: string }[];
  youtube?: { videoId: string | null; searchQuery: string | null };
  note: string | null;
}

const TABS_KEY = 'tc.browser.tabs';
const newId = () => Math.random().toString(36).slice(2, 9);
const homeTab = (): Tab => ({ id: newId(), mode: 'home', url: '', title: 'New tab', history: [{ mode: 'home', url: '' }], index: 0 });

function loadTabs(): Tab[] {
  try {
    const t = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]') as Tab[];
    // Live tabs live on the server and may have been reclaimed; reopen them on demand.
    return t.length ? t.map((x) => ({ ...x, liveTabId: undefined })) : [homeTab()];
  } catch {
    return [homeTab()];
  }
}

function ytFromUrl(url: string): { videoId: string | null; query: string | null } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return { videoId: u.pathname.slice(1, 12), query: null };
    if (host !== 'youtube.com') return null;
    const v = u.searchParams.get('v');
    if (v) return { videoId: v, query: null };
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    if (m) return { videoId: m[1], query: null };
    return { videoId: null, query: u.searchParams.get('search_query') };
  } catch {
    return null;
  }
}

export default function Browser() {
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const [active, setActive] = useState(() => tabs[0].id);
  const [address, setAddress] = useState('');
  const [liveAvailable, setLiveAvailable] = useState(false);
  // Rendering mode chosen in the toolbar; applies to addresses typed into the bar.
  const [prefMode, setPrefMode] = useState<'auto' | 'live' | 'reader'>('auto');
  const [summary, setSummary] = useState<{ title: string; summary: string } | null>(null);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs.slice(0, 8)));
    } catch {
      /* ignore */
    }
  }, [tabs]);
  useEffect(() => setAddress(tab.url), [tab.id, tab.url]);
  useEffect(() => {
    api.get<{ available: boolean }>('/api/browser/live/status').then((s) => setLiveAvailable(s.available)).catch(() => setLiveAvailable(false));
  }, []);

  const update = useCallback((id: string, patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))), []);

  const go = useCallback(
    async (input: string, opts: { mode?: 'auto' | 'live' | 'reader'; push?: boolean; tabId?: string } = {}) => {
      const id = opts.tabId ?? active;
      const r = await api.post<{ kind: 'url' | 'search'; url?: string; query?: string }>('/api/browser/resolve', { input });
      let url: string;
      if (r.kind === 'search') {
        // In-app results need a search provider; otherwise use a real search page in the live browser.
        try {
          const s = await api.post<{ engine: string; results: { title: string; url: string; snippet: string }[] }>('/api/browser/search', { query: r.query! });
          const html = `<h1>Search: ${escapeHtml(r.query!)}</h1><p><em>via ${escapeHtml(s.engine)}</em></p>${s.results.map((x) => `<p><a href="${escapeHtml(x.url)}">${escapeHtml(x.title)}</a><br><small>${escapeHtml(x.url)}</small><br>${escapeHtml(x.snippet)}</p>`).join('')}`;
          sessionStorage.setItem(`tc.search.${id}`, html);
          return navigateTab(id, { mode: 'reader', url: `search:${r.query}`, title: `Search: ${r.query}` }, opts.push !== false);
        } catch {
          if (!liveAvailable) {
            toast('warning', 'No search provider', 'Configure SearXNG or Brave in Connected Apps, or enable the remote browser.');
            return;
          }
          url = `https://duckduckgo.com/?q=${encodeURIComponent(r.query!)}`;
        }
      } else url = r.url!;
      const yt = ytFromUrl(url);
      const mode = opts.mode ?? 'auto';
      if (yt && mode === 'auto' && (yt.videoId || !liveAvailable)) {
        return navigateTab(id, { mode: 'youtube', url, title: 'YouTube', yt: { videoId: yt.videoId, query: yt.query } }, opts.push !== false);
      }
      const finalMode: Mode = mode === 'reader' ? 'reader' : mode === 'live' ? 'live' : liveAvailable ? 'live' : 'reader';
      return navigateTab(id, { mode: finalMode, url, title: new URL(url).hostname }, opts.push !== false);
    },
    [active, liveAvailable],
  );

  const navigateTab = (id: string, next: { mode: Mode; url: string; title: string; yt?: Tab['yt'] }, push: boolean) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        // push: new entry; otherwise (mode switch / reload) replace the current entry so Back/Forward stay accurate.
        const entry = { mode: next.mode, url: next.url };
        const history = push ? [...t.history.slice(0, t.index + 1), entry] : t.history.map((h, i) => (i === t.index ? entry : h));
        return { ...t, ...next, history, index: push ? history.length - 1 : t.index, liveTabId: next.mode === 'live' ? t.liveTabId : t.liveTabId };
      }),
    );
  };

  // Commands from Core Intelligence / voice ("open YouTube", "open bbc.co.uk"). Consumed once, even if
  // they were issued before this (lazily loaded) section mounted.
  const pending = useStore((s) => s.browserCommand);
  const handled = useRef(0);
  useEffect(() => {
    if (!pending || pending.nonce === handled.current) return;
    handled.current = pending.nonce;
    setState({ browserCommand: null });
    const t = homeTab();
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
    if (pending.kind === 'open_url') void go(pending.url, { mode: pending.mode, tabId: t.id }).catch((err) => toast('error', 'Could not open page', errMsg(err)));
    else navigateTab(t.id, { mode: 'youtube', url: 'https://www.youtube.com', title: 'YouTube', yt: { query: pending.query ?? null, videoId: pending.videoId ?? null } }, true);
  }, [pending, go]);

  const historyMove = async (delta: number) => {
    if (tab.mode === 'live' && tab.liveTabId) {
      await api.post(`/api/browser/live/tabs/${tab.liveTabId}/history`, { action: delta < 0 ? 'back' : 'forward' }).catch(() => {});
      return;
    }
    const idx = tab.index + delta;
    const h = tab.history[idx];
    if (!h) return;
    update(tab.id, { index: idx, mode: h.mode, url: h.url, title: h.url || 'New tab', ...(h.mode === 'youtube' ? { yt: ytFromUrl(h.url) ?? {} } : {}) });
  };

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.liveTabId) void api.del(`/api/browser/live/tabs/${t.liveTabId}`).catch(() => {});
    const rest = tabs.filter((x) => x.id !== id);
    const next = rest.length ? rest : [homeTab()];
    setTabs(next);
    if (active === id) setActive(next[next.length - 1].id);
  };

  const summarise = async () => {
    try {
      const r = await api.post<{ title: string; summary: string }>('/api/browser/summarize', tab.mode === 'live' && tab.liveTabId ? { tabId: tab.liveTabId } : { url: tab.url }, { timeoutMs: 180_000 });
      setSummary(r);
    } catch (err) {
      toast('error', 'Summary failed', errMsg(err));
    }
  };

  const external = tab.url && /^https?:/.test(tab.url) ? tab.url : null;
  return (
    <div className="browser" data-testid="browser">
      <div className="tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`tab ${t.id === active ? 'on' : ''}`} onClick={() => setActive(t.id)}>
            <span className="ellipsis">{t.mode === 'youtube' ? '▶ ' : t.mode === 'live' ? '● ' : ''}{t.title || 'New tab'}</span>
            <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} aria-label="Close tab">×</button>
          </div>
        ))}
        <button className="btn ghost sm icon" onClick={() => { const t = homeTab(); setTabs((ts) => [...ts, t]); setActive(t.id); }} aria-label="New tab"><Icon name="plus" size={18} /></button>
      </div>
      <form className="addrbar" onSubmit={(e) => { e.preventDefault(); void go(address, { mode: prefMode }).catch((err) => toast('error', 'Navigation failed', errMsg(err))); }}>
        <button type="button" className="btn ghost sm icon" onClick={() => void historyMove(-1)} aria-label="Back"><Icon name="back" size={18} /></button>
        <button type="button" className="btn ghost sm icon" onClick={() => void historyMove(1)} aria-label="Forward"><Icon name="forward" size={18} /></button>
        <button type="button" className="btn ghost sm icon" onClick={() => (tab.mode === 'live' && tab.liveTabId ? api.post(`/api/browser/live/tabs/${tab.liveTabId}/history`, { action: 'reload' }) : tab.url && go(tab.url, { mode: tab.mode === 'reader' ? 'reader' : 'auto', push: false }))} aria-label="Reload"><Icon name="reload" size={18} /></button>
        <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Search or enter address — e.g. youtube.com" inputMode="url" autoCapitalize="off" autoCorrect="off" enterKeyHint="go" data-testid="address" />
        <select className="select" style={{ width: 'auto', minHeight: 40 }} value={tab.mode === 'live' ? 'live' : tab.mode === 'reader' ? 'reader' : prefMode} onChange={(e) => {
          const m = e.target.value as 'auto' | 'live' | 'reader';
          setPrefMode(m);
          if (tab.url && /^https?:/.test(tab.url)) void go(tab.url, { mode: m, push: false });
        }} aria-label="Rendering mode">
          <option value="auto">Auto</option>
          <option value="live" disabled={!liveAvailable}>Live</option>
          <option value="reader">Reader</option>
        </select>
        <button type="button" className="btn ghost sm" onClick={() => void summarise()} disabled={!external && !(tab.mode === 'live' && tab.liveTabId)}>Summarise</button>
        {external && <a className="btn ghost sm icon" href={external} target="_blank" rel="noopener noreferrer" aria-label="Open in Safari" title="Open in Safari"><Icon name="external" size={18} /></a>}
      </form>
      <div className="viewport">
        {tab.mode === 'home' && <HomeView onGo={(u) => void go(u).catch((err) => toast('error', 'Navigation failed', errMsg(err)))} liveAvailable={liveAvailable} />}
        {tab.mode === 'reader' && <ReaderView key={`${tab.id}:${tab.url}`} tabId={tab.id} url={tab.url} onTitle={(title) => update(tab.id, { title })} onNavigate={(u) => void go(u, { mode: 'reader' })} onLive={liveAvailable ? () => void go(tab.url, { mode: 'live', push: false }) : undefined} onYouTube={(yt) => update(tab.id, { mode: 'youtube', yt })} />}
        {tab.mode === 'live' && <LiveTab key={tab.id} tab={tab} update={update} onYouTube={(videoId) => navigateTab(tab.id, { mode: 'youtube', url: `https://www.youtube.com/watch?v=${videoId}`, title: 'YouTube', yt: { videoId } }, true)} />}
        {tab.mode === 'youtube' && <YouTubePanel initialQuery={tab.yt?.query} initialVideo={tab.yt?.videoId} liveAvailable={liveAvailable} onOpenLive={(u) => void go(u, { mode: 'live' })} />}
      </div>
      {summary && (
        <Sheet title={`Summary — ${summary.title}`} onClose={() => setSummary(null)}>
          <Markdown text={summary.summary} />
          <div className="tiny muted" style={{ marginTop: 8 }}>AI summary of page content (inference). Verify important claims at the source.</div>
        </Sheet>
      )}
    </div>
  );
}

function LiveTab({ tab, update, onYouTube }: { tab: Tab; update: (id: string, p: Partial<Tab>) => void; onYouTube: (videoId: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [liveUrl, setLiveUrl] = useState(tab.url);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        if (tab.liveTabId && opened.current === tab.url) return;
        if (tab.liveTabId) {
          await api.post(`/api/browser/live/tabs/${tab.liveTabId}/navigate`, { url: tab.url });
        } else {
          const t = await api.post<{ id: string }>('/api/browser/live/tabs', { url: tab.url });
          if (cancelled) return;
          update(tab.id, { liveTabId: t.id });
        }
        opened.current = tab.url;
      } catch (err) {
        setError(errMsg(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab.url]);
  const yt = ytFromUrl(liveUrl);
  return (
    <>
      {yt?.videoId && (
        <div className="row" style={{ position: 'absolute', zIndex: 2, left: 12, right: 12, top: 10, justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => onYouTube(yt.videoId!)}><Icon name="play" size={18} /> Watch natively on this iPad</button>
          <span className="chip">The remote stream has no audio and a low frame rate</span>
        </div>
      )}
      {error && <div className="empty" style={{ color: 'var(--amber)' }}>{error}</div>}
      {tab.liveTabId && (
        <LiveView
          tabId={tab.liveTabId}
          onState={(s) => {
            setLiveUrl(s.url);
            update(tab.id, { title: s.title || new URL(s.url).hostname });
          }}
          onError={(m) => setError(m)}
        />
      )}
    </>
  );
}

function ReaderView({ tabId, url, onTitle, onNavigate, onLive, onYouTube }: { tabId: string; url: string; onTitle: (t: string) => void; onNavigate: (u: string) => void; onLive?: () => void; onYouTube: (yt: Tab['yt']) => void }) {
  const [page, setPage] = useState<ReaderPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (url.startsWith('search:')) {
      const html = sessionStorage.getItem(`tc.search.${tabId}`) ?? '<p>Search results expired. Search again.</p>';
      setPage({ kind: 'article', url, status: 200, redirects: [], title: url.slice(7), byline: null, siteName: null, html, text: '', links: [], note: null });
      return;
    }
    setPage(null);
    setError(null);
    api
      .post<ReaderPage>('/api/browser/read', { url }, { timeoutMs: 45_000 })
      .then((p) => {
        if (p.kind === 'youtube' && p.youtube) return onYouTube({ videoId: p.youtube.videoId, query: p.youtube.searchQuery });
        setPage(p);
        onTitle(p.title);
      })
      .catch((e) => setError(errMsg(e)));
  }, [url]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href && /^https?:/i.test(href)) onNavigate(href);
  };

  if (error) return <div className="reader"><h1>Could not open page</h1><p style={{ color: 'var(--amber)' }}>{error}</p>{onLive && <button className="btn" onClick={onLive}>Try the live browser</button>} <a className="btn" href={url} target="_blank" rel="noopener noreferrer">Open in Safari</a></div>;
  if (!page) return <div className="empty">Loading {url}…</div>;
  const clean = page.html ? DOMPurify.sanitize(page.html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'script'], FORBID_ATTR: ['style', 'srcset'], ALLOW_DATA_ATTR: false }) : null;
  return (
    <div className="reader" ref={ref} onClick={onClick} data-testid="reader">
      <div className="tiny muted mono" style={{ marginBottom: 10 }}>
        {page.siteName ?? ''} {page.status ? `· HTTP ${page.status}` : ''} {page.redirects.length ? `· redirected ${page.redirects.length}× → ${page.url}` : ''}
        {onLive && <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={onLive}>View live</button>}
      </div>
      {page.note && <p className="small" style={{ color: 'var(--amber)' }}>{page.note}</p>}
      {!clean && <h1>{page.title}</h1>}
      {page.byline && <p className="small muted">{page.byline}</p>}
      {clean ? <div dangerouslySetInnerHTML={{ __html: clean }} /> : page.kind === 'image' ? <img src={page.url} alt={page.title} /> : page.text ? <pre>{page.text}</pre> : null}
      {!clean && page.links.length > 0 && (
        <>
          <h3>Links on this page</h3>
          <ul>{page.links.slice(0, 80).map((l) => <li key={l.href}><a href={l.href}>{l.text}</a></li>)}</ul>
        </>
      )}
    </div>
  );
}

function HomeView({ onGo, liveAvailable }: { onGo: (u: string) => void; liveAvailable: boolean }) {
  const [history, setHistory] = useState<{ id: number; url: string; title: string; at: string; mode: string }[]>([]);
  useEffect(() => {
    api.get<typeof history>('/api/browser/history').then(setHistory).catch(() => {});
  }, []);
  const quick = [
    ['YouTube', 'youtube.com'],
    ['Wikipedia', 'en.wikipedia.org'],
    ['BBC News', 'bbc.co.uk/news'],
    ['GitHub', 'github.com'],
    ['Hacker News', 'news.ycombinator.com'],
    ['Blender Manual', 'docs.blender.org/manual/en/latest/'],
  ];
  return (
    <div className="reader" style={{ maxWidth: 900 }}>
      <h1 className="display" style={{ letterSpacing: '.2em', fontSize: 18 }}>BROWSER</h1>
      <p className="small muted">Engine: {liveAvailable ? 'live remote Chromium (full websites) with reader mode' : 'reader mode only — the server has no Chromium installed'}. “Open in Safari” is always available.</p>
      <div className="grid auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', margin: '14px 0 22px' }}>
        {quick.map(([name, url]) => (
          <button key={url} className="btn" onClick={() => onGo(url)}>{name}</button>
        ))}
      </div>
      <div className="row between"><h3 style={{ margin: 0 }}>History</h3>{history.length > 0 && <button className="btn ghost sm" onClick={async () => { await api.del('/api/browser/history'); setHistory([]); }}>Clear</button>}</div>
      {history.length === 0 ? <Empty>No browsing history yet.</Empty> : (
        <div className="list">
          {history.slice(0, 40).map((h) => (
            <div key={h.id} className="list-item clickable" onClick={() => onGo(h.url)}>
              <div style={{ flex: 1, minWidth: 0 }}><div className="small ellipsis">{h.title || h.url}</div><div className="tiny muted ellipsis">{h.url}</div></div>
              <span className="tiny muted">{h.mode} · {ago(h.at)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="tiny muted" style={{ marginTop: 20 }}>Return to the Command Center at any time from the navigation rail — <button className="btn ghost sm" onClick={() => navigate('command')}>Command Center</button></p>
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
