import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../../lib/api';
import { toast } from '../../lib/store';
import { Empty } from '../../components/ui';
import { Icon } from '../../components/icons';

/**
 * YouTube via the official IFrame Player API on the privacy-enhanced domain.
 * The status line reflects the player's *reported* state; if the video owner
 * disallows embedding (errors 101/150) we say so and offer Safari / the app.
 */

export interface VideoResult {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string | null;
  views: string | null;
  published: string | null;
  embeddable: boolean | null;
}

interface YTPlayer {
  destroy(): void;
  loadVideoById(id: string): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
}

let apiPromise: Promise<YTNamespace> | null = null;
function loadYouTubeApi(): Promise<YTNamespace> {
  const w = window as unknown as { YT?: YTNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT!);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('Could not load the YouTube player (network blocked or offline).'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

const STATE_NAMES: Record<number, string> = { [-1]: 'Not started', 0: 'Ended', 1: 'Playing', 2: 'Paused', 3: 'Buffering', 5: 'Ready' };
const ERRORS: Record<number, string> = {
  2: 'Invalid video id.',
  5: 'This video cannot be played in the HTML5 player.',
  100: 'Video not found, removed or private.',
  101: 'The owner does not allow this video to be played in other apps.',
  150: 'The owner does not allow this video to be played in other apps.',
  153: 'YouTube rejected the embed (missing referrer).',
};

export function YouTubePlayer({ videoId, title }: { videoId: string; title?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const [state, setState] = useState<string>('Loading player…');
  const [error, setError] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setState('Loading player…');
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !host.current) return;
        const el = document.createElement('div');
        host.current.replaceChildren();
        host.current.appendChild(el);
        player.current = new YT.Player(el, {
          host: 'https://www.youtube-nocookie.com',
          videoId,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
          events: {
            onReady: () => setState('Ready — tap play'),
            onStateChange: (e: { data: number }) => setState(STATE_NAMES[e.data] ?? `State ${e.data}`),
            onError: (e: { data: number }) => {
              setError(e.data);
              setState('Unavailable');
            },
          },
        });
        void api.post('/api/youtube/watched', { videoId, title });
      })
      .catch((e) => {
        setState('Player unavailable');
        toast('warning', 'YouTube player', errMsg(e));
        setError(-1);
      });
    return () => {
      cancelled = true;
      player.current?.destroy();
      player.current = null;
    };
  }, [videoId]);

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  return (
    <div className="stack" data-testid="yt-player">
      <div className="player" ref={host} />
      <div className="row between">
        <span className="chip" data-testid="yt-state"><span className={`dot ${error ? 'err' : state === 'Playing' ? 'ok' : 'live'}`} /> {state}</span>
        <a className="btn sm" href={watchUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> Open in Safari / YouTube app</a>
      </div>
      {error !== null && <div className="small" style={{ color: 'var(--amber)' }}>{ERRORS[error] ?? 'The player could not load this video.'} Use “Open in Safari / YouTube app” to watch it there.</div>}
    </div>
  );
}

export function YouTubePanel({ initialQuery, initialVideo, liveAvailable, onOpenLive }: { initialQuery?: string | null; initialVideo?: string | null; liveAvailable: boolean; onOpenLive: (url: string) => void }) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [results, setResults] = useState<VideoResult[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [video, setVideo] = useState<{ id: string; title?: string } | null>(initialVideo ? { id: initialVideo } : null);

  const search = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ source: string; results: VideoResult[] }>('/api/youtube/search', { query: q }, { timeoutMs: 60_000 });
      setResults(r.results);
      setSource(r.source);
      if (!r.results.length) setErr('No results could be read.');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialQuery) void search(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    if (initialVideo) setVideo({ id: initialVideo });
  }, [initialVideo]);

  return (
    <div className="stack" style={{ padding: 14 }} data-testid="youtube-panel">
      <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); void search(query); }}>
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search YouTube" enterKeyHint="search" data-testid="yt-search" />
        <button className="btn primary" disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {video && <YouTubePlayer videoId={video.id} title={video.title} />}
      {err && (
        <div className="small" style={{ color: 'var(--amber)' }}>
          {err}
          <div className="row" style={{ marginTop: 6 }}>
            {liveAvailable && <button className="btn sm" onClick={() => onOpenLive(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`)}>Open youtube.com in the live browser</button>}
            <a className="btn sm" href={`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">Search in Safari</a>
          </div>
        </div>
      )}
      {source && <div className="tiny muted">Results via {source === 'youtube-data-api' ? 'YouTube Data API' : 'youtube.com rendered in the remote browser'}.</div>}
      {results.length > 0 ? (
        <div className="yt-grid">
          {results.map((v) => (
            <div key={v.videoId} className="yt-card" onClick={() => { setVideo({ id: v.videoId, title: v.title }); window.scrollTo(0, 0); }} data-testid="yt-result">
              <img src={v.thumbnail} alt="" loading="lazy" />
              <div className="t">
                <div className="ellipsis" style={{ whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.title}</div>
                <div className="tiny muted ellipsis">{v.channel}{v.duration ? ` · ${v.duration}` : ''}{v.embeddable === false ? ' · not embeddable' : ''}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        !video && !busy && !err && <Empty>Search for videos, or open youtube.com in the live browser.</Empty>
      )}
    </div>
  );
}
