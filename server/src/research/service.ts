import type { Finding, ResearchTargetType } from '@tc/shared';
import { FINDING_CLASS_LABELS } from '@tc/shared';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { nowIso, parseJson } from '../db.js';
import type { NetPolicy } from '../security/net.js';
import type { SecretStore } from '../security/secrets.js';
import type { IntegrationRegistry } from '../services/integrations.js';
import { OSINT_MODULES, modulesFor, normaliseTarget, type ModuleResult } from './osint.js';

export const GITHUB_SECRET = 'github.token';

export interface OsintReport {
  id: number;
  taskId: number | null;
  target: string;
  targetType: ResearchTargetType;
  purpose: string;
  modules: { id: string; title: string; ok: boolean; error: string | null; sources: string[] }[];
  findings: Finding[];
  synthesis: string | null;
  createdAt: string;
}

/** Research department: runs OSINT modules and stores sourced, classified reports. */
export class ResearchService {
  constructor(
    private config: AppConfig,
    private db: Database,
    private policy: NetPolicy,
    private secrets: SecretStore,
    integrations: IntegrationRegistry,
  ) {
    integrations.register({
      id: 'github',
      name: 'GitHub API',
      description: 'Public repository research works without a token (60 requests/hour); a read-only token raises the limit.',
      permissions: ['Read public repository metadata'],
      requires: ['Optional: fine-grained read-only GitHub token'],
      isConfigured: () => true,
      details: () => ({ token: this.githubToken() ? 'configured' : 'none (unauthenticated)' }),
      test: async () => {
        const r = await this.runModule('github', 'github_repo', 'nodejs/node');
        if (!r.findings.some((f) => f.title === 'Repository')) throw new Error(r.findings[0]?.detail ?? 'GitHub API unreachable');
        return { checked: 'nodejs/node' };
      },
      disconnect: () => this.secrets.delete(GITHUB_SECRET),
    });
  }

  githubToken(): string | null {
    return this.secrets.get(GITHUB_SECRET) ?? this.config.githubToken;
  }

  modules(type?: ResearchTargetType) {
    return (type ? modulesFor(type) : OSINT_MODULES).map((m) => ({ id: m.id, title: m.title, description: m.description, targets: m.targets }));
  }

  normalise(type: ResearchTargetType, target: string) {
    return normaliseTarget(type, target);
  }

  async runModule(moduleId: string, type: ResearchTargetType, rawTarget: string, signal?: AbortSignal): Promise<ModuleResult> {
    const mod = OSINT_MODULES.find((m) => m.id === moduleId);
    if (!mod) throw new Error(`Unknown module ${moduleId}`);
    if (!mod.targets.includes(type)) throw new Error(`Module ${moduleId} does not accept ${type} targets`);
    const target = normaliseTarget(type, rawTarget);
    return mod.run(target, { config: this.config, policy: this.policy, signal, githubToken: this.githubToken() });
  }

  saveReport(r: Omit<OsintReport, 'id' | 'createdAt'>): OsintReport {
    const createdAt = nowIso();
    const { lastInsertRowid } = this.db.run(
      "INSERT INTO artifacts(task_id, kind, title, data, created_at) VALUES (?, 'osint_report', ?, ?, ?)",
      r.taskId,
      `${r.targetType}: ${r.target}`,
      JSON.stringify(r),
      createdAt,
    );
    return { ...r, id: lastInsertRowid, createdAt };
  }

  getReport(id: number): OsintReport | null {
    const row = this.db.get<{ id: number; data: string; created_at: string }>("SELECT id, data, created_at FROM artifacts WHERE id = ? AND kind = 'osint_report'", id);
    if (!row) return null;
    return { ...parseJson<OsintReport>(row.data, {} as OsintReport), id: row.id, createdAt: row.created_at };
  }

  listReports(limit = 50) {
    return this.db
      .all<{ id: number; task_id: number | null; title: string; created_at: string; data: string }>("SELECT id, task_id, title, created_at, data FROM artifacts WHERE kind = 'osint_report' ORDER BY id DESC LIMIT ?", limit)
      .map((r) => {
        const d = parseJson<OsintReport>(r.data, {} as OsintReport);
        return { id: r.id, taskId: r.task_id, title: r.title, createdAt: r.created_at, findings: d.findings?.length ?? 0, purpose: d.purpose };
      });
  }

  deleteReport(id: number) {
    this.db.run("DELETE FROM artifacts WHERE id = ? AND kind = 'osint_report'", id);
  }

  /** Findings recorded by the Research agent during an AI-driven mission. */
  recordFinding(taskId: number | null, f: Finding) {
    this.db.run("INSERT INTO artifacts(task_id, kind, title, data, created_at) VALUES (?, 'finding', ?, ?, ?)", taskId, f.title.slice(0, 200), JSON.stringify(f), nowIso());
  }

  taskFindings(taskId: number): Finding[] {
    return this.db.all<{ data: string }>("SELECT data FROM artifacts WHERE task_id = ? AND kind = 'finding' ORDER BY id", taskId).map((r) => parseJson<Finding>(r.data, {} as Finding));
  }

  toMarkdown(r: OsintReport): string {
    const lines = [
      `# Research report — ${r.target}`,
      '',
      `- Target type: ${r.targetType}`,
      `- Purpose / scope: ${r.purpose}`,
      `- Compiled: ${r.createdAt}`,
      `- Modules: ${r.modules.map((m) => `${m.title}${m.ok ? '' : ' (failed)'}`).join(', ')}`,
      '',
      '> Classification key: **Verified fact** — observed directly at collection time. **Source-reported claim** — stated by the cited source. **Inference** — derived by reasoning. **Unverified** — weak, missing or failed source.',
      '',
    ];
    if (r.synthesis) lines.push('## Analyst synthesis (AI — inference)', '', r.synthesis, '');
    const byClass = (['verified_fact', 'source_reported', 'inference', 'unverified'] as const).map((c) => [c, r.findings.filter((f) => f.classification === c)] as const);
    for (const [c, fs] of byClass) {
      if (!fs.length) continue;
      lines.push(`## ${FINDING_CLASS_LABELS[c]}s`, '');
      for (const f of fs) {
        lines.push(`### ${f.title} _(${f.module})_`, '', f.detail, '', `Source: ${f.sourceUrl ?? 'n/a'} · Collected: ${f.collectedAt}`, '');
      }
    }
    const timeline = r.findings.filter((f) => f.eventDate).sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
    if (timeline.length) {
      lines.push('## Timeline', '');
      for (const f of timeline) lines.push(`- ${String(f.eventDate).slice(0, 10)} — ${f.title} (${f.module})`);
      lines.push('');
    }
    lines.push('## Sources', '', ...[...new Set(r.modules.flatMap((m) => m.sources))].map((s) => `- ${s}`));
    return lines.join('\n');
  }
}
