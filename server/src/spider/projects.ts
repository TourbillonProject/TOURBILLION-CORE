import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import type { Database } from '../db.js';
import { nowIso } from '../db.js';
import type { AppConfig } from '../config.js';

/**
 * Code projects The Spider and the Development Engineer may work on.
 *
 * Sources:
 *  - upload: a .zip uploaded from the iPad (Files app); extracted with zip-slip protection.
 *  - git:    an https git URL cloned into the workspace (no credentials).
 *  - local:  a directory under TC_PROJECT_ROOTS on the server (allowlist).
 *
 * Every file path an agent supplies is resolved through `resolveInProject`,
 * which rejects traversal and symlink escapes.
 */

export interface Project {
  id: number;
  name: string;
  slug: string;
  sourceKind: 'upload' | 'git' | 'local';
  source: string | null;
  path: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
}

interface ProjectRow {
  id: number;
  name: string;
  slug: string;
  source_kind: Project['sourceKind'];
  source: string | null;
  path: string;
  description: string;
  created_at: string;
  updated_at: string;
  last_scan_at: string | null;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  sourceKind: r.source_kind,
  source: r.source,
  path: r.path,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastScanAt: r.last_scan_at,
});

export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode', 'vendor', '.turbo', 'out']);

export class PathEscapeError extends Error {
  constructor(p: string) {
    super(`Path is outside the project: ${p}`);
    this.name = 'PathEscapeError';
  }
}

export class ProjectService {
  readonly workspace: string;

  constructor(
    private db: Database,
    private config: AppConfig,
  ) {
    this.workspace = path.join(config.dataDir, 'workspace', 'projects');
    fs.mkdirSync(this.workspace, { recursive: true });
  }

  list(): Project[] {
    return this.db.all<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC').map(toProject);
  }

  get(id: number): Project | null {
    const r = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
    return r ? toProject(r) : null;
  }

  require(id: number): Project {
    const p = this.get(id);
    if (!p) throw new Error(`Project #${id} not found`);
    if (!fs.existsSync(p.path)) throw new Error(`Project #${id} files are missing at ${p.path}`);
    return p;
  }

  private uniqueSlug(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
    let slug = base;
    for (let i = 2; this.db.get('SELECT 1 FROM projects WHERE slug = ?', slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  private insert(name: string, kind: Project['sourceKind'], source: string | null, dir: string, description = ''): Project {
    const now = nowIso();
    const slug = path.basename(dir);
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO projects(name, slug, source_kind, source, path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      name.slice(0, 100),
      slug,
      kind,
      source,
      dir,
      description.slice(0, 1000),
      now,
      now,
    );
    return this.get(lastInsertRowid)!;
  }

  /** Registers an existing directory on the server. Must sit under an allowed root. */
  addLocal(name: string, dir: string, description = ''): Project {
    const real = fs.realpathSync(path.resolve(dir));
    const allowed = this.config.projectRoots.some((root) => {
      const r = fs.existsSync(root) ? fs.realpathSync(root) : root;
      return real === r || real.startsWith(r + path.sep);
    });
    if (!allowed) throw new Error(`Directory is not under an allowed project root (TC_PROJECT_ROOTS). Allowed: ${this.config.projectRoots.join(', ') || 'none configured'}`);
    if (!fs.statSync(real).isDirectory()) throw new Error('Not a directory');
    const now = nowIso();
    const slug = this.uniqueSlug(name);
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO projects(name, slug, source_kind, source, path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      name,
      slug,
      'local',
      real,
      real,
      description,
      now,
      now,
    );
    return this.get(lastInsertRowid)!;
  }

  /** Extracts an uploaded zip into the workspace. */
  addFromZip(name: string, zip: Uint8Array, description = ''): Project {
    if (zip.byteLength > 200 * 1024 * 1024) throw new Error('Archive too large (max 200 MB)');
    const entries = unzipSync(zip, {
      filter: (f) => !f.name.split('/').some((seg) => seg === 'node_modules' || seg === '.git') && f.originalSize < 20 * 1024 * 1024,
    });
    const names = Object.keys(entries);
    if (names.length === 0) throw new Error('The archive is empty');
    if (names.length > 50_000) throw new Error('Archive has too many files');
    let total = 0;
    for (const n of names) total += entries[n].byteLength;
    if (total > 1024 * 1024 * 1024) throw new Error('Archive expands beyond 1 GB');
    // Strip a single common top-level folder ("repo-main/...").
    const tops = new Set(names.map((n) => n.split('/')[0]));
    const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
    const dir = path.join(this.workspace, this.uniqueSlug(name));
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) {
      const rel = n.slice(strip.length);
      if (!rel || rel.endsWith('/')) continue;
      const target = path.resolve(dir, rel);
      if (!target.startsWith(dir + path.sep)) throw new Error(`Unsafe path in archive: ${n}`); // zip-slip
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entries[n]);
    }
    return this.insert(name, 'upload', `${names.length} files`, dir, description);
  }

  /** Clones a public https git repository (shallow, no credentials, no hooks). */
  async addFromGit(name: string, url: string, description = ''): Promise<Project> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('Invalid repository URL');
    }
    if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Only https URLs without embedded credentials are allowed');
    const dir = path.join(this.workspace, this.uniqueSlug(name));
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['clone', '--depth', '1', '--no-tags', '-c', 'core.hooksPath=/dev/null', '--', u.toString(), dir], {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', GIT_TERMINAL_PROMPT: '0', ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}) },
        timeout: 180_000,
      });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git clone failed (${code}): ${err.slice(-500)}`))));
    });
    return this.insert(name, 'git', u.toString(), dir, description);
  }

  delete(id: number, removeFiles: boolean) {
    const p = this.get(id);
    if (!p) return;
    if (removeFiles && p.sourceKind !== 'local' && p.path.startsWith(this.workspace + path.sep)) fs.rmSync(p.path, { recursive: true, force: true });
    this.db.run('DELETE FROM projects WHERE id = ?', id);
  }

  touchScan(id: number) {
    this.db.run('UPDATE projects SET last_scan_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
  }

  /** Resolves an agent-supplied relative path inside a project, refusing escapes (including via symlinks). */
  resolveInProject(project: Project, rel: string): string {
    const root = fs.realpathSync(project.path);
    const target = path.resolve(root, rel.replace(/^\/+/, ''));
    if (target !== root && !target.startsWith(root + path.sep)) throw new PathEscapeError(rel);
    if (fs.existsSync(target)) {
      const real = fs.realpathSync(target);
      if (real !== root && !real.startsWith(root + path.sep)) throw new PathEscapeError(rel);
    } else {
      // For new files, the nearest existing parent must be inside the root.
      let parent = path.dirname(target);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      const realParent = fs.realpathSync(parent);
      if (realParent !== root && !realParent.startsWith(root + path.sep)) throw new PathEscapeError(rel);
    }
    return target;
  }

  /** Walks the project, skipping ignored and hidden heavy directories. */
  walk(project: Project, opts: { maxFiles?: number } = {}): { rel: string; size: number }[] {
    const root = fs.realpathSync(project.path);
    const out: { rel: string; size: number }[] = [];
    const max = opts.maxFiles ?? 20_000;
    const stack = [''];
    while (stack.length && out.length < max) {
      const relDir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) stack.push(rel);
        } else if (e.isFile()) {
          try {
            out.push({ rel, size: fs.statSync(path.join(root, rel)).size });
          } catch {
            /* vanished */
          }
          if (out.length >= max) break;
        }
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }
}
