import net from 'node:net';
import type { Finding, FindingClass, ResearchTargetType } from '@tc/shared';
import type { AppConfig } from '../config.js';
import { safeFetch, type NetPolicy } from '../security/net.js';

/**
 * OSINT modules. Public, legitimate sources only; passive collection (no
 * scanning, no authentication bypass, no private accounts). Every finding
 * carries a classification, a source URL and a collection timestamp.
 */

export interface ModuleContext {
  config: AppConfig;
  policy: NetPolicy;
  signal?: AbortSignal;
  githubToken: string | null;
}

export interface ModuleResult {
  findings: Finding[];
  raw: unknown;
  sources: string[];
}

export interface OsintModule {
  id: string;
  title: string;
  description: string;
  targets: ResearchTargetType[];
  run: (target: string, mc: ModuleContext) => Promise<ModuleResult>;
}

const now = () => new Date().toISOString();

function finding(module: string, title: string, detail: string, classification: FindingClass, sourceUrl: string | null, data?: unknown, eventDate?: string | null): Finding {
  return { module, title, detail, classification, sourceUrl, collectedAt: now(), data, eventDate: eventDate ?? null };
}

async function getJson<T>(url: string, mc: ModuleContext, headers: Record<string, string> = {}): Promise<{ status: number; data: T | null; url: string }> {
  const res = await safeFetch(url, { policy: mc.policy, signal: mc.signal, timeoutMs: 25_000, headers: { accept: 'application/json', ...headers } });
  if (res.status < 200 || res.status >= 300) return { status: res.status, data: null, url: res.url };
  try {
    return { status: res.status, data: res.json<T>(), url: res.url };
  } catch {
    return { status: res.status, data: null, url: res.url };
  }
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

class TargetError extends Error {
  statusCode = 400;
}

export function normaliseTarget(type: ResearchTargetType, raw: string): string {
  try {
    return normaliseInner(type, raw);
  } catch (err) {
    throw new TargetError(err instanceof Error ? err.message : String(err));
  }
}

function normaliseInner(type: ResearchTargetType, raw: string): string {
  const v = raw.trim();
  switch (type) {
    case 'domain': {
      const d = v.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/\.$/, '');
      if (!DOMAIN_RE.test(d)) throw new Error('Enter a domain such as example.com');
      return d;
    }
    case 'ip':
      if (!net.isIP(v)) throw new Error('Enter a valid IPv4 or IPv6 address');
      return v;
    case 'url': {
      const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      return u.toString();
    }
    case 'github_repo': {
      const m = v.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})/);
      if (!m) throw new Error('Enter a repository as owner/name');
      return `${m[1]}/${m[2]}`;
    }
    case 'cve': {
      const m = v.toUpperCase().match(/^CVE-\d{4}-\d{4,7}$/);
      if (!m) throw new Error('Enter a CVE ID such as CVE-2021-44228');
      return m[0];
    }
    case 'package': {
      // ecosystem:name[@version], e.g. npm:lodash@4.17.20
      const m = v.match(/^(npm|PyPI|Go|crates\.io|RubyGems|Maven|NuGet|Packagist):([^@\s]+)(?:@(\S+))?$/i);
      if (!m) throw new Error('Enter a package as ecosystem:name@version, e.g. npm:lodash@4.17.20');
      return v;
    }
    case 'organization':
    case 'topic':
      if (/@/.test(v)) throw new Error('Email addresses are not accepted: research on private individuals is out of scope.');
      if (v.length < 2 || v.length > 200) throw new Error('Enter an organisation or topic name');
      return v;
  }
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA', 'SOA'] as const;

const dnsModule: OsintModule = {
  id: 'dns',
  title: 'DNS records',
  description: 'Live DNS answers via DNS-over-HTTPS (A, AAAA, CNAME, MX, NS, TXT, CAA, SOA).',
  targets: ['domain'],
  async run(domain, mc) {
    const findings: Finding[] = [];
    const raw: Record<string, unknown> = {};
    const sources: string[] = [];
    for (const type of DNS_TYPES) {
      const url = `${mc.config.endpoints.doh}?name=${encodeURIComponent(domain)}&type=${type}`;
      sources.push(url);
      const r = await getJson<{ Status: number; Answer?: { name: string; type: number; TTL: number; data: string }[] }>(url, mc);
      raw[type] = r.data;
      const answers = r.data?.Answer ?? [];
      if (!answers.length) continue;
      findings.push(
        finding('dns', `${type} records`, answers.map((a) => `${a.data} (TTL ${a.TTL})`).join('\n'), 'verified_fact', url, answers),
      );
      if (type === 'TXT') {
        const spf = answers.find((a) => a.data.includes('v=spf1'));
        if (spf) findings.push(finding('dns', 'SPF policy present', spf.data, 'verified_fact', url));
      }
    }
    const dmarcUrl = `${mc.config.endpoints.doh}?name=_dmarc.${encodeURIComponent(domain)}&type=TXT`;
    sources.push(dmarcUrl);
    const dmarc = await getJson<{ Answer?: { data: string }[] }>(dmarcUrl, mc);
    const d = dmarc.data?.Answer?.find((a) => a.data.includes('v=DMARC1'));
    findings.push(
      d
        ? finding('dns', 'DMARC policy present', d.data, 'verified_fact', dmarcUrl)
        : finding('dns', 'No DMARC record observed', `No v=DMARC1 TXT record at _dmarc.${domain} at collection time.`, 'verified_fact', dmarcUrl),
    );
    if (findings.length === 1 && !d) findings.unshift(finding('dns', 'No DNS answers', `The resolver returned no records for ${domain}.`, 'verified_fact', sources[0]));
    return { findings, raw, sources };
  },
};

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, [string, Record<string, unknown>, string, unknown][]];
  entities?: RdapEntity[];
  handle?: string;
}

/** Keeps organisation names and roles; drops personal contact details. */
function rdapEntities(entities: RdapEntity[] | undefined, depth = 0): { roles: string[]; name: string | null; kind: string | null }[] {
  const out: { roles: string[]; name: string | null; kind: string | null }[] = [];
  for (const e of entities ?? []) {
    const props = e.vcardArray?.[1] ?? [];
    const kind = (props.find((p) => p[0] === 'kind')?.[3] as string | undefined) ?? null;
    const org = (props.find((p) => p[0] === 'org')?.[3] as string | undefined) ?? null;
    const fn = (props.find((p) => p[0] === 'fn')?.[3] as string | undefined) ?? null;
    const isOrg = kind === 'org' || !!org || (e.roles ?? []).includes('registrar');
    out.push({ roles: e.roles ?? [], name: isOrg ? (org ?? fn) : fn ? '[individual — withheld]' : null, kind });
    if (depth < 2) out.push(...rdapEntities(e.entities, depth + 1));
  }
  return out;
}

const rdapModule: OsintModule = {
  id: 'rdap',
  title: 'Registration (RDAP)',
  description: 'Registry data via RDAP: registrar, key dates, status, name servers. Personal contact details are withheld.',
  targets: ['domain', 'ip'],
  async run(target, mc) {
    const isIp = !!net.isIP(target);
    const url = `${mc.config.endpoints.rdap}/${isIp ? 'ip' : 'domain'}/${encodeURIComponent(target)}`;
    const r = await getJson<{
      ldhName?: string;
      handle?: string;
      name?: string;
      startAddress?: string;
      endAddress?: string;
      country?: string;
      status?: string[];
      events?: { eventAction: string; eventDate: string }[];
      nameservers?: { ldhName: string }[];
      entities?: RdapEntity[];
      secureDNS?: { delegationSigned?: boolean };
    }>(url, mc, { accept: 'application/rdap+json, application/json' });
    if (!r.data) return { findings: [finding('rdap', 'No RDAP record', `RDAP lookup returned HTTP ${r.status}.`, 'unverified', url)], raw: null, sources: [url] };
    const d = r.data;
    const findings: Finding[] = [];
    const src = r.url;
    for (const ev of d.events ?? []) findings.push(finding('rdap', `Registry event: ${ev.eventAction}`, ev.eventDate, 'source_reported', src, ev, ev.eventDate));
    if (d.status?.length) findings.push(finding('rdap', 'Status', d.status.join(', '), 'source_reported', src));
    if (d.nameservers?.length) findings.push(finding('rdap', 'Name servers (registry)', d.nameservers.map((n) => n.ldhName).join(', '), 'source_reported', src));
    if (d.secureDNS) findings.push(finding('rdap', 'DNSSEC delegation', d.secureDNS.delegationSigned ? 'Signed' : 'Not signed', 'source_reported', src));
    if (isIp) findings.push(finding('rdap', 'Network allocation', `${d.name ?? d.handle ?? ''} ${d.startAddress ?? ''} – ${d.endAddress ?? ''} ${d.country ? `(${d.country})` : ''}`.trim(), 'source_reported', src));
    const ents = rdapEntities(d.entities).filter((e) => e.name);
    for (const e of ents) findings.push(finding('rdap', `Entity (${e.roles.join(', ') || 'unspecified role'})`, e.name!, 'source_reported', src));
    return { findings, raw: { ...d, entities: ents }, sources: [src] };
  },
};

const ctModule: OsintModule = {
  id: 'ct',
  title: 'Certificate Transparency',
  description: 'Certificates logged publicly for the domain and its subdomains (crt.sh).',
  targets: ['domain'],
  async run(domain, mc) {
    const url = `${mc.config.endpoints.crtsh}/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;
    const r = await getJson<{ issuer_name: string; name_value: string; not_before: string; not_after: string; id: number }[]>(url, mc);
    if (!r.data) return { findings: [finding('ct', 'CT lookup failed', `crt.sh returned HTTP ${r.status}.`, 'unverified', url)], raw: null, sources: [url] };
    const names = new Map<string, { first: string; last: string; count: number }>();
    const issuers = new Map<string, number>();
    for (const c of r.data) {
      for (const n of c.name_value.split('\n')) {
        const name = n.trim().toLowerCase();
        if (!name.endsWith(domain)) continue;
        const cur = names.get(name) ?? { first: c.not_before, last: c.not_before, count: 0 };
        cur.count += 1;
        if (c.not_before < cur.first) cur.first = c.not_before;
        if (c.not_before > cur.last) cur.last = c.not_before;
        names.set(name, cur);
      }
      const issuer = c.issuer_name.match(/O=([^,]+)/)?.[1] ?? c.issuer_name;
      issuers.set(issuer, (issuers.get(issuer) ?? 0) + 1);
    }
    const sorted = [...names.entries()].sort((a, b) => b[1].count - a[1].count);
    const findings: Finding[] = [
      finding('ct', 'Logged certificates', `${r.data.length} certificate entries covering ${names.size} distinct names.`, 'source_reported', url),
      finding('ct', 'Names seen in certificates', sorted.slice(0, 60).map(([n, v]) => `${n} (${v.count}×, ${v.first.slice(0, 10)} → ${v.last.slice(0, 10)})`).join('\n'), 'source_reported', url, sorted.slice(0, 200)),
      finding('ct', 'Issuers', [...issuers.entries()].sort((a, b) => b[1] - a[1]).map(([i, n]) => `${i}: ${n}`).join('\n'), 'source_reported', url),
    ];
    const earliest = r.data.reduce<string | null>((m, c) => (!m || c.not_before < m ? c.not_before : m), null);
    if (earliest) findings.push(finding('ct', 'Earliest logged certificate', earliest, 'source_reported', url, null, earliest));
    findings.push(finding('ct', 'Interpretation note', 'Subdomains in CT logs existed at certificate issue time; they may no longer resolve.', 'inference', null));
    return { findings, raw: { count: r.data.length, names: sorted.slice(0, 500) }, sources: [url] };
  },
};

const waybackModule: OsintModule = {
  id: 'wayback',
  title: 'Internet Archive',
  description: 'First, latest and yearly captures in the Wayback Machine.',
  targets: ['domain', 'url'],
  async run(target, mc) {
    const base = mc.config.endpoints.wayback;
    const availUrl = `${base}/wayback/available?url=${encodeURIComponent(target)}`;
    const cdxUrl = `${base}/cdx/search/cdx?url=${encodeURIComponent(target)}&output=json&fl=timestamp,original,statuscode&collapse=timestamp:4&limit=40`;
    const [avail, cdx] = await Promise.all([
      getJson<{ archived_snapshots?: { closest?: { url: string; timestamp: string; status: string } } }>(availUrl, mc),
      getJson<string[][]>(cdxUrl, mc),
    ]);
    const findings: Finding[] = [];
    const closest = avail.data?.archived_snapshots?.closest;
    if (closest) findings.push(finding('wayback', 'Most recent capture', `${tsToIso(closest.timestamp)} (HTTP ${closest.status}) — ${closest.url}`, 'source_reported', availUrl, closest, tsToIso(closest.timestamp)));
    const rows = (cdx.data ?? []).slice(1);
    if (rows.length) {
      findings.push(finding('wayback', 'First capture', `${tsToIso(rows[0][0])} — ${rows[0][1]}`, 'source_reported', cdxUrl, rows[0], tsToIso(rows[0][0])));
      findings.push(finding('wayback', 'Yearly captures', rows.map((r) => `${r[0].slice(0, 4)}: HTTP ${r[2]}`).join('\n'), 'source_reported', cdxUrl, rows));
    }
    if (!findings.length) findings.push(finding('wayback', 'No captures found', `The Wayback Machine returned no captures for ${target}.`, 'source_reported', availUrl));
    return { findings, raw: { closest, rows }, sources: [availUrl, cdxUrl] };
  },
};

function tsToIso(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10) || '00'}:${ts.slice(10, 12) || '00'}:${ts.slice(12, 14) || '00'}Z`;
}

const TECH_PATTERNS: { name: string; re: RegExp; where: 'html' | 'header' }[] = [
  { name: 'WordPress', re: /wp-content\/|wp-includes\//i, where: 'html' },
  { name: 'Next.js', re: /\/_next\/static\//, where: 'html' },
  { name: 'Nuxt', re: /\/_nuxt\//, where: 'html' },
  { name: 'React', re: /data-reactroot|react(-dom)?(\.production)?\.min\.js/i, where: 'html' },
  { name: 'Vue.js', re: /vue(\.runtime)?(\.global)?(\.prod)?(\.min)?\.js|data-v-[0-9a-f]{8}/i, where: 'html' },
  { name: 'Angular', re: /ng-version=/i, where: 'html' },
  { name: 'Svelte', re: /svelte-[a-z0-9]{6}/i, where: 'html' },
  { name: 'Shopify', re: /cdn\.shopify\.com/i, where: 'html' },
  { name: 'Squarespace', re: /static1\.squarespace\.com/i, where: 'html' },
  { name: 'Wix', re: /static\.wixstatic\.com/i, where: 'html' },
  { name: 'Drupal', re: /\/sites\/default\/files\/|Drupal\.settings/i, where: 'html' },
  { name: 'jQuery', re: /jquery(-\d[\d.]*)?(\.min)?\.js/i, where: 'html' },
  { name: 'Bootstrap', re: /bootstrap(\.min)?\.(css|js)/i, where: 'html' },
  { name: 'Tailwind CSS', re: /tailwind(css)?/i, where: 'html' },
  { name: 'Google Analytics / Tag Manager', re: /googletagmanager\.com|google-analytics\.com/i, where: 'html' },
  { name: 'Cloudflare', re: /cf-ray|cloudflare/i, where: 'header' },
  { name: 'Vercel', re: /x-vercel-id|vercel/i, where: 'header' },
  { name: 'Netlify', re: /x-nf-request-id|netlify/i, where: 'header' },
  { name: 'Amazon CloudFront', re: /x-amz-cf-id|cloudfront/i, where: 'header' },
  { name: 'Fastly', re: /x-served-by:[^\n]*cache-|fastly/i, where: 'header' },
  { name: 'nginx', re: /server: nginx/i, where: 'header' },
  { name: 'Apache httpd', re: /server: apache/i, where: 'header' },
  { name: 'Microsoft IIS', re: /server: microsoft-iis/i, where: 'header' },
  { name: 'PHP', re: /x-powered-by: php|PHPSESSID/i, where: 'header' },
  { name: 'Express (Node.js)', re: /x-powered-by: express/i, where: 'header' },
  { name: 'ASP.NET', re: /x-aspnet-version|x-powered-by: asp\.net/i, where: 'header' },
];

const SECURITY_HEADERS = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];

const techModule: OsintModule = {
  id: 'tech',
  title: 'Technology stack',
  description: 'One ordinary page request: response headers, security headers and markup fingerprints.',
  targets: ['domain', 'url'],
  async run(target, mc) {
    const url = /^https?:/i.test(target) ? target : `https://${target}/`;
    const res = await safeFetch(url, { policy: mc.policy, signal: mc.signal, timeoutMs: 20_000, maxBytes: 3 * 1024 * 1024, headers: { accept: 'text/html,*/*' } });
    const findings: Finding[] = [];
    const headerText = Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    findings.push(finding('tech', 'HTTP response', `HTTP ${res.status} from ${res.url}${res.redirects.length ? ` after ${res.redirects.length} redirect(s): ${res.redirects.join(' → ')}` : ''}`, 'verified_fact', res.url));
    const interesting = ['server', 'x-powered-by', 'via', 'x-generator', 'cf-ray', 'x-vercel-id', 'x-served-by'];
    const seenHeaders = interesting.filter((h) => res.headers[h]).map((h) => `${h}: ${res.headers[h]}`);
    if (seenHeaders.length) findings.push(finding('tech', 'Identifying headers', seenHeaders.join('\n'), 'verified_fact', res.url));
    const present = SECURITY_HEADERS.filter((h) => res.headers[h]);
    const missing = SECURITY_HEADERS.filter((h) => !res.headers[h]);
    findings.push(finding('tech', 'Security headers', `Present: ${present.join(', ') || 'none'}\nMissing: ${missing.join(', ') || 'none'}`, 'verified_fact', res.url, { present, missing }));
    const html = res.headers['content-type']?.includes('html') ? res.text() : '';
    const generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1];
    if (generator) findings.push(finding('tech', 'Generator meta tag', generator, 'verified_fact', res.url));
    const detected = TECH_PATTERNS.filter((p) => p.re.test(p.where === 'html' ? html : headerText)).map((p) => p.name);
    if (detected.length) findings.push(finding('tech', 'Likely technologies', `${detected.join(', ')} — inferred from markup and header fingerprints.`, 'inference', res.url, detected));
    return { findings, raw: { status: res.status, headers: res.headers, detected }, sources: [res.url] };
  },
};

const githubModule: OsintModule = {
  id: 'github',
  title: 'GitHub repository',
  description: 'Public repository metadata, languages and recent activity from the GitHub REST API.',
  targets: ['github_repo'],
  async run(repo, mc) {
    const base = mc.config.endpoints.github;
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(mc.githubToken ? { authorization: `Bearer ${mc.githubToken}` } : {}) };
    const repoUrl = `${base}/repos/${repo}`;
    const r = await getJson<{
      full_name: string; description: string | null; html_url: string; stargazers_count: number; forks_count: number; open_issues_count: number; license: { spdx_id: string } | null;
      language: string | null; created_at: string; pushed_at: string; archived: boolean; topics?: string[]; default_branch: string; owner: { type: string };
    }>(repoUrl, mc, headers);
    if (!r.data) return { findings: [finding('github', 'Repository not available', `GitHub API returned HTTP ${r.status} (private, renamed, or rate-limited).`, 'unverified', repoUrl)], raw: null, sources: [repoUrl] };
    const d = r.data;
    const page = d.html_url;
    const findings: Finding[] = [
      finding('github', 'Repository', `${d.full_name}${d.description ? ` — ${d.description}` : ''}`, 'source_reported', page),
      finding('github', 'Popularity', `${d.stargazers_count} stars, ${d.forks_count} forks, ${d.open_issues_count} open issues/PRs`, 'source_reported', page),
      finding('github', 'License', d.license?.spdx_id ?? 'No license detected', 'source_reported', page),
      finding('github', 'Created', d.created_at, 'source_reported', page, null, d.created_at),
      finding('github', 'Last push', d.pushed_at, 'source_reported', page, null, d.pushed_at),
    ];
    if (d.archived) findings.push(finding('github', 'Archived', 'The repository is archived (read-only).', 'source_reported', page));
    if (d.topics?.length) findings.push(finding('github', 'Topics', d.topics.join(', '), 'source_reported', page));
    const langUrl = `${base}/repos/${repo}/languages`;
    const langs = await getJson<Record<string, number>>(langUrl, mc, headers);
    if (langs.data) {
      const total = Object.values(langs.data).reduce((a, b) => a + b, 0) || 1;
      findings.push(finding('github', 'Languages', Object.entries(langs.data).map(([l, b]) => `${l} ${((b / total) * 100).toFixed(1)}%`).join(', '), 'source_reported', page));
    }
    const commitsUrl = `${base}/repos/${repo}/commits?per_page=5`;
    const commits = await getJson<{ sha: string; commit: { message: string; author: { date: string } } }[]>(commitsUrl, mc, headers);
    if (commits.data?.length) {
      findings.push(finding('github', 'Recent commits', commits.data.map((c) => `${c.commit.author.date.slice(0, 10)} ${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0].slice(0, 100)}`).join('\n'), 'source_reported', `${page}/commits`));
    }
    return { findings, raw: { repo: d, languages: langs.data }, sources: [repoUrl, langUrl, commitsUrl] };
  },
};

const cveModule: OsintModule = {
  id: 'cve',
  title: 'CVE record (NVD) + CISA KEV',
  description: 'NVD description, CVSS, references, and whether CISA lists it as known exploited.',
  targets: ['cve'],
  async run(id, mc) {
    const url = `${mc.config.endpoints.nvd}?cveId=${encodeURIComponent(id)}`;
    const r = await getJson<{ vulnerabilities?: { cve: { id: string; published: string; lastModified: string; vulnStatus: string; descriptions: { lang: string; value: string }[]; metrics?: Record<string, { cvssData: { baseScore: number; baseSeverity?: string; vectorString: string } ; baseSeverity?: string }[]>; references?: { url: string }[]; weaknesses?: { description: { value: string }[] }[] } }[] }>(url, mc);
    const findings: Finding[] = [];
    const page = `https://nvd.nist.gov/vuln/detail/${id}`;
    const cve = r.data?.vulnerabilities?.[0]?.cve;
    if (!cve) findings.push(finding('cve', 'Not found in NVD', `NVD returned HTTP ${r.status} with no record.`, 'unverified', url));
    else {
      findings.push(finding('cve', 'Description', cve.descriptions.find((d) => d.lang === 'en')?.value ?? '', 'source_reported', page));
      findings.push(finding('cve', 'Published', cve.published, 'source_reported', page, null, cve.published));
      findings.push(finding('cve', 'Status', `${cve.vulnStatus} (last modified ${cve.lastModified})`, 'source_reported', page));
      const metric = Object.values(cve.metrics ?? {})[0]?.[0];
      if (metric) findings.push(finding('cve', 'CVSS', `${metric.cvssData.baseScore} ${metric.cvssData.baseSeverity ?? metric.baseSeverity ?? ''} — ${metric.cvssData.vectorString}`, 'source_reported', page));
      const cwe = cve.weaknesses?.flatMap((w) => w.description.map((d) => d.value)).filter((v) => v.startsWith('CWE')) ?? [];
      if (cwe.length) findings.push(finding('cve', 'Weakness (CWE)', cwe.join(', '), 'source_reported', page));
      if (cve.references?.length) findings.push(finding('cve', 'References', cve.references.slice(0, 15).map((x) => x.url).join('\n'), 'source_reported', page));
    }
    const kev = await kevLookup(id, mc);
    findings.push(kev.finding);
    return { findings, raw: { nvd: cve ?? null, kev: kev.entry }, sources: [url, mc.config.endpoints.cisaKev] };
  },
};

let kevCache: { at: number; data: { vulnerabilities: KevEntry[] } } | null = null;
interface KevEntry {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  requiredAction: string;
  knownRansomwareCampaignUse: string;
}

async function kevLookup(cveId: string, mc: ModuleContext): Promise<{ finding: Finding; entry: KevEntry | null }> {
  const url = mc.config.endpoints.cisaKev;
  try {
    if (!kevCache || Date.now() - kevCache.at > 6 * 3600_000) {
      const r = await getJson<{ vulnerabilities: KevEntry[] }>(url, mc);
      if (!r.data) throw new Error(`HTTP ${r.status}`);
      kevCache = { at: Date.now(), data: r.data };
    }
    const entry = kevCache.data.vulnerabilities.find((v) => v.cveID === cveId) ?? null;
    return {
      entry,
      finding: entry
        ? finding('kev', 'Listed in CISA Known Exploited Vulnerabilities', `${entry.vendorProject} ${entry.product}: ${entry.vulnerabilityName}. Added ${entry.dateAdded}. Ransomware use: ${entry.knownRansomwareCampaignUse}. Action: ${entry.requiredAction}`, 'source_reported', url, entry, entry.dateAdded)
        : finding('kev', 'Not in CISA KEV', `${cveId} is not in the CISA KEV catalogue at collection time.`, 'source_reported', url),
    };
  } catch (err) {
    return { entry: null, finding: finding('kev', 'CISA KEV unavailable', `Could not load the KEV catalogue: ${err instanceof Error ? err.message : err}`, 'unverified', url) };
  }
}

const osvModule: OsintModule = {
  id: 'osv',
  title: 'Package vulnerabilities (OSV)',
  description: 'Known vulnerabilities for a package version from OSV.dev.',
  targets: ['package'],
  async run(target, mc) {
    const m = target.match(/^([^:]+):([^@]+)(?:@(.+))?$/)!;
    const ecosystems: Record<string, string> = { npm: 'npm', pypi: 'PyPI', go: 'Go', 'crates.io': 'crates.io', rubygems: 'RubyGems', maven: 'Maven', nuget: 'NuGet', packagist: 'Packagist' };
    const ecosystem = ecosystems[m[1].toLowerCase()] ?? m[1];
    const url = `${mc.config.endpoints.osv}/v1/query`;
    const res = await safeFetch(url, { method: 'POST', policy: mc.policy, signal: mc.signal, timeoutMs: 20_000, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package: { name: m[2], ecosystem }, ...(m[3] ? { version: m[3] } : {}) }) });
    if (res.status !== 200) return { findings: [finding('osv', 'OSV query failed', `HTTP ${res.status}`, 'unverified', url)], raw: null, sources: [url] };
    const data = res.json<{ vulns?: { id: string; summary?: string; aliases?: string[]; published?: string; database_specific?: { severity?: string } }[] }>();
    const vulns = data.vulns ?? [];
    const findings = vulns.length
      ? vulns.slice(0, 50).map((v) => finding('osv', `${v.id}${v.aliases?.length ? ` (${v.aliases.join(', ')})` : ''}`, `${v.summary ?? ''}${v.database_specific?.severity ? ` — severity ${v.database_specific.severity}` : ''}`, 'source_reported', `https://osv.dev/vulnerability/${v.id}`, v, v.published))
      : [finding('osv', 'No known vulnerabilities', `OSV lists no vulnerabilities for ${ecosystem}/${m[2]}${m[3] ? `@${m[3]}` : ''}.`, 'source_reported', url)];
    return { findings, raw: data, sources: [url] };
  },
};

const wikipediaModule: OsintModule = {
  id: 'wikipedia',
  title: 'Wikipedia summary',
  description: 'Encyclopaedic background from the Wikipedia REST API (a tertiary source — verify key claims).',
  targets: ['organization', 'topic'],
  async run(target, mc) {
    const base = mc.config.endpoints.wikipedia;
    const searchUrl = `${base}/w/rest.php/v1/search/title?q=${encodeURIComponent(target)}&limit=3`;
    const s = await getJson<{ pages: { key: string; title: string }[] }>(searchUrl, mc);
    const key = s.data?.pages?.[0]?.key;
    if (!key) return { findings: [finding('wikipedia', 'No article found', `No Wikipedia article matched "${target}".`, 'unverified', searchUrl)], raw: null, sources: [searchUrl] };
    const sumUrl = `${base}/api/rest_v1/page/summary/${encodeURIComponent(key)}`;
    const sum = await getJson<{ title: string; extract: string; description?: string; content_urls?: { desktop?: { page: string } }; timestamp?: string }>(sumUrl, mc);
    if (!sum.data) return { findings: [finding('wikipedia', 'Summary unavailable', `HTTP ${sum.status}`, 'unverified', sumUrl)], raw: null, sources: [searchUrl, sumUrl] };
    const page = sum.data.content_urls?.desktop?.page ?? sumUrl;
    return {
      findings: [
        finding('wikipedia', sum.data.title, `${sum.data.description ? `${sum.data.description}. ` : ''}${sum.data.extract}`, 'source_reported', page),
        ...(s.data!.pages.length > 1 ? [finding('wikipedia', 'Other possible matches', s.data!.pages.slice(1).map((p) => p.title).join(', '), 'unverified', searchUrl)] : []),
      ],
      raw: sum.data,
      sources: [searchUrl, sumUrl],
    };
  },
};

const reverseDnsModule: OsintModule = {
  id: 'ptr',
  title: 'Reverse DNS',
  description: 'PTR record for an IP address via DNS-over-HTTPS.',
  targets: ['ip'],
  async run(ip, mc) {
    let name: string;
    if (net.isIPv4(ip)) name = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
    else {
      const full = expandIPv6(ip);
      name = `${full.replace(/:/g, '').split('').reverse().join('.')}.ip6.arpa`;
    }
    const url = `${mc.config.endpoints.doh}?name=${encodeURIComponent(name)}&type=PTR`;
    const r = await getJson<{ Answer?: { data: string }[] }>(url, mc);
    const ans = r.data?.Answer ?? [];
    return { findings: [finding('ptr', 'Reverse DNS (PTR)', ans.length ? ans.map((a) => a.data).join(', ') : 'No PTR record', 'verified_fact', url)], raw: r.data, sources: [url] };
  },
};

function expandIPv6(ip: string): string {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = new Array(8 - h.length - t.length).fill('0');
  return [...h, ...(ip.includes('::') ? fill : []), ...t].map((x) => x.padStart(4, '0')).join(':');
}

export const OSINT_MODULES: OsintModule[] = [dnsModule, rdapModule, ctModule, waybackModule, techModule, reverseDnsModule, githubModule, cveModule, osvModule, wikipediaModule];

export function modulesFor(type: ResearchTargetType): OsintModule[] {
  return OSINT_MODULES.filter((m) => m.targets.includes(type));
}

export { kevLookup };
