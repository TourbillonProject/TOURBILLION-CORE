import { safeFetch, type NetPolicy } from '../security/net.js';

/**
 * YouTube support.
 *
 * Playback happens on the iPad itself through YouTube's official IFrame
 * Player API (privacy-enhanced youtube-nocookie.com domain). The player
 * reports its real state (playing, paused, buffering) and errors such as
 * 101/150 (owner disabled embedding) — in which case the UI offers to open
 * the video in Safari or the YouTube app. Nothing pretends to play.
 *
 * Search: the official YouTube Data API v3 when TC_YOUTUBE_API_KEY is set;
 * otherwise results are read from youtube.com rendered in the live remote
 * browser (the same page a person would see).
 */

export interface VideoResult {
  videoId: string;
  title: string;
  channel: string;
  description: string;
  thumbnail: string;
  duration: string | null;
  views: string | null;
  published: string | null;
  embeddable: boolean | null;
  url: string;
}

const ID = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(s: string): boolean {
  return ID.test(s);
}

export function parseYouTubeUrl(raw: string): { videoId: string | null; listId: string | null; searchQuery: string | null } | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return { videoId: ID.test(id) ? id : null, listId: u.searchParams.get('list'), searchQuery: null };
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com' && host !== 'music.youtube.com') return null;
  const v = u.searchParams.get('v');
  if (v && ID.test(v)) return { videoId: v, listId: u.searchParams.get('list'), searchQuery: null };
  const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
  if (m) return { videoId: m[1], listId: null, searchQuery: null };
  if (u.pathname === '/results') return { videoId: null, listId: null, searchQuery: u.searchParams.get('search_query') };
  return { videoId: null, listId: u.searchParams.get('list'), searchQuery: null };
}

function isoDuration(d: string | undefined): string | null {
  if (!d) return null;
  const m = d.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = Number(m[2] ?? 0) + Number(m[1] ?? 0) * 24;
  const min = Number(m[3] ?? 0);
  const s = Number(m[4] ?? 0);
  return h ? `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${min}:${String(s).padStart(2, '0')}`;
}

export async function searchYouTubeApi(query: string, apiKey: string, endpoint: string, policy: NetPolicy): Promise<VideoResult[]> {
  const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '20', q: query, key: apiKey, safeSearch: 'moderate' });
  const res = await safeFetch(`${endpoint}/search?${params}`, { policy, timeoutMs: 15_000 });
  if (res.status !== 200) {
    let msg = `YouTube Data API returned HTTP ${res.status}`;
    try {
      msg += `: ${res.json<{ error?: { message?: string } }>().error?.message ?? ''}`;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const data = res.json<{ items: { id: { videoId: string }; snippet: { title: string; channelTitle: string; description: string; publishedAt: string; thumbnails: { medium?: { url: string }; high?: { url: string } } } }[] }>();
  const ids = data.items.map((i) => i.id.videoId).filter(Boolean);
  const details = new Map<string, { duration: string | null; embeddable: boolean | null; views: string | null }>();
  if (ids.length) {
    const vp = new URLSearchParams({ part: 'contentDetails,status,statistics', id: ids.join(','), key: apiKey });
    const vr = await safeFetch(`${endpoint}/videos?${vp}`, { policy, timeoutMs: 15_000 });
    if (vr.status === 200) {
      for (const v of vr.json<{ items: { id: string; contentDetails?: { duration?: string }; status?: { embeddable?: boolean }; statistics?: { viewCount?: string } }[] }>().items) {
        details.set(v.id, { duration: isoDuration(v.contentDetails?.duration), embeddable: v.status?.embeddable ?? null, views: v.statistics?.viewCount ?? null });
      }
    }
  }
  return data.items
    .filter((i) => i.id.videoId)
    .map((i) => ({
      videoId: i.id.videoId,
      title: decodeEntities(i.snippet.title),
      channel: i.snippet.channelTitle,
      description: decodeEntities(i.snippet.description),
      thumbnail: i.snippet.thumbnails.high?.url ?? i.snippet.thumbnails.medium?.url ?? `https://i.ytimg.com/vi/${i.id.videoId}/hqdefault.jpg`,
      duration: details.get(i.id.videoId)?.duration ?? null,
      views: details.get(i.id.videoId)?.views ?? null,
      published: i.snippet.publishedAt,
      embeddable: details.get(i.id.videoId)?.embeddable ?? null,
      url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
    }));
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Runs inside the YouTube results page in the remote browser. Kept as a string-free function for page.evaluate. */
export function extractResultsInPage(): VideoResult[] {
  type Run = { text?: string };
  type Renderer = {
    videoId?: string;
    title?: { runs?: Run[]; simpleText?: string };
    ownerText?: { runs?: Run[] };
    longBylineText?: { runs?: Run[] };
    lengthText?: { simpleText?: string };
    viewCountText?: { simpleText?: string };
    publishedTimeText?: { simpleText?: string };
    detailedMetadataSnippets?: { snippetText?: { runs?: Run[] } }[];
  };
  const out: VideoResult[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 40 || out.length >= 30) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const vr = obj.videoRenderer as Renderer | undefined;
    if (vr?.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      const txt = (r?: { runs?: Run[]; simpleText?: string }) => (r?.simpleText ?? (r?.runs ?? []).map((x) => x.text ?? '').join('')).trim();
      out.push({
        videoId: vr.videoId,
        title: txt(vr.title),
        channel: txt(vr.ownerText ?? vr.longBylineText),
        description: txt(vr.detailedMetadataSnippets?.[0]?.snippetText),
        thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
        duration: vr.lengthText?.simpleText ?? null,
        views: vr.viewCountText?.simpleText ?? null,
        published: vr.publishedTimeText?.simpleText ?? null,
        embeddable: null,
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
      });
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };
  visit((window as unknown as { ytInitialData?: unknown }).ytInitialData, 0);
  if (out.length === 0) {
    for (const a of Array.from(document.querySelectorAll('a#video-title[href*="watch?v="]')) as HTMLAnchorElement[]) {
      const id = new URL(a.href).searchParams.get('v');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ videoId: id, title: (a.textContent ?? '').trim(), channel: '', description: '', thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: null, views: null, published: null, embeddable: null, url: `https://www.youtube.com/watch?v=${id}` });
    }
  }
  return out;
}
