import { BOOT_SECONDS, DEFAULT_INPUT, STATE_PARAMS, coreStats, lerpParams, stage, type CoreInput, type CoreParams, type CoreRenderer } from './params';

/**
 * 2D fallback core (Canvas 2D). Same states, parameters and boot sequence as
 * the 3D core, drawn with projected ellipses: grid sphere, rings with energy
 * beads, reticles, particles, energy waves, radar sweep and agent pathways.
 * Used when WebGL is unavailable, when the device cannot hold a frame rate,
 * or by choice. `static` mode draws a single frame and stops (no ongoing cost).
 */

interface Particle {
  r: number;
  a: number;
  h: number;
  s: number;
}
interface Wave {
  t: number;
  dur: number;
  rgb: [number, number, number];
  i: number;
  max: number;
}

const TAU = Math.PI * 2;
const RGB = {
  cyan: [46, 230, 255],
  violet: [143, 123, 255],
  emerald: [61, 255, 176],
  red: [255, 77, 94],
  turq: [31, 242, 210],
  ice: [168, 220, 255],
  holo: [79, 141, 255],
} satisfies Record<string, [number, number, number]>;

export class Core2D implements CoreRenderer {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private last = 0;
  private w = 0;
  private h = 0;
  private dpr: number;
  private params: CoreParams = { ...STATE_PARAMS.idle };
  private input: CoreInput = DEFAULT_INPUT;
  private prevState = DEFAULT_INPUT.state;
  private level = 0;
  private activity = 0;
  private pointer = { x: 0, y: 0 };
  private phase = { core: 0, rings: 0, particles: 0, neural: 0, nodes: 0, paths: 0, pulse: 0, sweep: 0, grid: 0 };
  private particles: Particle[] = [];
  private nodes: { a: number; b: number; ph: number }[] = [];
  private waves: Wave[] = [];
  private waveClock = 0;
  private bootT = BOOT_SECONDS + 1;
  private frames = 0;
  private fpsAt = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private mode: 'animated' | 'static' = 'animated',
    lowPower = false,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 2);
    const n = lowPower ? 140 : 260;
    for (let i = 0; i < n; i++) this.particles.push({ r: 1.7 + Math.random() * 2.4, a: Math.random() * TAU, h: (Math.random() - 0.5) * 0.7, s: 0.4 + Math.random() });
    for (let i = 0; i < 46; i++) this.nodes.push({ a: Math.random() * TAU, b: Math.acos(2 * Math.random() - 1), ph: Math.random() });
    Object.assign(coreStats, { engine: mode === 'static' ? 'static' : '2d', pixelRatio: this.dpr, bloom: false, particles: n, fps: 0 });
  }

  update(input: CoreInput) {
    if (input.state !== this.prevState) {
      if (input.state === 'success') {
        this.spawn(RGB.emerald, 1.2, 2.4, 6);
        this.spawn(RGB.turq, 0.7, 2.8, 5);
      } else if (input.state === 'error') this.spawn(RGB.red, 0.8, 2.6, 4.6);
      this.prevState = input.state;
    }
    this.input = input;
    if (this.mode === 'static') {
      this.params = { ...STATE_PARAMS[input.state] };
      this.draw(0, performance.now() / 1000);
    }
  }

  boot(play: boolean) {
    this.bootT = play && this.mode !== 'static' && !this.input.reducedMotion ? 0 : BOOT_SECONDS + 1;
  }

  pulse() {
    if (this.mode === 'static') return;
    this.spawn(RGB.cyan, 0.9, 1.3, 4.2);
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
    this.fpsAt = this.last;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
  }

  private spawn(rgb: [number, number, number], i: number, dur: number, max: number) {
    this.waves.push({ t: 0, dur, rgb, i, max });
    if (this.waves.length > 6) this.waves.shift();
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (++this.frames >= 60) {
      coreStats.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
      this.frames = 0;
      this.fpsAt = now;
    }
    this.draw(dt, now / 1000);
  };

  private draw(dt: number, t: number) {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const input = this.input;
    const motion = input.reducedMotion ? 0.35 : 1;
    const k = (rate: number) => (dt ? 1 - Math.exp(-dt * rate) : 1);
    this.params = lerpParams(this.params, STATE_PARAMS[input.state], k(3.2));
    this.level += (input.level - this.level) * k(10);
    this.activity += (input.activity - this.activity) * k(1.5);
    this.pointer.x += (input.pointer.x - this.pointer.x) * k(2.5);
    this.pointer.y += (input.pointer.y - this.pointer.y) * k(2.5);
    const p = this.params;
    const act = this.activity;
    const ph = this.phase;
    ph.core += dt * p.spin * motion;
    ph.rings += dt * p.ringSpeed * (1 + act * 0.4) * motion;
    ph.particles += dt * p.particleSpeed * (1 + act * 0.6) * motion;
    ph.neural += dt * (0.25 + p.neural) * motion;
    ph.nodes += dt * (0.6 + p.nodes * 4) * motion;
    ph.paths += dt * (0.3 + p.pathways) * motion;
    ph.pulse += dt * p.pulseRate * motion;
    ph.sweep += dt * (1.1 + p.scan * 0.9) * motion;
    ph.grid += dt * (0.3 + p.grid * 0.4) * motion;
    if (this.bootT <= BOOT_SECONDS) this.bootT += dt;
    const b = this.bootT;
    const B = { particles: stage(b, 0, 1), core: stage(b, 0.5, 1), grid: stage(b, 0.95, 0.8), hud: stage(b, 2.45, 0.7), nodes: stage(b, 2.65, 0.6) };

    // waves
    if (b > BOOT_SECONDS && this.mode !== 'static') this.waveClock += dt * (p.waves * 0.55 + act * 0.25) * (input.reducedMotion ? 0.3 : 1);
    if (this.waveClock >= 1) {
      this.waveClock = 0;
      const s = input.state;
      this.spawn(s === 'thinking' ? RGB.violet : s === 'researching' ? RGB.turq : s === 'error' ? RGB.red : s === 'success' ? RGB.emerald : s === 'idle' ? RGB.holo : RGB.cyan, 0.45 + p.waves * 0.35, 2.2 + (1 - p.waves) * 1.4, 4.6);
    }

    const cx = w / 2 + this.pointer.x * 10;
    const cy = h / 2 - this.pointer.y * 8;
    const unit = Math.min(w, h) / 9.6;
    const base = p.emerald > 0.01 ? mix(RGB.cyan, RGB.emerald, p.emerald * 0.85) : RGB.cyan;
    const tinted = (rgb: number[]) => mix(p.emerald > 0.01 ? mix(rgb, RGB.emerald, p.emerald * 0.85) : rgb, RGB.red, p.tint * 0.9);
    const col = (a: number, rgb: number[] = base) => {
      const c = tinted(rgb);
      return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
    };
    const vio = mix(RGB.cyan, RGB.violet, Math.min(1, p.violet * 1.4));
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // glow
    const breath = 0.5 + 0.5 * Math.sin(ph.pulse * TAU);
    const glow = (p.glow + this.level * 0.25 + act * 0.12) * (0.93 + 0.07 * breath);
    const glowR = unit * (3.4 + this.level * 0.4);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    grad.addColorStop(0, col(0.3 * glow * B.core));
    grad.addColorStop(0.35, col(0.1 * glow * B.core, vio));
    grad.addColorStop(1, col(0));
    ctx.fillStyle = grad;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

    // radar sweep (research)
    if (p.scan > 0.02) {
      const R = unit * 4.1;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, 0.34);
      for (let i = 0; i < 24; i++) {
        const a0 = ph.sweep - i * 0.06;
        ctx.fillStyle = col(p.scan * 0.16 * (1 - i / 24), RGB.turq);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R, a0 - 0.06, a0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = col(p.scan * 0.25, RGB.turq);
      for (const f of [0.5, 0.75, 1]) {
        ctx.beginPath();
        ctx.arc(0, 0, R * f, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }

    // rings (projected ellipses) with beads
    const ringScale = p.ringScale - this.level * 0.08;
    const rings = [
      { r: 2.35, tilt: 0.28, rot: 0.3, dashes: 48, dir: 1, rgb: RGB.ice },
      { r: 2.7, tilt: 0.55, rot: -0.6, dashes: 0, dir: -1, rgb: RGB.cyan },
      { r: 3.05, tilt: 0.2, rot: 1.1, dashes: 96, dir: 1, rgb: RGB.violet },
      { r: 3.45, tilt: 0.38, rot: 2.0, dashes: 6, dir: -1, rgb: RGB.turq },
    ];
    rings.forEach((rg, i) => {
      const reveal = stage(b, 1.35 + i * 0.32, 0.6);
      if (reveal <= 0) return;
      const rx = rg.r * unit * ringScale;
      const ry = rx * rg.tilt;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rg.rot + ph.rings * 0.2 * rg.dir);
      ctx.strokeStyle = col(0.16 + 0.28 * p.glow, rg.rgb);
      ctx.lineWidth = 1;
      if (rg.dashes) ctx.setLineDash([Math.max(1, (Math.PI * rx) / rg.dashes), (Math.PI * rx) / rg.dashes]);
      ctx.lineDashOffset = -ph.rings * 40 * rg.dir * (i + 1);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, TAU * reveal);
      ctx.stroke();
      ctx.setLineDash([]);
      if (reveal >= 1 && p.beads > 0.05) {
        for (let j = 0; j < 2; j++) {
          const a = (ph.rings * rg.dir * 0.9 + j * Math.PI + i) % TAU;
          for (let tr = 0; tr < 6; tr++) {
            const aa = a - tr * 0.05 * rg.dir;
            ctx.fillStyle = col(p.beads * (1 - tr / 6) * 0.9, tr === 0 ? [235, 253, 255] : rg.rgb);
            ctx.beginPath();
            ctx.arc(Math.cos(aa) * rx, Math.sin(aa) * ry, 2.6 - tr * 0.3, 0, TAU);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    });

    // grid sphere: latitude ellipses and turning meridians
    if (B.grid > 0) {
      const GR = 1.42 * unit;
      ctx.lineWidth = 1;
      for (const lat of [-0.75, -0.45, -0.15, 0.15, 0.45, 0.75]) {
        const y = cy + lat * GR * 0.95;
        const rx = Math.sqrt(1 - lat * lat) * GR;
        const rip = Math.exp(-(((lat - (((ph.grid * 0.25) % 1) * 2.4 - 1.2)) / 0.15) ** 2));
        ctx.strokeStyle = col((0.06 + rip * 0.2) * p.grid * B.grid + (Math.abs(lat - Math.sin(t * 0.9) * 0.92) < 0.08 ? p.scan * 0.5 : 0), RGB.holo);
        ctx.beginPath();
        ctx.ellipse(cx, y, rx, rx * 0.16, 0, 0, TAU);
        ctx.stroke();
      }
      for (let m = 0; m < 8; m++) {
        const a = (m / 8) * Math.PI - ph.core * 1.6;
        const rx = Math.abs(Math.cos(a)) * GR;
        ctx.strokeStyle = col(0.07 * p.grid * B.grid * (0.4 + 0.6 * Math.abs(Math.sin(a))), RGB.holo);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, GR * 0.95, 0, 0, TAU);
        ctx.stroke();
      }
      if (p.scan > 0.02) {
        const sy = Math.sin(t * 0.9 * motion) * 0.92;
        const srx = Math.sqrt(1 - sy * sy) * GR;
        ctx.strokeStyle = col(p.scan * 0.85, RGB.turq);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, cy + sy * GR * 0.95, srx, srx * 0.16, 0, 0, TAU);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // neural nodes + links on a rotating sphere
    const pts = this.nodes.map((n) => {
      const a = n.a + ph.core * 1.5;
      const x = Math.sin(n.b) * Math.cos(a);
      const y = Math.cos(n.b);
      const z = Math.sin(n.b) * Math.sin(a);
      return { x: cx + x * 1.74 * unit, y: cy + y * 1.74 * unit * 0.95, z, ph: n.ph };
    });
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        if (dx * dx + dy * dy > (unit * 1.1) ** 2) continue;
        const pulse = Math.max(0, 1 - Math.abs(((ph.neural + pts[i].ph) % 1) - 0.5) * 6) * p.neural;
        ctx.strokeStyle = col((0.04 + 0.07 * p.neural + pulse * 0.55) * (0.5 + (0.5 * (pts[i].z + 1)) / 2) * B.grid, RGB.ice);
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
    pts.forEach((q, i) => {
      const on = Math.abs((Math.sin(i * 12.9898 + Math.floor(ph.nodes) * 78.233) * 43758.5) % 1) > 1 - p.nodes * 0.35;
      ctx.fillStyle = col((on ? 0.95 : 0.3 * (0.5 + q.z / 2)) * B.grid);
      ctx.beginPath();
      ctx.arc(q.x, q.y, on ? 2.6 : 1.2, 0, TAU);
      ctx.fill();
    });

    // core body
    const form = B.core;
    const coreR = unit * 1.15 * (0.15 + 0.85 * form) * (1 + Math.sin(ph.pulse * TAU) * 0.03 + this.level * 0.08);
    const body = ctx.createRadialGradient(cx - coreR * 0.25, cy - coreR * 0.3, coreR * 0.1, cx, cy, coreR);
    body.addColorStop(0, `rgba(235,253,255,${0.95 * form})`);
    body.addColorStop(0.3, col(0.5 * glow * form, mix(base, RGB.violet, p.violet * 0.5)));
    body.addColorStop(0.85, col(0.14 * glow * form, vio));
    body.addColorStop(1, col(0.5 * glow * form));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();
    // chromatic halo
    for (const [dr, rgb] of [[-1.5, RGB.holo], [0, base], [1.5, RGB.violet]] as const) {
      ctx.strokeStyle = col(0.12 * glow * form, rgb as number[]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 1.12 + dr, 0, TAU);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // particles
    for (const pt of this.particles) {
      const a = pt.a + ph.particles * pt.s * (2.4 / pt.r);
      const spread = 1 + (1 - B.particles) * 1.4;
      const x = cx + Math.cos(a) * pt.r * unit * ringScale * spread;
      const y = cy + (Math.sin(a) * pt.r * 0.32 + pt.h + Math.sin(t + pt.a * 5) * p.turbulence) * unit * spread;
      ctx.fillStyle = col((0.22 + 0.36 * ((Math.sin(a) + 1) / 2)) * B.particles, pt.s > 1.2 ? vio : base);
      ctx.fillRect(x, y, 1.6, 1.6);
    }

    // reticles and bezel
    if (B.hud > 0) {
      const arcs = [
        { r: 1.96, seg: 3, duty: 0.16, sp: 0.55 * (0.6 + p.spin * 3), a: 0.5, rgb: RGB.ice, lw: 1.5 },
        { r: 3.61, seg: 1, duty: 0.07, sp: -0.42 * (1 + p.ringSpeed), a: 0.7, rgb: RGB.turq, lw: 1.5 },
        { r: 3.74, seg: 4, duty: 0.19, sp: 0.06 * (1 + p.ringSpeed), a: 0.3, rgb: RGB.cyan, lw: 3 },
      ];
      arcs.forEach((arc) => {
        ctx.strokeStyle = col(arc.a * B.hud, arc.rgb);
        ctx.lineWidth = arc.lw;
        const rot = t * arc.sp * motion;
        for (let s = 0; s < arc.seg; s++) {
          const a0 = rot + (s / arc.seg) * TAU;
          ctx.beginPath();
          ctx.arc(cx, cy, arc.r * unit, a0, a0 + arc.duty * TAU);
          ctx.stroke();
        }
      });
      ctx.lineWidth = 1;
      ctx.fillStyle = col(0.3 * B.hud, RGB.ice);
      for (let i = 0; i < 120; i += 2) {
        const a = (i / 120) * TAU - ph.rings * 0.15;
        const r = (i % 10 === 0 ? 3.86 : 3.9) * unit;
        ctx.fillRect(cx + Math.cos(a) * r - 0.8, cy + Math.sin(a) * r - 0.8, i % 10 === 0 ? 2.4 : 1.4, i % 10 === 0 ? 2.4 : 1.4);
      }
    }

    // pathways to agent nodes
    const n = Math.max(1, input.agentCount);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.PI / n + ph.core * 0.5;
      const ex = cx + Math.cos(a) * unit * 4.2;
      const ey = cy + Math.sin(a) * unit * 1.6;
      const on = (input.activeAgents.includes(i) ? 1 : p.pathways * 0.25) * B.nodes;
      const rgb = i % 2 ? RGB.violet : RGB.cyan;
      const sx = cx + Math.cos(a) * coreR;
      const sy = cy + Math.sin(a) * coreR * 0.4;
      const qx = cx + Math.cos(a) * unit * 2.6;
      const qy = cy + Math.sin(a) * unit * 1.2 + (i % 2 ? -1 : 1) * unit * 0.8;
      ctx.strokeStyle = col((0.05 + on * 0.25) * B.nodes, rgb);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(qx, qy, ex, ey);
      ctx.stroke();
      if (on > 0.3) {
        const kk = (ph.paths + i * 0.17) % 1;
        const px = (1 - kk) ** 2 * sx + 2 * (1 - kk) * kk * qx + kk * kk * ex;
        const py = (1 - kk) ** 2 * sy + 2 * (1 - kk) * kk * qy + kk * kk * ey;
        ctx.fillStyle = col(0.95, rgb);
        ctx.beginPath();
        ctx.arc(px, py, 2.4, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = col((0.3 + on * 0.6) * B.nodes, rgb);
      ctx.beginPath();
      ctx.arc(ex, ey, 4 + on * 3, 0, TAU);
      ctx.stroke();
    }

    // energy waves
    this.waves = this.waves.filter((wv) => {
      wv.t += dt * (input.reducedMotion ? 0.6 : 1);
      const kk = wv.t / wv.dur;
      if (kk >= 1) return false;
      const r0 = 1.25 / wv.max;
      const prog = r0 + (1 - r0) * (1 - (1 - kk) ** 2.2);
      const R = prog * wv.max * unit;
      const a = (1 - prog) ** 1.4 * wv.i;
      ctx.lineWidth = 1.5 + prog * 2;
      ctx.strokeStyle = `rgba(${wv.rgb[0]},${wv.rgb[1]},${wv.rgb[2]},${a * 0.6})`;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      return true;
    });
    ctx.lineWidth = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function mix(a: readonly number[], b: readonly number[], k: number): number[] {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
