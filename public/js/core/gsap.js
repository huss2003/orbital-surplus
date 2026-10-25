// core/gsap.js — GSAP 3 wrapper with a no-GSAP fallback.
//
// Everything imports `gsap` from here. It starts as a tiny built-in tween engine
// (to / fromTo / set / timeline / killTweensOf / delayedCall, power*/sine/expo/circ
// eases, autoAlpha, x/y/scale on elements) and is swapped for real GSAP once the
// CDN module loads. `export let` is a live binding, so importers see the swap.
import { timeScale } from './env.js';

// ---------------------------------------------------------------- fallback engine
const BASE = {
  power1: (t) => t * t, quad: (t) => t * t,
  power2: (t) => t * t * t, cubic: (t) => t * t * t,
  power3: (t) => t ** 4, power4: (t) => t ** 5,
  sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  expo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
  circ: (t) => 1 - Math.sqrt(1 - t * t),
};
function parseEase(e) {
  if (typeof e === 'function') return e;
  if (e === 'none' || e === 'linear') return (t) => t;
  const [fam, type = 'out'] = String(e || 'power1.out').split('.');
  const b = BASE[fam] || BASE.power1;
  if (type === 'in') return b;
  if (type === 'out') return (t) => 1 - b(1 - t);
  return (t) => (t < 0.5 ? b(t * 2) / 2 : 1 - b((1 - t) * 2) / 2);
}
const RESERVED = new Set(['duration', 'delay', 'ease', 'onStart', 'onUpdate', 'onComplete', 'overwrite', 'repeat', 'yoyo', 'stagger', 'immediateRender', 'paused', 'repeatDelay']);
const toArr = (t) => (!t ? [] : typeof t === 'string' ? [...document.querySelectorAll(t)] : (t instanceof NodeList || Array.isArray(t)) ? [...t] : [t]);
const isEl = (o) => typeof Element !== 'undefined' && o instanceof Element;

function getProp(o, k) {
  if (isEl(o)) {
    if (k === 'opacity' || k === 'autoAlpha') { const v = parseFloat(o.style.opacity !== '' ? o.style.opacity : getComputedStyle(o).opacity); return isNaN(v) ? 1 : v; }
    if (k === 'x' || k === 'y') return o.__fx?.[k] ?? 0;
    if (k === 'scale') return o.__fx?.scale ?? 1;
    return o.style[k];
  }
  return o[k];
}
function setProp(o, k, v) {
  if (!isEl(o)) { o[k] = v; return; }
  if (k === 'opacity') o.style.opacity = v;
  else if (k === 'autoAlpha') { o.style.opacity = v; o.style.visibility = v <= 0.001 ? 'hidden' : 'visible'; }
  else if (k === 'x' || k === 'y' || k === 'scale') {
    o.__fx = { x: 0, y: 0, scale: 1, ...o.__fx, [k]: v };
    o.style.transform = `translate(${o.__fx.x}px, ${o.__fx.y}px) scale(${o.__fx.scale})`;
  } else o.style[k] = v;
}

const active = new Set();
let raf = 0;
function loop(now) {
  raf = 0;
  for (const tw of [...active]) step(tw, now);
  if (active.size) raf = requestAnimationFrame(loop);
}
const ensure = () => { if (!raf) raf = requestAnimationFrame(loop); };

function begin(tw) {
  tw.started = true;
  tw.props = [];
  tw.targets.forEach((o, i) => {
    for (const k in tw.vars) {
      if (RESERVED.has(k)) continue;
      let to = tw.vars[k]; if (typeof to === 'function') to = to(i, o);
      let from = tw.from && k in tw.from ? tw.from[k] : getProp(o, k);
      if (typeof from === 'function') from = from(i, o);
      const nf = parseFloat(from), nt = parseFloat(to);
      if (typeof to === 'number' || (!isNaN(nt) && String(to).trim() === String(nt))) {
        tw.props.push({ o, k, a: isNaN(nf) ? 0 : nf, b: nt });
      } else {
        // non-numeric: visibility:'visible' / pointerEvents:'auto' apply at start, the rest at the end
        if (k === 'visibility' || k === 'pointerEvents' || k === 'display') setProp(o, k, to);
        else tw.props.push({ o, k, end: to });
      }
    }
  });
  tw.vars.onStart?.();
}
function step(tw, now) {
  if (tw.dead) return;
  if (now < tw.start) return;
  if (!tw.started) begin(tw);
  const p = tw.dur <= 0 ? 1 : Math.min(1, (now - tw.start) / tw.dur);
  const e = tw.ease(p);
  for (const pr of tw.props) {
    if ('end' in pr) { if (p >= 1) setProp(pr.o, pr.k, pr.end); }
    else setProp(pr.o, pr.k, pr.a + (pr.b - pr.a) * e);
  }
  tw.vars.onUpdate?.();
  if (p >= 1) { tw.dead = true; active.delete(tw); tw.vars.onComplete?.(); tw._res?.(); }
}
function makeTween(targets, vars, from) {
  const tw = {
    targets: toArr(targets), vars, from, started: false, dead: false,
    dur: ((vars.duration ?? 0.5) * 1000) / timeScale, ease: parseEase(vars.ease),
    start: performance.now() + ((vars.delay || 0) * 1000) / timeScale,
    kill() { tw.dead = true; active.delete(tw); return tw; },
    progress() { return tw.dead ? 1 : 0; },
    isActive() { return !tw.dead; },
  };
  const pr = new Promise((r) => { tw._res = r; });
  tw.then = (a, b) => pr.then(a, b);
  if (vars.repeat === -1) { // infinite repeats are decorative; the fallback just lands on the end value
    tw.vars = { ...vars, repeat: 0, yoyo: false };
  }
  if (vars.overwrite) fallback.killTweensOf(targets);
  active.add(tw);
  step(tw, performance.now());
  ensure();
  return tw;
}
const fallback = {
  isFallback: true,
  to: (t, v) => makeTween(t, v),
  fromTo: (t, f, v) => makeTween(t, v, f),
  from: (t, f) => { const cur = {}; toArr(t).forEach((o) => { for (const k in f) if (!RESERVED.has(k)) cur[k] = getProp(o, k); }); return makeTween(t, { ...f, ...cur }, f); },
  set: (t, v) => makeTween(t, { ...v, duration: 0, delay: 0 }),
  killTweensOf(t) { const arr = toArr(t); for (const tw of [...active]) if (tw.targets.some((o) => arr.includes(o))) tw.kill(); },
  delayedCall(sec, fn) { const id = setTimeout(fn, (sec * 1000) / timeScale); return { kill: () => clearTimeout(id) }; },
  timeline() {
    let cursor = 0, last = 0; const kids = [];
    const tl = {
      to(t, v, pos) {
        const at = pos === '<' ? last : cursor;
        const tw = makeTween(t, { ...v, delay: at + (v.delay || 0) });
        kids.push(tw); last = at; cursor = Math.max(cursor, at + (v.delay || 0) + (v.duration ?? 0.5));
        return tl;
      },
      kill() { kids.forEach((k) => k.kill()); return tl; },
      then: (a, b) => Promise.all(kids.map((k) => k.then())).then(a, b),
    };
    return tl;
  },
  utils: { random: (a, b) => a + Math.random() * (b - a) },
  globalTimeline: { timeScale() {} },
  registerPlugin() {},
};

// ---------------------------------------------------------------- live binding
export let gsap = fallback;

/** Load real GSAP from the import map; keep the fallback if the CDN is unreachable. */
export async function loadGsap() {
  try {
    const m = await import('gsap');
    gsap = m.gsap || m.default;
    gsap.globalTimeline.timeScale(timeScale);
  } catch (err) {
    console.warn('[gsap] CDN unavailable, using the built-in fallback tween engine', err?.message);
  }
  return gsap;
}
