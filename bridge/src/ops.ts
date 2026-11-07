import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { BridgeOp } from '@tc/shared';
import type { BridgeConfig } from './config.js';

/**
 * Bridge operations. Fixed set; every path is confined to configured folders
 * (realpath-checked, so symlinks cannot escape); external programs are run
 * with an argument array, never through a shell.
 */

export class BridgeError extends Error {}

const JSON_MARK = '@@TC_JSON@@';

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Resolves "rel/path" inside the first matching root (or "N:rel" for root N). */
export function resolveIn(roots: string[], rel: string, mustExist = false): string {
  if (!roots.length) throw new BridgeError('No folders are allowed in the bridge config (roots).');
  let idx = 0;
  let p = rel;
  const m = rel.match(/^(\d+):(.*)$/);
  if (m) {
    idx = Number(m[1]);
    p = m[2];
  }
  const root = roots[idx];
  if (!root) throw new BridgeError(`No root #${idx}`);
  if (!fs.existsSync(root)) throw new BridgeError(`Allowed folder does not exist: ${root}`);
  const realRoot = fs.realpathSync(root);
  const target = path.isAbsolute(p) ? path.resolve(p) : path.resolve(realRoot, p);
  if (!within(realRoot, target)) throw new BridgeError(`Path is outside the allowed folders: ${rel}`);
  if (fs.existsSync(target)) {
    if (!within(realRoot, fs.realpathSync(target))) throw new BridgeError(`Path escapes the allowed folder via a link: ${rel}`);
  } else {
    if (mustExist) throw new BridgeError(`Not found: ${rel}`);
    let parent = path.dirname(target);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (!within(realRoot, fs.realpathSync(parent))) throw new BridgeError(`Path escapes the allowed folder: ${rel}`);
  }
  return target;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutSec: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutSec * 1000);
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-400_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-200_000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Blender (always background mode: -b)
// ---------------------------------------------------------------------------

export async function blenderVersion(cfg: BridgeConfig): Promise<string | null> {
  const r = await run(cfg.blender.path, ['--version'], { timeoutSec: 30 });
  const m = r.stdout.match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/);
  return r.exitCode === 0 && m ? m[1] : null;
}

async function runBlenderScript(cfg: BridgeConfig, script: string, blendFile: string | null): Promise<RunResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-blender-'));
  const file = path.join(tmp, 'script.py');
  fs.writeFileSync(file, script);
  try {
    const args = ['-b', ...(blendFile ? [blendFile] : []), '--python', file, '--python-exit-code', '1'];
    return await run(cfg.blender.path, args, { timeoutSec: cfg.blender.timeoutSec });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function parseMarked(stdout: string): unknown {
  const line = stdout.split('\n').find((l) => l.startsWith(JSON_MARK));
  if (!line) return null;
  return JSON.parse(line.slice(JSON_MARK.length));
}

const SCENE_INFO_PY = `
import bpy, json
s = bpy.context.scene
def v(x): return [round(c, 4) for c in x]
objs = []
for o in s.objects:
    objs.append({
        "name": o.name, "type": o.type, "location": v(o.location), "rotation": v(o.rotation_euler), "scale": v(o.scale),
        "dimensions": v(o.dimensions), "parent": o.parent.name if o.parent else None,
        "materials": [m.name for m in getattr(o.data, "materials", []) if m] if o.data is not None and hasattr(o.data, "materials") else [],
        "modifiers": [m.type for m in o.modifiers], "visible": not o.hide_render,
    })
info = {
    "file": bpy.data.filepath, "blender": bpy.app.version_string, "scene": s.name,
    "frameRange": [s.frame_start, s.frame_end], "fps": s.render.fps, "engine": s.render.engine,
    "resolution": [s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage],
    "camera": s.camera.name if s.camera else None, "objects": objs,
    "materials": [m.name for m in bpy.data.materials], "collections": [c.name for c in bpy.data.collections],
}
print("${JSON_MARK}" + json.dumps(info))
`;

export async function blenderSceneInfo(cfg: BridgeConfig, blendRel: string) {
  const blend = resolveIn(cfg.roots, blendRel, true);
  const r = await runBlenderScript(cfg, SCENE_INFO_PY, blend);
  const data = parseMarked(r.stdout);
  if (r.exitCode !== 0 || !data) throw new BridgeError(`Blender failed (exit ${r.exitCode}): ${r.stderr.slice(-800) || r.stdout.slice(-800)}`);
  return data;
}

export async function blenderRunScript(cfg: BridgeConfig, p: { script: string; blendFile?: string; saveAs?: string }) {
  if (!cfg.blender.allowScripts) throw new BridgeError('Running Blender scripts is disabled in this bridge’s config (blender.allowScripts = false).');
  const blend = p.blendFile ? resolveIn(cfg.roots, p.blendFile, true) : null;
  const saveAs = p.saveAs ? resolveIn(cfg.roots, p.saveAs) : null;
  if (saveAs && !saveAs.endsWith('.blend')) throw new BridgeError('saveAs must be a .blend file');
  const wrapper = `
import bpy, sys, traceback
__tc_src = ${JSON.stringify(p.script)}
try:
    exec(compile(__tc_src, "tourbillion_script.py", "exec"), {"__name__": "__main__", "bpy": bpy})
except Exception:
    traceback.print_exc()
    sys.exit(1)
${saveAs ? `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(saveAs)})\nprint("Saved", ${JSON.stringify(saveAs)})` : ''}
`;
  const r = await runBlenderScript(cfg, wrapper, blend);
  return { exitCode: r.exitCode, stdout: r.stdout.slice(-60_000), stderr: r.stderr.slice(-30_000), timedOut: r.timedOut, saved: saveAs };
}

export async function blenderRender(cfg: BridgeConfig, p: { blendFile: string; frame?: number; output?: string; resolutionPercent?: number; engine?: string }) {
  const blend = resolveIn(cfg.roots, p.blendFile, true);
  const out = p.output ? resolveIn(cfg.roots, p.output) : blend.replace(/\.blend$/i, '') + `_render_${p.frame ?? 'current'}.png`;
  const script = `
import bpy, json
s = bpy.context.scene
${p.frame !== undefined ? `s.frame_set(${Number(p.frame)})` : ''}
s.render.resolution_percentage = ${Math.max(10, Math.min(100, p.resolutionPercent ?? 50))}
${p.engine ? `s.render.engine = ${JSON.stringify(p.engine)}` : ''}
if s.render.engine == "CYCLES":
    s.cycles.samples = min(s.cycles.samples, 32)
    s.cycles.device = "CPU"
s.render.image_settings.file_format = "PNG"
s.render.filepath = ${JSON.stringify(out)}
bpy.ops.render.render(write_still=True)
w = int(s.render.resolution_x * s.render.resolution_percentage / 100)
h = int(s.render.resolution_y * s.render.resolution_percentage / 100)
print("${JSON_MARK}" + json.dumps({"output": s.render.filepath, "width": w, "height": h, "engine": s.render.engine}))
`;
  const r = await runBlenderScript(cfg, script, blend);
  const data = parseMarked(r.stdout) as { output: string; width: number; height: number; engine: string } | null;
  if (r.exitCode !== 0 || !data || !fs.existsSync(out)) throw new BridgeError(`Render failed (exit ${r.exitCode}): ${r.stderr.slice(-1000) || r.stdout.slice(-1000)}`);
  const bytes = fs.statSync(out).size;
  return { ...data, output: out, bytes, previewBase64: bytes < 4_000_000 ? fs.readFileSync(out).toString('base64') : undefined };
}

// ---------------------------------------------------------------------------
// Roblox (Rojo project files + named tasks)
// ---------------------------------------------------------------------------

function robloxRoot(cfg: BridgeConfig): string {
  if (!cfg.roblox.projectDir) throw new BridgeError('No Roblox project configured (roblox.projectDir).');
  return cfg.roblox.projectDir;
}

export function robloxList(cfg: BridgeConfig, under = '') {
  const root = fs.realpathSync(robloxRoot(cfg));
  const start = resolveIn([root], under || '.', true);
  const out: { path: string; bytes: number }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.tourbillion-backups'].includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push({ path: path.relative(root, abs).split(path.sep).join('/'), bytes: fs.statSync(abs).size });
      if (out.length > 5000) return;
    }
  };
  walk(start);
  return { root, files: out };
}

export function robloxRead(cfg: BridgeConfig, rel: string) {
  const file = resolveIn([robloxRoot(cfg)], rel, true);
  const st = fs.statSync(file);
  if (st.size > 2_000_000) throw new BridgeError('File too large');
  return { path: rel, content: fs.readFileSync(file, 'utf8') };
}

export function robloxWrite(cfg: BridgeConfig, rel: string, content: string) {
  const root = robloxRoot(cfg);
  const file = resolveIn([root], rel);
  if (!/\.(lua|luau|json|toml|md|txt)$/i.test(file)) throw new BridgeError('Only .lua, .luau, .json, .toml, .md and .txt files can be written');
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    const dir = path.join(root, '.tourbillion-backups');
    fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, `${rel.replace(/[\\/]/g, '__')}.${Date.now()}.bak`);
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { bytes: Buffer.byteLength(content), backup: backup ? path.relative(root, backup) : null };
}

export async function robloxRunTask(cfg: BridgeConfig, task: string) {
  const argv = cfg.roblox.tasks[task];
  if (!argv?.length) throw new BridgeError(`Unknown task "${task}". Defined tasks: ${Object.keys(cfg.roblox.tasks).join(', ') || 'none'}`);
  const r = await run(argv[0], argv.slice(1), { cwd: robloxRoot(cfg), timeoutSec: cfg.roblox.timeoutSec });
  return { command: argv.join(' '), exitCode: r.exitCode, stdout: r.stdout.slice(-60_000), stderr: r.stderr.slice(-30_000), timedOut: r.timedOut };
}

// ---------------------------------------------------------------------------
// Generic files inside roots
// ---------------------------------------------------------------------------

export function fsList(cfg: BridgeConfig, rel = '.') {
  const dir = resolveIn(cfg.roots, rel, true);
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
}

export function fsRead(cfg: BridgeConfig, rel: string) {
  const f = resolveIn(cfg.roots, rel, true);
  if (fs.statSync(f).size > 2_000_000) throw new BridgeError('File too large');
  return { content: fs.readFileSync(f, 'utf8') };
}

export function fsWrite(cfg: BridgeConfig, rel: string, content: string) {
  const f = resolveIn(cfg.roots, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return { bytes: Buffer.byteLength(content) };
}

export async function dispatch(cfg: BridgeConfig, op: BridgeOp, p: Record<string, unknown>): Promise<unknown> {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  switch (op) {
    case 'fs.list':
      return fsList(cfg, s('path') ?? '.');
    case 'fs.read':
      return fsRead(cfg, s('path') ?? '');
    case 'fs.write':
      return fsWrite(cfg, s('path') ?? '', s('content') ?? '');
    case 'blender.version':
      return { version: await blenderVersion(cfg) };
    case 'blender.scene_info':
      return blenderSceneInfo(cfg, s('blendFile') ?? '');
    case 'blender.run_script':
      return blenderRunScript(cfg, { script: s('script') ?? '', blendFile: s('blendFile'), saveAs: s('saveAs') });
    case 'blender.render':
      return blenderRender(cfg, { blendFile: s('blendFile') ?? '', frame: typeof p.frame === 'number' ? p.frame : undefined, output: s('output'), resolutionPercent: typeof p.resolutionPercent === 'number' ? p.resolutionPercent : undefined, engine: s('engine') });
    case 'roblox.list':
      return robloxList(cfg, s('under') ?? '');
    case 'roblox.read':
      return robloxRead(cfg, s('path') ?? '');
    case 'roblox.write':
      return robloxWrite(cfg, s('path') ?? '', s('content') ?? '');
    case 'roblox.run_task':
      return robloxRunTask(cfg, s('task') ?? '');
    default:
      throw new BridgeError(`Unsupported operation ${op}`);
  }
}
