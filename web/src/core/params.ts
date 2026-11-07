import type { CoreState } from '@tc/shared';

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
  tint: number; // 0 = cyan, 1 = amber warning
  violet: number; // violet accent mix
}

export const STATE_PARAMS: Record<CoreState, CoreParams> = {
  idle: { spin: 0.08, ringSpeed: 0.14, ringScale: 1, particleSpeed: 0.12, turbulence: 0.05, neural: 0.12, nodes: 0.1, pathways: 0, glow: 0.72, displacement: 0.035, pulseRate: 0.55, tint: 0, violet: 0.15 },
  listening: { spin: 0.12, ringSpeed: 0.55, ringScale: 0.8, particleSpeed: 0.28, turbulence: 0.1, neural: 0.3, nodes: 0.2, pathways: 0, glow: 1.0, displacement: 0.06, pulseRate: 1.3, tint: 0, violet: 0.05 },
  thinking: { spin: 0.32, ringSpeed: 0.62, ringScale: 0.96, particleSpeed: 0.85, turbulence: 0.22, neural: 1.0, nodes: 0.45, pathways: 0.15, glow: 1.05, displacement: 0.085, pulseRate: 2.1, tint: 0, violet: 0.55 },
  researching: { spin: 0.2, ringSpeed: 0.42, ringScale: 1.02, particleSpeed: 0.5, turbulence: 0.14, neural: 0.6, nodes: 1.0, pathways: 0.3, glow: 0.95, displacement: 0.05, pulseRate: 1.5, tint: 0, violet: 0.3 },
  executing: { spin: 0.26, ringSpeed: 0.95, ringScale: 1.0, particleSpeed: 0.6, turbulence: 0.16, neural: 0.55, nodes: 0.35, pathways: 1.0, glow: 1.1, displacement: 0.06, pulseRate: 1.7, tint: 0, violet: 0.25 },
  speaking: { spin: 0.14, ringSpeed: 0.34, ringScale: 0.94, particleSpeed: 0.3, turbulence: 0.08, neural: 0.35, nodes: 0.15, pathways: 0, glow: 0.92, displacement: 0.05, pulseRate: 1.0, tint: 0, violet: 0.4 },
  error: { spin: 0.04, ringSpeed: 0.08, ringScale: 1.04, particleSpeed: 0.07, turbulence: 0.03, neural: 0.05, nodes: 0.05, pathways: 0, glow: 0.66, displacement: 0.02, pulseRate: 0.4, tint: 1, violet: 0 },
};

export const STATE_LABEL: Record<CoreState, string> = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  researching: 'Researching',
  executing: 'Executing',
  speaking: 'Speaking',
  error: 'Attention',
};

export function lerpParams(cur: CoreParams, target: CoreParams, k: number): CoreParams {
  const out = { ...cur };
  for (const key of Object.keys(target) as (keyof CoreParams)[]) out[key] = cur[key] + (target[key] - cur[key]) * k;
  return out;
}

export interface CoreInput {
  state: CoreState;
  level: number; // 0..1 audio / speech energy
  activeAgents: number[]; // indices 0..5 of agents currently working
  reducedMotion: boolean;
}

export interface CoreRenderer {
  update(input: CoreInput): void;
  resize(w: number, h: number): void;
  start(): void;
  stop(): void;
  dispose(): void;
}
