import type { Risk } from '@tc/shared';

/**
 * The permission gate. Pure function so it is trivially testable.
 *
 * - read: always allowed.
 * - write: allowed when the owner enabled auto-approval for low-risk writes,
 *          or when the tool was listed in a mission plan the owner approved.
 * - sensitive: always requires a fresh, per-call approval. Nothing — not a
 *          plan approval, not a setting, not model output — bypasses this.
 */
export function gateFor(risk: Risk, tool: string, autoApproveWrites: boolean, preApproved: string[]): 'allow' | 'approval' {
  if (risk === 'read') return 'allow';
  if (risk === 'write') return autoApproveWrites || preApproved.includes(tool) ? 'allow' : 'approval';
  return 'approval';
}
