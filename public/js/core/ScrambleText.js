// core/ScrambleText.js — the <ScrambleText> component (design-notes §3.1), vanilla.
//
// Props and algorithm are verbatim from overlayLock-*.js. Accessibility fix: the
// real string lives in an .sr-only span, the scrambling glyphs in an aria-hidden one.
import { reducedMotion } from './env.js';

const DEFAULT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+';

/** Presets used across the site */
export const PRESET = {
  // nav + footer buttons: "types itself in" over 400 ms with random glyphs
  nav: { scrambleSpeed: 40, maxIterations: 10, sequential: true, revealDirection: 'start', useOriginalCharsOnly: false },
  // HUD / overlay / price labels: 50 ms × 10, anagram of the label's own letters
  label: {},
  // ghost wordmarks + BuyNow "PORTFOLIO": scramble 500 ms, readable 300 ms, forever
  ghost: { loop: true, loopDelay: 300 },
};

export class ScrambleText {
  constructor(text, opts = {}) {
    this.o = { scrambleSpeed: 50, maxIterations: 10, sequential: false, revealDirection: 'start', useOriginalCharsOnly: true, characters: DEFAULT_CHARS, loop: false, loopDelay: 2000, hover: true, ...opts };
    this.el = document.createElement(opts.tag || 'span');
    this.el.className = 'scramble' + (opts.className ? ' ' + opts.className : '');
    this.sr = document.createElement('span'); this.sr.className = 'sr-only';
    this.vis = document.createElement('span'); this.vis.className = 'scramble-vis'; this.vis.setAttribute('aria-hidden', 'true');
    this.el.append(this.sr, this.vis);
    this.timer = 0; this.loopTimer = 0; this.wasConnected = false; this.born = performance.now();
    this.setText(text, false);
    if (this.o.hover) this.el.addEventListener('mouseenter', () => this.scramble());
    requestAnimationFrame(() => this.scramble());          // on mount
  }
  setText(text, rescramble = true) {
    this.text = String(text ?? '');
    this.sr.textContent = this.text;
    this.vis.textContent = this.text;
    if (rescramble) this.scramble();                        // when `text` changes
  }
  randomChar() {
    const pool = this.o.useOriginalCharsOnly ? this.text.replace(/\s/g, '') || this.o.characters : this.o.characters;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  stop() { clearInterval(this.timer); clearTimeout(this.loopTimer); this.vis.textContent = this.text; }
  alive() {
    if (this.el.isConnected) { this.wasConnected = true; return true; }
    // auto-cleanup: once mounted and then removed (route change), stop all timers
    return !this.wasConnected && performance.now() - this.born < 3000;
  }
  scramble() {
    clearInterval(this.timer); clearTimeout(this.loopTimer);
    if (reducedMotion() || !this.text) { this.vis.textContent = this.text; return; }
    const { scrambleSpeed, maxIterations, sequential, revealDirection, loop, loopDelay } = this.o;
    const chars = [...this.text];
    let i = 0;
    this.timer = setInterval(() => {
      if (!this.alive()) { this.stop(); return; }
      if (i >= maxIterations) {                               // done → show the real text
        this.vis.textContent = this.text; clearInterval(this.timer);
        if (loop) this.loopTimer = setTimeout(() => this.scramble(), loopDelay);
        return;
      }
      if (sequential) {                                       // reveal one char per tick
        const n = chars.length;
        this.vis.textContent = chars.map((c, idx) => {
          if (c === ' ' || c === '\n') return c;
          const show = revealDirection === 'start' ? idx <= i : revealDirection === 'end' ? idx >= n - i : Math.abs(idx - n / 2) <= i;
          return show ? c : this.randomChar();
        }).join('');
      } else {
        this.vis.textContent = chars.map((c) => (c === ' ' || c === '\n' ? c : this.randomChar())).join('');
      }
      i++;
    }, scrambleSpeed);
  }
}

/** Shorthand: returns the element. */
export const scramble = (text, opts) => new ScrambleText(text, opts).el;
