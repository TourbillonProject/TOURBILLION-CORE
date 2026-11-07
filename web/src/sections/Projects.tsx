import { useEffect, useState } from 'react';
import type { MemoryRecord, TaskRecord } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { navigate, toast, useStore } from '../lib/store';
import { ActionButton, Empty, Field, Panel, Seg, StatusBadge } from '../components/ui';
import { ago, bytes } from '../lib/format';

interface Project { id: number; name: string; sourceKind: string; source: string | null; path: string; description: string; createdAt: string; lastScanAt: string | null }
interface ProjectDetail extends Project { exists: boolean; checks: { id: string; label: string }[]; missions: TaskRecord[]; patches: { id: number; title: string; status: string }[]; memories: MemoryRecord[] }

export default function Projects() {
  const param = useStore((s) => s.sectionParam);
  const [projects, setProjects] = useState<Project[]>([]);
  const [mode, setMode] = useState<'upload' | 'git' | 'local'>('upload');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const load = () => api.get<Project[]>('/api/projects').then(setProjects);
  useEffect(() => {
    void load();
    api.get<{ roots: string[] }>('/api/projects/roots').then((r) => setRoots(r.roots));
  }, []);
  const selected = param ? Number(param) : null;

  const add = async () => {
    try {
      let p: Project;
      if (mode === 'upload') {
        if (!file) return;
        const fd = new FormData();
        fd.append('name', name || file.name.replace(/\.zip$/i, ''));
        fd.append('file', file);
        p = await api.post<Project>('/api/projects/upload', fd, { timeoutMs: 600_000 });
      } else if (mode === 'git') p = await api.post<Project>('/api/projects/git', { name: name || url.split('/').pop()?.replace(/\.git$/, '') || 'repository', url }, { timeoutMs: 300_000 });
      else p = await api.post<Project>('/api/projects/local', { name: name || path.split('/').pop() || 'project', path });
      toast('success', 'Project added', p.name);
      setName('');
      setUrl('');
      setPath('');
      setFile(null);
      await load();
      navigate('projects', String(p.id));
    } catch (err) {
      toast('error', 'Could not add project', errMsg(err));
    }
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 360px) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <Panel title="Projects" idx="PR">
          {projects.length === 0 && <Empty>No projects yet.</Empty>}
          <div className="list">
            {projects.map((p) => (
              <div key={p.id} className={`list-item clickable ${p.id === selected ? 'selected' : ''}`} onClick={() => navigate('projects', String(p.id))}>
                <div style={{ flex: 1, minWidth: 0 }}><div className="small ellipsis">{p.name}</div><div className="tiny muted">{p.sourceKind}{p.lastScanAt ? ` · inspected ${ago(p.lastScanAt)}` : ''}</div></div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Add project" idx="+">
          <div className="stack">
            <Seg value={mode} onChange={setMode} options={[{ value: 'upload', label: 'Upload .zip' }, { value: 'git', label: 'Git URL' }, { value: 'local', label: 'Server folder' }]} />
            <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" /></Field>
            {mode === 'upload' && <Field label="Archive"><input className="input" type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>}
            {mode === 'git' && <Field label="Repository (https)"><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" inputMode="url" /></Field>}
            {mode === 'local' && (
              <>
                <Field label="Folder on the server"><input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder={roots[0] ?? '/srv/projects/app'} /></Field>
                <div className="tiny muted">Allowed roots (TC_PROJECT_ROOTS): {roots.length ? roots.join(', ') : 'none configured'}</div>
              </>
            )}
            <ActionButton className="btn primary" onClick={add} disabled={mode === 'upload' ? !file : mode === 'git' ? !url : !path}>Add</ActionButton>
            {mode === 'upload' && <div className="tiny muted">On iPad: tap “Choose File” and pick a .zip from the Files app (GitHub’s “Download ZIP” works).</div>}
          </div>
        </Panel>
      </div>
      {selected ? <ProjectView key={selected} id={selected} onDeleted={() => { void load(); navigate('projects'); }} /> : <Panel><Empty>Select a project.</Empty></Panel>}
    </div>
  );
}

function ProjectView({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const [p, setP] = useState<ProjectDetail | null>(null);
  const [files, setFiles] = useState<{ rel: string; size: number }[]>([]);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null);
  useEffect(() => {
    api.get<ProjectDetail>(`/api/projects/${id}`).then(setP).catch((e) => toast('error', 'Project unavailable', errMsg(e)));
    api.get<{ rel: string; size: number }[]>(`/api/projects/${id}/files`).then(setFiles).catch(() => {});
  }, [id]);
  if (!p) return <Panel><Empty>Loading…</Empty></Panel>;
  const shown = files.filter((f) => !filter || f.rel.toLowerCase().includes(filter.toLowerCase())).slice(0, 400);
  return (
    <div className="stack">
      <Panel title={p.name} idx="PV" actions={
        <div className="row">
          <ActionButton className="btn sm primary" onClick={async () => {
            const t = await api.post<TaskRecord>('/api/missions', { playbook: 'spider.inspect', params: { projectId: id }, title: `Spider: inspect ${p.name}` });
            navigate('missions', String(t.id));
          }}>Inspect with the Spider</ActionButton>
          <button className="btn sm danger" onClick={async () => {
            if (!confirm(`Remove project “${p.name}”?${p.sourceKind !== 'local' ? ' Its workspace copy will be deleted.' : ' The server folder itself is left untouched.'}`)) return;
            await api.del(`/api/projects/${id}?removeFiles=true`);
            onDeleted();
          }}>Remove</button>
        </div>
      }>
        <div className="small stack">
          <div className="row tiny muted"><span>{p.sourceKind}</span>{p.source && <span className="mono ellipsis">{p.source}</span>}<span>{files.length} files</span>{!p.exists && <span style={{ color: 'var(--red)' }}>Files missing on server</span>}</div>
          <div className="row tiny">Detected checks: {p.checks.length ? p.checks.map((c) => <span key={c.id} className="badge">{c.label}</span>) : <span className="muted">none</span>}</div>
        </div>
      </Panel>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Panel title="Files" idx="FL">
          <input className="input" placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />
          <div className="list" style={{ maxHeight: 420, overflow: 'auto' }}>
            {shown.map((f) => (
              <div key={f.rel} className="list-item clickable" style={{ minHeight: 36, padding: '4px 8px' }} onClick={() => api.get<{ path: string; content: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(f.rel)}`).then(setOpen).catch((e) => toast('warning', 'Cannot open file', errMsg(e)))}>
                <span className="mono tiny ellipsis" style={{ flex: 1 }}>{f.rel}</span>
                <span className="tiny muted">{bytes(f.size)}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title={open ? open.path : 'Viewer'} idx="VW">
          {open ? <pre style={{ maxHeight: 520 }}>{open.content}</pre> : <Empty>Tap a file to view it (read-only).</Empty>}
        </Panel>
      </div>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Panel title="Missions" idx="MS">
          {p.missions.length === 0 && <Empty>No missions on this project.</Empty>}
          <div className="list">{p.missions.map((t) => <div key={t.id} className="list-item clickable" onClick={() => navigate('missions', String(t.id))}><span className="small ellipsis" style={{ flex: 1 }}>#{t.id} {t.title}</span><StatusBadge status={t.status} /></div>)}</div>
        </Panel>
        <Panel title="Project memory" idx="MM">
          {p.memories.length === 0 && <Empty>No project-specific memories.</Empty>}
          <div className="list">{p.memories.map((m) => <div key={m.id} className="list-item"><div><div className="small">{m.title}</div><div className="tiny muted">{m.content.slice(0, 160)}</div></div></div>)}</div>
        </Panel>
      </div>
    </div>
  );
}
