// core/sound.js — sound manager (design-notes §5) with WebAudio-synthesised blips
// instead of the original's encrypted mp3 files.
//
// Keys, volumes and timing match the original: click .5, woosh .6, drop .7,
// drag .45 (throttled to 120 ms, each grain cut at 90 ms), ambient loop at .1
// with a 600 ms fade-out. Difference (fix #4): sound starts OFF and only the
// SOUND toggle turns it on — no auto-enable on the first click.
import { storage, emit } from './env.js';

let ctx = null, master = null, ambient = null, noiseBuf = null;
let enabled = storage.get('os:sound') === '1';
let lastDrag = 0;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  // 1 s of white noise reused by woosh / drag / ambient
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

function env(gainNode, t0, peak, attack, release) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
  g.exponentialRampToValueAtTime(0.0001, t0 + attack + release);
}
function noiseSource() { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s; }

const SYNTH = {
  // short square "tick" — nav buttons, [CLOSE], toggles
  click(vol) {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.04);
    env(g, t, 0.25 * vol, 0.002, 0.05); o.connect(g).connect(master); o.start(t); o.stop(t + 0.08);
  },
  // band-passed noise sweep — every route change
  woosh(vol) {
    const t = ctx.currentTime, n = noiseSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.Q.value = 1.4; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3200, t + 0.35); f.frequency.exponentialRampToValueAtTime(500, t + 0.7);
    env(g, t, 0.5 * vol, 0.18, 0.55); n.connect(f).connect(g).connect(master); n.start(t); n.stop(t + 0.8);
  },
  // falling sine "thunk" — selecting a jacket
  drop(vol) {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    env(g, t, 0.6 * vol, 0.005, 0.32); o.connect(g).connect(master); o.start(t); o.stop(t + 0.4);
  },
  // granular tick, cut at 90 ms — slider movement
  drag(vol) {
    const t = ctx.currentTime, n = noiseSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'highpass'; f.frequency.value = 2400 + Math.random() * 1600;
    env(g, t, 0.18 * vol, 0.003, 0.08); n.connect(f).connect(g).connect(master); n.start(t, Math.random()); n.stop(t + 0.09);
  },
};
const VOL = { click: 0.5, woosh: 0.6, drop: 0.7, drag: 0.45 };

function startAmbient() {
  if (!ensureCtx() || ambient) return;
  const t = ctx.currentTime;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.1, t + 1.2); // played at .1
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), n = noiseSource(), ng = ctx.createGain();
  o1.type = 'sawtooth'; o1.frequency.value = 55; o2.type = 'sawtooth'; o2.frequency.value = 55.6; ng.gain.value = 0.08;
  const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 0.07; lfoG.gain.value = 180;
  lfo.connect(lfoG).connect(lp.frequency);
  o1.connect(lp); o2.connect(lp); n.connect(ng).connect(lp); lp.connect(g).connect(master);
  [o1, o2, n, lfo].forEach((s) => s.start(t));
  ambient = { g, nodes: [o1, o2, n, lfo] };
}
function stopAmbient() {
  if (!ambient) return;
  const { g, nodes } = ambient, t = ctx.currentTime;
  g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);              // fade(vol, 0, 600) then stop
  nodes.forEach((s) => s.stop(t + 0.65));
  ambient = null;
}

export const sound = {
  get enabled() { return enabled; },
  setEnabled(v) {
    enabled = !!v; storage.set('os:sound', enabled ? '1' : '0');
    if (enabled) { ensureCtx(); ctx?.resume?.(); startAmbient(); this.play('click'); } else stopAmbient();
    emit('sound', enabled);
  },
  toggle() { this.setEnabled(!enabled); },
  play(name) {
    if (!enabled || !ensureCtx() || ctx.state === 'suspended' && !ctx.resume) return;
    if (name === 'drag') { const now = performance.now(); if (now - lastDrag < 120) return; lastDrag = now; }
    try { SYNTH[name]?.(VOL[name] ?? 0.5); } catch { /* ignore */ }
  },
  /** Re-arm after a reload: browsers need a gesture before audio can start. */
  resumeOnGesture() {
    if (!enabled) return;
    const go = () => { ensureCtx(); ctx?.resume?.(); startAmbient(); window.removeEventListener('pointerdown', go); window.removeEventListener('keydown', go); };
    window.addEventListener('pointerdown', go, { once: true }); window.addEventListener('keydown', go, { once: true });
  },
};
