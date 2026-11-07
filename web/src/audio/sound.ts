/**
 * TOURBILLION CORE sound identity — every sound is synthesised live with the
 * Web Audio API (no samples, no third-party assets). The palette is built on
 * a D-minor-pentatonic "mechanism" motif: soft FM bells, filtered noise like
 * an escapement, and low sine swells, through a generated short reverb.
 *
 * Browsers only allow audio after a user gesture; `unlock()` is called from
 * the boot overlay tap. On iPadOS the session is set to "ambient" so the
 * ringer/silent switch is respected.
 */

export type SoundName = 'startup' | 'activate' | 'listen' | 'thinking' | 'deploy' | 'complete' | 'warning' | 'error' | 'shutdown' | 'tap';

const D = 146.83; // D3
const ratio = (semitones: number) => 2 ** (semitones / 12);

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wet: GainNode | null = null;
  private enabled = true;
  private volume = 0.6;
  private last = new Map<SoundName, number>();

  configure(enabled: boolean, volume: number) {
    this.enabled = enabled;
    this.volume = volume;
    if (this.master) this.master.gain.value = volume * 0.5;
  }

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture handler. */
  async unlock() {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'ambient';
    } catch {
      /* not supported */
    }
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume * 0.5;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      // Short generated reverb (exponentially decaying stereo noise).
      const conv = this.ctx.createConvolver();
      conv.buffer = this.impulse(1.8, 2.6);
      this.wet = this.ctx.createGain();
      this.wet.gain.value = 0.32;
      this.wet.connect(conv).connect(this.master);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    // iOS: a silent buffer inside the gesture fully unlocks output.
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start(0);
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
    return buf;
  }

  private out(pan = 0): AudioNode {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain();
    g.gain.value = 1;
    if (p) {
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.master!);
      p.connect(this.wet!);
    } else {
      g.connect(this.master!);
      g.connect(this.wet!);
    }
    return g;
  }

  /** FM bell: carrier + modulator with decaying index. */
  private bell(freq: number, t: number, dur: number, gain: number, pan = 0, brightness = 2.4) {
    const ctx = this.ctx!;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const env = ctx.createGain();
    car.type = 'sine';
    mod.type = 'sine';
    car.frequency.value = freq;
    mod.frequency.value = freq * 3.5;
    modGain.gain.setValueAtTime(freq * brightness, t);
    modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mod.connect(modGain).connect(car.frequency);
    car.connect(env).connect(this.out(pan));
    car.start(t);
    mod.start(t);
    car.stop(t + dur + 0.05);
    mod.stop(t + dur + 0.05);
  }

  private tone(type: OscillatorType, f0: number, f1: number, t: number, dur: number, gain: number, pan = 0, attack = 0.02) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const env = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(env).connect(this.out(pan));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Band-passed noise burst — the "escapement tick" texture. */
  private tick(t: number, freq: number, gain: number, dur = 0.05, pan = 0) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 8;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(this.out(pan));
    src.start(t);
  }

  private sweep(t: number, from: number, to: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(from, t);
    lp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.out());
    src.start(t);
  }

  play(name: SoundName) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const nowMs = performance.now();
    if (nowMs - (this.last.get(name) ?? 0) < 250) return; // debounce bursts
    this.last.set(name, nowMs);
    const t = this.ctx.currentTime + 0.01;
    switch (name) {
      case 'startup': {
        this.tone('sine', D / 2, D, t, 2.6, 0.35, 0, 0.9); // low swell
        this.sweep(t, 200, 3200, 1.6, 0.06);
        [0, 7, 12, 15, 19].forEach((s, i) => this.bell(D * 2 * ratio(s), t + 0.55 + i * 0.16, 1.8, 0.12, (i - 2) * 0.3));
        for (let i = 0; i < 6; i++) this.tick(t + 0.2 + i * 0.09, 3200 + i * 300, 0.12, 0.04, i % 2 ? 0.4 : -0.4);
        break;
      }
      case 'activate':
        this.bell(D * 4, t, 0.9, 0.14, -0.2);
        this.bell(D * 4 * ratio(7), t + 0.07, 1.1, 0.12, 0.2);
        break;
      case 'listen':
        this.tone('sine', D * 4 * ratio(3), D * 4 * ratio(10), t, 0.22, 0.12, 0, 0.01);
        this.tick(t, 4200, 0.05);
        break;
      case 'thinking':
        for (let i = 0; i < 4; i++) this.tick(t + i * 0.11, 2600 + i * 420, 0.06, 0.035, i % 2 ? 0.5 : -0.5);
        break;
      case 'deploy':
        this.sweep(t, 400, 2400, 0.45, 0.07);
        this.bell(D * 2 * ratio(12), t + 0.18, 0.8, 0.1, 0.3);
        this.bell(D * 2 * ratio(19), t + 0.28, 0.9, 0.08, -0.3);
        break;
      case 'complete':
        [0, 7, 15].forEach((s, i) => this.bell(D * 4 * ratio(s), t + i * 0.09, 1.4, 0.11, (i - 1) * 0.35, 1.6));
        break;
      case 'warning':
        this.bell(D * 2 * ratio(17), t, 0.5, 0.1, 0, 1.2);
        this.bell(D * 2 * ratio(12), t + 0.2, 0.7, 0.1, 0, 1.2);
        break;
      case 'error':
        this.tone('triangle', D * ratio(1), D * ratio(-2), t, 0.45, 0.14);
        this.tone('triangle', D, D * ratio(-3), t + 0.02, 0.5, 0.1);
        break;
      case 'shutdown':
        [19, 15, 12, 7, 0].forEach((s, i) => this.bell(D * 2 * ratio(s), t + i * 0.12, 1.2, 0.08, (2 - i) * 0.25));
        this.tone('sine', D, D / 2, t + 0.3, 1.8, 0.25, 0, 0.3);
        break;
      case 'tap':
        this.tick(t, 5200, 0.04, 0.025);
        break;
    }
  }
}

export const sound = new SoundEngine();
