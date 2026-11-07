import type { ReactNode } from 'react';
import type { SectionId } from '@tc/shared';

/** Original line icons (24×24, 1.6 stroke). */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const d = PATHS[name] ?? PATHS.dot;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...P}>
      {d}
    </svg>
  );
}

const PATHS: Record<string, ReactNode> = {
  command: (<><circle cx="12" cy="12" r="3" /><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(-25 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(35 12 12)" /></>),
  intelligence: (<><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 4v-4h0A2 2 0 0 1 4 14Z" /><path d="M8.5 9.5h7M8.5 12.5h4.5" /></>),
  agents: (<><circle cx="12" cy="7" r="2.6" /><circle cx="5.5" cy="16.5" r="2.2" /><circle cx="18.5" cy="16.5" r="2.2" /><path d="M10.6 9.2 6.8 14.5M13.4 9.2l3.8 5.3M7.7 16.5h8.6" /></>),
  spider: (<><circle cx="12" cy="12.5" r="3" /><path d="M12 9.5V3M9.4 11 4 7M14.6 11 20 7M9 13l-6 1M15 13l6 1M9.8 14.8 5.5 20M14.2 14.8l4.3 5.2" /></>),
  browser: (<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M3 9h18" /><circle cx="6" cy="6.8" r=".6" /><circle cx="8.2" cy="6.8" r=".6" /></>),
  research: (<><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5.5 5.5M8 10.5h5M10.5 8v5" /></>),
  projects: (<><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5H10l2 2.2h6.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /><path d="m10 12-2 2 2 2M14 12l2 2-2 2" /></>),
  missions: (<><path d="M6 20V4M6 4.5h10.5l-2 3.5 2 3.5H6" /><circle cx="6" cy="20" r="1" /></>),
  automations: (<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /><path d="M19.5 4.5 17.5 6.5M4.5 4.5l2 2" /></>),
  apps: (<><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><path d="M16.75 13.5v6.5M13.5 16.75H20" /></>),
  memory: (<><ellipse cx="12" cy="6" rx="7" ry="2.6" /><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" /></>),
  settings: (<><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" /></>),
  mic: (<><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" /></>),
  stop: (<rect x="7" y="7" width="10" height="10" rx="2" />),
  send: (<path d="M4 12 20 4l-6.5 16-2.3-6.7Z" />),
  menu: (<path d="M4 7h16M4 12h16M4 17h10" />),
  close: (<path d="M6 6l12 12M18 6 6 18" />),
  back: (<path d="M15 5 8 12l7 7" />),
  forward: (<path d="m9 5 7 7-7 7" />),
  reload: (<><path d="M19 12a7 7 0 1 1-2.1-5" /><path d="M19 4.5V8h-3.5" /></>),
  bell: (<><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5Z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>),
  shield: (<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6Z" />),
  plus: (<path d="M12 5v14M5 12h14" />),
  play: (<path d="M8 5.5v13l10.5-6.5Z" />),
  external: (<><path d="M14 4h6v6M20 4l-8.5 8.5" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>),
  speaker: (<><path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3Z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>),
  keyboard: (<><rect x="3" y="6.5" width="18" height="11" rx="2" /><path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M7.5 14h9" /></>),
  trash: (<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7" />),
  check: (<path d="m5 12.5 4.5 4.5L19 7.5" />),
  dot: (<circle cx="12" cy="12" r="2" />),
};

export const SECTION_ICON: Record<SectionId, string> = {
  command: 'command',
  intelligence: 'intelligence',
  agents: 'agents',
  spider: 'spider',
  browser: 'browser',
  research: 'research',
  projects: 'projects',
  missions: 'missions',
  automations: 'automations',
  apps: 'apps',
  memory: 'memory',
  settings: 'settings',
};

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id="lg" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".4" stopColor="#8ff3ff" />
          <stop offset="1" stopColor="#2ee6ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g fill="none" strokeLinecap="round">
        <ellipse cx="32" cy="32" rx="26" ry="9" stroke="#a8dcff" strokeOpacity=".8" strokeWidth="1.6" transform="rotate(-28 32 32)" />
        <ellipse cx="32" cy="32" rx="22" ry="7.5" stroke="#8f7bff" strokeOpacity=".85" strokeWidth="1.6" transform="rotate(42 32 32)" />
        <circle cx="32" cy="32" r="17" stroke="#2ee6ff" strokeWidth="1.2" strokeDasharray="1.5 4" />
      </g>
      <circle cx="32" cy="32" r="12" fill="url(#lg)" />
      <circle cx="32" cy="32" r="3.5" fill="#fff" />
    </svg>
  );
}
