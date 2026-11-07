import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { safeFetch, type NetPolicy } from '../security/net.js';
import { parseYouTubeUrl } from './youtube.js';

/**
 * Reader mode: the server fetches a page (through the SSRF guard), extracts
 * the readable article with Mozilla Readability, and returns structured
 * content. The client sanitises again with DOMPurify before display and
 * renders links as in-app navigation. Scripts never run.
 */

export interface ReaderPage {
  kind: 'article' | 'text' | 'json' | 'image' | 'unsupported' | 'youtube';
  requestedUrl: string;
  url: string;
  status: number;
  redirects: string[];
  contentType: string;
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  html: string | null;
  text: string;
  links: { href: string; text: string }[];
  youtube?: { videoId: string | null; listId: string | null; searchQuery: string | null };
  fetchedAt: string;
  note: string | null;
}

export async function readPage(rawUrl: string, policy: NetPolicy, signal?: AbortSignal): Promise<ReaderPage> {
  const fetchedAt = new Date().toISOString();
  const yt = parseYouTubeUrl(rawUrl);
  if (yt) {
    return {
      kind: 'youtube',
      requestedUrl: rawUrl,
      url: rawUrl,
      status: 0,
      redirects: [],
      contentType: 'text/html',
      title: 'YouTube',
      byline: null,
      siteName: 'YouTube',
      excerpt: null,
      html: null,
      text: '',
      links: [],
      youtube: yt,
      fetchedAt,
      note: 'YouTube is a script-heavy app; it opens in the YouTube panel (official embed player) or the live remote browser.',
    };
  }
  const res = await safeFetch(rawUrl, {
    policy,
    signal,
    timeoutMs: 20_000,
    maxBytes: 8 * 1024 * 1024,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-language': 'en-GB,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 TourbillionCoreReader/0.1',
    },
  });
  const contentType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const base: Omit<ReaderPage, 'kind' | 'title' | 'html' | 'text' | 'links' | 'byline' | 'siteName' | 'excerpt' | 'note'> = {
    requestedUrl: rawUrl,
    url: res.url,
    status: res.status,
    redirects: res.redirects,
    contentType,
    fetchedAt,
  };

  if (contentType.startsWith('image/')) {
    return { ...base, kind: 'image', title: res.url.split('/').pop() ?? 'Image', byline: null, siteName: null, excerpt: null, html: null, text: '', links: [], note: null };
  }
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    let pretty = res.text();
    try {
      pretty = JSON.stringify(JSON.parse(pretty), null, 2);
    } catch {
      /* show raw */
    }
    return { ...base, kind: 'json', title: new URL(res.url).pathname, byline: null, siteName: new URL(res.url).hostname, excerpt: null, html: null, text: pretty.slice(0, 500_000), links: [], note: null };
  }
  if (contentType.startsWith('text/plain') || contentType === 'text/markdown' || contentType === 'text/csv') {
    return { ...base, kind: 'text', title: new URL(res.url).pathname, byline: null, siteName: new URL(res.url).hostname, excerpt: null, html: null, text: res.text().slice(0, 500_000), links: [], note: null };
  }
  if (!contentType.includes('html')) {
    return {
      ...base,
      kind: 'unsupported',
      title: res.url,
      byline: null,
      siteName: new URL(res.url).hostname,
      excerpt: null,
      html: null,
      text: '',
      links: [],
      note: `Reader mode cannot display ${contentType || 'this content type'}. Open it in the live browser or in Safari.`,
    };
  }

  const html = res.text();
  const { document } = parseHTML(html);
  // Absolutise links and media before Readability rewrites the tree.
  for (const el of document.querySelectorAll('a[href]')) absolutise(el, 'href', res.url);
  for (const el of document.querySelectorAll('img[src]')) absolutise(el, 'src', res.url);
  for (const el of document.querySelectorAll('img[srcset], source[srcset]')) el.removeAttribute('srcset');
  const links: { href: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) links.push({ href, text: text.slice(0, 160) });
    if (links.length >= 300) break;
  }
  const docTitle = (document.querySelector('title')?.textContent ?? '').trim();
  let article: ReturnType<Readability<string>['parse']> = null;
  try {
    article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  if (!article) {
    const text = (document.body?.textContent ?? '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    return {
      ...base,
      kind: 'article',
      title: docTitle || res.url,
      byline: null,
      siteName: new URL(res.url).hostname,
      excerpt: null,
      html: null,
      text: text.slice(0, 200_000),
      links,
      note: 'No main article detected; showing page text and links. The live browser renders the full page.',
    };
  }
  return {
    ...base,
    kind: 'article',
    title: article.title || docTitle || res.url,
    byline: article.byline ?? null,
    siteName: article.siteName ?? new URL(res.url).hostname,
    excerpt: article.excerpt ?? null,
    html: article.content ?? null,
    text: (article.textContent ?? '').trim().slice(0, 200_000),
    links,
    note: null,
  };
}

function absolutise(el: Element, attr: string, base: string) {
  const v = el.getAttribute(attr);
  if (!v) return;
  try {
    el.setAttribute(attr, new URL(v, base).toString());
  } catch {
    el.removeAttribute(attr);
  }
}

/** Normalises what the owner typed in the address bar into a URL or a search. */
export function interpretAddress(input: string): { kind: 'url'; url: string } | { kind: 'search'; query: string } {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(s) && !s.includes(' ')) return { kind: 'url', url: `https://${s}` };
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return { kind: 'url', url: `http://${s}` };
  return { kind: 'search', query: s };
}
