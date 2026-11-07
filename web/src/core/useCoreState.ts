import { useEffect, useState } from 'react';
import type { CoreState } from '@tc/shared';
import { useStore } from '../lib/store';

/**
 * Derives the core's visual state from *real* system signals: local voice
 * state, live chat streams, recent agent activity events, running missions
 * and mission completions (a short "success" state).
 */
export function useCoreState(): CoreState {
  const voice = useStore((s) => s.voice);
  const activity = useStore((s) => s.activity);
  const chat = useStore((s) => s.chat);
  const tasks = useStore((s) => s.tasks);
  const ws = useStore((s) => s.ws);
  const successAt = useStore((s) => s.successAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 700);
    return () => clearInterval(t);
  }, []);

  if (voice.listening) return 'listening';
  if (voice.speaking) return 'speaking';
  const recent = (ms: number, kinds: string[]) => activity.some((a) => now - a.at < ms && kinds.includes(a.kind));
  const lastError = [...activity].reverse().find((a) => a.kind === 'error');
  if ((lastError && now - lastError.at < 5000) || ws === 'offline') return 'error';
  // A mission just completed: brief emerald expansion, then back to normal.
  if (Date.now() - successAt < 2600) return 'success';
  const streaming = Object.values(chat).some((c) => !c.done);
  const latest = [...activity].reverse().find((a) => now - a.at < 4000);
  if (latest?.kind === 'research') return 'researching';
  if (streaming && recent(3000, ['thinking', 'responding'])) return 'thinking';
  if (recent(3500, ['tool', 'executing'])) return 'executing';
  if (recent(4000, ['research'])) return 'researching';
  if (streaming || recent(2500, ['thinking', 'responding'])) return 'thinking';
  if (Object.values(tasks).some((t) => t.status === 'running' || t.status === 'planning')) return 'executing';
  return 'idle';
}
