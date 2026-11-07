import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureServer, makeApp, waitFor, type TestApp } from './helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let app: TestApp;
let osv: Awaited<ReturnType<typeof fixtureServer>>;
let projectDir: string;

function writeFixtureProject(dir: string) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-app', version: '1.0.0', scripts: { test: 'node test.js', lint: 'node -e "process.exit(1)"' }, dependencies: { lodash: '4.17.20' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, packages: { '': { name: 'fixture-app' }, 'node_modules/lodash': { version: '4.17.20' } } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'src/app.js'),
    [
      "const api_key = 'abcd1234efgh5678ijkl';",
      'function run(userInput) {',
      '  return eval(userInput);',
      '}',
      "function render(el, html) { el.innerHTML = html; }",
      "// TODO: validate input",
      'module.exports = { run, render };',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'src/math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(dir, 'test.js'), "const { add } = require('./src/math.js');\nif (add(2, 2) !== 4) { console.error('add failed'); process.exit(1); }\nconsole.log('1 passing');\n");
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture app\nA deliberately flawed project for The Spider.\n');
}

beforeAll(async () => {
  osv = await fixtureServer({
    '/v1/querybatch': (_req, _url, body) => {
      const q = JSON.parse(body) as { queries: { package: { name: string } }[] };
      return { body: { results: q.queries.map((x) => (x.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] } : {})) } };
    },
    '/v1/vulns/*': () => ({
      body: { id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', aliases: ['CVE-2021-23337'], database_specific: { severity: 'HIGH' }, affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] },
    }),
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-spider-'));
  projectDir = path.join(root, 'fixture-app');
  writeFixtureProject(projectDir);
  app = await makeApp({ projectRoots: [root, REPO], endpoints: { osv: osv.base } as never });
});
afterAll(async () => {
  await app.close();
  await osv.close();
});

describe('The Spider', () => {
  it('inspects a project, gates test execution on approval, runs the tests, and reports', async () => {
    const p = await app.req('POST', '/api/projects/local', { name: 'Fixture app', path: projectDir });
    expect(p.status).toBe(200);
    const projectId = p.json.id;
    const detail = await app.req('GET', `/api/projects/${projectId}`);
    expect(detail.json.checks.map((c: { id: string }) => c.id)).toEqual(['npm:test', 'npm:lint']);

    const files: string[] = [];
    const off = app.ctx.bus.on((e) => e.type === 'spider.file' && files.push(e.path));
    const m = await app.req('POST', '/api/missions', { playbook: 'spider.inspect', params: { projectId, runChecks: true, checks: ['npm:test'], aiReview: false } });
    expect(m.status).toBe(200);
    const id = m.json.id;
    const waiting = await waitFor(() => app.req('GET', `/api/missions/${id}`), (r) => r.json.status === 'awaiting_approval', 20_000, 'test-run approval');
    const approval = waiting.json.approvals.find((a: { status: string }) => a.status === 'pending');
    expect(approval.tool).toBe('run_project_check');
    expect(approval.risk).toBe('sensitive');
    expect(approval.input.checkId).toBe('npm:test');
    // The tests have not run yet.
    expect(waiting.json.artifacts.some((a: { kind: string }) => a.kind === 'test_run')).toBe(false);

    await app.req('POST', `/api/approvals/${approval.id}`, { approve: true });
    const done = await waitFor(() => app.req('GET', `/api/missions/${id}`), (r) => ['completed', 'failed'].includes(r.json.status), 60_000, 'inspection');
    off();
    expect(done.json.status).toBe('completed');
    expect(done.json.verification.outcome).toBe('succeeded');

    const report = done.json.artifacts.find((a: { kind: string }) => a.kind === 'spider_report').data;
    const rules = report.scan.findings.map((f: { rule: string }) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['js.eval', 'secret.generic', 'js.inner-html', 'debug.marker']));
    const evalHit = report.scan.findings.find((f: { rule: string }) => f.rule === 'js.eval');
    expect(evalHit).toMatchObject({ file: 'src/app.js', line: 3, severity: 'high' });
    expect(report.dependencies.osv.vulns[0]).toMatchObject({ package: 'lodash', version: '4.17.20', id: 'GHSA-35jh-r3h4-6jhm', fixed: ['4.17.21'] });
    expect(report.overview.languages[0].language).toBe('JavaScript');

    const run = done.json.artifacts.find((a: { kind: string }) => a.kind === 'test_run').data;
    expect(run).toMatchObject({ exitCode: 0, passed: true, command: 'npm run test --silent' });
    expect(run.stdout).toContain('1 passing');
    expect(done.json.report).toContain('npm:test: passed');
    expect(files).toEqual(expect.arrayContaining(['src/app.js', 'test.js']));
  });

  it('reports failing checks honestly as a partial result', async () => {
    const projectId = (await app.req('GET', '/api/projects')).json[0].id;
    const m = await app.req('POST', '/api/missions', { playbook: 'spider.inspect', params: { projectId, runChecks: true, checks: ['npm:lint'], aiReview: false } });
    const waiting = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => r.json.status === 'awaiting_approval');
    await app.req('POST', `/api/approvals/${waiting.json.approvals[0].id}`, { approve: true });
    const done = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 60_000);
    expect(done.json.verification.outcome).toBe('partial');
    expect(done.json.report).toContain('npm:lint: FAILED');
  });

  it('does not run anything when the owner denies the test run', async () => {
    const projectId = (await app.req('GET', '/api/projects')).json[0].id;
    const m = await app.req('POST', '/api/missions', { playbook: 'spider.inspect', params: { projectId, runChecks: true, checks: ['npm:test'], aiReview: false } });
    const waiting = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => r.json.status === 'awaiting_approval');
    await app.req('POST', `/api/approvals/${waiting.json.approvals[0].id}`, { approve: false });
    const done = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 60_000);
    expect(done.json.artifacts.some((a: { kind: string }) => a.kind === 'test_run')).toBe(false);
    expect(done.json.steps.some((s: { message: string }) => /Not approved \(denied\)/.test(s.message))).toBe(true);
  });

  it('proposes, applies, reverts patches and detects conflicts', async () => {
    const projectId = (await app.req('GET', '/api/projects')).json[0].id;
    const fixed = "function run(userInput) {\n  return JSON.parse(userInput);\n}\nmodule.exports = { run };\n";
    const patch = app.ctx.patches.propose({ projectId, title: 'Remove eval', files: [{ path: 'src/app.js', content: fixed }] });
    expect(patch.files[0].diff).toContain('-  return eval(userInput);');
    expect(patch.files[0].diff).toContain('+  return JSON.parse(userInput);');
    const original = fs.readFileSync(path.join(projectDir, 'src/app.js'), 'utf8');

    const applied = await app.req('POST', `/api/patches/${patch.id}/apply`, {});
    expect(applied.json.status).toBe('applied');
    expect(fs.readFileSync(path.join(projectDir, 'src/app.js'), 'utf8')).toBe(fixed);
    const reverted = await app.req('POST', `/api/patches/${patch.id}/revert`, {});
    expect(reverted.json.status).toBe('reverted');
    expect(fs.readFileSync(path.join(projectDir, 'src/app.js'), 'utf8')).toBe(original);

    const p2 = app.ctx.patches.propose({ projectId, title: 'Conflicting', files: [{ path: 'src/math.js', content: 'exports.add = (a, b) => b + a;\n' }] });
    fs.appendFileSync(path.join(projectDir, 'src/math.js'), '// edited by hand\n');
    const conflict = await app.req('POST', `/api/patches/${p2.id}/apply`, {});
    expect(conflict.status).toBe(409);
    expect(conflict.json.message).toMatch(/Conflict/);
    expect(() => app.ctx.patches.propose({ projectId, title: 'escape', files: [{ path: '../outside.js', content: 'x' }] })).toThrow(/outside the project/);
  });

  it('inspects this TOURBILLION CORE repository (real-world run)', async () => {
    const p = await app.req('POST', '/api/projects/local', { name: 'TOURBILLION CORE', path: REPO });
    const m = await app.req('POST', '/api/missions', { playbook: 'spider.inspect', params: { projectId: p.json.id, runChecks: false, aiReview: false } });
    const done = await waitFor(() => app.req('GET', `/api/missions/${m.json.id}`), (r) => ['completed', 'failed'].includes(r.json.status), 120_000, 'self-inspection');
    expect(done.json.status).toBe('completed');
    const report = done.json.artifacts.find((a: { kind: string }) => a.kind === 'spider_report').data;
    expect(report.overview.files).toBeGreaterThan(50);
    expect(report.overview.languages[0].language).toBe('TypeScript');
    expect(report.dependencies.deps.length).toBeGreaterThan(50);
    // The fake OSV endpoint only knows lodash; the repository does not depend on it.
    expect(report.dependencies.osv.vulns.length).toBe(0);
    // Summary for the testing report.
    console.log(`[self-inspection] files=${report.overview.files} lines=${report.overview.lines} deps=${report.dependencies.deps.length} leads=${report.scan.findings.length} (${['critical', 'high', 'medium', 'low', 'info'].map((s) => `${s}:${report.scan.findings.filter((f: { severity: string }) => f.severity === s).length}`).join(' ')})`);
  });
});
