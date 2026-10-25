// components/HomeOverlay.js — HomeOverlay / ShopOverlay micro HUD (design-notes §2 Home 4.).
// Top-centre manifesto block, two VAULT STATUS blocks (TIMESTAMP ticks every 1 s), five [X]
// cross marks. Every label is a ScrambleText; `rekey()` re-scrambles everything (the original
// re-keys the overlay each time the slider lands). Decorative → aria-hidden (fix #7).
// DISPLAY / CLIENT are computed instead of the original's hard-coded "@ 75HZ" + UA sniff (fix #8).
import { h } from '../core/dialog.js';
import { ScrambleText } from '../core/ScrambleText.js';

let measuredHz = 60;
(function measure() {
  let n = 0; const t0 = performance.now();
  const f = (t) => { n++; if (t - t0 < 1000) requestAnimationFrame(f); else measuredHz = Math.round((n * 1000) / (t - t0) / 5) * 5 || 60; };
  requestAnimationFrame(f);
})();
function clientName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand).filter((b) => !/not.?a.?brand|chromium/i.test(b));
  if (brands?.length) return brands[0].toUpperCase();
  const ua = navigator.userAgent;
  return /firefox/i.test(ua) ? 'FIREFOX' : /edg\//i.test(ua) ? 'EDGE' : /chrome/i.test(ua) ? 'CHROME' : /safari/i.test(ua) ? 'SAFARI' : 'BROWSER';
}

export function createHomeOverlay({ variant = 'home' } = {}) {
  const texts = [];
  const st = (t, o) => { const s = new ScrambleText(t, o); texts.push(s); return s; };
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
  const clock = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

  const top = h('p', { class: `hud-micro hud-top ${variant === 'shop' ? 'hud-top--shop' : ''}` },
    st('* ORBITAL SURPLUS / OUTERWEAR DEPOT / LOW ORBIT / 2051').el, '\n',
    st('SIX JACKETS · REAL-TIME 3D · TRY ON IN AR').el, '\n',
    st('PRESSURE-TESTED FOR VACUUM AND RAIN').el, '\n',
    st('BROWSE · HOLD · LAUNCH').el);

  const status = (cls) => {
    const ts = st(`TIMESTAMP: [${clock()}]`, { hover: false });
    const el = h('p', { class: `hud-micro hud-status ${cls}` },
      st('DEPOT STATUS').el, '\n------------\n\n',
      st(`SESSION  : [${today()}]`).el, '\n', ts.el, '\n', st('ASSETS   : (LOADED)').el, '\n\n',
      st(`DISPLAY  : (${screen.width}X${screen.height}PX @ ${measuredHz}HZ)`).el, '\n', st(`CLIENT   : (${clientName()})`).el, '\n', st('ORBIT    : (LEO-2051)').el);
    return { el, ts };
  };
  const left = status('hud-status--left'), right = status('hud-status--right');
  const tick = setInterval(() => { const v = `TIMESTAMP: [${clock()}]`; left.ts.text = v; left.ts.sr.textContent = v; left.ts.vis.textContent = v; right.ts.text = v; right.ts.sr.textContent = v; right.ts.vis.textContent = v; }, 1000);

  const crosses = [
    { top: '15%', left: '15%' }, { top: '35%', right: '40%' }, { bottom: '25%', left: '20%' }, { bottom: '15%', right: '8%' }, { top: '12%', right: '18%' },
  ].map((pos) => h('span', { class: 'cross', style: pos }, '[X]'));

  const el = h('div', { class: 'hud hud--micro', 'aria-hidden': 'true' }, top, ...(variant === 'home' ? [left.el, right.el] : []), ...crosses);
  return {
    el,
    rekey() { texts.forEach((t) => t.scramble()); },
    destroy() { clearInterval(tick); texts.forEach((t) => t.stop()); el.remove(); },
  };
}
