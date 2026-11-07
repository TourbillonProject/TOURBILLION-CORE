import type { SectionId } from '@tc/shared';

/**
 * Local command understanding for instant, deterministic actions (works even
 * without Claude). Anything not matched here goes to Core Intelligence.
 */

export type Intent =
  | { kind: 'navigate'; section: SectionId }
  | { kind: 'youtube'; query: string | null }
  | { kind: 'open_url'; url: string }
  | { kind: 'diagnostics' }
  | { kind: 'stop' }
  | { kind: 'mute'; on: boolean }
  | { kind: 'spider_inspect'; project: string | null }
  | { kind: 'research'; target: string | null }
  | { kind: 'ask'; text: string };

const WAKE_VARIANTS = ['tourbillion', 'tourbillon', 'tour billion', 'tour billon', 'two billion', 'tour bill yon', 'core'];

export function stripWake(text: string, wake: string): { text: string; woke: boolean } {
  const variants = [wake.toLowerCase(), ...WAKE_VARIANTS];
  const t = text.trim();
  for (const v of variants) {
    const re = new RegExp(`^(?:hey|ok|okay)?\\s*${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s,.!:;-]*`, 'i');
    if (re.test(t)) return { text: t.replace(re, '').trim(), woke: true };
  }
  return { text: t, woke: false };
}

const SECTION_WORDS: [RegExp, SectionId][] = [
  [/command( cent(er|re))?|dashboard|home/, 'command'],
  [/intelligence|chat|conversations?/, 'intelligence'],
  [/agents?/, 'agents'],
  [/(the )?spider/, 'spider'],
  [/browser|web/, 'browser'],
  [/research|osint|intel(ligence)? department/, 'research'],
  [/projects?/, 'projects'],
  [/missions?|tasks?/, 'missions'],
  [/automations?|schedules?/, 'automations'],
  [/(connected )?apps|integrations|connections/, 'apps'],
  [/memory|memories/, 'memory'],
  [/settings|preferences/, 'settings'],
];

export function parseIntent(raw: string, wake = 'Tourbillion'): Intent {
  const { text } = stripWake(raw, wake);
  const t = text.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (!t) return { kind: 'ask', text: raw.trim() };

  if (/^(stop|cancel|be quiet|quiet|silence|that'?s enough)$/.test(t)) return { kind: 'stop' };
  if (/^(mute|disable) (the )?sounds?$/.test(t)) return { kind: 'mute', on: true };
  if (/^(unmute|enable) (the )?sounds?$/.test(t)) return { kind: 'mute', on: false };
  if (/\b(initiate|run|start|perform)\b.*\bdiagnostics?\b|^diagnostics$/.test(t)) return { kind: 'diagnostics' };

  let m = t.match(/^(?:search|look up|find)\s+(?:on\s+)?youtube\s+for\s+(.+)$/) ?? t.match(/^(?:play|find|search for)\s+(.+?)\s+on youtube$/) ?? t.match(/^youtube\s+(.+)$/);
  if (m) return { kind: 'youtube', query: m[1].trim() };
  if (/^(open|launch|go to|show)\s+(up\s+)?(the\s+)?youtube(\.com)?$/.test(t) || t === 'youtube') return { kind: 'youtube', query: null };

  m = t.match(/^(?:ask\s+)?(?:the\s+)?spider\s+(?:to\s+)?(?:inspect|scan|analy[sz]e|audit|review)\s*(.*)$/) ?? t.match(/^(?:inspect|scan|audit)\s+(.*?)\s*(?:with|using)\s+(?:the\s+)?spider$/);
  if (m) {
    const target = m[1].replace(/^(this|the|my)\s+(project|repo(sitory)?|code(base)?)\s*/, '').replace(/^project\s+/, '').trim();
    return { kind: 'spider_inspect', project: target || null };
  }

  m = t.match(/^(?:research|investigate|look into)\s+(.+)$/);
  if (m) {
    const target = m[1].replace(/^(this|that)\s+(company|domain|site|website)$/, '').trim();
    return { kind: 'research', target: target || null };
  }

  m = t.match(/^(?:open|go to|visit|browse( to)?|show me)\s+((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)$/);
  if (m) {
    const host = m[2];
    return { kind: 'open_url', url: /^https?:\/\//.test(host) ? host : `https://${host}` };
  }

  m = t.match(/^(?:open|go to|show|switch to|take me to)\s+(?:the\s+)?(.+?)(?:\s+(?:section|page|panel|view))?$/);
  if (m) {
    for (const [re, section] of SECTION_WORDS) if (new RegExp(`^(${re.source})$`).test(m[1])) return { kind: 'navigate', section };
  }

  return { kind: 'ask', text: text || raw.trim() };
}
