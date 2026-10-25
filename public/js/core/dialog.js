// core/dialog.js — the overlay open/close pattern (design-notes §4.7) plus the
// accessibility the original lacked: role="dialog", aria-modal, focus move,
// focus trap, Escape, focus restore, scrim click, ref-counted body lock.
import { gsap } from './gsap.js';
import { reducedMotion } from './env.js';
import { sound } from './sound.js';

export const dialogStack = [];
let locks = 0;
const lock = { acquire() { locks++; document.body.classList.add('is-locked'); }, release() { locks = Math.max(0, locks - 1); if (!locks) document.body.classList.remove('is-locked'); } };

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Presets: 'small' = Contact/BuyNow (tweens #9/#10), 'big' = Info/Gallery (#11). */
const PRESETS = {
  small: { open: { duration: 0.6, ease: 'expo.out' }, close: { duration: 0.5, ease: 'power2.inOut' } },
  big: { open: { duration: 0.8, ease: 'power4.inOut' }, close: { duration: 0.8, ease: 'power4.inOut' } },
};

/**
 * createDialog({ label, className, preset, closeLabel }) → { el, panel, body, open(), close(), isOpen }
 * `body` is where callers render content. Every dialog swallows wheel/pointer events
 * so the WebGL scene behind it can't be panned (@wheel.stop in the original).
 */
export function createDialog({ label, className = '', preset = 'big', withClose = true, closeClass = 'overlay-close', onClose, labelledBy } = {}) {
  const el = document.createElement('div');
  el.className = `overlay ${className}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (labelledBy) el.setAttribute('aria-labelledby', labelledBy); else el.setAttribute('aria-label', label || 'Dialog');
  el.tabIndex = -1;
  const inner = document.createElement('div'); inner.className = 'overlay-inner';
  el.append(inner);
  let closeBtn = null;
  if (withClose) {
    closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = `btn-bracket ${closeClass}`; closeBtn.textContent = '[CLOSE]';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => { sound.play('click'); api.close(); });
    el.append(closeBtn);
  }
  ['wheel', 'pointerdown', 'pointermove', 'touchstart', 'touchmove'].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));
  el.addEventListener('click', (e) => { if (e.target === el || e.target === inner) api.close(); }); // @click.self
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); api.close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  let opener = null;
  const P = PRESETS[preset] || PRESETS.big;
  const api = {
    el, body: inner, closeBtn, isOpen: false,
    open() {
      if (api.isOpen) return;
      if (!el.isConnected) document.body.append(el);
      api.isOpen = true; opener = document.activeElement; dialogStack.push(api); lock.acquire();
      gsap.killTweensOf(el);
      gsap.set(el, { autoAlpha: 0, visibility: 'visible', pointerEvents: 'auto' });
      gsap.to(el, { autoAlpha: 1, ...P.open, duration: reducedMotion() ? 0.15 : P.open.duration });
      requestAnimationFrame(() => (el.querySelector('[autofocus]') || closeBtn || el).focus({ preventScroll: true }));
    },
    close() {
      if (!api.isOpen) return;
      api.isOpen = false;
      const i = dialogStack.indexOf(api); if (i >= 0) dialogStack.splice(i, 1);
      gsap.killTweensOf(el);
      gsap.to(el, {
        autoAlpha: 0, ...P.close, duration: reducedMotion() ? 0.15 : P.close.duration,
        onComplete: () => { gsap.set(el, { visibility: 'hidden', pointerEvents: 'none' }); lock.release(); },
      });
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      onClose?.();
    },
    destroy() { if (api.isOpen) { api.isOpen = false; const i = dialogStack.indexOf(api); if (i >= 0) dialogStack.splice(i, 1); lock.release(); } el.remove(); },
  };
  return api;
}

/** Tiny hyperscript helper used by the components. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
