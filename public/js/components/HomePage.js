// components/HomePage.js — "/" (HomeSlider + HomeOverlay + ghost wordmark), and 404 via
// the same component with `notFound` (design-notes §2 Home / 404).
import { h } from '../core/dialog.js';
import { ScrambleText, PRESET } from '../core/ScrambleText.js';
import { getProducts } from '../core/store.js';
import { createHomeOverlay } from './HomeOverlay.js';
import { loadScene, renderFallback } from './Fallback.js';

const splitName = (n) => { const i = n.indexOf(' '); return i < 0 ? n : n.slice(0, i) + '\n' + n.slice(i + 1); };

export async function mount(root, route, ctx, { notFound = false } = {}) {
  document.title = notFound ? '404 — ORBITAL SURPLUS' : 'ORBITAL SURPLUS — outerwear depot in orbit, 2051';
  const products = await getProducts();
  ctx.progress?.data(1);
  const stage = h('div', { class: 'stage' });
  const ghost = new ScrambleText(notFound ? '404 PAGE\nNOT FOUND' : splitName(products[0].name), { ...PRESET.ghost, tag: 'p', className: `ghost ${notFound ? 'ghost--404' : ''}`, hover: false });
  if (!notFound) ghost.el.setAttribute('aria-hidden', 'true');
  ghost.el.inert = true;
  const main = h('main', { id: 'main', class: 'stage-main', tabindex: '-1' },
    h('h1', { class: 'sr-only' }, notFound ? 'Page not found' : 'ORBITAL SURPLUS — six jackets in real-time 3D'));
  root.append(ghost.el, stage, main);

  let overlay = null;
  if (!notFound) { overlay = createHomeOverlay({ variant: 'home' }); root.append(overlay.el); }

  // keyboard / screen-reader entry to the shop: the central click box as a real button
  const enter = h('button', { class: 'home-hit', type: 'button' }, 'Enter the depot (shop)');
  enter.addEventListener('click', () => ctx.navigate('/shop'));
  if (!notFound) main.append(enter);
  if (notFound) root.append(h('a', { class: 'return-link', href: '/' }, '[RETURN TO DEPOT]'));
  else main.append(h('ul', { class: 'sr-only' }, ...products.map((p) => h('li', {}, h('a', { href: `/shop/${p.slug}` }, p.name)))));

  const Scene = await loadScene('HomeSlider');
  let scene = null;
  if (Scene) {
    try {
      scene = Scene.createHomeSlider({
        container: stage, products: notFound ? [products[0]] : products, notFound,
        progress: (f) => ctx.progress?.scene(f),
        onLand: (p) => { ghost.setText(splitName(p.name)); overlay?.rekey(); },
        onActivate: () => ctx.navigate('/shop'),
      });
    } catch (err) { console.warn('[home] WebGL init failed', err); scene = null; }
  }
  if (!scene) { ctx.progress?.scene(1); if (!notFound) renderFallback(stage, products); }

  return {
    ready: scene ? scene.ready : Promise.resolve(),
    enter() { scene?.startIntro(); },
    destroy() { scene?.destroy(); overlay?.destroy(); ghost.stop(); },
  };
}
