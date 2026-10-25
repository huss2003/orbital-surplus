// components/CartDrawer.js — the cart the original never had.
// `renderCart(host)` draws lines (qty −/+, remove), discount code, totals and the checkout
// link from the API cart; it is reused by the drawer dialog and the full /cart page.
import { h, createDialog } from '../core/dialog.js';
import { api, money } from '../core/api.js';
import { cartState, setCart, refreshCart } from '../core/store.js';
import { on } from '../core/env.js';
import { sound } from '../core/sound.js';

export function renderCart(host, { onCheckout, headingLevel = 'h2' } = {}) {
  const live = h('p', { class: 'form-ok', role: 'status', 'aria-live': 'polite' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const body = h('div');
  host.append(body, live, err);

  const act = async (fn, msg) => {
    err.textContent = '';
    try { setCart(await fn()); if (msg) live.textContent = msg; sound.play('click'); }
    catch (e) { err.textContent = e.message; }
  };

  function draw(cart) {
    body.textContent = '';
    if (cartState.offline && !cart) { body.append(h('p', { class: 'cart-empty' }, 'THE DEPOT IS OFFLINE — TRY AGAIN IN A MOMENT.')); return; }
    if (!cart || !cart.items?.length) {
      body.append(h('p', { class: 'cart-empty' }, 'YOUR CARGO HOLD IS EMPTY.'), h('a', { class: 'btn-bracket', href: '/shop', 'data-close-drawer': '' }, '[ BROWSE THE DEPOT ]'));
      return;
    }
    const list = h('ul', { class: 'cart-lines', 'aria-label': 'Items in your cargo hold' });
    for (const it of cart.items) {
      const qty = h('output', { 'aria-live': 'polite', 'aria-label': `Quantity of ${it.name}` }, String(it.quantity));
      const minus = h('button', { class: 'btn-bracket', type: 'button', 'aria-label': `Decrease quantity of ${it.name} size ${it.size}` }, '[−]');
      const plus = h('button', { class: 'btn-bracket', type: 'button', 'aria-label': `Increase quantity of ${it.name} size ${it.size}` }, '[+]');
      const rm = h('button', { class: 'btn-bracket', type: 'button', 'aria-label': `Remove ${it.name} size ${it.size}` }, '[REMOVE]');
      minus.addEventListener('click', () => act(() => api.setQty(it.line_id, it.quantity - 1), it.quantity - 1 ? `${it.name}: ${it.quantity - 1}` : `${it.name} removed`));
      plus.addEventListener('click', () => act(() => api.setQty(it.line_id, it.quantity + 1), `${it.name}: ${it.quantity + 1}`));
      rm.addEventListener('click', () => act(() => api.removeItem(it.line_id), `${it.name} removed`));
      list.append(h('li', { class: 'cart-line' },
        h('img', { src: it.image || '/img/perigee-moto-jacket-front.png', alt: '' }),
        h('div', {}, h('div', { class: 'cart-line-name' }, it.name), h('div', { class: 'cart-line-meta' }, `SIZE ${it.size} · ${money(it.unit_price, cart.currency)}`),
          it.available < it.quantity ? h('div', { class: 'low-stock' }, it.available ? `ONLY ${it.available} LEFT — LOWER THE QUANTITY` : 'SOLD OUT — REMOVE TO CHECK OUT') : it.available <= 2 ? h('div', { class: 'low-stock' }, `${it.available} LEFT IN ${it.size}`) : null,
          h('div', { class: 'qty' }, minus, qty, plus)),
        h('div', { class: 'cart-line-right' }, h('span', {}, money(it.line_total, cart.currency)), rm)));
    }
    body.append(list);

    // discount code
    if (cart.discount?.code) {
      const rm = h('button', { class: 'btn-bracket', type: 'button' }, '[REMOVE]');
      rm.addEventListener('click', () => act(() => api.removeDiscount(), 'Discount removed'));
      body.append(h('div', { class: 'discount-applied' }, h('span', {}, `CODE ${cart.discount.code} APPLIED`), rm));
    } else {
      const input = h('input', { name: 'code', placeholder: 'CODE — TRY LAUNCH10', 'aria-label': 'Discount code', autocomplete: 'off', autocapitalize: 'characters' });
      const form = h('form', { class: 'discount-form' }, input, h('button', { class: 'btn-bracket', type: 'submit' }, '[APPLY]'));
      form.addEventListener('submit', (e) => { e.preventDefault(); const code = input.value.trim(); if (code) act(() => api.applyDiscount(code), `Code ${code.toUpperCase()} applied`); });
      body.append(form);
    }

    const row = (label, val, cls = '') => h('tr', { class: cls }, h('th', { scope: 'row' }, label), h('td', {}, val));
    body.append(h('table', { class: 'totals' }, h('tbody', {},
      row('Subtotal', money(cart.subtotal, cart.currency)),
      cart.discount?.amount ? row('Discount', h('span', { class: 'neg' }, '−' + money(cart.discount.amount, cart.currency))) : null,
      row('Shipping (US est.)', cart.shipping_estimate ? money(cart.shipping_estimate, cart.currency) : 'FREE'),
      row('Total', money(cart.total, cart.currency), 'total'))));
    if (cart.free_shipping_over) {
      const after = cart.subtotal - (cart.discount?.amount || 0);
      const left = cart.free_shipping_over - after;
      body.append(h('p', { class: 'free-ship' }, left > 0 ? `${money(left, cart.currency)} AWAY FROM FREE US GROUND SHUTTLE` : 'FREE US GROUND SHUTTLE UNLOCKED',
        h('i', {}, h('b', { style: { width: `${Math.min(100, (after / cart.free_shipping_over) * 100)}%` } }))));
    }
    const co = h('a', { class: 'btn-primary', href: '/checkout' }, '[ CHECKOUT ]');
    co.addEventListener('click', () => onCheckout?.());
    body.append(co);
  }
  draw(cartState.cart);
  const off = on('cart', draw);
  return { destroy: () => off() };
}

export function createCartDrawer() {
  const dlg = createDialog({ label: 'Your cargo hold', className: 'overlay--modal overlay--drawer', preset: 'small', withClose: false });
  const close = h('button', { class: 'btn-bracket', type: 'button', 'aria-label': 'Close cargo hold' }, '[CLOSE]');
  close.addEventListener('click', () => { sound.play('click'); dlg.close(); });
  const panel = h('div', { class: 'drawer' }, h('div', { class: 'drawer-head' }, h('h2', {}, 'CARGO HOLD'), close));
  dlg.body.append(panel);
  dlg.body.className = '';                           // the drawer is the panel, not the padded column
  dlg.body.style.cssText = 'position:absolute;inset:0';
  renderCart(panel, { onCheckout: () => dlg.close() });
  panel.addEventListener('click', (e) => { if (e.target.closest('[data-close-drawer]')) dlg.close(); });
  return {
    open() { refreshCart(); dlg.open(); requestAnimationFrame(() => close.focus()); },
    close: () => dlg.close(),
    get isOpen() { return dlg.isOpen; },
  };
}
