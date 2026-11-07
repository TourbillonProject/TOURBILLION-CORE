import { useEffect, useState } from 'react';
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, type MemoryCategory, type MemoryRecord } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { toast } from '../lib/store';
import { ActionButton, Empty, Field, Panel } from '../components/ui';
import { dateTime } from '../lib/format';

export default function Memory() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<MemoryCategory | ''>('');
  const [items, setItems] = useState<(MemoryRecord & { score?: number })[]>([]);
  const [stats, setStats] = useState<{ total: number; byCategory: Record<string, number> } | null>(null);
  const [edit, setEdit] = useState<Partial<MemoryRecord> | null>(null);

  const load = async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (cat) params.set('category', cat);
    setItems(await api.get(`/api/memory?${params}`));
    setStats(await api.get('/api/memory/stats'));
  };
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, cat]);

  const save = async () => {
    if (!edit) return;
    try {
      const body = { category: edit.category ?? 'preference', title: edit.title ?? '', content: edit.content ?? '', tags: edit.tags ?? [] };
      if (edit.id) await api.patch(`/api/memory/${edit.id}`, body);
      else await api.post('/api/memory', body);
      setEdit(null);
      void load();
      toast('success', 'Memory saved');
    } catch (err) {
      toast('error', 'Memory not saved', errMsg(err));
    }
  };

  return (
    <div className="stack">
      <div>
        <h2 className="section-title">Memory</h2>
        <p className="section-sub">Long-term memory that Core Intelligence searches before answering. You control it completely: search, edit, delete. Credentials are refused automatically.</p>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 340px)', alignItems: 'start' }}>
        <Panel title={`Memories${stats ? ` · ${stats.total}` : ''}`} idx="MM" actions={<button className="btn sm primary" onClick={() => setEdit({ category: 'preference', title: '', content: '' })}>Add</button>}>
          <div className="row nowrap" style={{ marginBottom: 8 }}>
            <input className="input" placeholder="Search memory…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="memory-search" />
            <select className="select" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value as MemoryCategory | '')}>
              <option value="">All categories</option>
              {MEMORY_CATEGORIES.map((c) => <option key={c} value={c}>{MEMORY_CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
          {items.length === 0 && <Empty>{q ? 'Nothing matches.' : 'No memories yet.'}</Empty>}
          <div className="list">
            {items.map((m) => (
              <div key={m.id} className="list-item" style={{ alignItems: 'flex-start' }} data-testid="memory-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row nowrap"><span className="badge">{m.category}</span><b className="small ellipsis">{m.title}</b></div>
                  <div className="small" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{m.content}</div>
                  <div className="tiny muted">#{m.id} · {m.source} · updated {dateTime(m.updatedAt)}{m.projectId ? ` · project ${m.projectId}` : ''}{m.tags.length ? ` · ${m.tags.join(', ')}` : ''}</div>
                </div>
                <div className="row">
                  <button className="btn sm" onClick={() => setEdit(m)}>Edit</button>
                  <ActionButton className="btn sm danger" onClick={async () => { await api.del(`/api/memory/${m.id}`); void load(); }}>Delete</ActionButton>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <div className="stack">
          {edit && (
            <Panel title={edit.id ? `Edit #${edit.id}` : 'New memory'} idx="ED">
              <div className="stack">
                <Field label="Category"><select className="select" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value as MemoryCategory })}>{MEMORY_CATEGORIES.map((c) => <option key={c} value={c}>{MEMORY_CATEGORY_LABELS[c]}</option>)}</select></Field>
                <Field label="Title"><input className="input" value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
                <Field label="Content"><textarea className="textarea" value={edit.content ?? ''} onChange={(e) => setEdit({ ...edit, content: e.target.value })} /></Field>
                <Field label="Tags (comma separated)"><input className="input" value={(edit.tags ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} /></Field>
                <div className="row"><ActionButton className="btn primary" onClick={save} disabled={!edit.title || !edit.content}>Save</ActionButton><button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button></div>
              </div>
            </Panel>
          )}
          <Panel title="By category" idx="ST">
            {MEMORY_CATEGORIES.map((c) => (
              <div key={c} className="row between small" style={{ padding: '4px 0' }}><span>{MEMORY_CATEGORY_LABELS[c]}</span><span className="mono">{stats?.byCategory[c] ?? 0}</span></div>
            ))}
            <hr className="sep" />
            <ActionButton className="btn sm danger" onClick={async () => {
              const label = cat ? MEMORY_CATEGORY_LABELS[cat] : 'ALL categories';
              if (!confirm(`Delete every memory in ${label}? This cannot be undone.`)) return;
              await api.del(`/api/memory?confirm=yes${cat ? `&category=${cat}` : ''}`);
              void load();
            }}>Delete {cat ? 'this category' : 'all memories'}</ActionButton>
          </Panel>
        </div>
      </div>
    </div>
  );
}
