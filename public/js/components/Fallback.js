// components/Fallback.js — WebGL detection + static SVG fallback (the original had neither:
// `new WebGLRenderer()` simply threw inside onMounted, 3d-ar-notes §6).
import { h } from '../core/dialog.js';
import { hasWebGL } from '../core/env.js';

/** Dynamically import a scene module; null when WebGL2 is missing or the three CDN is down. */
export async function loadScene(name) {
  if (!hasWebGL()) return null;
  try {
    const m = await import(`../scenes/${name}.js`);
    return m;
  } catch (err) {
    console.warn(`[scene] ${name} unavailable (three.js CDN unreachable?) — static fallback`, err?.message);
    return null;
  }
}

/** Static product art grid, linking to the product routes. */
export function renderFallback(host, products, { note, linkTo = (p) => `/shop/${p.slug}` } = {}) {
  const wrap = h('div', { class: 'fallback' });
  for (const p of products) {
    wrap.append(h('a', { href: linkTo(p) }, h('figure', {}, h('img', { src: p.images[0], alt: `${p.name}, front view`, width: 340, height: 420 }), h('figcaption', {}, p.name))));
  }
  host.append(wrap);
  host.append(h('p', { class: 'fallback-note' }, note || (hasWebGL() ? '3D unavailable (could not load three.js) — showing static images.' : 'WebGL2 is not available on this device — showing static images.')));
  return wrap;
}
