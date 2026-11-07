import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { IntegrationState, TaskStatus } from '@tc/shared';
import { Icon } from './icons';

export function Panel({ title, idx, actions, children, className = '', flat = false }: { title?: ReactNode; idx?: string; actions?: ReactNode; children: ReactNode; className?: string; flat?: boolean }) {
  return (
    <section className={`panel ${flat ? 'flat' : ''} ${className}`}>
      <span className="panel-edge" aria-hidden="true" />
      {(title || actions) && (
        <div className="panel-head">
          {idx && <span className="idx">{idx}</span>}
          {title && <h2>{title}</h2>}
          <span className="grow" />
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Dot({ kind, pulse }: { kind: 'ok' | 'live' | 'warn' | 'err' | 'off'; pulse?: boolean }) {
  return <span className={`dot ${kind === 'off' ? '' : kind} ${pulse ? 'pulse' : ''}`} aria-hidden="true" />;
}

export function integrationDot(state: IntegrationState): 'ok' | 'warn' | 'err' | 'off' {
  return state === 'connected' ? 'ok' : state === 'error' ? 'err' : state === 'configured' || state === 'disconnected' ? 'warn' : 'off';
}

export const INTEGRATION_LABEL: Record<IntegrationState, string> = {
  not_configured: 'Not configured',
  configured: 'Configured · untested',
  connected: 'Connected',
  error: 'Error',
  disconnected: 'Disconnected',
};

const STATUS_BADGE: Record<TaskStatus, string> = {
  pending: '',
  planning: 'violet',
  awaiting_approval: 'amber',
  running: 'cyan',
  completed: 'green',
  failed: 'red',
  cancelled: '',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge ${STATUS_BADGE[status]}`}>{status.replace('_', ' ')}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Sheet({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // Portalled to <body>: transformed or glass (backdrop-filter) ancestors would otherwise trap a fixed overlay.
  return createPortal(
    <div className="scrim" onClick={onClose} role="dialog" aria-modal="true">
      <div className="sheet" style={wide ? { width: 'min(1000px, 100%)' } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="row between nowrap" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} role="tab" aria-selected={o.value === value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Labelled form field. `group` is for button sets (a <label> would rename its first button). */
export function Field({ label, children, group }: { label: string; children: ReactNode; group?: boolean }) {
  if (group) {
    return (
      <div className="field" role="group" aria-label={label}>
        <span>{label}</span>
        {children}
      </div>
    );
  }
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
          {l || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** Async action button with built-in busy state. */
export function ActionButton({ onClick, children, className = 'btn', disabled, title }: { onClick: () => Promise<unknown> | unknown; children: ReactNode; className?: string; disabled?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={disabled || busy}
      title={title}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="dot live pulse" /> : null}
      {children}
    </button>
  );
}

export function Json({ value, max = 6000 }: { value: unknown; max?: number }) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre>{s.length > max ? `${s.slice(0, max)}\n…` : s}</pre>;
}
