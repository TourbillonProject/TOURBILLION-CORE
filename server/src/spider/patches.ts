import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Database } from '../db.js';
import { nowIso, parseJson } from '../db.js';
import type { ProjectService } from './projects.js';

/**
 * Proposed code changes. Agents never write project files directly: they
 * propose a patch (stored, reviewable diff), and the owner approves applying
 * it. Applying checks the files have not changed since the proposal, keeps a
 * backup, and can be reverted.
 */

export interface PatchFile {
  path: string;
  before: string | null; // null = new file
  after: string | null; // null = delete
}

export interface PatchRecord {
  id: number;
  projectId: number;
  taskId: number | null;
  title: string;
  description: string;
  files: (PatchFile & { diff: string })[];
  status: 'proposed' | 'applied' | 'rejected' | 'reverted' | 'conflict';
  createdAt: string;
  appliedAt: string | null;
}

export class PatchService {
  private backupDir: string;

  constructor(
    private db: Database,
    private projects: ProjectService,
    dataDir: string,
  ) {
    this.backupDir = path.join(dataDir, 'workspace', 'backups');
  }

  propose(input: { projectId: number; taskId?: number | null; title: string; description?: string; files: { path: string; content: string | null }[] }): PatchRecord {
    const project = this.projects.require(input.projectId);
    if (input.files.length === 0) throw new Error('A patch needs at least one file');
    if (input.files.length > 50) throw new Error('Too many files in one patch (max 50)');
    const files: PatchFile[] = input.files.map((f) => {
      const abs = this.projects.resolveInProject(project, f.path);
      const rel = path.relative(fs.realpathSync(project.path), abs).split(path.sep).join('/');
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (f.content !== null && f.content.length > 2_000_000) throw new Error(`File too large: ${rel}`);
      return { path: rel, before, after: f.content };
    });
    const { lastInsertRowid } = this.db.run(
      "INSERT INTO patches(project_id, task_id, title, description, files, status, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)",
      input.projectId,
      input.taskId ?? null,
      input.title.slice(0, 200),
      (input.description ?? '').slice(0, 5000),
      JSON.stringify(files),
      nowIso(),
    );
    return this.get(lastInsertRowid)!;
  }

  get(id: number): PatchRecord | null {
    const r = this.db.get<{ id: number; project_id: number; task_id: number | null; title: string; description: string; files: string; status: PatchRecord['status']; created_at: string; applied_at: string | null }>(
      'SELECT * FROM patches WHERE id = ?',
      id,
    );
    if (!r) return null;
    const files = parseJson<PatchFile[]>(r.files, []);
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      title: r.title,
      description: r.description,
      files: files.map((f) => ({ ...f, diff: createTwoFilesPatch(`a/${f.path}`, `b/${f.path}`, f.before ?? '', f.after ?? '', '', '', { context: 3 }) })),
      status: r.status,
      createdAt: r.created_at,
      appliedAt: r.applied_at,
    };
  }

  list(projectId?: number): Omit<PatchRecord, 'files'>[] & { fileCount?: number }[] {
    const rows = projectId
      ? this.db.all<{ id: number }>('SELECT id FROM patches WHERE project_id = ? ORDER BY id DESC LIMIT 100', projectId)
      : this.db.all<{ id: number }>('SELECT id FROM patches ORDER BY id DESC LIMIT 100');
    return rows.map((r) => {
      const p = this.get(r.id)!;
      return { ...p, files: p.files.map((f) => ({ ...f, before: null, after: null })) };
    });
  }

  apply(id: number): PatchRecord {
    const patch = this.get(id);
    if (!patch) throw new Error('Patch not found');
    if (patch.status !== 'proposed') throw new Error(`Patch is ${patch.status}`);
    const project = this.projects.require(patch.projectId);
    // Conflict check: files must still match what the patch was based on.
    for (const f of patch.files) {
      const abs = this.projects.resolveInProject(project, f.path);
      const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (now !== f.before) {
        this.db.run("UPDATE patches SET status = 'conflict' WHERE id = ?", id);
        throw new Error(`Conflict: ${f.path} changed after the patch was proposed. Ask for a fresh patch.`);
      }
    }
    const backup = path.join(this.backupDir, String(id));
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(patch.files.map((f) => ({ path: f.path, existed: f.before !== null }))));
    patch.files.forEach((f, i) => {
      if (f.before !== null) fs.writeFileSync(path.join(backup, `${i}.orig`), f.before);
    });
    for (const f of patch.files) {
      const abs = this.projects.resolveInProject(project, f.path);
      if (f.after === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.after);
      }
    }
    this.db.run("UPDATE patches SET status = 'applied', applied_at = ? WHERE id = ?", nowIso(), id);
    return this.get(id)!;
  }

  revert(id: number): PatchRecord {
    const patch = this.get(id);
    if (!patch || patch.status !== 'applied') throw new Error('Only applied patches can be reverted');
    const project = this.projects.require(patch.projectId);
    const backup = path.join(this.backupDir, String(id));
    patch.files.forEach((f, i) => {
      const abs = this.projects.resolveInProject(project, f.path);
      if (f.before === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, fs.readFileSync(path.join(backup, `${i}.orig`), 'utf8'));
    });
    this.db.run("UPDATE patches SET status = 'reverted' WHERE id = ?", id);
    return this.get(id)!;
  }

  reject(id: number) {
    this.db.run("UPDATE patches SET status = 'rejected' WHERE id = ? AND status = 'proposed'", id);
    return this.get(id);
  }
}
