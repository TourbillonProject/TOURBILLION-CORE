import { STATE_PARAMS, lerpParams, type CoreInput, type CoreParams, type CoreRenderer } from './params';

/**
 * 2D fallback core (Canvas 2D). Same states and parameters as the 3D core,
 * drawn with projected ellipses and a few hundred particles. Used when WebGL
 * is unavailable, when the device cannot hold a frame rate, or by choice.
 * `static` mode draws a single frame and stops (zero ongoing GPU/CPU cost).
 */

interface Particle {
  r: number;
  a: number;
  h: number;
  s: number;
}

export class Core2D implements CoreRenderer {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private last = 0;
  private w = 0;
  private h = 0;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private params: CoreParams = { ...STATE_PARAMS.idle };
  private input: CoreInput = { state: 'idle', level: 0, activeAgents: [], reducedMotion: false };
  private level = 0;
  private phase = { core: 0, rings: 0, particles: 0, neural: 0, nodes: 0, paths: 0, pulse: 0 };
  private particles: Particle[] = [];
  private nodes: { a: number; b: number; ph: number }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private mode: 'animated' | 'static' = 'animated',
    batterySaver = false,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const n = batterySaver ? 140 : 260;
    for (let i = 0; i < n; i++) this.particles.push({ r: 1.7 + Math.random() * 2.2, a: Math.random() * Math.PI * 2, h: (Math.random() - 0.5) * 0.7, s: 0.4 + Math.random() });
    for (let i = 0; i < 46; i++) this.nodes.push({ a: Math.random() * Math.PI * 2, b: Math.acos(2 * Math.random() - 1), ph: Math.random() });
  }

  update(input: CoreInput) {
    this.input = input;
    if (this.mode === 'static') {
      this.params = { ...STATE_PARAMS[input.state] };
      this.draw(0, performance.now() / 1000);
    }
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.mode === 'static') this.draw(0, performance.now() / 1000);
  }

  start() {
    if (this.mode === 'static') {
      this.draw(0, performance.now() / 1000);
      return;
    }
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.draw(dt, now / 1000);
  };

  private draw(dt: number, t: number) {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const motion = this.input.reducedMotion ? 0.35 : 1;
    this.params = lerpParams(this.params, STATE_PARAMS[this.input.state], dt ? 1 - Math.exp(-dt * 3.2) : 1);
    this.level += (this.input.level - this.level) * (dt ? 1 - Math.exp(-dt * 10) : 1);
    const p = this.params;
    const ph = this.phase;
    ph.core += dt * p.spin * motion;
    ph.rings += dt * p.ringSpeed * motion;
    ph.particles += dt * p.particleSpeed * motion;
    ph.neural += dt * (0.25 + p.neural) * motion;
    ph.nodes += dt * (0.6 + p.nodes * 4) * motion;
    ph.paths += dt * (0.3 + p.pathways) * motion;
    ph.pulse += dt * p.pulseRate * motion;

    const cx = w / 2;
    const cy = h / 2;
    const unit = Math.min(w, h) / 9.2;
    const tint = p.tint;
    const col = (a: number, violet = 0) => {
      const r = Math.round(46 + (255 - 46) * tint + (143 - 46) * violet * (1 - tint));
      const g = Math.round(230 + (182 - 230) * tint + (123 - 230) * violet * (1 - tint));
      const b = Math.round(255 + (72 - 255) * tint);
      return `rgba(${r},${g},${b},${a})`;
    };
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // glow
    const glowR = unit * (3.4 + this.level * 0.4);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    grad.addColorStop(0, col(0.32 * p.glow));
    grad.addColorStop(0.35, col(0.12 * p.glow, p.violet));
    grad.addColorStop(1, col(0));
    ctx.fillStyle = grad;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

    // rings (projected ellipses)
    const ringScale = p.ringScale - this.level * 0.08;
    const rings = [
      { r: 2.35, tilt: 0.28, rot: 0.3, dashes: 48, dir: 1 },
      { r: 2.7, tilt: 0.55, rot: -0.6, dashes: 0, dir: -1 },
      { r: 3.05, tilt: 0.2, rot: 1.1, dashes: 96, dir: 1 },
      { r: 3.45, tilt: 0.38, rot: 2.0, dashes: 6, dir: -1 },
    ];
    rings.forEach((rg, i) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rg.rot + ph.rings * 0.2 * rg.dir);
      ctx.strokeStyle = col(0.18 + 0.3 * p.glow, i === 2 ? 0.8 : 0);
      ctx.lineWidth = 1;
      if (rg.dashes) ctx.setLineDash([Math.max(1, (Math.PI * rg.r * unit) / rg.dashes), (Math.PI * rg.r * unit) / rg.dashes]);
      ctx.lineDashOffset = -ph.rings * 40 * rg.dir * (i + 1);
      ctx.beginPath();
      ctx.ellipse(0, 0, rg.r * unit * ringScale, rg.r * unit * ringScale * rg.tilt, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });
    ctx.setLineDash([]);

    // neural nodes + links on a rotating sphere
    const pts = this.nodes.map((n) => {
      const a = n.a + ph.core * 1.5;
      const x = Math.sin(n.b) * Math.cos(a);
      const y = Math.cos(n.b);
      const z = Math.sin(n.b) * Math.sin(a);
      return { x: cx + x * 1.72 * unit, y: cy + y * 1.72 * unit * 0.95, z, ph: n.ph };
    });
    ctx.lineWidth = 1;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 > (unit * 1.1) ** 2) continue;
        const pulse = Math.max(0, 1 - Math.abs(((ph.neural + pts[i].ph) % 1) - 0.5) * 6) * p.neural;
        ctx.strokeStyle = col((0.05 + 0.08 * p.neural + pulse * 0.6) * (0.5 + 0.5 * (pts[i].z + 1) / 2));
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
    pts.forEach((q, i) => {
      const on = (Math.sin(i * 12.9898 + Math.floor(ph.nodes) * 78.233) * 43758.5) % 1 > 1 - p.nodes * 0.35;
      ctx.fillStyle = col(on ? 0.95 : 0.35 * (0.5 + q.z / 2));
      ctx.beginPath();
      ctx.arc(q.x, q.y, on ? 2.6 : 1.2, 0, Math.PI * 2);
      ctx.fill();
    });

    // core body
    const coreR = unit * 1.15 * (1 + Math.sin(ph.pulse * Math.PI * 2) * 0.03 + this.level * 0.08);
    const body = ctx.createRadialGradient(cx - coreR * 0.25, cy - coreR * 0.3, coreR * 0.1, cx, cy, coreR);
    body.addColorStop(0, 'rgba(235,253,255,0.95)');
    body.addColorStop(0.3, col(0.55 * p.glow, p.violet * 0.5));
    body.addColorStop(0.85, col(0.15 * p.glow, p.violet));
    body.addColorStop(1, col(0.5 * p.glow));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // particles
    for (const pt of this.particles) {
      const a = pt.a + ph.particles * pt.s * (2.4 / pt.r);
      const x = cx + Math.cos(a) * pt.r * unit * ringScale;
      const y = cy + (Math.sin(a) * pt.r * 0.32 + pt.h + Math.sin(t + pt.a * 5) * p.turbulence) * unit;
      ctx.fillStyle = col(0.25 + 0.4 * ((Math.sin(a) + 1) / 2));
      ctx.fillRect(x, y, 1.6, 1.6);
    }

    // pathways to agent nodes
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6 + ph.core * 0.5;
      const ex = cx + Math.cos(a) * unit * 4.2;
      const ey = cy + Math.sin(a) * unit * 1.6;
      const on = this.input.activeAgents.includes(i) ? 1 : p.pathways * 0.25;
      ctx.strokeStyle = col(0.05 + on * 0.25, i % 2 ? 0.9 : 0);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * coreR, cy + Math.sin(a) * coreR * 0.4);
      ctx.quadraticCurveTo(cx + Math.cos(a) * unit * 2.6, cy + Math.sin(a) * unit * 1.2 + (i % 2 ? -1 : 1) * unit * 0.8, ex, ey);
      ctx.stroke();
      if (on > 0.3) {
        const k = (ph.paths + i * 0.17) % 1;
        const px = (1 - k) ** 2 * (cx + Math.cos(a) * coreR) + 2 * (1 - k) * k * (cx + Math.cos(a) * unit * 2.6) + k * k * ex;
        const py = (1 - k) ** 2 * (cy + Math.sin(a) * coreR * 0.4) + 2 * (1 - k) * k * (cy + Math.sin(a) * unit * 1.2 + (i % 2 ? -1 : 1) * unit * 0.8) + k * k * ey;
        ctx.fillStyle = col(0.95, i % 2 ? 0.9 : 0);
        ctx.beginPath();
        ctx.arc(px, py, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = col(0.3 + on * 0.6, i % 2 ? 0.9 : 0);
      ctx.beginPath();
      ctx.arc(ex, ey, 4 + on * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
