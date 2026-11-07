import type { CoreState, GraphicsQuality } from '@tc/shared';

/** Visual parameters per system state. Renderers ease toward these targets. */
export interface CoreParams {
  spin: number; // core rotation speed
  ringSpeed: number;
  ringScale: number; // <1 = contracted
  particleSpeed: number;
  turbulence: number;
  neural: number; // pulses along neural connections
  nodes: number; // information node activation
  pathways: number; // energy toward agent nodes
  glow: number;
  displacement: number;
  pulseRate: number;
  waves: number; // expanding energy / scanning waves (rate & intensity)
  scan: number; // radar sweep + latitude scan beam
  fragments: number; // orbiting data fragments
  beads: number; // energy travelling along orbital rings
  grid: number; // wireframe-sphere grid brightness
  tint: number; // 0 = cyan, 1 = red warning
  emerald: number; // success energy
  violet: number; // violet accent mix
}

export const STATE_PARAMS: Record<CoreState, CoreParams> = {
  idle:        { spin: 0.07, ringSpeed: 0.12, ringScale: 1, particleSpeed: 0.1, turbulence: 0.05, neural: 0.12, nodes: 0.1, pathways: 0, glow: 0.7, displacement: 0.035, pulseRate: 0.32, waves: 0.15, scan: 0, fragments: 0, beads: 0.35, grid: 0.35, tint: 0, emerald: 0, violet: 0.15 },
  listening:   { spin: 0.12, ringSpeed: 0.55, ringScale: 0.8, particleSpeed: 0.28, turbulence: 0.1, neural: 0.3, nodes: 0.2, pathways: 0, glow: 1.0, displacement: 0.06, pulseRate: 1.3, waves: 0.55, scan: 0, fragments: 0, beads: 0.6, grid: 0.6, tint: 0, emerald: 0, violet: 0.05 },
  thinking:    { spin: 0.34, ringSpeed: 0.7, ringScale: 0.96, particleSpeed: 0.9, turbulence: 0.22, neural: 1.0, nodes: 0.45, pathways: 0.2, glow: 1.05, displacement: 0.085, pulseRate: 2.1, waves: 0.9, scan: 0.1, fragments: 0.2, beads: 1.0, grid: 0.7, tint: 0, emerald: 0, violet: 0.55 },
  researching: { spin: 0.2, ringSpeed: 0.42, ringScale: 1.02, particleSpeed: 0.5, turbulence: 0.14, neural: 0.6, nodes: 1.0, pathways: 0.3, glow: 0.95, displacement: 0.05, pulseRate: 1.5, waves: 0.45, scan: 1.0, fragments: 1.0, beads: 0.7, grid: 0.9, tint: 0, emerald: 0, violet: 0.3 },
  executing:   { spin: 0.3, ringSpeed: 1.05, ringScale: 1.0, particleSpeed: 0.75, turbulence: 0.16, neural: 0.55, nodes: 0.35, pathways: 1.0, glow: 1.15, displacement: 0.06, pulseRate: 1.8, waves: 0.7, scan: 0.25, fragments: 0.35, beads: 1.0, grid: 0.6, tint: 0, emerald: 0, violet: 0.15 },
  speaking:    { spin: 0.14, ringSpeed: 0.34, ringScale: 0.94, particleSpeed: 0.3, turbulence: 0.08, neural: 0.35, nodes: 0.15, pathways: 0, glow: 0.92, displacement: 0.05, pulseRate: 1.0, waves: 0.5, scan: 0, fragments: 0, beads: 0.6, grid: 0.5, tint: 0, emerald: 0, violet: 0.4 },
  error:       { spin: 0.04, ringSpeed: 0.08, ringScale: 1.04, particleSpeed: 0.07, turbulence: 0.03, neural: 0.05, nodes: 0.05, pathways: 0, glow: 0.7, displacement: 0.02, pulseRate: 0.9, waves: 0.35, scan: 0, fragments: 0, beads: 0.15, grid: 0.4, tint: 1, emerald: 0, violet: 0 },
  success:     { spin: 0.16, ringSpeed: 0.5, ringScale: 1.06, particleSpeed: 0.45, turbulence: 0.12, neural: 0.5, nodes: 0.4, pathways: 0.4, glow: 1.1, displacement: 0.05, pulseRate: 1.2, waves: 1.0, scan: 0, fragments: 0, beads: 0.9, grid: 0.8, tint: 0, emerald: 1, violet: 0 },
};

export const STATE_LABEL: Record<CoreState, string> = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  researching: 'Researching',
  executing: 'Executing',
  speaking: 'Speaking',
  error: 'Attention',
  success: 'Complete',
};

export function lerpParams(cur: CoreParams, target: CoreParams, k: number): CoreParams {
  const out = { ...cur };
  for (const key of Object.keys(target) as (keyof CoreParams)[]) out[key] = cur[key] + (target[key] - cur[key]) * k;
  return out;
}

export interface CoreInput {
  state: CoreState;
  level: number; // 0..1 speech / microphone energy (from real recognition and word-boundary events)
  activity: number; // 0..1 recent system activity (events per minute, normalised)
  activeAgents: number[]; // indices of agents currently working
  agentCount: number;
  reducedMotion: boolean;
  pointer: { x: number; y: number }; // -1..1, for parallax
}

export const DEFAULT_INPUT: CoreInput = { state: 'idle', level: 0, activity: 0, activeAgents: [], agentCount: 7, reducedMotion: false, pointer: { x: 0, y: 0 } };

export interface CoreStats {
  engine: '3d' | '2d' | 'static';
  fps: number;
  pixelRatio: number;
  quality: GraphicsQuality;
  bloom: boolean;
  particles: number;
}

/** Last measured renderer statistics (read by the diagnostics view). */
export const coreStats: CoreStats = { engine: '2d', fps: 0, pixelRatio: 1, quality: 'balanced', bloom: false, particles: 0 };

/** Ease-out cubic progress of a boot stage that starts at `start` seconds and lasts `dur`. */
export function stage(t: number, start: number, dur: number): number {
  const k = Math.min(1, Math.max(0, (t - start) / dur));
  return 1 - (1 - k) ** 3;
}

/** Total length of the core materialisation sequence, seconds. */
export const BOOT_SECONDS = 3.4;

export interface CoreRenderer {
  update(input: CoreInput): void;
  resize(w: number, h: number): void;
  start(): void;
  stop(): void;
  /** play=true runs the materialisation sequence (core forms, rings activate one by one); false completes it at once. */
  boot(play: boolean): void;
  /** A one-off energy pulse (a command was sent). */
  pulse(): void;
  dispose(): void;
}
