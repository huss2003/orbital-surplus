// core/cursor.js — 4-square custom cursor (design-notes §4.2).
// JS moves it 1:1 (no lerp) and only sets --size / toggles classes; CSS does the morph.
// Not created on coarse pointers or ≤768px: the system cursor is kept on touch devices.
import { gsap } from './gsap.js';
import { isCoarse } from './env.js';

let root = null, open = false;

export function initCursor() {
  if (isCoarse() || innerWidth <= 768) return null;
  root = document.createElement('div');
  root.className = 'custom-cursor';
  root.setAttribute('aria-hidden', 'true');
  for (const c of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const s = document.createElement('div'); s.className = 'sub-square ' + c; root.append(s);
  }
  document.body.append(root);
  document.documentElement.classList.add('has-custom-cursor');

  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    root.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
  }, { capture: true, passive: true });
  addEventListener('pointerdown', () => root.classList.add('active'), { capture: true, passive: true });
  addEventListener('pointerup', () => root.classList.remove('active'), { capture: true, passive: true });
  document.addEventListener('mouseleave', () => { root.style.transform = 'translate3d(-100px,-100px,0)'; });

  // Hovering anything interactive turns the squares white (tween #15)
  const SEL = 'a, button, [role="radio"], [role="button"], input, select, label, summary';
  document.addEventListener('pointerover', (e) => { if (!open && e.target.closest?.(SEL)) white(true); });
  document.addEventListener('pointerout', (e) => { if (!open && e.target.closest?.(SEL) && !e.relatedTarget?.closest?.(SEL)) white(false); });
  return root;
}

function white(on) {
  if (!root) return;
  gsap.to(root.querySelectorAll('.sub-square'), on
    ? { backgroundColor: '#ffffff', duration: 0.3, delay: 0.1, ease: 'sine.inOut', overwrite: 'auto' }
    : { backgroundColor: '#C8FF2E', duration: 0.3, ease: 'sine.inOut', overwrite: 'auto' });
}

export const cursor = {
  /** Open into a dashed frame of `px` size (home hover reveal); squares fly to the corners and blink. */
  open(px) {
    if (!root) return;
    if (px > 14) {
      root.style.setProperty('--size', `${Math.round(px * 2) / 2}px`);
      if (!open) { root.classList.add('is-open'); white(true); open = true; }
    } else this.close();
  },
  close() {
    if (!root || !open) return;
    open = false; root.classList.remove('is-open'); root.style.removeProperty('--size'); white(false);
  },
  native(on) { document.documentElement.classList.toggle('cursor-native', !!on); },
};
