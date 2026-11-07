import type { ReactNode } from 'react';
import type { IntegrationStatus } from '@tc/shared';
import { INTEGRATION_LABEL, integrationDot } from '../../components/ui';
import { useStore } from '../../lib/store';
import { ago } from '../../lib/format';
import type { OpenSheet } from './util';

/** Display order and accent for the nine connected services (states always come from the server). */
export const APP_ORDER = ['claude', 'browser', 'youtube', 'search', 'github', 'gmail', 'bridge', 'blender', 'roblox'] as const;
const ACCENT: Record<string, string> = {
  claude: '#8f7bff',
  browser: '#2ee6ff',
  youtube: '#ff6b7d',
  search: '#1ff2d2',
  github: '#a8dcff',
  gmail: '#ffb648',
  bridge: '#4f8dff',
  blender: '#ff9a4a',
  roblox: '#3dffb0',
};
export const APP_SHORT: Record<string, string> = {
  claude: 'Claude',
  browser: 'Remote Browser',
  youtube: 'YouTube Data API',
  search: 'Web Search',
  github: 'GitHub',
  gmail: 'Gmail',
  bridge: 'Desktop Bridge',
  blender: 'Blender',
  roblox: 'Roblox Studio',
};

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** Original glyphs (generic symbols, not third-party logos). */
const GLYPH: Record<string, ReactNode> = {
  claude: (<><circle cx="16" cy="9" r="2.6" /><circle cx="8.5" cy="21.5" r="2.6" /><circle cx="23.5" cy="21.5" r="2.6" /><path d="M14.7 11.3 9.8 19.2M17.3 11.3l4.9 7.9M11.1 21.5h9.8" /><circle cx="16" cy="17.3" r="1.4" fill="currentColor" /></>),
  browser: (<><rect x="4" y="6" width="24" height="20" rx="3" /><path d="M4 11h24" /><circle cx="16" cy="18.5" r="4.6" /><path d="M11.4 18.5h9.2M16 13.9c-2 2.6-2 6.6 0 9.2M16 13.9c2 2.6 2 6.6 0 9.2" /></>),
  youtube: (<><rect x="4" y="8" width="24" height="16" rx="2.5" /><path d="M7 8v16M25 8v16M4 12h3M4 20h3M25 12h3M25 20h3" /><path d="m14 12.6 6 3.4-6 3.4Z" /></>),
  search: (<><circle cx="14" cy="14" r="6.5" /><path d="m19 19 7 7" /><path d="M10.5 12.5a4.5 4.5 0 0 1 3.5-3" /><path d="M23 7.5a6 6 0 0 1 2 3.5M24.5 4.5a10 10 0 0 1 3.5 6" /></>),
  github: (<><circle cx="9" cy="7.5" r="2.6" /><circle cx="9" cy="24.5" r="2.6" /><circle cx="23" cy="12" r="2.6" /><path d="M9 10.1v11.8M23 14.6c0 5-6 4.6-12.6 8.3" /></>),
  gmail: (<><rect x="4" y="8" width="24" height="16" rx="2.5" /><path d="m5 9.5 11 8 11-8" /><path d="m5 23 8-7M27 23l-8-7" /></>),
  bridge: (<><rect x="3" y="7" width="11" height="9" rx="1.6" /><rect x="18" y="7" width="11" height="9" rx="1.6" /><path d="M8.5 16v3M23.5 16v3M6 19.5h5M21 19.5h5" /><path d="M14 11.5h4" strokeDasharray="1.5 1.5" /><circle cx="16" cy="25" r="1.6" /><path d="M8.5 22.5c2 2.5 13 2.5 15 0" /></>),
  blender: (<><path d="m16 5 9 5v10l-9 5-9-5V10Z" /><path d="M7 10l9 5 9-5M16 15v10" /><ellipse cx="16" cy="15" rx="13" ry="4.5" transform="rotate(-18 16 15)" opacity=".7" /></>),
  roblox: (<><path d="M9 11h14a5 5 0 0 1 5 5v1a5 5 0 0 1-5 5c-2 0-3-1.6-4.2-2.6h-5.6C12 20.4 11 22 9 22a5 5 0 0 1-5-5v-1a5 5 0 0 1 5-5Z" /><path d="M10 14.5v4M8 16.5h4" /><circle cx="21" cy="15.5" r="1" fill="currentColor" /><circle cx="23.5" cy="18" r="1" fill="currentColor" /></>),
};

export function AppGlyph({ id, size = 34 }: { id: string; size?: number }) {
  return (
    <span className="app-glyph" style={{ color: ACCENT[id] ?? 'var(--cyan)', width: size + 18, height: size + 18 }}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" {...S}>
        {GLYPH[id] ?? <circle cx="16" cy="16" r="8" />}
      </svg>
    </span>
  );
}

export function AppsGrid({ open }: { open: OpenSheet }) {
  const integrations = useStore((s) => s.integrations);
  const known = APP_ORDER.map((id) => integrations.find((i) => i.id === id)).filter((i): i is IntegrationStatus => !!i);
  const extra = integrations.filter((i) => !(APP_ORDER as readonly string[]).includes(i.id));
  const all = [...known, ...extra];
  if (all.length === 0) return <div className="empty">Waiting for integration status…</div>;
  return (
    <div className="apps-grid">
      {all.map((i, n) => {
        const dot = integrationDot(i.state);
        return (
          <button key={i.id} className={`app-card ${i.state}`} style={{ animationDelay: `${n * 45}ms`, ['--accent' as string]: ACCENT[i.id] ?? 'var(--cyan)' }} onClick={() => open({ kind: 'integration', id: i.id })} data-testid={`app-${i.id}`}>
            <AppGlyph id={i.id} />
            <span className="app-meta">
              <span className="app-name">{APP_SHORT[i.id] ?? i.name}</span>
              <span className={`app-state ${dot}`}>
                <i />
                {INTEGRATION_LABEL[i.state]}
              </span>
              <span className="tiny muted ellipsis" title={i.lastError ?? (i.requires.length ? `Needs ${i.requires.join(', ')}` : undefined)}>{i.lastError ? i.lastError : i.lastSuccessAt ? `Last success ${ago(i.lastSuccessAt)}` : i.requires.length ? `Needs ${i.requires.join(', ')}` : 'Not checked yet'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
