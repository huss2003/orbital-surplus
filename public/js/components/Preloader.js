// components/Preloader.js — "rotating decode" wordmark (design-notes §3.2).
//
// The word condenses out of noise as real loading progress arrives:
//   every 40 ms: rotate the word one char per 120 ms (marquee), then each char is
//   real with probability p * 0.8, else a random glyph. p is eased with a .3 s
//   power1.out tween so it never jumps. Exit: opacity → 0 over .5 s, delay .2,
//   power2.inOut; the loader gate resolves on exit start.
// Shown on the first visit only (original: every initial load of "/"), and it
// is skippable (fix #5): click, Enter, Space or Escape.
import { gsap } from '../core/gsap.js';
import { reducedMotion, storage } from '../core/env.js';

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*<>';

/** Weighted progress tracker (the original's w0()): value 0..0.999, 1 on complete(). */
export function createProgress() {
  const steps = []; const subs = new Set(); let done = false;
  const value = () => done ? 1 : Math.min(0.999, steps.reduce((a, s) => a + s.w * s.f, 0) / Math.max(1e-6, steps.reduce((a, s) => a + s.w, 0)));
  const notify = () => subs.forEach((f) => f(value()));
  return {
    step(w) { const s = { w, f: 0 }; steps.push(s); return (f) => { s.f = Math.max(s.f, Math.min(1, f)); notify(); }; },
    complete() { done = true; notify(); },
    subscribe(f) { subs.add(f); f(value()); return () => subs.delete(f); },
    get value() { return value(); },
  };
}

export const shouldShowPreloader = () => storage.get('os:visited') !== '1';

export function showPreloader(progress, word = 'ORBITAL SURPLUS') {
  storage.set('os:visited', '1');
  const wrap = document.createElement('div');
  wrap.className = 'preloader';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  const p = document.createElement('p'); p.className = 'preloader-word'; p.setAttribute('aria-hidden', 'true');
  const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = 'Loading ORBITAL SURPLUS…';
  const skip = document.createElement('button'); skip.className = 'preloader-skip'; skip.type = 'button'; skip.textContent = '[ SKIP ]';
  wrap.append(p, sr, skip);
  document.body.append(wrap);

  const pv = { val: 0 };
  let tick = 0, shift = 0, exiting = false, resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  const timer = setInterval(() => {
    tick++; if (tick % 3 === 0) shift++;                    // rotate one char every 120 ms
    if (pv.val >= 1 || reducedMotion()) { p.textContent = `[${word}]`; return; }
    const k = word.length - (shift % word.length);
    const rotated = word.slice(k) + word.slice(0, k);       // marquee-like rotation
    p.textContent = '[' + [...rotated].map((c) => (c === ' ' ? ' ' : Math.random() < pv.val * 0.8 ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('') + ']';
  }, 40);

  const exit = (delay) => {
    if (exiting) return; exiting = true;
    gsap.to(wrap, {
      opacity: 0, duration: reducedMotion() ? 0.2 : 0.5, delay, ease: 'power2.inOut',
      onStart: () => resolveGate(),
      onComplete: () => { clearInterval(timer); unsub(); wrap.remove(); },
    });
  };
  const unsub = progress.subscribe((v) => {
    gsap.to(pv, { val: v, duration: 0.3, ease: 'power1.out', overwrite: 'auto', onComplete: () => { if (v >= 1) exit(0.2); } });
  });
  const skipNow = () => { pv.val = 1; exit(0); };
  skip.addEventListener('click', (e) => { e.stopPropagation(); skipNow(); });
  wrap.addEventListener('click', skipNow);
  const onKey = (e) => { if (['Escape', 'Enter', ' '].includes(e.key)) { skipNow(); removeEventListener('keydown', onKey); } };
  addEventListener('keydown', onKey);
  return gate;
}
