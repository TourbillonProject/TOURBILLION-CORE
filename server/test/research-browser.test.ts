import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { fixtureServer, makeApp, waitFor, type TestApp } from './helpers.js';
import { parseYouTubeUrl } from '../src/browser/youtube.js';
import { interpretAddress } from '../src/browser/reader.js';

/**
 * Public data sources are unreachable from the CI sandbox, so a local fixture
 * server reproduces their response formats. The code paths (HTTP, parsing,
 * classification, redaction, reporting) are the production ones.
 */

let app: TestApp;
let fx: Awaited<ReturnType<typeof fixtureServer>>;

const ARTICLE = `<!doctype html><html><head><title>Tourbillon — Wikipedia</title></head><body>
<nav><a href="/home">Home</a> <a href="/about">About</a></nav>
<article><h1>Tourbillon</h1>
<p>In horology, a <b>tourbillon</b> is an addition to the mechanics of a watch escapement to increase accuracy. It was invented around 1795 by the French-Swiss watchmaker Abraham-Louis Breguet and patented on 26 June 1801.</p>
<p>The escapement and balance wheel are mounted in a rotating cage, so that errors caused by gravity in different positions average out. Modern tourbillons are a showcase of watchmaking skill rather than a practical necessity.</p>
<p>See also <a href="/wiki/Escapement">Escapement</a> and <a href="https://example.org/balance">balance wheel</a>. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
<script>window.evil = 1</script>
</article></body></html>`;

const YT_RESULTS = `<!doctype html><html><head><title>orbital - YouTube</title></head><body>
<script>var ytInitialData = {"contents":{"twoColumnSearchResultsRenderer":{"primaryContents":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[
{"videoRenderer":{"videoId":"aaaaaaaaaaa","title":{"runs":[{"text":"Orbital mechanics explained"}]},"ownerText":{"runs":[{"text":"Space Channel"}]},"lengthText":{"simpleText":"12:34"},"viewCountText":{"simpleText":"1.2M views"}}},
{"videoRenderer":{"videoId":"bbbbbbbbbbb","title":{"runs":[{"text":"Hohmann transfers"}]},"ownerText":{"runs":[{"text":"Rocket Lab Notes"}]},"lengthText":{"simpleText":"8:01"}}}
]}}]}}}}};</script><h1>results</h1></body></html>`;

beforeAll(async () => {
  fx = await fixtureServer({
    '/dns': (_r, url) => {
      const type = url.searchParams.get('type');
      const name = url.searchParams.get('name');
      const answers: Record<string, unknown[]> = {
        A: [{ name, type: 1, TTL: 300, data: '93.184.216.34' }],
        MX: [{ name, type: 15, TTL: 300, data: '10 mail.example.com.' }],
        TXT: name?.startsWith('_dmarc') ? [{ name, type: 16, TTL: 300, data: '"v=DMARC1; p=reject"' }] : [{ name, type: 16, TTL: 300, data: '"v=spf1 -all"' }],
        NS: [{ name, type: 2, TTL: 300, data: 'a.iana-servers.net.' }],
      };
      return { body: { Status: 0, Answer: answers[type ?? ''] } };
    },
    '/rdap/domain/*': () => ({
      body: {
        ldhName: 'EXAMPLE.COM',
        status: ['client delete prohibited'],
        events: [
          { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
          { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
        ],
        nameservers: [{ ldhName: 'A.IANA-SERVERS.NET' }],
        secureDNS: { delegationSigned: true },
        entities: [
          { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority']]] },
          { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Jane Private Person'], ['kind', {}, 'text', 'individual'], ['email', {}, 'text', 'jane@private.example'], ['tel', {}, 'uri', 'tel:+44.1234']]] },
        ],
      },
    }),
    '/crt/*': () => ({ body: [{ id: 1, issuer_name: 'C=US, O=DigiCert Inc, CN=DigiCert TLS', name_value: 'example.com\nwww.example.com', not_before: '2024-01-15T00:00:00', not_after: '2025-02-15T23:59:59' }, { id: 2, issuer_name: "C=US, O=Let's Encrypt, CN=R3", name_value: 'dev.example.com', not_before: '2023-05-01T00:00:00', not_after: '2023-08-01T00:00:00' }] }),
    '/wayback/wayback/available': () => ({ body: { archived_snapshots: { closest: { url: 'http://web.archive.org/web/20250101000000/https://example.com/', timestamp: '20250101000000', status: '200' } } } }),
    '/wayback/cdx/search/cdx': () => ({ body: [['timestamp', 'original', 'statuscode'], ['19961220000000', 'http://example.com/', '200'], ['20100101000000', 'http://example.com/', '200']] }),
    '/nvd': () => ({ body: { vulnerabilities: [{ cve: { id: 'CVE-2021-44228', published: '2021-12-10T10:15:09', lastModified: '2025-01-01T00:00:00', vulnStatus: 'Analyzed', descriptions: [{ lang: 'en', value: 'Apache Log4j2 JNDI features do not protect against attacker-controlled LDAP endpoints.' }], metrics: { cvssMetricV31: [{ cvssData: { baseScore: 10, baseSeverity: 'CRITICAL', vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H' } }] }, weaknesses: [{ description: [{ value: 'CWE-917' }] }], references: [{ url: 'https://logging.apache.org/log4j/2.x/security.html' }] } }] } }),
    '/kev.json': () => ({ body: { vulnerabilities: [{ cveID: 'CVE-2021-44228', vendorProject: 'Apache', product: 'Log4j2', vulnerabilityName: 'Apache Log4j2 RCE', dateAdded: '2021-12-10', requiredAction: 'Apply updates.', knownRansomwareCampaignUse: 'Known' }] } }),
    '/site/': () => ({ headers: { server: 'nginx', 'x-powered-by': 'Express', 'strict-transport-security': 'max-age=1' }, body: '<html><head><meta name="generator" content="WordPress 6.4"><script src="/wp-content/x.js"></script></head><body>hi</body></html>' }),
    '/article': () => ({ body: ARTICLE }),
    '/old-article': () => ({ status: 301, headers: { location: '/article' }, body: '' }),
    '/data.json': () => ({ body: { hello: 'world' } }),
    '/yt/results': () => ({ body: YT_RESULTS }),
    '/live-page': () => ({ body: '<html><head><title>Live fixture</title></head><body style="margin:0"><a id="go" href="/live-next" style="display:block;width:400px;height:200px;background:#0af">GO</a></body></html>' }),
    '/live-next': () => ({ body: '<html><head><title>Arrived</title></head><body><h1>Second page</h1></body></html>' }),
  });
  app = await makeApp({
    endpoints: { doh: `${fx.base}/dns`, rdap: `${fx.base}/rdap`, crtsh: `${fx.base}/crt`, wayback: `${fx.base}/wayback`, nvd: `${fx.base}/nvd`, cisaKev: `${fx.base}/kev.json` } as never,
    browser: { enabled: true, executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', maxTabs: 4, proxy: null },
  });
});
afterAll(async () => {
  await app.close();
  await fx.close();
});

describe('OSINT', () => {
  it('validates targets and refuses personal-data research', async () => {
    expect((await app.req('POST', '/api/research/validate', { type: 'domain', target: 'https://Example.COM/path' })).json.target).toBe('example.com');
    expect((await app.req('POST', '/api/research/validate', { type: 'organization', target: 'jane@private.example' })).status).toBe(400);
    const noAuth = await app.req('POST', '/api/missions', { playbook: 'research.osint', params: { targetType: 'domain', target: 'example.com', purpose: 'supplier check', authorized: false } });
    expect(noAuth.status).toBe(400);
    expect(noAuth.json.message).toMatch(/authorised/);
  });

  it('compiles a classified, sourced domain report with a timeline and withheld personal data', async () => {
    const m = await app.req('POST', '/api/missions', { playbook: 'research.osint', params: { targetType: 'domain', target: 'example.com', purpose: 'vet a supplier website', authorized: true, modules: ['dns', 'rdap', 'ct', 'wayback'], aiSynthesis: false } });
    const done = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 30_000, 'osint');
    expect(done.json.status).toBe('completed');
    expect(done.json.verification.outcome).toBe('succeeded');
    const reportId = done.json.artifacts.find((a: { kind: string }) => a.kind === 'osint_report').id;
    const r = (await app.req('GET', `/api/research/reports/${reportId}`)).json;
    const byTitle = (t: string) => r.findings.find((f: { title: string }) => f.title === t);
    expect(byTitle('A records')).toMatchObject({ classification: 'verified_fact', detail: expect.stringContaining('93.184.216.34') });
    expect(byTitle('DMARC policy present').classification).toBe('verified_fact');
    expect(byTitle('Registry event: registration')).toMatchObject({ classification: 'source_reported', eventDate: '1995-08-14T04:00:00Z' });
    const ct = byTitle('Names seen in certificates');
    expect(ct.detail).toContain('dev.example.com');
    expect(byTitle('Interpretation note').classification).toBe('inference');
    expect(byTitle('First capture').eventDate).toBe('1996-12-20T00:00:00Z');
    for (const f of r.findings) {
      expect(f.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      if (f.classification !== 'inference') expect(f.sourceUrl).toBeTruthy();
    }
    // Personal data from RDAP is withheld; the registrar (an organisation) is kept.
    const all = JSON.stringify(r);
    expect(all).not.toContain('Jane Private Person');
    expect(all).not.toContain('jane@private.example');
    expect(all).toContain('[individual — withheld]');
    expect(all).toContain('Internet Assigned Numbers Authority');
    const md = await app.app.inject({ url: `/api/research/reports/${reportId}/markdown`, headers: { cookie: app.cookie } });
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('## Verified facts');
    expect(md.body).toContain('## Timeline');
    expect(md.body).toContain('1995-08-14 — Registry event: registration');
  });

  it('looks up a CVE with CVSS and CISA KEV status', async () => {
    const r = await app.req('POST', '/api/research/lookup', { module: 'cve', type: 'cve', target: 'cve-2021-44228' });
    const titles = r.json.findings.map((f: { title: string }) => f.title);
    expect(titles).toEqual(expect.arrayContaining(['Description', 'CVSS', 'Weakness (CWE)', 'Listed in CISA Known Exploited Vulnerabilities']));
    expect(r.json.findings.find((f: { title: string }) => f.title === 'CVSS').detail).toContain('10 CRITICAL');
  });

  it('identifies a technology stack from one request, separating observation from inference', async () => {
    const r = await app.req('POST', '/api/research/lookup', { module: 'tech', type: 'url', target: `${fx.base}/site/` });
    const f = r.json.findings;
    expect(f.find((x: { title: string }) => x.title === 'Identifying headers')).toMatchObject({ classification: 'verified_fact', detail: expect.stringContaining('server: nginx') });
    expect(f.find((x: { title: string }) => x.title === 'Generator meta tag').detail).toBe('WordPress 6.4');
    expect(f.find((x: { title: string }) => x.title === 'Likely technologies')).toMatchObject({ classification: 'inference', detail: expect.stringContaining('WordPress') });
    expect(f.find((x: { title: string }) => x.title === 'Security headers').detail).toContain('Missing: content-security-policy');
  });
});

describe('Browser', () => {
  it('interprets the address bar', () => {
    expect(interpretAddress('youtube.com')).toEqual({ kind: 'url', url: 'https://youtube.com' });
    expect(interpretAddress('how do tourbillons work')).toEqual({ kind: 'search', query: 'how do tourbillons work' });
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toMatchObject({ videoId: 'dQw4w9WgXcQ' });
    expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ videoId: 'dQw4w9WgXcQ' });
    expect(parseYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toMatchObject({ videoId: 'dQw4w9WgXcQ' });
    expect(parseYouTubeUrl('youtube.com/results?search_query=orbital+mechanics')).toMatchObject({ videoId: null, searchQuery: 'orbital mechanics' });
    expect(parseYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('reader mode follows redirects, extracts the article and drops scripts', async () => {
    const r = await app.req('POST', '/api/browser/read', { url: `${fx.base}/old-article` });
    expect(r.json.kind).toBe('article');
    expect(r.json.redirects).toEqual([`${fx.base}/article`]);
    expect(r.json.title).toContain('Tourbillon');
    expect(r.json.html).toContain('Abraham-Louis Breguet');
    expect(r.json.html).not.toContain('window.evil');
    expect(r.json.links.map((l: { href: string }) => l.href)).toEqual(expect.arrayContaining([`${fx.base}/wiki/Escapement`, 'https://example.org/balance']));
    const hist = await app.req('GET', '/api/browser/history');
    expect(hist.json[0].url).toBe(`${fx.base}/article`);
  });

  it('reader mode routes YouTube links to the YouTube player and renders JSON', async () => {
    expect((await app.req('POST', '/api/browser/read', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).json).toMatchObject({ kind: 'youtube', youtube: { videoId: 'dQw4w9WgXcQ' } });
    expect((await app.req('POST', '/api/browser/read', { url: `${fx.base}/data.json` })).json.text).toContain('"hello": "world"');
  });

  it('blocks private addresses when the policy forbids them', async () => {
    app.ctx.net.allowPrivateNetwork = false;
    try {
      const r = await app.req('POST', '/api/browser/read', { url: `${fx.base}/article` });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('network_policy');
    } finally {
      app.ctx.net.allowPrivateNetwork = true;
    }
  });

  it('streams a real Chromium tab, forwards taps, and navigates', async () => {
    const probe = await app.req('GET', '/api/browser/live/status');
    expect(probe.json.available).toBe(true);
    const tab = await app.req('POST', '/api/browser/live/tabs', { url: `${fx.base}/live-page` });
    expect(tab.status).toBe(200);
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser/live/ws/${tab.json.id}`, { headers: { cookie: app.cookie, origin: `http://127.0.0.1:${port}` } });
    const frames: Buffer[] = [];
    const states: { url: string; title: string }[] = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) frames.push(data as Buffer);
      else {
        const m = JSON.parse(String(data));
        if (m.type === 'state') states.push(m);
      }
    });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'viewport', width: 800, height: 600 }));
    await waitFor(() => frames.length, (n) => n > 0, 20_000, 'first frame');
    expect(frames[0].subarray(0, 3).toString('hex')).toBe('ffd8ff'); // JPEG
    await waitFor(() => states.at(-1)?.title, (t) => t === 'Live fixture', 15_000, 'page title');
    // Under heavy CPU load the first tap can land before layout settles; tapping the link again is harmless.
    for (let attempt = 0; attempt < 3 && states.at(-1)?.title !== 'Arrived'; attempt++) {
      ws.send(JSON.stringify({ type: 'tap', x: 100, y: 100 }));
      await waitFor(() => states.at(-1)?.title, (t) => t === 'Arrived', 6_000, 'navigation after tap').catch(() => null);
    }
    expect(states.at(-1)?.title).toBe('Arrived');
    expect(states.at(-1)!.url).toBe(`${fx.base}/live-next`);
    const back = await app.req('POST', `/api/browser/live/tabs/${tab.json.id}/history`, { action: 'back' });
    expect(back.json.url).toBe(`${fx.base}/live-page`);
    ws.close();
    await app.req('DELETE', `/api/browser/live/tabs/${tab.json.id}`);
  });

  it('reads YouTube search results from the page rendered in the live browser', async () => {
    const tab = await app.ctx.browser.live.open(`${fx.base}/yt/results`);
    // The extractor only runs on youtube.com/results URLs; exercise it directly on the fixture page.
    const t = await waitFor(() => app.ctx.browser.live.listTabs().find((x) => x.id === tab.id)?.title, (v) => v === 'orbital - YouTube');
    expect(t).toBe('orbital - YouTube');
    const { extractResultsInPage } = await import('../src/browser/youtube.js');
    const page = (app.ctx.browser.live as unknown as { tabs: Map<string, { page: { evaluate: (fn: unknown) => Promise<unknown> } }> }).tabs.get(tab.id)!.page;
    const results = (await page.evaluate(extractResultsInPage)) as { videoId: string; title: string; duration: string }[];
    expect(results.map((r) => r.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(results[0]).toMatchObject({ title: 'Orbital mechanics explained', duration: '12:34' });
    await app.ctx.browser.live.close(tab.id);
  });

  it('the live browser refuses private addresses when the policy forbids them', async () => {
    app.ctx.net.allowPrivateNetwork = false;
    try {
      const r = await app.req('POST', '/api/browser/live/tabs', { url: 'http://169.254.169.254/latest/meta-data/' });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('network_policy');
    } finally {
      app.ctx.net.allowPrivateNetwork = true;
    }
  });
});
