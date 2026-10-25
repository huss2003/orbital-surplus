// components/ArPage.js — /ar/:sku (ARPage) and the in-shop AR viewer modal (3d-ar-notes §3.2, §5;
// design-notes §2 AR). Full-screen black, [CLOSE] at left 32.03125vw, product name top right,
// viewer fades in (.6 s), action button at bottom: 9.375vw.
//   mobile:  [ VIEW IN YOUR SPACE ] — shown only when model-viewer reports canActivateAR
//   desktop: [ OPEN ON YOUR PHONE ] — a QR code for this /ar/:sku URL (the original had none)
import { h, createDialog } from '../core/dialog.js';
import { getProduct } from '../core/store.js';
import { isMobileUA } from '../core/env.js';
import { sound } from '../core/sound.js';
import { loadScene } from './Fallback.js';

/** Builds the viewer UI into `host`. Returns { destroy }. */
async function buildViewer(host, product, { onClose, closeAsLink = false }) {
  const close = closeAsLink
    ? h('a', { class: 'btn-bracket ar-close', href: '/shop' }, '[CLOSE]')
    : h('button', { class: 'btn-bracket ar-close', type: 'button' }, '[CLOSE]');
  if (!closeAsLink) close.addEventListener('click', () => { sound.play('click'); onClose?.(); });
  const name = h('h1', { class: 'ar-name' }, product.name.toUpperCase());
  const hint = h('p', { class: 'ar-hint', role: 'status', 'aria-live': 'polite' });
  const actions = h('div', { class: 'ar-actions' });
  host.append(close, name, actions);

  const Scene = await loadScene('ArViewer');
  let viewer = null;
  if (Scene) {
    try { viewer = Scene.createArViewer({ container: host, product }); } catch (err) { console.warn('[ar] viewer failed', err); }
  }
  if (!viewer) host.append(h('div', { class: 'fallback' }, h('figure', {}, h('img', { src: product.images[0], alt: `${product.name}, front view` }))));
  const url = `${location.origin}/ar/${product.sku}`;

  if (isMobileUA() && Scene) {
    hint.textContent = 'PREPARING AR…';
    actions.append(hint);
    Scene.mountArLauncher(host, product).then((ar) => {
      if (ar.canActivateAR) {
        const btn = h('button', { class: 'btn-bracket', type: 'button' }, '[ VIEW IN YOUR SPACE ]');
        btn.addEventListener('click', () => { sound.play('click'); ar.activate(); });
        actions.prepend(btn);
        hint.textContent = 'PLACES THE JACKET AT LIFE SIZE IN YOUR ROOM (WEBXR / QUICK LOOK).';
      } else hint.textContent = 'AR IS NOT SUPPORTED IN THIS BROWSER — DRAG TO ROTATE, PINCH TO ZOOM.';
    }).catch(() => { hint.textContent = 'AR COULD NOT LOAD — DRAG TO ROTATE.'; });
  } else {
    const qr = h('div', { class: 'ar-qr', id: 'ar-qr' });
    const btn = h('button', { class: 'btn-bracket', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ar-qr' }, '[ OPEN ON YOUR PHONE ]');
    const urlEl = h('p', { class: 'ar-qr-url' });
    let rendered = false;
    btn.addEventListener('click', async () => {
      sound.play('click');
      const open = !qr.classList.contains('is-open');
      qr.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', String(open));
      if (open && !rendered) { rendered = true; if (Scene) await Scene.renderQr(qr, url); else qr.textContent = url; urlEl.textContent = url; }
    });
    hint.textContent = 'AR NEEDS A PHONE: SCAN TO PLACE THE JACKET IN YOUR ROOM. DRAG TO ROTATE · SCROLL TO ZOOM.';
    actions.append(qr, urlEl, btn, hint);
  }
  return { destroy() { viewer?.destroy(); host.textContent = ''; }, focusTarget: close };
}

/** The in-shop modal (barcode click). Pauses the shop render loop while open. */
export function openArModal(product, { onClose } = {}) {
  let v = null;
  const dlg = createDialog({ label: `${product.name} in 3D and AR`, className: 'overlay--ar', preset: 'small', withClose: false,
    onClose: () => { setTimeout(() => { v?.destroy(); dlg.destroy(); }, 550); onClose?.(); } });
  dlg.body.className = ''; dlg.body.style.cssText = 'position:absolute;inset:0';
  dlg.open();
  buildViewer(dlg.body, product, { onClose: () => dlg.close() }).then((x) => { v = x; x.focusTarget.focus(); });
  return dlg;
}

export async function mount(root, route, ctx) {
  const product = await getProduct(route.params.sku);
  ctx.progress?.data(1);
  const stage = h('main', { class: 'ar-stage', id: 'main', tabindex: '-1' });
  root.append(stage);
  let v = null;
  if (!product) {
    document.title = 'Product not found — ORBITAL SURPLUS';
    stage.append(h('div', { class: 'ar-404' }, h('strong', {}, '404'), h('p', {}, 'Product not found'), h('a', { class: 'btn-outline', href: '/shop' }, '← Back to shop')));
  } else {
    document.title = `${product.name} in AR — ORBITAL SURPLUS`;
    v = await buildViewer(stage, product, { closeAsLink: true });
  }
  ctx.progress?.scene(1);
  return { ready: Promise.resolve(), destroy() { v?.destroy(); } };
}
