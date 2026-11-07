import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoreState, GraphicsQuality } from '@tc/shared';
import { AGENT_IDS } from '@tc/shared';
import { Core2D } from './core2d';
import { BOOT_SECONDS, DEFAULT_INPUT, STATE_LABEL, coreStats, type CoreInput, type CoreRenderer } from './params';
import { useStore } from '../lib/store';

/**
 * Hosts the core renderer. Chooses 3D (lazy-loaded Three.js chunk) or the 2D
 * fallback, applies the graphics-quality tier, pauses when hidden, feeds the
 * renderer real signals (state, speech energy, activity, working agents,
 * pointer parallax) and overlays live data indicators read from telemetry.
 */

const FALLBACK_KEY = 'tc.core.fallback2d';

function readFallback(): boolean {
  try {
    return localStorage.getItem(FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function useGraphicsQuality(): GraphicsQuality {
  const settings = useStore((s) => s.settings);
  return settings?.batterySaver ? 'performance' : settings?.graphicsQuality ?? 'balanced';
}

interface Indicator {
  key: string;
  label: string;
  value: string;
  angle: number;
  tone?: 'warn' | 'err' | 'ok';
}

export function CoreView({ state, onTap, label = 'Open AI diagnostics' }: { state: CoreState; onTap?: () => void; label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<CoreRenderer | null>(null);
  const inputRef = useRef<CoreInput>(DEFAULT_INPUT);
  const settings = useStore((s) => s.settings);
  const level = useStore((s) => s.voice.level);
  const agents = useStore((s) => s.agents);
  const activity = useStore((s) => s.activity);
  const bootSeq = useStore((s) => s.bootSeq);
  const latest = useStore((s) => s.telemetry.at(-1));
  const linkMs = useStore((s) => s.link.latencyMs);
  const status = useStore((s) => s.status);
  const [engine, setEngine] = useState<'3d' | '2d' | 'static' | 'loading'>('loading');
  const [note, setNote] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const mode = settings?.coreRenderMode ?? 'auto';
  const quality = useGraphicsQuality();
  const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A new canvas element per engine: a canvas that held a WebGL context cannot provide a 2D one.
  const [canvasKey, setCanvasKey] = useState(0);
  const bootRef = useRef(bootSeq);
  bootRef.current = bootSeq;

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    let disposed = false;
    let renderer: CoreRenderer | null = null;

    const use2d = (why: string | null, staticMode = false) => {
      renderer = new Core2D(canvas, staticMode ? 'static' : 'animated', quality === 'performance');
      setEngine(staticMode ? 'static' : '2d');
      setNote(why);
      attach();
    };
    const attach = () => {
      if (!renderer || disposed) return;
      rendererRef.current = renderer;
      const r = stage.getBoundingClientRect();
      renderer.resize(r.width, r.height);
      renderer.update(inputRef.current);
      const seq = bootRef.current;
      if (seq != null && performance.now() - seq < (BOOT_SECONDS * 1000) / 2) renderer.boot(true);
      if (!document.hidden) renderer.start();
    };

    (async () => {
      if (mode === 'static') return use2d(null, true);
      if (mode === '2d') return use2d(null);
      if (mode === 'auto' && readFallback()) return use2d('2D mode chosen automatically after low frame rates (change in Settings).');
      const { Core3D, webglAvailable } = await import('./core3d');
      if (disposed) return;
      if (!webglAvailable()) return use2d('WebGL2 is unavailable on this device — using the 2D core.');
      try {
        renderer = new Core3D(canvas, {
          quality,
          onTooSlow: () => {
            if (mode !== 'auto') return;
            try {
              localStorage.setItem(FALLBACK_KEY, '1');
            } catch {
              /* private mode */
            }
            renderer?.dispose();
            setCanvasKey((k) => k + 1);
          },
        });
        setEngine('3d');
        setNote(null);
        attach();
      } catch {
        use2d('3D initialisation failed — using the 2D core.');
      }
    })();

    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect();
      rendererRef.current?.resize(r.width, r.height);
      setCompact(r.width < 460 || r.height < 300);
    });
    ro.observe(stage);
    const onVis = () => (document.hidden ? rendererRef.current?.stop() : rendererRef.current?.start());
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, [mode, quality, canvasKey]);

  // Pointer parallax: the renderer eases toward the pointer; CSS layers follow via custom properties.
  useEffect(() => {
    if (reducedMotion) return;
    let raf = 0;
    let px = 0;
    let py = 0;
    const onMove = (e: PointerEvent) => {
      px = (e.clientX / window.innerWidth) * 2 - 1;
      py = -((e.clientY / window.innerHeight) * 2 - 1);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        inputRef.current = { ...inputRef.current, pointer: { x: px, y: py } };
        rendererRef.current?.update(inputRef.current);
        stageRef.current?.style.setProperty('--px', px.toFixed(3));
        stageRef.current?.style.setProperty('--py', py.toFixed(3));
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  // A sent command pulses the core.
  useEffect(() => {
    const onSent = () => rendererRef.current?.pulse();
    window.addEventListener('tc:command-sent', onSent);
    return () => window.removeEventListener('tc:command-sent', onSent);
  }, []);

  // Boot sequence start / skip.
  const lastBoot = useRef<number | null>(bootSeq);
  useEffect(() => {
    if (bootSeq === lastBoot.current) return;
    lastBoot.current = bootSeq;
    rendererRef.current?.boot(bootSeq != null);
  }, [bootSeq]);

  const activeAgents = useMemo(() => agents.filter((a) => a.status === 'working' || a.status === 'planning').map((a) => AGENT_IDS.indexOf(a.id)), [agents]);
  const now = Date.now();
  const recentEvents = activity.filter((a) => now - a.at < 30_000).length;
  const input: CoreInput = {
    state,
    level,
    activity: Math.min(1, recentEvents / 18),
    activeAgents,
    agentCount: AGENT_IDS.length,
    reducedMotion,
    pointer: inputRef.current.pointer,
  };
  inputRef.current = input;
  useEffect(() => {
    rendererRef.current?.update(inputRef.current);
  });

  const cpu = latest?.cpu.percent ?? null;
  const mem = latest?.memory.percent ?? null;
  const indicators: Indicator[] = [
    { key: 'cpu', label: 'CPU', value: latest ? (cpu == null ? 'n/a' : `${Math.round(cpu)}%`) : '—', angle: -152, tone: cpu != null && cpu > 85 ? 'warn' : undefined },
    { key: 'mem', label: 'MEMORY', value: mem == null ? '—' : `${Math.round(mem)}%`, angle: -28, tone: mem != null && mem > 90 ? 'warn' : undefined },
    { key: 'link', label: 'LINK', value: linkMs == null ? 'no link' : `${linkMs} ms`, angle: 28, tone: linkMs == null ? 'err' : linkMs > 400 ? 'warn' : 'ok' },
    { key: 'ops', label: 'MISSIONS', value: status ? `${status.tasks.active} active` : '—', angle: 152, tone: status?.tasks.awaitingApproval ? 'warn' : undefined },
  ];

  return (
    <div
      className={`core-stage ${compact ? 'compact' : ''}`}
      ref={stageRef}
      onClick={onTap}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onTap?.()}
      role="button"
      tabIndex={0}
      aria-label={`TOURBILLION core — ${STATE_LABEL[state]}. ${label}`}
      data-engine={engine}
      data-state={state}
      data-quality={quality}
    >
      <canvas key={canvasKey} ref={canvasRef} />
      <svg className="core-leaders" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {indicators.map((i) => {
          const a = (i.angle * Math.PI) / 180;
          return <line key={i.key} x1={50 + Math.cos(a) * 33} y1={50 + Math.sin(a) * 33} x2={50 + Math.cos(a) * 22} y2={50 + Math.sin(a) * 22} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <div className="core-inds" aria-hidden="true">
        {indicators.map((i, n) => {
          const a = (i.angle * Math.PI) / 180;
          return (
            <div key={i.key} className={`core-ind ${i.tone ?? ''} ${Math.cos(a) < 0 ? 'west' : 'east'}`} style={{ left: `${50 + Math.cos(a) * 36}%`, top: `${50 + Math.sin(a) * 36}%`, animationDelay: `${-n * 1.7}s` }}>
              <span className="k">{i.label}</span>
              <span className="v">{i.value}</span>
            </div>
          );
        })}
      </div>
      <div className="core-hud">
        <div className={`core-state ${state}`}>{STATE_LABEL[state]}</div>
      </div>
      <div className="core-sub">{note ?? (engine === 'loading' ? 'Initialising core…' : engine === '3d' ? '' : engine === 'static' ? 'Static core' : '2D core')}</div>
    </div>
  );
}

export { coreStats };
