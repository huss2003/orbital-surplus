// components/ShopPage.js — /shop and /shop/:slug: one view, two states (design-notes §2 Shop /
// Product). Focusing a jacket router.replace()s /shop/:slug; Escape / empty click replaces /shop.
// A deep link auto-selects the nearest matching jacket once the intro dolly finishes.
import { h } from '../core/dialog.js';
import { ScrambleText, PRESET } from '../core/ScrambleText.js';
import { getProducts } from '../core/store.js';
import { createHomeOverlay } from './HomeOverlay.js';
import { createHudOverlay } from './HudOverlay.js';
import { loadScene, renderFallback } from './Fallback.js';
import { openArModal } from './ArPage.js';

export async function mount(root, route, ctx) {
  const products = await getProducts();
  ctx.progress?.data(1);
  const stage = h('div', { class: 'stage' });
  const ghost = new ScrambleText('', { ...PRESET.ghost, tag: 'p', className: 'ghost ghost--shop', hover: false });
  ghost.el.setAttribute('aria-hidden', 'true'); ghost.el.style.opacity = '0'; ghost.el.style.transition = 'opacity .6s ease';
  const main = h('main', { id: 'main', tabindex: '-1' }, h('h1', { class: 'sr-only' }, 'Shop — the depot'));
  const overlay = createHomeOverlay({ variant: 'shop' });
  let scene = null;

  const hud = createHudOverlay({
    onAdded: () => ctx.openCart?.(),
    onOpenAr: (p) => {
      scene?.setCovered(true);
      openArModal(p, { onClose: () => scene?.setCovered(false) });
    },
  });
  // keyboard path into the spatial grid (visible on focus)
  const kbd = h('div', { class: 'kbd-list', role: 'group', 'aria-label': 'Products' },
    ...products.map((p) => { const b = h('button', { class: 'btn-bracket', type: 'button' }, `[ ${p.name} ]`); b.addEventListener('click', () => select(p.slug)); return b; }));
  root.append(ghost.el, stage, overlay.el, main, kbd, hud.el);

  function showProduct(p) {
    document.title = `${p.name} — ORBITAL SURPLUS`;
    hud.show(p);
    ghost.setText(p.name); ghost.el.style.opacity = '1';
  }
  function hideProduct() {
    document.title = 'Shop — ORBITAL SURPLUS';
    hud.hide(); ghost.el.style.opacity = '0';
  }
  function select(slug) {
    const p = products.find((x) => x.slug === slug);
    if (!p) return;
    if (scene) scene.focusSlug(slug); else { showProduct(p); ctx.replace(`/shop/${slug}`); }
  }

  const Scene = await loadScene('ShopGrid');
  if (Scene) {
    try {
      scene = Scene.createShopGrid({
        container: stage, products, progress: (f) => ctx.progress?.scene(f),
        onFocus: (p) => { showProduct(p); if (location.pathname !== `/shop/${p.slug}`) ctx.replace(`/shop/${p.slug}`); },
        onUnfocus: () => { hideProduct(); if (location.pathname !== '/shop') ctx.replace('/shop'); },
      });
    } catch (err) { console.warn('[shop] WebGL init failed', err); scene = null; }
  }
  if (!scene) {
    ctx.progress?.scene(1);
    renderFallback(stage, products);
    stage.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); e.stopPropagation(); select(a.getAttribute('href').split('/').pop()); } }, true);
  }

  const apply = (r) => {
    const slug = r.params.slug;
    if (slug) {
      const p = products.find((x) => x.slug === slug);
      if (!p) { ctx.navigate(location.pathname, { replace: true, notFound: true }); return; }
      if (scene) scene.focusSlug(slug); else showProduct(p);
    } else { if (scene) scene.unfocus(); hideProduct(); }
  };
  const onEsc = (e) => { if (!scene && e.key === 'Escape' && !document.querySelector('.overlay[style*="visible"]')) { hideProduct(); ctx.replace('/shop'); } };
  addEventListener('keydown', onEsc);
  document.title = route.params.slug ? document.title : 'Shop — ORBITAL SURPLUS';

  return {
    ready: scene ? scene.ready : Promise.resolve(),
    enter() { scene?.startIntro(); apply(route); },
    /** same-view navigation (/shop ↔ /shop/:slug, back/forward): no curtain */
    update(r) { apply(r); return true; },
    destroy() { removeEventListener('keydown', onEsc); scene?.destroy(); hud.destroy(); overlay.destroy(); ghost.stop(); },
  };
}
