import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Small, dependency-free data-visualisation kit (SVG + CSS). Every chart takes
 * real series; nulls render as gaps and "unavailable" states are explicit.
 */

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Number that eases toward its new value (no tween under reduced motion). */
export function AnimatedNumber({ value, format = (n) => String(Math.round(n)), duration = 650 }: { value: number | null | undefined; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(value ?? 0);
  const cur = useRef(value ?? 0);
  useEffect(() => {
    if (value == null) return;
    const from = cur.current;
    if (reduced() || from === value || !Number.isFinite(from)) {
      cur.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / duration);
      const v = from + (value - from) * (1 - (1 - k) ** 3);
      cur.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  if (value == null) return <span className="num na">n/a</span>;
  return <span className="num">{format(shown)}</span>;
}

/** Splits a series into drawable runs, skipping nulls. */
function runs(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string[] {
  const out: string[] = [];
  let cur = '';
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (cur) out.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
  });
  if (cur) out.push(cur);
  return out;
}

let gradSeq = 0;
function useId(prefix: string) {
  const [id] = useState(() => `${prefix}${++gradSeq}`);
  return id;
}

export function Sparkline({ values, color = 'var(--cyan)', height = 28, max, min = 0, label }: { values: (number | null)[]; color?: string; height?: number; max?: number; min?: number; label?: string }) {
  const id = useId('sp');
  const W = 100;
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  const hi = max ?? Math.max(1e-9, ...nums) * 1.15;
  const n = Math.max(2, values.length);
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => height - ((Math.min(hi, v) - min) / (hi - min || 1)) * (height - 2) - 1;
  const paths = runs(values, x, y);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" height={height} role="img" aria-label={label ?? 'trend'}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {paths.map((d, i) => {
        const first = d.slice(1).split('L')[0].split(',')[0];
        const last = d.split('L').at(-1)!.replace('M', '').split(',')[0];
        return (
          <g key={i}>
            <path d={`${d}L${last},${height}L${first},${height}Z`} fill={`url(#${id})`} />
            <path d={d} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
}

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  format: (v: number) => string;
}

/** Multi-series area chart with a hover/touch crosshair and readout. */
export function AreaChart({ series, times, height = 110, max, empty = 'Collecting samples…' }: { series: Series[]; times: number[]; height?: number; max?: number; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = times.length;
  const W = 300;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null && Number.isFinite(v));
  const hi = max ?? Math.max(1e-9, ...all) * 1.2;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => height - (Math.min(hi, Math.max(0, v)) / hi) * (height - 6) - 3;
  const pick = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || n < 2) return;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left) / r.width) * (n - 1)))));
  };
  if (n < 2) return <div className="chart-empty" style={{ height }}>{empty}</div>;
  const hx = hover != null ? (hover / (n - 1)) * 100 : 0;
  return (
    <div className="chart" ref={ref} style={{ height }} onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`ac-${s.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={height * g} y2={height * g} className="gridline" vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s) =>
          runs(s.values, x, y).map((d, i) => {
            const pts = d.split('L');
            const first = pts[0].slice(1).split(',')[0];
            const last = pts.at(-1)!.replace('M', '').split(',')[0];
            return (
              <g key={`${s.key}${i}`}>
                <path d={`${d}L${last},${height}L${first},${height}Z`} fill={`url(#ac-${s.key})`} />
                <path d={d} fill="none" stroke={s.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="series" />
              </g>
            );
          }),
        )}
      </svg>
      {hover != null && (
        <>
          <div className="crosshair" style={{ left: `${hx}%` }} />
          <div className={`readout ${hx > 60 ? 'left' : ''}`} style={{ left: `${hx}%` }}>
            <div className="tiny muted mono">{new Date(times[hover]).toLocaleTimeString('en-GB')}</div>
            {series.map((s) => {
              const v = s.values[hover];
              return (
                <div key={s.key} className="tiny mono row nowrap" style={{ gap: 6 }}>
                  <i className="swatch" style={{ background: s.color }} />
                  {s.label} <b>{v == null ? 'n/a' : s.format(v)}</b>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function Legend({ series }: { series: Pick<Series, 'key' | 'label' | 'color'>[] }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.key} className="tiny muted">
          <i className="swatch" style={{ background: s.color }} /> {s.label}
        </span>
      ))}
    </div>
  );
}

/** Circular gauge (0..1). `null` renders an explicit "unavailable" ring. */
export function RingGauge({ value, label, sub, color = 'var(--cyan)', size = 74 }: { value: number | null; label: string; sub?: ReactNode; color?: string; size?: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const v = value == null ? null : Math.max(0, Math.min(1, value));
  const warn = v != null && v > 0.9 ? 'var(--red)' : v != null && v > 0.75 ? 'var(--amber)' : color;
  return (
    <div className="gauge" style={{ width: size }}>
      <svg viewBox="0 0 80 80" width={size} height={size} role="img" aria-label={`${label} ${v == null ? 'unavailable' : `${Math.round(v * 100)}%`}`}>
        <circle cx="40" cy="40" r={r} className="gauge-track" />
        <circle cx="40" cy="40" r={r + 6} className="gauge-ticks" />
        {v != null && <circle cx="40" cy="40" r={r} className="gauge-val" stroke={warn} strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - v)} transform="rotate(-90 40 40)" />}
      </svg>
      <div className="gauge-center">
        <AnimatedNumber value={v == null ? null : v * 100} format={(n) => `${Math.round(n)}%`} />
      </div>
      <div className="gauge-label">{label}</div>
      {sub && <div className="gauge-sub">{sub}</div>}
    </div>
  );
}

/** Four signal bars from a latency (ms); null = no link. */
export function SignalBars({ ms }: { ms: number | null }) {
  const lvl = ms == null ? 0 : ms < 60 ? 4 : ms < 150 ? 3 : ms < 400 ? 2 : 1;
  return (
    <span className={`signal l${lvl}`} aria-hidden="true">
      {[1, 2, 3, 4].map((b) => (
        <i key={b} className={b <= lvl ? 'on' : ''} style={{ height: 3 + b * 2.5 }} />
      ))}
    </span>
  );
}

/** Indeterminate holographic loader. */
export function HoloLoader({ label }: { label?: string }) {
  return (
    <div className="holo-loader" role="status">
      <span className="ring a" />
      <span className="ring b" />
      <span className="ring c" />
      {label && <span className="tiny muted mono">{label}</span>}
    </div>
  );
}

/** Progress bar; `pct` null renders an animated indeterminate bar (no invented percentage). */
export function Progress({ pct, tone = 'cyan', label }: { pct: number | null; tone?: 'cyan' | 'green' | 'red' | 'amber' | 'violet'; label?: string }) {
  return (
    <div className={`progress ${tone} ${pct == null ? 'indeterminate' : ''}`} role="progressbar" aria-label={label} aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: pct == null ? undefined : `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network topology
// ---------------------------------------------------------------------------

export interface TopoNode {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'err' | 'off' | 'live';
  detail?: string;
  parent?: string;
}

/** Radial topology around the TOURBILLION server. Edges flow when connected. */
export function Topology({ nodes, onSelect }: { nodes: TopoNode[]; onSelect?: (id: string) => void }) {
  const W = 460;
  const H = 290;
  const cx = W / 2;
  const cy = H / 2;
  const first = nodes.filter((n) => !n.parent && n.id !== 'server');
  const center = nodes.find((n) => n.id === 'server');
  const pos = new Map<string, { x: number; y: number; a: number }>();
  first.forEach((n, i) => {
    const a = (i / first.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: cx + Math.cos(a) * 150, y: cy + Math.sin(a) * 92, a });
  });
  // Second ring: children sit further out along their parent's bearing, fanned apart.
  const children = nodes.filter((n) => n.parent);
  children.forEach((n) => {
    const p = pos.get(n.parent!);
    if (!p) return;
    const sibs = children.filter((c) => c.parent === n.parent);
    const a = p.a + (sibs.indexOf(n) - (sibs.length - 1) / 2) * 0.36;
    pos.set(n.id, { x: Math.min(W - 60, Math.max(60, cx + Math.cos(a) * 200)), y: Math.min(H - 12, Math.max(12, cy + Math.sin(a) * 132)), a });
  });
  return (
    <svg className="topology" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Network topology">
      {nodes.map((n) => {
        if (n.id === 'server') return null;
        const p = pos.get(n.id);
        const from = n.parent ? pos.get(n.parent) : { x: cx, y: cy };
        if (!p || !from) return null;
        return <line key={`e-${n.id}`} x1={from.x} y1={from.y} x2={p.x} y2={p.y} className={`edge ${n.state}`} />;
      })}
      {center && (
        <g className={`tnode center ${center.state} ${onSelect ? 'clickable' : ''}`} onClick={() => onSelect?.(center.id)}>
          <circle cx={cx} cy={cy} r="26" className="halo" />
          <circle cx={cx} cy={cy} r="17" />
          <text x={cx} y={cy + 3} textAnchor="middle">CORE</text>
        </g>
      )}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p || n.id === 'server') return null;
        const below = Math.sin(p.a) > 0.2;
        // Second-ring labels sit beside their node, on the outward side, so siblings never collide.
        const side = n.parent ? (Math.cos(p.a) < 0 ? -1 : 1) : 0;
        return (
          <g key={n.id} className={`tnode ${n.state} ${onSelect ? 'clickable' : ''}`} onClick={() => onSelect?.(n.id)}>
            <title>{`${n.label}${n.detail ? ` — ${n.detail}` : ''}`}</title>
            <circle cx={p.x} cy={p.y} r={n.parent ? 5 : 7} />
            {side ? (
              <text x={p.x + side * 9} y={p.y + 3.5} textAnchor={side < 0 ? 'end' : 'start'}>{n.label}</text>
            ) : (
              <text x={p.x} y={p.y + (below ? 19 : -12)} textAnchor="middle">{n.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Agent communication (radial)
// ---------------------------------------------------------------------------

export interface CommAgent {
  id: string;
  code: string;
  name: string;
  busy: boolean;
  events: number; // real activity events in the window
  error: boolean;
}

export function AgentComms({ agents, onSelect }: { agents: CommAgent[]; onSelect?: (id: string) => void }) {
  const W = 300;
  const H = 230;
  const cx = W / 2;
  const cy = H / 2 + 4;
  const core = agents[0];
  const rest = agents.slice(1);
  const pts = rest.map((a, i) => {
    const ang = (i / rest.length) * Math.PI * 2 - Math.PI / 2;
    return { a, x: cx + Math.cos(ang) * 112, y: cy + Math.sin(ang) * 86 };
  });
  const maxEv = Math.max(1, ...agents.map((a) => a.events));
  return (
    <svg className="comms" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Agent communication">
      {pts.map(({ a, x, y }) => {
        const strength = a.events / maxEv;
        const path = `M${cx},${cy} Q${(cx + x) / 2 + (y - cy) * 0.18},${(cy + y) / 2 - (x - cx) * 0.18} ${x},${y}`;
        return (
          <g key={a.id}>
            <path d={path} className={`link ${a.busy ? 'busy' : ''} ${a.error ? 'err' : ''}`} style={{ strokeOpacity: 0.15 + strength * 0.6 }} />
            {(a.busy || a.events > 0) && !reduced() && (
              <circle r="2.6" className="packet">
                <animateMotion dur={`${a.busy ? 1.6 : 3.2}s`} repeatCount="indefinite" path={path} />
              </circle>
            )}
          </g>
        );
      })}
      {core && (
        <g className={`anode core ${core.busy ? 'busy' : ''}`} onClick={() => onSelect?.(core.id)}>
          <circle cx={cx} cy={cy} r="20" />
          <text x={cx} y={cy - 1} textAnchor="middle" className="code">01</text>
          <text x={cx} y={cy + 9} textAnchor="middle" className="ev">{core.events}</text>
        </g>
      )}
      {pts.map(({ a, x, y }) => (
        <g key={a.id} className={`anode ${a.busy ? 'busy' : ''} ${a.error ? 'err' : ''}`} onClick={() => onSelect?.(a.id)}>
          <title>{`${a.code} ${a.name} — ${a.events} event(s) in the last minute${a.busy ? ', working' : ''}`}</title>
          <circle cx={x} cy={y} r="14" />
          <text x={x} y={y + 3.5} textAnchor="middle" className="code">{a.code.replace('AGENT ', '')}</text>
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Mission timeline (Gantt)
// ---------------------------------------------------------------------------

export interface TimelineItem {
  id: number;
  label: string;
  start: number;
  end: number | null; // null = still running
  status: string;
}

export function MissionTimeline({ items, onSelect }: { items: TimelineItem[]; onSelect?: (id: number) => void }) {
  const now = Date.now();
  const { lo, hi, ticks } = useMemo(() => {
    const starts = items.map((i) => i.start);
    const span = Math.min(6 * 3600_000, Math.max(10 * 60_000, now - Math.min(now, ...starts)));
    const lo = now - span * 1.04;
    const step = span > 3 * 3600_000 ? 3600_000 : span > 3600_000 ? 30 * 60_000 : span > 30 * 60_000 ? 10 * 60_000 : 5 * 60_000;
    const ticks: number[] = [];
    for (let t = Math.ceil(lo / step) * step; t <= now; t += step) ticks.push(t);
    return { lo, hi: now, ticks };
    // Recomputed when the set of start times changes, and every 30 s as "now" advances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.start).join(','), Math.floor(now / 30000)]);
  if (items.length === 0) return <div className="chart-empty" style={{ height: 80 }}>No missions in this window.</div>;
  const pct = (t: number) => ((Math.max(lo, Math.min(hi, t)) - lo) / (hi - lo)) * 100;
  return (
    <div className="mtl">
      <div className="mtl-axis">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${pct(t)}%` }}>{new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
        ))}
      </div>
      {items.map((it) => {
        const left = pct(it.start);
        const right = pct(it.end ?? now);
        return (
          <div key={it.id} className="mtl-row" onClick={() => onSelect?.(it.id)} title={`#${it.id} ${it.label} — ${it.status.replace('_', ' ')}`}>
            <span className="mtl-label tiny ellipsis">#{it.id} {it.label}</span>
            <span className="mtl-track">
              <i className={`mtl-bar ${it.status} ${it.end == null ? 'live' : ''}`} style={{ left: `${left}%`, width: `${Math.max(0.8, right - left)}%` }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
