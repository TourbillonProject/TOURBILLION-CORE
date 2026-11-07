import { useEffect, useRef, useState } from 'react';
import type { CoreState } from '@tc/shared';
import { AGENT_IDS } from '@tc/shared';
import { Core2D } from './core2d';
import type { CoreRenderer } from './params';
import { STATE_LABEL } from './params';
import { useStore } from '../lib/store';

/**
 * Hosts the core renderer. Chooses 3D (lazy-loaded Three.js chunk) or the 2D
 * fallback, pauses when hidden, and remembers an automatic fallback.
 */

const FALLBACK_KEY = 'tc.core.fallback2d';

function readFallback(): boolean {
  try {
    return localStorage.getItem(FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function CoreView({ state, onTap }: { state: CoreState; onTap?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<CoreRenderer | null>(null);
  const settings = useStore((s) => s.settings);
  const level = useStore((s) => s.voice.level);
  const agents = useStore((s) => s.agents);
  const [engine, setEngine] = useState<'3d' | '2d' | 'static' | 'loading'>('loading');
  const [note, setNote] = useState<string | null>(null);
  const mode = settings?.coreRenderMode ?? 'auto';
  const batterySaver = settings?.batterySaver ?? false;
  const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A new canvas element per engine: a canvas that held a WebGL context cannot provide a 2D one.
  const [canvasKey, setCanvasKey] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    let disposed = false;
    let renderer: CoreRenderer | null = null;

    const use2d = (why: string | null, staticMode = false) => {
      renderer = new Core2D(canvas, staticMode ? 'static' : 'animated', batterySaver);
      setEngine(staticMode ? 'static' : '2d');
      setNote(why);
      attach();
    };
    const attach = () => {
      if (!renderer || disposed) return;
      rendererRef.current = renderer;
      const r = stage.getBoundingClientRect();
      renderer.resize(r.width, r.height);
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
          batterySaver,
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
  }, [mode, batterySaver, canvasKey]);

  const activeAgents = agents.filter((a) => a.status === 'working' || a.status === 'planning').map((a) => AGENT_IDS.indexOf(a.id));
  useEffect(() => {
    rendererRef.current?.update({ state, level, activeAgents, reducedMotion });
  });

  return (
    <div className="core-stage" ref={stageRef} onClick={onTap} role="img" aria-label={`TOURBILLION core — ${STATE_LABEL[state]}`} data-engine={engine} data-state={state}>
      <canvas key={canvasKey} ref={canvasRef} />
      <div className="core-hud">
        <div className={`core-state ${state === 'error' ? 'error' : ''}`}>{STATE_LABEL[state]}</div>
      </div>
      <div className="core-sub">{note ?? (engine === 'loading' ? 'Initialising core…' : engine === '3d' ? '' : engine === 'static' ? 'Static core' : '2D core')}</div>
    </div>
  );
}
