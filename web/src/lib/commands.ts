import type { TaskRecord } from '@tc/shared';
import { api, errMsg } from './api';
import { parseIntent } from './intents';
import { getState, navigate, sendBrowserCommand, setState, toast } from './store';
import { sound } from '../audio/sound';
import { speakable, voice } from '../voice/voice';

/**
 * Executes a command typed or spoken in the Command Center. Deterministic
 * intents act immediately; everything else goes to Core Intelligence.
 * Responses are spoken when voice was used (or always, if enabled).
 */

const CMD_KEY = 'tc.commandConversation';

export function say(text: string, from: 'core' | 'system', spoken: boolean, conversationId: number | null = null) {
  setState({ reply: { text, from, at: Date.now(), conversationId, pending: false } });
  const st = getState().settings;
  if (spoken && st?.speakResponses !== false) {
    voice.speak(speakable(text), {
      voiceName: st?.voiceName ?? null,
      rate: st?.voiceRate ?? 0.98,
      pitch: st?.voicePitch ?? 0.9,
      onStart: () => setState((s) => ({ voice: { ...s.voice, speaking: true } })),
      onEnd: () => setState((s) => ({ voice: { ...s.voice, speaking: false, level: 0 } })),
      onBoundary: () => {
        setState((s) => ({ voice: { ...s.voice, level: 0.7 } }));
        setTimeout(() => setState((s) => ({ voice: { ...s.voice, level: 0.15 } })), 120);
      },
    });
  }
}

async function commandConversation(): Promise<number> {
  const cached = getState().commandConversationId ?? Number(localStorageGet(CMD_KEY) ?? 0);
  if (cached) {
    try {
      await api.get(`/api/conversations/${cached}`);
      setState({ commandConversationId: cached });
      return cached;
    } catch {
      /* deleted — create a new one */
    }
  }
  const c = await api.post<{ id: number }>('/api/conversations', { title: 'Command Center' });
  localStorageSet(CMD_KEY, String(c.id));
  setState({ commandConversationId: c.id });
  return c.id;
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

export async function runCommand(raw: string, opts: { spoken: boolean }) {
  const text = raw.trim();
  if (!text) return;
  const wake = getState().settings?.wakePhrase ?? 'Tourbillion';
  const intent = parseIntent(text, wake);
  const speak = opts.spoken;
  try {
    switch (intent.kind) {
      case 'stop':
        voice.cancelSpeech();
        setState((s) => ({ voice: { ...s.voice, speaking: false } }));
        return;
      case 'mute': {
        const s = await api.patch<Record<string, unknown>>('/api/settings', { soundEnabled: !intent.on });
        setState({ settings: s as never });
        say(intent.on ? 'Sound effects muted.' : 'Sound effects restored.', 'system', speak);
        return;
      }
      case 'navigate':
        navigate(intent.section);
        return;
      case 'youtube':
        sendBrowserCommand({ kind: 'open_youtube', query: intent.query ?? undefined });
        say(intent.query ? `Searching YouTube for ${intent.query}.` : 'Opening YouTube.', 'system', speak);
        return;
      case 'open_url':
        sendBrowserCommand({ kind: 'open_url', url: intent.url, mode: 'auto' });
        say(`Opening ${new URL(intent.url).hostname}.`, 'system', speak);
        return;
      case 'diagnostics': {
        const t = await api.post<TaskRecord>('/api/missions', { playbook: 'system.diagnostics', params: {}, title: 'System diagnostics' });
        say(`Diagnostics initiated — mission ${t.id}. The System Operator is testing every subsystem now.`, 'system', speak);
        return;
      }
      case 'spider_inspect': {
        const projects = await api.get<{ id: number; name: string }[]>('/api/projects');
        if (!projects.length) {
          say('There are no projects yet. Add one in Projects — upload a zip, clone a repository, or register a server folder — and I will send the Spider in.', 'system', speak);
          navigate('projects');
          return;
        }
        const q = intent.project?.toLowerCase();
        const match = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : [];
        if (match.length !== 1) {
          say(`Which project should the Spider inspect? ${q && !match.length ? `I could not find “${intent.project}”. ` : ''}Available: ${projects.map((p) => p.name).join(', ')}.`, 'system', speak);
          navigate('spider');
          return;
        }
        const t = await api.post<TaskRecord>('/api/missions', { playbook: 'spider.inspect', params: { projectId: match[0].id, runChecks: false }, title: `Spider: inspect ${match[0].name}` });
        say(`The Spider is on it — mission ${t.id}, inspecting ${match[0].name}. Running the project’s tests will need your approval.`, 'system', speak);
        return;
      }
      case 'research':
        navigate('research', intent.target ?? undefined);
        say(intent.target ? `Opening Research with ${intent.target} as the target. Confirm the purpose and scope to begin.` : 'Which company or domain should I research? Research needs a target and a stated purpose before it begins.', 'system', speak);
        return;
      case 'ask': {
        if (getState().integrations.find((i) => i.id === 'claude')?.state === 'not_configured') {
          say('Claude is not connected yet, so I cannot reason about that. Add an Anthropic API key in Connected Apps. Direct commands — open YouTube, run diagnostics, inspect a project — still work.', 'system', speak);
          return;
        }
        const cid = await commandConversation();
        setState({ reply: { text: '', from: 'core', at: Date.now(), conversationId: cid, pending: true } });
        sound.play('thinking');
        const { turnId } = await api.post<{ turnId: string }>(`/api/conversations/${cid}/messages`, { text: intent.text });
        const done = await waitForTurn(cid, turnId);
        const conv = await api.get<{ messages: { role: string; text: string; turnId: string | null }[] }>(`/api/conversations/${cid}`);
        const last = [...conv.messages].reverse().find((m) => m.turnId === turnId && (m.role === 'assistant' || m.role === 'notice') && m.text.trim());
        const reply = last?.text ?? (done.status === 'awaiting_approval' ? 'That needs your approval first — see the approval card.' : done.error ?? 'No response.');
        say(reply, 'core', speak, cid);
        return;
      }
    }
  } catch (err) {
    sound.play('error');
    say(errMsg(err), 'system', false);
    toast('error', 'Command failed', errMsg(err));
  }
}

function waitForTurn(conversationId: number, turnId: string): Promise<{ status: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: { status: string; error?: string }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('tc:chat-done', onDone);
      clearInterval(poll);
      resolve(v);
    };
    const onDone = (e: Event) => {
      const d = (e as CustomEvent).detail as { conversationId: number; turnId: string; status: string; error?: string };
      if (d.conversationId === conversationId && d.turnId === turnId) finish(d);
    };
    window.addEventListener('tc:chat-done', onDone);
    // Safety net if the socket dropped mid-turn: poll the conversation.
    const poll = setInterval(async () => {
      try {
        const c = await api.get<{ busy: boolean }>(`/api/conversations/${conversationId}`);
        if (!c.busy) finish({ status: 'completed' });
      } catch {
        /* keep waiting */
      }
    }, 8000);
  });
}
