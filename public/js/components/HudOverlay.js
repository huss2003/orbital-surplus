// components/HudOverlay.js — product HUD shown when a jacket is focused on /shop/:slug
// (design-notes §2 Product + Product overlays, §3.3 barcode flicker, §4.7 overlay pattern).
//
// Left: name, Ref., price (red), DESCRIPTION [+] (79-char excerpt), MATERIAL [+] (hidden ≤1024).
// Right: [+] FIND YOUR SIZE, SIZES radiogroup (real buttons, aria-checked, arrow keys,
// sold-out sizes disabled), [ ADD TO VAULT ] → POST /api/cart/items, 2×2 previews → gallery.
// Bottom centre: barcode-styled link to /ar/:sku that opens the AR viewer modal.
import { h, createDialog } from '../core/dialog.js';
import { ScrambleText, scramble } from '../core/ScrambleText.js';
import { gsap } from '../core/gsap.js';
import { api, money } from '../core/api.js';
import { setCart, getSizeChart } from '../core/store.js';
import { sound } from '../core/sound.js';
import { reducedMotion } from '../core/env.js';

/** Decorative CODE128-looking bars derived from the URL (not a scannable barcode — the QR on /ar is). */
function barcodeSvg(text) {
  let x = 0, seed = 7; const rects = [];
  const bars = [2, 1, 1, 2, 3, 1];                                   // start-ish guard
  for (const ch of text) { seed = (seed * 31 + ch.charCodeAt(0)) % 9973; bars.push(1 + (seed % 3), 1 + ((seed >> 2) % 3), 1 + ((seed >> 4) % 2)); }
  bars.push(2, 3, 3, 1, 1, 1, 2);
  bars.forEach((w, i) => { if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="40"/>`); x += w; });
  return `<svg class="barcode" viewBox="0 0 ${x} 40" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

export function createHudOverlay({ onAdded, onOpenAr }) {
  let product = null, size = 'M', flicker = null;
  const reduced = reducedMotion();

  // ---- left column
  const nameEl = new ScrambleText('', { tag: 'h1', className: 'phud-name' });
  const refEl = new ScrambleText(''), priceEl = new ScrambleText('');
  const excerpt = h('p', { class: 'phud-text' });
  const matList = h('ul', { class: 'phud-list' });
  const descBtn = h('button', { class: 'phud-head', type: 'button', 'aria-haspopup': 'dialog' }, scramble('DESCRIPTION'), h('span', { 'aria-hidden': 'true' }, '[+]'));
  const matBtn = h('button', { class: 'phud-head', type: 'button', 'aria-haspopup': 'dialog' }, scramble('MATERIAL'), h('span', { 'aria-hidden': 'true' }, '[+]'));
  const left = h('div', { class: 'phud-col phud-left' },
    h('div', {}, nameEl.el),
    h('div', {}, h('p', { class: 'phud-ref' }, refEl.el), h('p', { class: 'phud-price' }, priceEl.el)),
    h('div', { class: 'phud-block phud-desc' }, descBtn, excerpt),
    h('div', { class: 'phud-block phud-material' }, matBtn, matList));

  // ---- right column
  const sizeBtn = h('button', { class: 'phud-head', type: 'button', 'aria-haspopup': 'dialog' }, h('span', { 'aria-hidden': 'true' }, '[+]'), scramble('FIND YOUR SIZE'));
  const sizesEl = h('div', { class: 'sizes', role: 'radiogroup', 'aria-labelledby': 'sizes-label' });
  const status = h('p', { class: 'phud-status', role: 'status', 'aria-live': 'polite' });
  const addBtn = h('button', { class: 'btn-bracket phud-add', type: 'button' }, '[ ADD TO CARGO ]');
  const previews = h('div', { class: 'previews' });
  const right = h('div', { class: 'phud-col phud-right' },
    sizeBtn,
    h('div', { class: 'phud-block' }, h('p', { class: 'sizes-label', id: 'sizes-label' }, 'SIZES'), sizesEl),
    addBtn, status, previews);

  const arLink = h('a', { class: 'phud-ar', href: '#', 'aria-label': 'View in AR' });

  const el = h('section', { class: 'phud', 'aria-label': 'Product details', hidden: true }, left, right, arLink);

  // ---- overlays
  const infoDesc = createDialog({ label: 'Description' });
  const infoMat = createDialog({ label: 'Material and care' });
  const infoSize = createDialog({ label: 'Size guide' });
  const gallery = createDialog({ label: 'Gallery', className: 'overlay--gallery', closeClass: 'gallery-close' });
  descBtn.addEventListener('click', () => { sound.play('click'); infoDesc.open(); });
  matBtn.addEventListener('click', () => { sound.play('click'); infoMat.open(); });
  sizeBtn.addEventListener('click', () => { sound.play('click'); renderSizeGuide(); infoSize.open(); });

  let unit = 'cm', chart = null;
  async function renderSizeGuide() {
    chart = chart || await getSizeChart();
    const b = infoSize.body; b.textContent = '';
    const toggle = h('div', { class: 'unit-toggle', role: 'group', 'aria-label': 'Units' });
    const table = h('table', { class: 'size-table' });
    const draw = () => {
      table.textContent = '';
      table.append(h('caption', {}, `Garment measurements in ${unit === 'cm' ? 'centimetres' : 'inches'}`));
      table.append(h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'DEPOT SIZE'), ...chart.sizes.map((s) => h('th', { scope: 'col' }, s)))));
      table.append(h('tbody', {}, ...chart.rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.label),
        ...r.values.map((v) => h('td', {}, scramble(unit === 'cm' ? String(v) : String(Math.round((v / 2.54) * 10) / 10))))))));
    };
    for (const u of ['cm', 'inches']) {
      const btn = h('button', { type: 'button', 'aria-pressed': String(unit === u) }, u.toUpperCase());
      btn.addEventListener('click', () => { unit = u; toggle.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn))); draw(); sound.play('click'); });
      toggle.append(btn);
    }
    draw();
    b.append(h('h2', { class: 'overlay-title' }, scramble('SIZE GUIDE')), toggle, table);
  }

  // ---- sizes radiogroup
  function renderSizes() {
    sizesEl.textContent = '';
    const avail = new Set(product.available_sizes);
    if (!avail.has(size)) size = product.sizes.find((s) => avail.has(s)) || product.sizes[0];
    for (const s of product.sizes) {
      const out = !avail.has(s);
      const b = h('button', { class: 'size', type: 'button', role: 'radio', 'aria-checked': String(s === size), 'aria-disabled': out ? 'true' : null, tabindex: s === size ? '0' : '-1', 'aria-label': out ? `${s}, sold out` : s }, s);
      b.addEventListener('click', () => { if (out) { status.className = 'phud-status is-error'; status.textContent = `${s} IS SOLD OUT`; return; } select(s, false); sound.play('click'); });
      sizesEl.append(b);
    }
  }
  function select(s, focus) {
    size = s;
    [...sizesEl.children].forEach((b) => { const on = b.textContent === s; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    status.className = 'phud-status'; status.textContent = '';
  }
  sizesEl.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const avail = product.sizes.filter((s) => product.available_sizes.includes(s));
    const i = avail.indexOf(size); select(avail[(i + dir + avail.length) % avail.length], true);
  });

  addBtn.addEventListener('click', async () => {
    if (!product) return;
    sound.play('click');
    addBtn.disabled = true; status.className = 'phud-status'; status.textContent = 'ADDING…';
    try {
      const cart = setCart(await api.addItem(product.slug, size, 1));
      status.textContent = `ADDED ${size} · CARGO (${cart.item_count})`;
      onAdded?.(cart);
    } catch (err) {
      status.className = 'phud-status is-error';
      status.textContent = err.code === 'OUT_OF_STOCK' ? 'OUT OF STOCK' : (err.message || 'COULD NOT ADD').toUpperCase();
    } finally { addBtn.disabled = false; }
  });

  arLink.addEventListener('click', (e) => { e.preventDefault(); sound.play('click'); onOpenAr?.(product); });

  function renderGallery(start = 0) {
    const b = gallery.body; b.textContent = '';
    const track = h('div', { class: 'gallery-track', tabindex: '0', 'aria-label': 'Product images' });
    const imgs = [...product.images, ...product.images];
    imgs.forEach((src, i) => track.append(h('img', { src, alt: `${product.name}, view ${i + 1}`, loading: 'lazy' })));
    const layout = h('div', { class: 'gallery-layout', role: 'group', 'aria-label': 'Layout' });
    for (const [k, label] of [['up', 'UPWARD'], ['right', 'RIGHTWARD']]) {
      const btn = h('button', { class: 'btn-bracket', type: 'button', 'aria-pressed': String(k === 'up') }, label);
      btn.addEventListener('click', () => { track.classList.toggle('is-right', k === 'right'); layout.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn))); sound.play('click'); });
      layout.append(btn);
    }
    b.append(layout, track);
    requestAnimationFrame(() => track.children[start]?.scrollIntoView({ block: 'center', inline: 'center' }));
  }

  return {
    el,
    show(p) {
      product = p;
      nameEl.setText(p.name); refEl.setText(`Ref. ${p.sku}`); priceEl.setText(money(p.price, p.currency));
      const d = (p.description || '').replace(/\s+/g, ' ');
      excerpt.textContent = d.length > 79 ? d.slice(0, 79) + '...' : d;
      matList.textContent = ''; p.materials.forEach((m) => matList.append(h('li', {}, m)));
      renderSizes(); status.textContent = '';
      previews.textContent = '';
      [0, 1, 0, 1].forEach((imgIdx, i) => {
        const b = h('button', { class: 'preview', type: 'button', 'aria-label': `Open gallery, image ${i + 1}` }, h('img', { src: p.images[imgIdx % p.images.length], alt: '' }));
        b.addEventListener('click', () => { sound.play('click'); renderGallery(i); gallery.open(); });
        previews.append(b);
      });
      const arUrl = `${location.origin}/ar/${p.sku}`;
      arLink.href = `/ar/${p.sku}`; arLink.innerHTML = barcodeSvg(arUrl) + '<span class="barcode-label">[ TAP TO VIEW IN AR ]</span>';
      infoDesc.body.textContent = ''; infoDesc.body.append(h('h2', { class: 'overlay-title' }, scramble('DESCRIPTION')), h('div', { class: 'overlay-body' }, p.description));
      infoMat.body.textContent = ''; infoMat.body.append(h('h2', { class: 'overlay-title' }, scramble('MATERIAL')), h('div', { class: 'overlay-body' },
        h('ol', {}, ...p.materials.map((m) => h('li', {}, m))), h('h3', { class: 'overlay-sub' }, 'CARE INSTRUCTIONS'), h('ol', {}, ...p.care.map((c) => h('li', {}, c)))));
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('is-in'));        // Vue fade .6s cubic-bezier(.19,1,.22,1)
      // §3.3 barcode: fade in .6 s power2.out, then bars flicker (opacity random .25–1, .15 s, yoyo, stagger .03 random)
      flicker?.kill?.();
      const svg = arLink.querySelector('.barcode');
      if (reduced) { svg.style.opacity = 1; return; }
      const tl = gsap.timeline(); flicker = tl;
      tl.to(svg, { opacity: 1, duration: 0.6, ease: 'power2.out', onComplete: () => {
        if (gsap.isFallback) return;
        tl.to(svg.querySelectorAll('rect'), { opacity: () => gsap.utils.random(0.25, 1), duration: 0.15, repeat: -1, yoyo: true, stagger: { each: 0.03, from: 'random' } });
      } });
    },
    hide() {
      el.classList.remove('is-in'); flicker?.kill?.();
      [infoDesc, infoMat, infoSize, gallery].forEach((d) => d.close());
      setTimeout(() => { if (!el.classList.contains('is-in')) el.hidden = true; }, 650);
    },
    destroy() { flicker?.kill?.(); [infoDesc, infoMat, infoSize, gallery].forEach((d) => d.destroy()); el.remove(); },
  };
}
