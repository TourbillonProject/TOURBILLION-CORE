import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { nowIso } from '../db.js';
import type { NetPolicy } from '../security/net.js';
import { safeFetch } from '../security/net.js';
import type { SecretStore } from '../security/secrets.js';
import type { IntegrationRegistry } from '../services/integrations.js';
import { LiveBrowser } from './live.js';
import { readPage, interpretAddress, type ReaderPage } from './reader.js';
import { searchYouTubeApi, type VideoResult } from './youtube.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export const YOUTUBE_SECRET = 'youtube.api_key';
export const BRAVE_SECRET = 'brave.api_key';

/** Browser facade: reader mode, live remote browser, web search, YouTube, history. */
export class BrowserService {
  readonly live: LiveBrowser;

  constructor(
    private config: AppConfig,
    private db: Database,
    private policy: NetPolicy,
    private secrets: SecretStore,
    integrations: IntegrationRegistry,
  ) {
    this.live = new LiveBrowser(config, policy);
    this.live.onNavigate = (url, title) => this.record(url, title, 'live');

    integrations.register({
      id: 'browser',
      name: 'Remote browser (Chromium)',
      description: 'A real Chromium on the server, streamed to the iPad. Needed for JavaScript-heavy sites such as youtube.com.',
      permissions: ['Open public websites on the server', 'Blocked from private/internal network addresses'],
      requires: ['playwright-core + Chromium on the server (npx playwright-core install chromium)'],
      isConfigured: () => this.config.browser.enabled,
      details: () => ({ ...this.live.availability, tabs: this.live.listTabs().length }),
      test: async () => {
        const p = await this.live.probe();
        if (!p.available) throw new Error(p.detail);
        return { detail: p.detail };
      },
    });
    integrations.register({
      id: 'youtube',
      name: 'YouTube Data API',
      description: 'Official YouTube search. Without it, search uses youtube.com in the remote browser.',
      permissions: ['Search public YouTube videos (read-only)'],
      requires: ['YouTube Data API v3 key (Google Cloud Console)'],
      isConfigured: () => !!this.youtubeKey(),
      details: () => ({ keySource: this.secrets.has(YOUTUBE_SECRET) ? 'stored' : this.config.youtubeApiKey ? 'environment' : 'none' }),
      test: async () => {
        const r = await searchYouTubeApi('nasa', this.youtubeKey()!, this.config.endpoints.youtube, this.policy);
        return { sampleResults: r.length };
      },
      disconnect: () => this.secrets.delete(YOUTUBE_SECRET),
    });
    integrations.register({
      id: 'search',
      name: 'Web search provider',
      description: 'SearXNG (self-hosted metasearch) or Brave Search API for in-app search results.',
      permissions: ['Send search queries to the configured provider'],
      requires: ['TC_SEARXNG_URL, or a Brave Search API key'],
      isConfigured: () => !!this.config.searxngUrl || !!this.braveKey(),
      details: () => ({ provider: this.config.searxngUrl ? 'searxng' : this.braveKey() ? 'brave' : 'none', searxngUrl: this.config.searxngUrl }),
      test: async () => {
        const r = await this.search('open source intelligence');
        return { sampleResults: r.results.length, engine: r.engine };
      },
      disconnect: () => this.secrets.delete(BRAVE_SECRET),
    });
  }

  youtubeKey(): string | null {
    return this.secrets.get(YOUTUBE_SECRET) ?? this.config.youtubeApiKey;
  }

  braveKey(): string | null {
    return this.secrets.get(BRAVE_SECRET) ?? this.config.braveSearchKey;
  }

  interpret(input: string) {
    return interpretAddress(input);
  }

  async read(url: string, signal?: AbortSignal): Promise<ReaderPage> {
    const page = await readPage(url, this.policy, signal);
    this.record(page.url, page.title, 'reader');
    return page;
  }

  record(url: string, title: string | null, mode: 'reader' | 'live' | 'youtube') {
    if (!/^https?:/i.test(url)) return;
    this.db.run('INSERT INTO browse_history(url, title, mode, at) VALUES (?, ?, ?, ?)', url.slice(0, 2000), (title ?? '').slice(0, 300), mode, nowIso());
  }

  historyList(limit = 100) {
    return this.db.all<{ id: number; url: string; title: string; mode: string; at: string }>('SELECT * FROM browse_history ORDER BY id DESC LIMIT ?', limit);
  }

  clearHistory() {
    this.db.run('DELETE FROM browse_history');
  }

  async search(query: string): Promise<{ engine: string; results: SearchResult[] }> {
    if (this.config.searxngUrl) {
      const res = await safeFetch(`${this.config.searxngUrl}/search?${new URLSearchParams({ q: query, format: 'json', language: 'en-GB', safesearch: '1' })}`, {
        // A self-hosted SearXNG usually lives on the private network: trust exactly that host, nothing else.
        policy: { ...this.policy, trustedHosts: [...(this.policy.trustedHosts ?? []), new URL(this.config.searxngUrl).hostname.toLowerCase()] },
        timeoutMs: 15_000,
        headers: { accept: 'application/json' },
      });
      if (res.status !== 200) throw new Error(`SearXNG returned HTTP ${res.status} (is the JSON format enabled in settings.yml?)`);
      const data = res.json<{ results: { title: string; url: string; content?: string; engine?: string }[] }>();
      return { engine: 'searxng', results: data.results.slice(0, 20).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '', engine: r.engine ?? 'searxng' })) };
    }
    const brave = this.braveKey();
    if (brave) {
      const res = await safeFetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: '20' })}`, {
        policy: this.policy,
        timeoutMs: 15_000,
        headers: { accept: 'application/json', 'x-subscription-token': brave },
      });
      if (res.status !== 200) throw new Error(`Brave Search returned HTTP ${res.status}`);
      const data = res.json<{ web?: { results: { title: string; url: string; description?: string }[] } }>();
      return { engine: 'brave', results: (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: (r.description ?? '').replace(/<[^>]+>/g, ''), engine: 'brave' })) };
    }
    throw new Error('No search provider configured. Set TC_SEARXNG_URL or add a Brave Search key in Connected Apps — or search in the live browser.');
  }

  async youtubeSearch(query: string): Promise<{ source: 'youtube-data-api' | 'live-browser'; results: VideoResult[]; tabId?: string }> {
    const key = this.youtubeKey();
    if (key) {
      const results = await searchYouTubeApi(query, key, this.config.endpoints.youtube, this.policy);
      return { source: 'youtube-data-api', results };
    }
    const tab = await this.live.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
    // Wait for the results page to render, then read it.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 750));
      try {
        const results = await this.live.youtubeResults(tab.id);
        if (results.length) return { source: 'live-browser', results, tabId: tab.id };
      } catch {
        /* still loading */
      }
    }
    return { source: 'live-browser', results: [], tabId: tab.id };
  }
}
