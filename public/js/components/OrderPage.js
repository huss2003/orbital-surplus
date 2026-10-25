// components/OrderPage.js — /order/:token (GET /api/orders/:token[?session_id=…]).
// Stripe's success_url lands here with ?session_id: the server confirms the payment with
// Stripe before answering, so the page shows PAID straight away even if the webhook is late.
// The unguessable token is the "auth": whoever has the link can see the order.
import { h } from '../core/dialog.js';
import { api, money } from '../core/api.js';
import { refreshCart } from '../core/store.js';

const STEPS = [['paid', 'PAID'], ['packing', 'PACKING'], ['fulfilled', 'LAUNCHED'], ['delivered', 'DOCKED']];

function tracker(o) {
  const at = o.status === 'fulfilled' ? 2 : o.status === 'paid' ? 1 : -1;
  return h('ol', { class: 'track', 'aria-label': 'Order progress' }, ...STEPS.map(([, label], i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' },
    label,
    i === 0 && o.paid_at ? h('small', {}, new Date(o.paid_at).toLocaleString()) : null,
    i === 2 && o.fulfilled_at ? h('small', {}, new Date(o.fulfilled_at).toLocaleString()) : null)));
}

const HEADLINE = {
  paid: (o) => `PAYMENT RECEIVED${o.name ? ', ' + o.name.split(' ')[0].toUpperCase() : ''}. A CONFIRMATION IS ON ITS WAY TO ${o.email.toUpperCase()}.`,
  fulfilled: (o) => `YOUR CARGO HAS LAUNCHED${o.tracking ? ` — ${o.tracking.carrier.toUpperCase()} ${o.tracking.number}` : ''}.`,
  pending: () => 'WAITING FOR PAYMENT. YOUR SIZES ARE HELD UNTIL THE TIMER RUNS OUT.',
  expired: () => 'THIS CHECKOUT EXPIRED BEFORE PAYMENT, SO THE STOCK WENT BACK ON THE SHELF.',
  cancelled: () => 'THIS CHECKOUT WAS CANCELLED. NO PAYMENT WAS TAKEN.',
  refunded: (o) => `REFUNDED ${money(o.refunded, o.currency)}.`,
};

export async function mount(root, route, ctx) {
  document.title = 'Order — ORBITAL SURPLUS';
  root.classList.add('is-scroll');
  const inner = h('div', { class: 'shop-page-inner' });
  root.append(h('main', { class: 'shop-page', id: 'main', tabindex: '-1' }, inner));
  const sessionId = new URLSearchParams(location.search).get('session_id');
  try {
    let o = await api.order(route.params.token, sessionId);
    // webhook race: Stripe redirected before the payment settled — ask again a couple of times
    for (let i = 0; i < 3 && sessionId && o.status === 'pending'; i++) { await new Promise((r) => setTimeout(r, 1500)); o = await api.order(route.params.token, sessionId); }
    if (sessionId) history.replaceState({}, '', `/order/${encodeURIComponent(o.token)}`);
    if (o.status === 'paid' || o.status === 'fulfilled') refreshCart();
    ctx.progress?.data(1);
    document.title = `Order #${o.number} — ORBITAL SURPLUS`;
    const cur = o.currency || 'USD';
    const row = (l, v, cls = '') => h('tr', { class: cls }, h('th', { scope: 'row' }, l), h('td', {}, v));
    const a = o.address || {};
    const ok = ['paid', 'fulfilled'].includes(o.status);
    inner.append(...[
      h('h1', {}, `ORDER #${o.number} `, h('span', { class: 'badge' }, `[${o.status.toUpperCase()}]`)),
      ok ? tracker(o) : null,
      h('p', { class: ok ? 'form-ok' : 'form-error', role: 'status' }, (HEADLINE[o.status] || (() => ''))(o)),
      o.status === 'pending' && o.pay_url ? h('p', {}, h('a', { class: 'btn-bracket', href: o.pay_url }, '[ COMPLETE PAYMENT ]')) : null,
      h('div', { class: 'cols' },
        h('section', { 'aria-label': 'Items' }, h('h2', {}, 'CARGO'),
          h('ul', { class: 'cart-lines' }, ...(o.items || []).map((it) => h('li', { class: 'cart-line' }, h('img', { src: it.image, alt: '' }),
            h('div', {}, h('div', { class: 'cart-line-name' }, h('a', { href: `/shop/${it.slug}` }, it.name)), h('div', { class: 'cart-line-meta' }, `SIZE ${it.size} × ${it.quantity}${it.color ? ' · ' + it.color.toUpperCase() : ''}`)),
            h('div', { class: 'cart-line-right' }, money(it.line_total, cur))))),
          h('table', { class: 'totals' }, h('tbody', {},
            row('Subtotal', money(o.subtotal, cur)),
            o.discount?.amount ? row(`Discount (${o.discount.code})`, h('span', { class: 'neg' }, '−' + money(o.discount.amount, cur))) : null,
            row(`Shipping · ${o.shipping?.label || ''}`, o.shipping?.amount ? money(o.shipping.amount, cur) : 'FREE'),
            o.tax ? row('Tax', money(o.tax, cur)) : null,
            row('Total', money(o.total, cur), 'total'),
            o.refunded ? row('Refunded', h('span', { class: 'neg' }, '−' + money(o.refunded, cur))) : null))),
        h('section', { 'aria-label': 'Details' }, h('h2', {}, 'DETAILS'), h('dl', { class: 'order-meta' },
          h('dt', {}, 'Placed'), h('dd', {}, new Date(o.created_at).toLocaleString()),
          h('dt', {}, 'Ship to'), h('dd', {}, o.name, h('br'), [a.line1, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ')),
          h('dt', {}, 'Shipping'), h('dd', {}, `${o.shipping?.label || '—'}${o.shipping?.eta ? ' · ' + o.shipping.eta : ''}`),
          o.tracking ? [h('dt', {}, 'Tracking'), h('dd', {}, `${o.tracking.carrier} ${o.tracking.number}`)] : null,
          h('dt', {}, 'Payment'), h('dd', {}, o.payment ? `${(o.payment.brand || 'card').toUpperCase()}${o.payment.last4 ? ' ···· ' + o.payment.last4 : ''}` : '—')),
          h('p', { class: 'cart-line-meta' }, 'BOOKMARK THIS PAGE TO TRACK YOUR ORDER, OR ', h('a', { href: '/account' }, 'CREATE AN ACCOUNT'), ' WITH THE SAME EMAIL TO SEE IT THERE.'),
          h('a', { class: 'btn-bracket', href: '/shop' }, '[ BACK TO THE DEPOT ]')))].filter(Boolean));
  } catch (e) {
    ctx.progress?.data(1);
    inner.append(h('h1', {}, 'ORDER NOT FOUND'), h('p', { class: 'form-error' }, e.status === 404 ? 'This order link is invalid.' : e.message), h('a', { class: 'btn-bracket', href: '/shop' }, '[ BACK TO THE DEPOT ]'));
  }
  return { ready: Promise.resolve(), destroy() {} };
}
