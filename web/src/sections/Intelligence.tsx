import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRecord } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { navigate, setState, toast, useStore } from '../lib/store';
import { Markdown } from '../components/Markdown';
import { ApprovalCard } from '../components/Approvals';
import { ActionButton, Empty, Panel } from '../components/ui';
import { Icon } from '../components/icons';
import { ago, clock } from '../lib/format';
import { voice, voiceSupport } from '../voice/voice';
import { sound } from '../audio/sound';

interface Conv {
  id: number;
  title: string;
  projectId: number | null;
  updatedAt: string;
  busy: boolean;
}
interface Msg {
  id: number;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  thinking: string | null;
  tools: { name: string; input: unknown }[];
  turnId: string | null;
  createdAt: string;
}

export default function Intelligence() {
  const param = useStore((s) => s.sectionParam);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([]);
  const activeId = param ? Number(param) : null;

  const loadList = useCallback(() => api.get<Conv[]>('/api/conversations').then(setConvs).catch(() => {}), []);
  useEffect(() => {
    void loadList();
    api.get<{ id: number; name: string }[]>('/api/projects').then(setProjects).catch(() => {});
    const onDone = () => void loadList();
    window.addEventListener('tc:chat-done', onDone);
    return () => window.removeEventListener('tc:chat-done', onDone);
  }, [loadList]);

  useEffect(() => {
    if (!activeId && convs.length) navigate('intelligence', String(convs[0].id));
  }, [activeId, convs]);

  const create = async () => {
    const c = await api.post<Conv>('/api/conversations', {});
    await loadList();
    navigate('intelligence', String(c.id));
  };

  return (
    <div className="chat">
      <Panel title="Conversations" idx="IN" className="chat-list" actions={<button className="btn sm primary" onClick={() => void create()}><Icon name="plus" size={16} /> New</button>}>
        {convs.length === 0 && <Empty>No conversations yet.</Empty>}
        <div className="list">
          {convs.map((c) => (
            <div key={c.id} className={`list-item clickable ${c.id === activeId ? 'selected' : ''}`} onClick={() => navigate('intelligence', String(c.id))}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small ellipsis">{c.title}</div>
                <div className="tiny muted">{ago(c.updatedAt)}</div>
              </div>
              {c.busy && <span className="dot live pulse" />}
            </div>
          ))}
        </div>
      </Panel>
      {activeId ? <ChatView key={activeId} id={activeId} projects={projects} onChanged={loadList} /> : <Panel><Empty>Start a conversation with Core Intelligence.</Empty></Panel>}
    </div>
  );
}

function ChatView({ id, projects, onChanged }: { id: number; projects: { id: number; name: string }[]; onChanged: () => void }) {
  const [conv, setConv] = useState<(Conv & { messages: Msg[]; approvals: ApprovalRecord[] }) | null>(null);
  const [text, setText] = useState('');
  const stream = useStore((s) => s.chat[id]);
  const pendingApprovals = useStore((s) => s.approvals.filter((a) => a.conversationId === id));
  const aiState = useStore((s) => s.integrations.find((i) => i.id === 'claude')?.state);
  const listening = useStore((s) => s.voice.listening);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(() => api.get<Conv & { messages: Msg[]; approvals: ApprovalRecord[] }>(`/api/conversations/${id}`).then(setConv).catch((e) => toast('error', 'Could not load conversation', errMsg(e))), [id]);
  useEffect(() => {
    void load();
    const onDone = (e: Event) => {
      if ((e as CustomEvent).detail.conversationId === id) void load();
    };
    window.addEventListener('tc:chat-done', onDone);
    return () => window.removeEventListener('tc:chat-done', onDone);
  }, [id, load]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [conv?.messages.length, stream?.text.length]);

  const send = async (value: string) => {
    if (!value.trim()) return;
    setText('');
    try {
      const { turnId } = await api.post<{ turnId: string }>(`/api/conversations/${id}/messages`, { text: value });
      setState((s) => ({ chat: { ...s.chat, [id]: { turnId, text: '', thinking: '', tools: [], done: false } } }));
      sound.play('thinking');
      await load();
      onChanged();
    } catch (err) {
      sound.play('error');
      toast('error', 'Message not sent', errMsg(err));
      setText(value);
    }
  };

  const busy = conv?.busy || (stream && !stream.done);
  const streamingTurn = stream && !stream.done ? stream.turnId : null;
  return (
    <div className="chat-main panel flat" style={{ padding: 12 }}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <div className="row nowrap" style={{ minWidth: 0 }}>
          <b className="display ellipsis">{conv?.title ?? '…'}</b>
        </div>
        <div className="row">
          <select
            className="select"
            style={{ width: 'auto', minHeight: 36 }}
            value={conv?.projectId ?? ''}
            onChange={async (e) => {
              await api.patch(`/api/conversations/${id}`, { projectId: e.target.value ? Number(e.target.value) : null });
              void load();
            }}
            aria-label="Project in focus"
          >
            <option value="">No project focus</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>Focus: {p.name}</option>
            ))}
          </select>
          <ActionButton className="btn sm" onClick={async () => {
            try {
              const m = await api.post<{ id: number }>(`/api/conversations/${id}/summarize`, {});
              toast('success', 'Saved to memory', `Memory #${m.id}`);
            } catch (err) {
              toast('error', 'Summary failed', errMsg(err));
            }
          }}>Save to memory</ActionButton>
          <button className="btn sm danger" onClick={async () => {
            if (!confirm('Delete this conversation permanently?')) return;
            await api.del(`/api/conversations/${id}`);
            onChanged();
            navigate('intelligence');
          }}><Icon name="trash" size={16} /></button>
        </div>
      </div>
      <div className="msgs" data-testid="messages">
        {conv?.messages.length === 0 && !stream && <Empty>{aiState === 'not_configured' ? 'Claude is not connected — add an API key in Connected Apps to talk to Core Intelligence.' : 'Ask anything. Core Intelligence can delegate to the specialist agents.'}</Empty>}
        {conv?.messages.map((m) =>
          m.turnId === streamingTurn && m.role === 'assistant' ? null : (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role !== 'notice' && <div className="meta">{m.role === 'user' ? 'YOU' : 'CORE'} · {clock(m.createdAt)}</div>}
              {m.thinking && (
                <details className="thinking">
                  <summary>▸ Reasoning summary</summary>
                  <div className="pre small">{m.thinking}</div>
                </details>
              )}
              {m.tools.length > 0 && <div>{m.tools.map((t, i) => <span key={i} className="toolchip">⚙ {t.name}</span>)}</div>}
              {m.role === 'assistant' ? <Markdown text={m.text} /> : <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>}
            </div>
          ),
        )}
        {stream && !stream.done && (
          <div className="msg assistant" data-testid="streaming">
            <div className="meta">CORE · LIVE</div>
            {stream.thinking && (
              <details className="thinking" open={!stream.text}>
                <summary>▸ Reasoning…</summary>
                <div className="pre small">{stream.thinking.slice(-1500)}</div>
              </details>
            )}
            {stream.tools.map((t, i) => (
              <span key={i} className="toolchip">{t.status === 'awaiting_approval' ? '⏸' : t.status === 'error' || t.status === 'denied' ? '✕' : '⚙'} {t.summary ?? t.tool}</span>
            ))}
            {stream.text ? <Markdown text={stream.text} /> : <div className="small muted">Working…</div>}
          </div>
        )}
        {pendingApprovals.map((a) => (
          <ApprovalCard key={a.id} a={a} />
        ))}
        <div ref={bottom} />
      </div>
      <form className="cmdbar" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        {voiceSupport.recognition && (
          <button type="button" className={`mic ${listening ? 'on' : ''}`} aria-label="Dictate" onClick={() => {
            if (listening) return voice.stopListening();
            sound.play('listen');
            setState((s) => ({ voice: { ...s.voice, listening: true } }));
            voice.listen({
              onInterim: (t) => setText(t),
              onFinal: (t) => setText(t),
              onEnd: () => setState((s) => ({ voice: { ...s.voice, listening: false } })),
              onError: (m) => toast('warning', 'Voice', m),
            });
          }}>
            <Icon name={listening ? 'stop' : 'mic'} />
          </button>
        )}
        <textarea className="input" style={{ minHeight: 48, maxHeight: 160, resize: 'none' }} rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message Core Intelligence…" onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send(text);
          }
        }} data-testid="chat-input" />
        {busy ? (
          <button type="button" className="btn danger icon" aria-label="Cancel response" onClick={() => api.post(`/api/conversations/${id}/cancel`, {})}><Icon name="stop" /></button>
        ) : (
          <button type="submit" className="btn primary icon" aria-label="Send" disabled={!text.trim()}><Icon name="send" /></button>
        )}
      </form>
    </div>
  );
}
