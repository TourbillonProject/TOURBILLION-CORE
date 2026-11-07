import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Central configuration. Every value comes from the environment so that the
 * same build runs on a laptop, a home server or a cloud host. Documented in
 * docs/ENVIRONMENT.md — keep the two in sync.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  publicUrl: string | null;
  trustProxy: boolean;
  dataDir: string;
  webDistDir: string;
  ownerName: string;
  masterKey: string | null;
  ownerPassphrase: string | null;
  sessionDays: number;
  anthropic: {
    apiKey: string | null;
    baseUrl: string;
    defaultModel: string;
  };
  google: { clientId: string | null; clientSecret: string | null };
  youtubeApiKey: string | null;
  githubToken: string | null;
  searxngUrl: string | null;
  braveSearchKey: string | null;
  browser: {
    enabled: boolean;
    executablePath: string | null;
    maxTabs: number;
    proxy: string | null;
  };
  /** Allow server-side fetches / remote browser to reach private, loopback and link-local addresses. Never enable on a shared host. */
  allowPrivateNetwork: boolean;
  projectRoots: string[];
  /** Override base URLs of public APIs (used by tests to point at local fixtures). */
  endpoints: {
    doh: string;
    rdap: string;
    crtsh: string;
    wayback: string;
    github: string;
    nvd: string;
    osv: string;
    cisaKev: string;
    wikipedia: string;
    googleOAuth: string;
    googleToken: string;
    gmail: string;
    youtube: string;
  };
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const e = process.env;
  const env = (e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['env'];
  const cfg: AppConfig = {
    env,
    host: e.TC_HOST ?? '0.0.0.0',
    port: int(e.TC_PORT ?? e.PORT, 8787),
    publicUrl: e.TC_PUBLIC_URL ? e.TC_PUBLIC_URL.replace(/\/$/, '') : null,
    trustProxy: bool(e.TC_TRUST_PROXY, false),
    dataDir: path.resolve(e.TC_DATA_DIR ?? path.join(process.cwd(), 'data')),
    webDistDir: path.resolve(e.TC_WEB_DIST ?? path.join(here, '../../web/dist')),
    ownerName: e.TC_OWNER_NAME ?? 'Keenan',
    masterKey: e.TC_MASTER_KEY ?? null,
    ownerPassphrase: e.TC_OWNER_PASSPHRASE ?? null,
    sessionDays: int(e.TC_SESSION_DAYS, 30),
    anthropic: {
      apiKey: e.TC_ANTHROPIC_API_KEY ?? null,
      // Deliberately NOT reading ANTHROPIC_BASE_URL: tooling on a dev machine may set it for other purposes.
      baseUrl: e.TC_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      defaultModel: e.TC_ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    },
    google: { clientId: e.TC_GOOGLE_CLIENT_ID ?? null, clientSecret: e.TC_GOOGLE_CLIENT_SECRET ?? null },
    youtubeApiKey: e.TC_YOUTUBE_API_KEY ?? null,
    githubToken: e.TC_GITHUB_TOKEN ?? null,
    searxngUrl: e.TC_SEARXNG_URL ? e.TC_SEARXNG_URL.replace(/\/$/, '') : null,
    braveSearchKey: e.TC_BRAVE_SEARCH_KEY ?? null,
    browser: {
      enabled: bool(e.TC_BROWSER_ENABLED, true),
      executablePath: e.TC_BROWSER_EXECUTABLE ?? null,
      maxTabs: int(e.TC_BROWSER_MAX_TABS, 6),
      proxy: e.TC_BROWSER_PROXY ?? null,
    },
    allowPrivateNetwork: bool(e.TC_ALLOW_PRIVATE_NETWORK, false),
    projectRoots: list(e.TC_PROJECT_ROOTS).map((p) => path.resolve(p)),
    endpoints: {
      doh: e.TC_ENDPOINT_DOH ?? 'https://dns.google/resolve',
      rdap: e.TC_ENDPOINT_RDAP ?? 'https://rdap.org',
      crtsh: e.TC_ENDPOINT_CRTSH ?? 'https://crt.sh',
      wayback: e.TC_ENDPOINT_WAYBACK ?? 'https://archive.org',
      github: e.TC_ENDPOINT_GITHUB ?? 'https://api.github.com',
      nvd: e.TC_ENDPOINT_NVD ?? 'https://services.nvd.nist.gov/rest/json/cves/2.0',
      osv: e.TC_ENDPOINT_OSV ?? 'https://api.osv.dev',
      cisaKev: e.TC_ENDPOINT_CISA_KEV ?? 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
      wikipedia: e.TC_ENDPOINT_WIKIPEDIA ?? 'https://en.wikipedia.org',
      googleOAuth: e.TC_ENDPOINT_GOOGLE_OAUTH ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      googleToken: e.TC_ENDPOINT_GOOGLE_TOKEN ?? 'https://oauth2.googleapis.com/token',
      gmail: e.TC_ENDPOINT_GMAIL ?? 'https://gmail.googleapis.com/gmail/v1',
      youtube: e.TC_ENDPOINT_YOUTUBE ?? 'https://www.googleapis.com/youtube/v3',
    },
  };
  return { ...cfg, ...overrides, anthropic: { ...cfg.anthropic, ...(overrides.anthropic ?? {}) }, endpoints: { ...cfg.endpoints, ...(overrides.endpoints ?? {}) }, browser: { ...cfg.browser, ...(overrides.browser ?? {}) } };
}

export const APP_VERSION = '0.1.0';
