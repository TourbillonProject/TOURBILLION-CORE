import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Project, ProjectService } from './projects.js';
import { safeFetch, type NetPolicy } from '../security/net.js';

/**
 * The Spider's deterministic analysers. These run without an AI key and
 * produce evidence (file, line, snippet) that Claude can then confirm,
 * dismiss and explain. Pattern matches are labelled as leads, not verdicts.
 */

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', lua: 'Lua', luau: 'Luau', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'CSS',
  vue: 'Vue', svelte: 'Svelte', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', md: 'Markdown', dart: 'Dart', scala: 'Scala', r: 'R',
};
const TEXT_EXT = new Set([...Object.keys(LANGUAGES), 'txt', 'env', 'ini', 'cfg', 'conf', 'xml', 'gradle', 'properties', 'dockerfile', 'lock']);

export function isTextFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (['dockerfile', 'makefile', '.env', '.gitignore', 'procfile'].includes(base)) return true;
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return TEXT_EXT.has(ext);
}

export function readText(file: string, max = 1_000_000): string | null {
  try {
    const st = fs.statSync(file);
    if (st.size > max) return null;
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface Overview {
  files: number;
  totalBytes: number;
  lines: number;
  languages: { language: string; files: number; lines: number }[];
  topLevel: { name: string; files: number }[];
  manifests: string[];
  scripts: Record<string, string>;
  largestFiles: { path: string; bytes: number }[];
  hasTests: boolean;
  readme: string | null;
}

export function overview(projects: ProjectService, project: Project, onFile?: (rel: string) => void): Overview {
  const files = projects.walk(project);
  const root = project.path;
  const langs = new Map<string, { files: number; lines: number }>();
  const top = new Map<string, number>();
  let lines = 0;
  let totalBytes = 0;
  const manifests: string[] = [];
  let hasTests = false;
  for (const f of files) {
    totalBytes += f.size;
    const head = f.rel.includes('/') ? f.rel.split('/')[0] + '/' : f.rel;
    top.set(head, (top.get(head) ?? 0) + 1);
    if (/(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle|composer\.json|default\.project\.json|wally\.toml|selene\.toml)$/.test(f.rel) && !f.rel.includes('/node_modules/')) manifests.push(f.rel);
    if (/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/.test(f.rel)) hasTests = true;
    const ext = f.rel.split('.').pop()?.toLowerCase() ?? '';
    const lang = LANGUAGES[ext];
    if (!lang || f.size > 2_000_000) continue;
    onFile?.(f.rel);
    const text = readText(path.join(root, f.rel));
    const n = text ? text.split('\n').length : 0;
    lines += n;
    const cur = langs.get(lang) ?? { files: 0, lines: 0 };
    cur.files += 1;
    cur.lines += n;
    langs.set(lang, cur);
  }
  let scripts: Record<string, string> = {};
  const pkg = readJson<{ scripts?: Record<string, string> }>(path.join(root, 'package.json'));
  if (pkg?.scripts) scripts = pkg.scripts;
  const readmeFile = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f.rel));
  return {
    files: files.length,
    totalBytes,
    lines,
    languages: [...langs.entries()].map(([language, v]) => ({ language, ...v })).sort((a, b) => b.lines - a.lines),
    topLevel: [...top.entries()].map(([name, n]) => ({ name, files: n })).sort((a, b) => b.files - a.files).slice(0, 30),
    manifests: manifests.slice(0, 50),
    scripts,
    largestFiles: [...files].sort((a, b) => b.size - a.size).slice(0, 10).map((f) => ({ path: f.rel, bytes: f.size })),
    hasTests,
    readme: readmeFile ? (readText(path.join(root, readmeFile.rel), 200_000) ?? '').slice(0, 3000) : null,
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface Dependency {
  ecosystem: 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'RubyGems';
  name: string;
  version: string | null;
  dev: boolean;
  direct: boolean;
  manifest: string;
}

export function dependencies(project: Project): Dependency[] {
  const root = project.path;
  const out: Dependency[] = [];
  const lock = readJson<{ packages?: Record<string, { version?: string; dev?: boolean }> }>(path.join(root, 'package-lock.json'));
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(root, 'package.json'));
  const directNames = new Set([...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.devDependencies ?? {})]);
  if (lock?.packages) {
    for (const [key, info] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/') || !info.version) continue;
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      out.push({ ecosystem: 'npm', name, version: info.version, dev: !!info.dev, direct: directNames.has(name) && key === `node_modules/${name}`, manifest: 'package-lock.json' });
    }
  } else if (pkg) {
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) out.push({ ecosystem: 'npm', name, version: cleanRange(range), dev: false, direct: true, manifest: 'package.json' });
    for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) out.push({ ecosystem: 'npm', name, version: cleanRange(range), dev: true, direct: true, manifest: 'package.json' });
  }
  const req = readText(path.join(root, 'requirements.txt'));
  if (req) {
    for (const line of req.split('\n')) {
      const m = line.trim().match(/^([A-Za-z0-9_.\-[\]]+)\s*(?:==\s*([^\s;#]+))?/);
      if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) out.push({ ecosystem: 'PyPI', name: m[1].replace(/\[.*\]/, ''), version: m[2] ?? null, dev: false, direct: true, manifest: 'requirements.txt' });
    }
  }
  const gomod = readText(path.join(root, 'go.mod'));
  if (gomod) {
    for (const m of gomod.matchAll(/^\s*([a-z0-9.\-/]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/gim)) out.push({ ecosystem: 'Go', name: m[1], version: m[2], dev: false, direct: true, manifest: 'go.mod' });
  }
  const cargo = readText(path.join(root, 'Cargo.lock'));
  if (cargo) {
    for (const m of cargo.matchAll(/\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g)) out.push({ ecosystem: 'crates.io', name: m[1], version: m[2], dev: false, direct: false, manifest: 'Cargo.lock' });
  }
  const gemlock = readText(path.join(root, 'Gemfile.lock'));
  if (gemlock) {
    for (const m of gemlock.matchAll(/^ {4}([a-zA-Z0-9_\-]+) \(([0-9][^)]*)\)$/gm)) out.push({ ecosystem: 'RubyGems', name: m[1], version: m[2], dev: false, direct: false, manifest: 'Gemfile.lock' });
  }
  return out;
}

function cleanRange(r: string): string | null {
  const m = r.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

export interface Vulnerability {
  id: string;
  aliases: string[];
  summary: string;
  severity: string | null;
  package: string;
  version: string | null;
  ecosystem: string;
  fixed: string[];
  url: string;
}

/** Queries OSV.dev (querybatch) for known vulnerabilities in pinned dependency versions. */
export async function osvAudit(deps: Dependency[], endpoint: string, policy: NetPolicy, signal?: AbortSignal): Promise<{ vulns: Vulnerability[]; queried: number; source: string }> {
  const pinned = deps.filter((d) => d.version).slice(0, 1000);
  const vulns: Vulnerability[] = [];
  for (let i = 0; i < pinned.length; i += 200) {
    const chunk = pinned.slice(i, i + 200);
    const res = await safeFetch(`${endpoint}/v1/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
      policy,
      signal,
      timeoutMs: 30_000,
    });
    if (res.status !== 200) throw new Error(`OSV returned HTTP ${res.status}`);
    const data = res.json<{ results: { vulns?: { id: string }[] }[] }>();
    const ids = new Map<string, Dependency[]>();
    data.results.forEach((r, idx) => {
      for (const v of r.vulns ?? []) ids.set(v.id, [...(ids.get(v.id) ?? []), chunk[idx]]);
    });
    for (const [id, affected] of ids) {
      let detail: { summary?: string; details?: string; aliases?: string[]; database_specific?: { severity?: string }; affected?: { ranges?: { events?: { fixed?: string }[] }[] }[] } = {};
      try {
        const d = await safeFetch(`${endpoint}/v1/vulns/${encodeURIComponent(id)}`, { policy, signal, timeoutMs: 20_000 });
        if (d.status === 200) detail = d.json();
      } catch {
        /* keep id-only entry */
      }
      const fixed = new Set<string>();
      for (const a of detail.affected ?? []) for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixed.add(e.fixed);
      for (const dep of affected) {
        vulns.push({
          id,
          aliases: detail.aliases ?? [],
          summary: detail.summary ?? (detail.details ?? '').slice(0, 300),
          severity: detail.database_specific?.severity ?? null,
          package: dep.name,
          version: dep.version,
          ecosystem: dep.ecosystem,
          fixed: [...fixed],
          url: `https://osv.dev/vulnerability/${id}`,
        });
      }
    }
  }
  return { vulns, queried: pinned.length, source: `${endpoint}/v1/querybatch` };
}

/** `npm audit --package-lock-only`: reads the lockfile only; never runs project code. */
export function npmAudit(project: Project, signal?: AbortSignal): Promise<{ ok: boolean; summary: Record<string, number> | null; advisories: { name: string; severity: string; title: string; url: string; range: string }[]; error?: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(project.path, 'package-lock.json'))) return resolve({ ok: false, summary: null, advisories: [], error: 'No package-lock.json' });
    const child = spawn('npm', ['audit', '--json', '--package-lock-only', '--ignore-scripts'], {
      cwd: project.path,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', npm_config_update_notifier: 'false', ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? '' } : {}) },
      timeout: 120_000,
      signal,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, summary: null, advisories: [], error: e.message }));
    child.on('close', () => {
      try {
        const j = JSON.parse(out) as { metadata?: { vulnerabilities?: Record<string, number> }; vulnerabilities?: Record<string, { name: string; severity: string; via: ({ title?: string; url?: string; range?: string } | string)[] }>; error?: { summary?: string } };
        if (j.error) return resolve({ ok: false, summary: null, advisories: [], error: j.error.summary ?? 'npm audit error' });
        const advisories: { name: string; severity: string; title: string; url: string; range: string }[] = [];
        for (const v of Object.values(j.vulnerabilities ?? {})) {
          for (const via of v.via) if (typeof via === 'object') advisories.push({ name: v.name, severity: v.severity, title: via.title ?? '', url: via.url ?? '', range: via.range ?? '' });
        }
        resolve({ ok: true, summary: j.metadata?.vulnerabilities ?? null, advisories });
      } catch {
        resolve({ ok: false, summary: null, advisories: [], error: `Unparseable npm audit output: ${out.slice(0, 200)}` });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Static security scan
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  langs: string[] | null; // file extensions; null = all text files
  re: RegExp;
  advice: string;
  /** Skip matches in test files. */
  skipTests?: boolean;
}

const RULES: Rule[] = [
  { id: 'secret.private-key', title: 'Private key committed to the repository', severity: 'critical', langs: null, re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, advice: 'Remove the key, rotate it, and purge it from git history.' },
  { id: 'secret.aws-key', title: 'AWS access key ID', severity: 'high', langs: null, re: /\bAKIA[0-9A-Z]{16}\b/, advice: 'Rotate the key and load credentials from the environment or a secrets manager.' },
  { id: 'secret.github-token', title: 'GitHub token', severity: 'high', langs: null, re: /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, advice: 'Revoke the token and use environment variables.' },
  { id: 'secret.anthropic-key', title: 'Anthropic API key', severity: 'high', langs: null, re: /sk-ant-[A-Za-z0-9_-]{20,}/, advice: 'Revoke the key in the Anthropic Console; keep keys server-side.' },
  { id: 'secret.generic', title: 'Hard-coded credential', severity: 'medium', langs: null, re: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i, advice: 'Move secrets to environment variables or a secrets manager.', skipTests: true },
  { id: 'js.eval', title: 'Dynamic code execution (eval / new Function)', severity: 'high', langs: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'], re: /\beval\s*\(|new\s+Function\s*\(/, advice: 'Avoid evaluating strings as code; parse data explicitly.', skipTests: true },
  { id: 'js.child-process-shell', title: 'Shell command built from variables', severity: 'high', langs: ['js', 'ts', 'mjs', 'cjs'], re: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|[^'"`)]*\+)/, advice: 'Use execFile/spawn with an argument array; never interpolate input into shell strings.' },
  { id: 'js.inner-html', title: 'Raw HTML injection sink', severity: 'medium', langs: ['js', 'jsx', 'ts', 'tsx'], re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/, advice: 'Render text, or sanitise with a vetted library (e.g. DOMPurify) before inserting HTML.' },
  { id: 'js.tls-disabled', title: 'TLS certificate verification disabled', severity: 'high', langs: ['js', 'ts', 'mjs', 'cjs'], re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, advice: 'Keep certificate verification on; trust a specific CA instead.' },
  { id: 'js.weak-random', title: 'Math.random used for something that looks security-sensitive', severity: 'medium', langs: ['js', 'ts', 'jsx', 'tsx'], re: /(token|secret|password|nonce|salt|session)[^\n]{0,40}Math\.random\(\)|Math\.random\(\)[^\n]{0,40}(token|secret|password|nonce|salt|session)/i, advice: 'Use crypto.randomBytes / crypto.getRandomValues.' },
  { id: 'js.cors-any-credentials', title: 'Permissive CORS with credentials', severity: 'medium', langs: ['js', 'ts'], re: /origin\s*:\s*(true|['"]\*['"])[^\n]{0,80}credentials\s*:\s*true/, advice: 'Restrict allowed origins when credentials are allowed.' },
  { id: 'sql.concat', title: 'SQL query built by string concatenation', severity: 'high', langs: ['js', 'ts', 'py', 'php', 'rb', 'java', 'go', 'cs'], re: /(SELECT|INSERT|UPDATE|DELETE)\b[^\n;]{0,80}(['"`]\s*\+\s*\w|\$\{\w|%s['"]\s*%|f["'][^"']*\{)/i, advice: 'Use parameterised queries / prepared statements.' },
  { id: 'py.subprocess-shell', title: 'subprocess with shell=True', severity: 'high', langs: ['py'], re: /subprocess\.\w+\([^)]*shell\s*=\s*True/, advice: 'Pass an argument list and shell=False.' },
  { id: 'py.yaml-load', title: 'yaml.load without a safe loader', severity: 'high', langs: ['py'], re: /yaml\.load\((?![^)]*Loader\s*=\s*(yaml\.)?SafeLoader)/, advice: 'Use yaml.safe_load.' },
  { id: 'py.pickle', title: 'Unpickling data', severity: 'medium', langs: ['py'], re: /pickle\.loads?\(/, advice: 'Never unpickle untrusted data; use JSON.' },
  { id: 'py.requests-verify-false', title: 'requests with verify=False', severity: 'high', langs: ['py'], re: /requests\.\w+\([^)]*verify\s*=\s*False/, advice: 'Keep TLS verification enabled.' },
  { id: 'py.eval', title: 'eval/exec on dynamic input', severity: 'high', langs: ['py'], re: /\b(eval|exec)\s*\((?!\s*['"])/, advice: 'Avoid eval/exec; use ast.literal_eval for literals.', skipTests: true },
  { id: 'crypto.weak-hash', title: 'MD5/SHA-1 used (check it is not for passwords or signatures)', severity: 'low', langs: null, re: /\b(md5|sha1)\b\s*\(|createHash\(\s*['"](md5|sha1)['"]/i, advice: 'Use SHA-256+ for integrity and a password hash (scrypt/argon2/bcrypt) for passwords.' },
  { id: 'net.plain-http', title: 'Plain-HTTP endpoint', severity: 'low', langs: ['js', 'ts', 'py', 'go', 'java', 'rb', 'php', 'lua', 'luau'], re: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|example\.)[a-z0-9.-]+/i, advice: 'Prefer https for remote endpoints.', skipTests: true },
  { id: 'lua.loadstring', title: 'loadstring (dynamic code) in Luau', severity: 'medium', langs: ['lua', 'luau'], re: /\bloadstring\s*\(/, advice: 'Avoid loadstring; it is disabled by default in Roblox and enables code injection.' },
  { id: 'roblox.remote-trust', title: 'RemoteEvent handler — confirm the server validates client input', severity: 'info', langs: ['lua', 'luau'], re: /OnServerEvent:Connect\s*\(/, advice: 'Never trust client-supplied values; validate types, ranges and ownership on the server.' },
  { id: 'debug.marker', title: 'TODO / FIXME / HACK marker', severity: 'info', langs: null, re: /\b(TODO|FIXME|HACK|XXX)\b[:\s]/, advice: 'Track outstanding work explicitly.' },
];

export interface ScanFinding {
  rule: string;
  title: string;
  severity: Severity;
  file: string;
  line: number;
  snippet: string;
  advice: string;
  confidence: 'pattern-match';
}

export function securityScan(projects: ProjectService, project: Project, onFile?: (rel: string) => void): { findings: ScanFinding[]; filesScanned: number; rules: number } {
  const files = projects.walk(project).filter((f) => isTextFile(f.rel) && f.size < 1_000_000 && !/\.min\.(js|css)$/.test(f.rel) && !f.rel.endsWith('package-lock.json'));
  const findings: ScanFinding[] = [];
  let scanned = 0;
  for (const f of files) {
    const text = readText(path.join(project.path, f.rel));
    if (text === null) continue;
    scanned += 1;
    onFile?.(f.rel);
    const ext = f.rel.split('.').pop()?.toLowerCase() ?? '';
    const isTest = /(^|\/)(test|tests|__tests__|spec|fixtures?)\/|\.(test|spec)\.[a-z]+$/.test(f.rel);
    const lines = text.split('\n');
    for (const rule of RULES) {
      if (rule.langs && !rule.langs.includes(ext)) continue;
      if (rule.skipTests && isTest) continue;
      let hits = 0;
      for (let i = 0; i < lines.length && hits < 5; i++) {
        const line = lines[i];
        if (line.length > 2000) continue;
        if (rule.re.test(line)) {
          hits += 1;
          findings.push({ rule: rule.id, title: rule.title, severity: rule.severity, file: f.rel, line: i + 1, snippet: line.trim().slice(0, 200).replace(/(sk-ant-|AKIA|ghp_)[A-Za-z0-9_-]{6,}/g, '$1••••'), advice: rule.advice, confidence: 'pattern-match' });
        }
      }
    }
    if (findings.length > 2000) break;
  }
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return { findings, filesScanned: scanned, rules: RULES.length };
}

// ---------------------------------------------------------------------------
// Checks / tests (executes project code — always approval-gated)
// ---------------------------------------------------------------------------

export interface CheckDef {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export function detectChecks(project: Project): CheckDef[] {
  const root = project.path;
  const checks: CheckDef[] = [];
  const pkg = readJson<{ scripts?: Record<string, string> }>(path.join(root, 'package.json'));
  for (const s of ['test', 'lint', 'typecheck', 'check', 'build']) {
    if (pkg?.scripts?.[s]) checks.push({ id: `npm:${s}`, label: `npm run ${s}`, command: 'npm', args: ['run', s, '--silent'] });
  }
  if (fs.existsSync(path.join(root, 'tsconfig.json')) && !pkg?.scripts?.typecheck) checks.push({ id: 'tsc', label: 'npx tsc --noEmit', command: 'npx', args: ['--no-install', 'tsc', '--noEmit'] });
  if (fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'tests'))) {
    if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'))) checks.push({ id: 'pytest', label: 'python -m pytest -q', command: 'python3', args: ['-m', 'pytest', '-q'] });
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) checks.push({ id: 'go-test', label: 'go test ./...', command: 'go', args: ['test', './...'] });
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) checks.push({ id: 'cargo-test', label: 'cargo test', command: 'cargo', args: ['test'] });
  if (fs.existsSync(path.join(root, 'selene.toml'))) checks.push({ id: 'selene', label: 'selene .', command: 'selene', args: ['.'] });
  return checks;
}

export interface CheckResult {
  check: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

/**
 * Runs a detected check. No shell; fixed argv chosen from `detectChecks`;
 * a minimal environment with no server secrets; hard timeout.
 */
export function runCheck(project: Project, check: CheckDef, signal?: AbortSignal, timeoutMs = 300_000): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(check.command, check.args, {
      cwd: project.path,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        npm_config_update_notifier: 'false',
      },
      timeout: timeoutMs,
      signal,
    });
    let stdout = '';
    let stderr = '';
    const cap = (s: string, d: Buffer) => (s.length > 200_000 ? s : s + d.toString());
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ check: check.id, command: `${check.command} ${check.args.join(' ')}`, exitCode: code, timedOut, durationMs: Date.now() - started, stdout: stdout.slice(-100_000), stderr: stderr.slice(-50_000), passed: code === 0 });
    };
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
