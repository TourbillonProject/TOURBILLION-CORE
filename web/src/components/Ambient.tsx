import { useEffect, useRef } from 'react';
import type { GraphicsQuality } from '@tc/shared';

/**
 * Ambient environment behind every section: three depths of stars with
 * pointer parallax, a perspective grid flowing toward the viewer, drifting
 * holographic glyphs and faint data streams. One throttled Canvas 2D layer
 * (30 fps cinematic, 24 balanced, a single still frame in performance mode or
 * with reduced motion); light blobs, radial gradients and scanlines are CSS.
 */

interface Star {
  x: number;
  y: number;
  r: number;
  d: number;
  ph: number;
}
interface Glyph {
  x: number;
  y: number;
  kind: number;
  size: number;
  speed: number;
  ph: number;
  spin: number;
}
interface Stream {
  x: number;
  y: number;
  speed: number;
  len: number;
}

const COUNTS: Record<GraphicsQuality, { stars: number; glyphs: number; streams: number; fps: number; dpr: number }> = {
  cinematic: { stars: 280, glyphs: 9, streams: 9, fps: 30, dpr: 1.5 },
  balanced: { stars: 170, glyphs: 6, streams: 6, fps: 24, dpr: 1 },
  performance: { stars: 90, glyphs: 3, streams: 0, fps: 0, dpr: 1 },
};

export function Ambient({ quality }: { quality: GraphicsQuality }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cfg = COUNTS[quality];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animated = cfg.fps > 0 && !reduced;
    const dpr = Math.min(window.devicePixelRatio || 1, cfg.dpr);
    let w = 0;
    let h = 0;
    const stars: Star[] = Array.from({ length: cfg.stars }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() ** 3 * 1.4 + 0.35, d: 0.2 + Math.random() * 0.8, ph: Math.random() * Math.PI * 2 }));
    const glyphs: Glyph[] = Array.from({ length: cfg.glyphs }, () => ({ x: Math.random(), y: Math.random(), kind: Math.floor(Math.random() * 5), size: 8 + Math.random() * 14, speed: 0.004 + Math.random() * 0.008, ph: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.2 }));
    const streams: Stream[] = Array.from({ length: cfg.streams }, () => ({ x: Math.random(), y: Math.random(), speed: 0.03 + Math.random() * 0.06, len: 40 + Math.random() * 120 }));
    const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
    let raf = 0;
    let last = 0;
    let t = 0;

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(0);
    };

    const glyph = (g: Glyph, x: number, y: number, a: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(g.ph + t * g.spin);
      ctx.strokeStyle = `rgba(120, 200, 255, ${a})`;
      ctx.lineWidth = 1;
      const s = g.size;
      ctx.beginPath();
      if (g.kind === 0) {
        for (let i = 0; i <= 6; i++) {
          const an = (i / 6) * Math.PI * 2;
          i ? ctx.lineTo(Math.cos(an) * s, Math.sin(an) * s) : ctx.moveTo(s, 0);
        }
      } else if (g.kind === 1) {
        ctx.arc(0, 0, s, 0, Math.PI * 1.5);
        ctx.moveTo(s * 0.4, 0);
        ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2);
      } else if (g.kind === 2) {
        ctx.moveTo(-s, 0);
        ctx.lineTo(s, 0);
        ctx.moveTo(0, -s);
        ctx.lineTo(0, s);
        ctx.moveTo(s * 0.6, 0);
        ctx.arc(0, 0, s * 0.6, 0, Math.PI * 2);
      } else if (g.kind === 3) {
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.87, s * 0.5);
        ctx.lineTo(-s * 0.87, s * 0.5);
        ctx.closePath();
      } else {
        const k = s * 0.35;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.moveTo(sx * s, sy * s - sy * k);
          ctx.lineTo(sx * s, sy * s);
          ctx.lineTo(sx * s - sx * k, sy * s);
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    const draw = (dt: number) => {
      if (!w || !h) return;
      t += dt;
      ptr.x += (ptr.tx - ptr.x) * Math.min(1, dt * 2);
      ptr.y += (ptr.ty - ptr.y) * Math.min(1, dt * 2);
      ctx.clearRect(0, 0, w, h);

      // stars (deeper = smaller parallax)
      for (const s of stars) {
        const tw = 0.55 + 0.45 * Math.sin(t * (0.6 + s.d) + s.ph);
        const x = s.x * w - ptr.x * s.d * 14;
        const y = s.y * h + ptr.y * s.d * 10;
        ctx.fillStyle = `rgba(${s.d > 0.85 ? '200, 225, 255' : '150, 205, 255'}, ${(0.18 + s.d * 0.42) * tw})`;
        ctx.fillRect(x, y, s.r, s.r);
      }

      // perspective grid flowing toward the viewer
      const horizon = h * 0.7;
      const cx = w / 2 - ptr.x * 18;
      const depth = h - horizon;
      ctx.lineWidth = 1;
      const rows = 12;
      const off = (t * 0.06) % (1 / rows);
      for (let k = 0; k < rows; k++) {
        const z = k / rows + off;
        const y = horizon + depth * z ** 2.1;
        ctx.strokeStyle = `rgba(80, 170, 255, ${0.012 + z * 0.06})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      const cols = 22;
      const grad = ctx.createLinearGradient(0, horizon, 0, h);
      grad.addColorStop(0, 'rgba(80, 170, 255, 0)');
      grad.addColorStop(1, 'rgba(80, 170, 255, 0.07)');
      ctx.strokeStyle = grad;
      for (let i = -cols; i <= cols; i++) {
        const xb = cx + i * (w / cols) * 1.1;
        const xt = cx + i * (w / cols) * 0.1;
        ctx.beginPath();
        ctx.moveTo(xt, horizon);
        ctx.lineTo(xb, h);
        ctx.stroke();
      }

      // data streams
      for (const s of streams) {
        s.y += s.speed * dt;
        if (s.y * h - s.len > h) {
          s.y = -Math.random() * 0.3;
          s.x = Math.random();
        }
        const x = Math.round(s.x * w - ptr.x * 6);
        const y = s.y * h;
        for (let k = 0; k < s.len; k += 7) {
          ctx.fillStyle = `rgba(46, 230, 255, ${0.07 * (1 - k / s.len)})`;
          ctx.fillRect(x, y - k, 1, 4);
        }
      }

      // holographic glyphs drifting upward
      for (const g of glyphs) {
        g.y -= g.speed * dt;
        if (g.y < -0.05) {
          g.y = 1.05;
          g.x = Math.random();
        }
        const fade = Math.sin(Math.min(1, Math.max(0, g.y)) * Math.PI);
        glyph(g, g.x * w - ptr.x * 22, g.y * h + ptr.y * 14, 0.09 * fade);
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const el = now - last;
      if (el < 1000 / cfg.fps) return;
      last = now;
      draw(Math.min(0.1, el / 1000));
    };
    const onMove = (e: PointerEvent) => {
      ptr.tx = (e.clientX / window.innerWidth) * 2 - 1;
      ptr.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && animated) raf = requestAnimationFrame(frame);
    };
    resize();
    window.addEventListener('resize', resize);
    if (animated) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('visibilitychange', onVis);
      raf = requestAnimationFrame(frame);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [quality]);

  return (
    <div className="backdrop" aria-hidden="true">
      <div className="aurora a" />
      <div className="aurora b" />
      <canvas ref={ref} className="ambient" />
      <div className="scanlines" />
    </div>
  );
}
