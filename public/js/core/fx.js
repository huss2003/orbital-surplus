// core/fx.js — global dither/glitch easter-egg state (clicking the navbar mark).
import { emit } from './env.js';

export const fxState = { on: false };
export function toggleFx() {
  fxState.on = !fxState.on;
  document.documentElement.classList.toggle('is-glitching', fxState.on);
  setTimeout(() => document.documentElement.classList.toggle('is-glitching', false), fxState.on ? 600 : 0);
  emit('fx', fxState.on);
  return fxState.on;
}
