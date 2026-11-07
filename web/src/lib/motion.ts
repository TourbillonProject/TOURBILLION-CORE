/**
 * Pointer-driven interface motion, installed once:
 *  - cursor-following light: sets --mx/--my on the hovered surface (.spot)
 *  - magnetic hover: .magnetic elements lean a few pixels toward the pointer
 * Mouse/pen only (no effect on touch), and off when motion is reduced.
 */
let installed = false;

export function installMotion() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  let magnet: HTMLElement | null = null;
  const release = () => {
    if (magnet) magnet.style.translate = '';
    magnet = null;
  };
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch' || document.documentElement.dataset.motion !== 'full') return;
      const t = e.target as Element | null;
      const spot = t?.closest?.('.spot, .panel, .agent-card, .app-card') as HTMLElement | null;
      if (spot) {
        const r = spot.getBoundingClientRect();
        spot.style.setProperty('--mx', `${e.clientX - r.left}px`);
        spot.style.setProperty('--my', `${e.clientY - r.top}px`);
      }
      const m = t?.closest?.('.magnetic') as HTMLElement | null;
      if (m !== magnet) release();
      if (m) {
        magnet = m;
        const r = m.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
        const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
        m.style.translate = `${(dx * 6).toFixed(1)}px ${(dy * 5).toFixed(1)}px`;
      }
    },
    { passive: true },
  );
  document.addEventListener('pointerleave', release, true);
  window.addEventListener('blur', release);
}
