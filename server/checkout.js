// server/checkout.js
// -----------------------------------------------------------------------------
// Checkout: pending order + stock hold → Stripe Checkout → paid order.
//
//   1. POST /api/checkout/session
//        validate address, price the cart on the server, and in ONE transaction take
//        the stock (conditional UPDATE … where stock >= qty) and insert a `pending`
//        order that expires in 31 minutes. Then create a Stripe Checkout Session.
//   2. The shopper pays on checkout.stripe.com.
//   3. Either the return page (/order/:token?session_id=…) or the signed webhook
//      marks the order paid. markPaid is idempotent, so whichever arrives first wins.
//   4. If the session expires or the shopper cancels, the order is released and
//      the stock goes back (webhook `checkout.session.expired`, the cancel_url, or a
//      lazy sweep that runs on checkout and admin requests).
//
// Without STRIPE_SECRET_KEY (local dev + tests) a built-in test card page stands in
// for Stripe: 4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 declines.
// -----------------------------------------------------------------------------
import crypto from 'node:crypto';
import * as store from './store.js';
import { AppError, q, one, tx, logEvent } from './store.js';
import * as stripe from './stripe.js';
import * as mail from './email.js';
import { vString, vEmail } from './security.js';

export const HOLD_MINUTES = 31;
const token = () => crypto.randomBytes(18).toString('base64url');

function validAddress(b) {
  const a = b.address || {};
  const country = vString(a.country, 'address.country', { max: 2, pattern: /^[A-Za-z]{2}$/ }).toUpperCase();
  return {
    line1: vString(a.line1, 'address.line1', { max: 120 }),
    line2: a.line2 ? vString(a.line2, 'address.line2', { min: 0, max: 120 }) : '',
    city: vString(a.city, 'address.city', { max: 80 }),
    state: a.state ? vString(a.state, 'address.state', { min: 0, max: 40 }).toUpperCase() : '',
    postal_code: vString(a.postal_code, 'address.postal_code', { max: 16 }),
    country,
  };
}

/** Create the pending order + Stripe session. Returns what the frontend needs to redirect. */
export async function createSession(cart, body, { origin, customer }) {
  await sweepExpired();
  const email = vEmail(body.email);
  const name = vString(body.name, 'name', { max: 100 });
  const address = validAddress(body);

  const { items, subtotal, discount, discountRow } = await store.cartTotals(cart);
  if (!items.length) throw new AppError(400, 'CART_EMPTY', 'Your cargo hold is empty.');
  if (items.some((i) => i.missing)) throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'An item in your cart is no longer sold. Remove it to continue.');

  const rates = store.shippingRates(address.country, subtotal - discount);
  const rate = rates.find((r) => r.id === body.shipping_rate) || rates[0];
  const tax = store.taxFor(address, subtotal - discount);
  const total = subtotal - discount + rate.amount + tax;
  const orderItems = items.map(({ line_id, available, missing, ...l }) => l);

  const order = await tx(async (t) => {
    await store.takeStock(t, orderItems);
    const [o] = await t.q(`insert into orders (token, status, customer_id, cart_id, email, name, address, items, subtotal, discount_code, discount, shipping, tax, total, expires_at)
      values ($1,'pending',$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13, now() + make_interval(mins => $14)) returning *`,
    [token(), customer?.id ?? null, cart.id, email, name, JSON.stringify(address), JSON.stringify(orderItems), subtotal,
      discount ? discountRow.code : null, discount, JSON.stringify(rate), tax, total, HOLD_MINUTES]);
    await logEvent('system', 'order.created', String(o.number), { total, items: orderItems.length }, true, t);
    return o;
  });

  if (customer && body.save_address) await q('update customers set default_address = $2::jsonb, name = coalesce(nullif(name, \'\'), $3) where id = $1', [customer.id, JSON.stringify(address), name]);

  if (!stripe.stripeEnabled()) {
    return { session_id: order.token, order_token: order.token, amount: total, currency: 'USD', provider: 'test', payment_url: `/checkout/pay/${order.token}`, expires_at: order.expires_at };
  }
  try {
    const s = await stripe.createCheckoutSession(order, origin);
    await q('update orders set stripe_session_id = $2, stripe_url = $3 where id = $1', [order.id, s.id, s.url]);
    return { session_id: s.id, order_token: order.token, amount: total, currency: 'USD', provider: 'stripe', payment_url: s.url, expires_at: order.expires_at };
  } catch (e) {
    await releaseOrder(order, 'cancelled', `stripe: ${e.message}`);
    throw new AppError(502, 'PAYMENT_PROVIDER', `The payment provider refused the session: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------
/** pending → paid (idempotent). A late payment on an expired hold still becomes an order. */
export async function markPaid(order, { paymentIntent = null, payment = null, via = 'return' } = {}, origin = '') {
  const paid = await tx(async (t) => {
    const [o] = await t.q('select * from orders where id = $1 for update', [order.id]);
    if (!o || !['pending', 'expired', 'cancelled'].includes(o.status)) return null;
    if (o.status !== 'pending') await store.forceTakeStock(t, o.items); // its stock went back already
    const [u] = await t.q("update orders set status = 'paid', paid_at = now(), payment_intent = $2, payment = $3::jsonb, notes = $4 where id = $1 returning *",
      [o.id, paymentIntent, payment ? JSON.stringify(payment) : null, o.status !== 'pending' ? `Paid after the hold lapsed (${o.status}).` : o.notes]);
    if (u.discount_code) await t.q('update discounts set used = used + 1 where code = $1', [u.discount_code]);
    await logEvent('system', 'order.paid', String(u.number), { via, total: u.total }, true, t);
    return u;
  });
  if (!paid) return one('select * from orders where id = $1', [order.id]);
  await store.clearCart(paid.cart_id);
  try { await mail.orderConfirmation(paid, origin); } catch (e) { console.error('[email]', e.message); }
  return paid;
}

/** pending → expired/cancelled, giving the stock back. No-op for anything else. */
export async function releaseOrder(order, status = 'expired', reason = '') {
  return tx(async (t) => {
    const r = await t.q(`update orders set status = $2, notes = nullif($3, '') where id = $1 and status = 'pending' returning *`, [order.id, status, reason]);
    if (!r.length) return null;
    await store.returnStock(t, r[0].items);
    await logEvent('system', `order.${status}`, String(r[0].number), reason ? { reason } : null, true, t);
    return r[0];
  });
}

/** Release holds whose time ran out (lazy: runs on checkout + admin requests, and on the expired webhook). */
export async function sweepExpired() {
  const stale = await q("select id, number, stripe_session_id from orders where status = 'pending' and expires_at < now() - interval '1 minute' order by id limit 25");
  for (const o of stale) await releaseOrder(o, 'expired', 'hold timed out');
  return stale.length;
}

/** Cancel link from Stripe (cancel_url): put the stock back straight away, keep the cart. */
export async function cancelByToken(tok) {
  const o = await one("select * from orders where token = $1 and status = 'pending'", [String(tok || '')]);
  if (!o) return { ok: true };
  if (o.stripe_session_id && stripe.stripeEnabled()) { try { await stripe.expireSession(o.stripe_session_id); } catch { /* already expired or paid */ } }
  const fresh = await one('select status from orders where id = $1', [o.id]);
  if (fresh.status === 'pending') await releaseOrder(o, 'cancelled', 'shopper returned from payment');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reading orders
// ---------------------------------------------------------------------------
function paymentFromSession(s) {
  const card = s.payment_intent?.latest_charge?.payment_method_details?.card;
  return card ? { brand: card.brand, last4: card.last4 } : { brand: 'card', last4: '' };
}

/** Return page: if Stripe says the session is paid, record it before showing the order. */
export async function orderForReturn(tok, sessionId, origin) {
  let o = await one('select * from orders where token = $1', [String(tok || '')]);
  if (!o) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (o.status === 'pending' && sessionId && sessionId === o.stripe_session_id && stripe.stripeEnabled()) {
    try {
      const s = await stripe.retrieveSession(sessionId);
      if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
        o = await markPaid(o, { paymentIntent: s.payment_intent?.id || s.payment_intent, payment: paymentFromSession(s), via: 'return' }, origin);
      }
    } catch (e) { console.error('[stripe] retrieve', e.message); }
  }
  return publicOrder(o);
}

/** What a customer may see about their order. */
export function publicOrder(o) {
  return {
    number: o.number, token: o.token, status: o.status, email: o.email, name: o.name, address: o.address,
    items: o.items, subtotal: o.subtotal, discount: { code: o.discount_code, amount: o.discount }, shipping: o.shipping,
    tax: o.tax, total: o.total, currency: o.currency, payment: o.payment, tracking: o.tracking, refunded: o.refunded,
    created_at: o.created_at, paid_at: o.paid_at, fulfilled_at: o.fulfilled_at, expires_at: o.status === 'pending' ? o.expires_at : null,
    pay_url: o.status === 'pending' ? o.stripe_url || (stripe.stripeEnabled() ? null : `/checkout/pay/${o.token}`) : null,
  };
}

// ---------------------------------------------------------------------------
// Built-in test payment (only when Stripe is not configured)
// ---------------------------------------------------------------------------
export async function testSessionView(tok) {
  const o = await one('select * from orders where token = $1', [String(tok || '')]);
  if (!o) throw new AppError(404, 'SESSION_NOT_FOUND', 'Unknown checkout session.');
  return { id: o.token, status: o.status, amount: o.total, currency: o.currency, email: o.email, expires_at: o.expires_at, order_token: o.token };
}

export async function confirmTestPayment(tok, body, origin) {
  if (stripe.stripeEnabled()) throw new AppError(400, 'USE_STRIPE', 'Payments go through Stripe Checkout on this deployment.');
  const o = await one('select * from orders where token = $1', [String(tok || '')]);
  if (!o) throw new AppError(404, 'SESSION_NOT_FOUND', 'Unknown checkout session.');
  if (o.status === 'paid' || o.status === 'fulfilled') throw new AppError(409, 'ALREADY_PAID', 'This order is already paid.', { order_token: o.token });
  if (o.status !== 'pending' || new Date(o.expires_at) < new Date()) {
    await releaseOrder(o, 'expired', 'hold timed out');
    throw new AppError(410, 'RESERVATION_EXPIRED', 'Your stock hold expired. Please start checkout again.');
  }
  const card = String(body.card_number || '').replace(/\D/g, '');
  if (card === '4000000000000002') throw new AppError(402, 'card_declined', 'Your card was declined.');
  if (card !== '4242424242424242') throw new AppError(402, 'card_declined', 'Use the test card 4242 4242 4242 4242.');
  const paid = await markPaid(o, { paymentIntent: `pi_test_${o.token.slice(0, 10)}`, payment: { brand: 'visa', last4: '4242' }, via: 'test-card' }, origin);
  return { status: 'succeeded', order: publicOrder(paid), order_token: paid.token };
}

// ---------------------------------------------------------------------------
// Stripe webhook
// ---------------------------------------------------------------------------
export async function handleStripeWebhook(raw, signature, origin) {
  const secret = await stripe.webhookSecret();
  if (!stripe.verifySignature(raw, signature, secret)) {
    await logEvent('stripe', 'signature.invalid', null, { sig: Boolean(signature) }, false);
    throw new AppError(400, 'BAD_SIGNATURE', 'Invalid signature.');
  }
  const evt = JSON.parse(raw);
  // dedupe: Stripe retries, and the unique index on (ref) makes the second insert a no-op
  const fresh = await q("insert into events (source, type, ref, verified, data) values ('stripe', $1, $2, true, $3::jsonb) on conflict (ref) where source = 'stripe' and verified do nothing returning id",
    [evt.type, evt.id, JSON.stringify({ object: evt.data?.object?.id, livemode: evt.livemode })]);
  if (!fresh.length) return { received: true, duplicate: true };

  const s = evt.data?.object || {};
  const findBySession = () => one('select * from orders where stripe_session_id = $1 or token = $2', [s.id, s.metadata?.order_token || s.client_reference_id || '']);
  switch (evt.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (s.payment_status !== 'paid' && evt.type === 'checkout.session.completed') break; // async methods settle later
      const o = await findBySession();
      if (o) {
        let payment = null;
        try { payment = paymentFromSession(await stripe.retrieveSession(s.id)); } catch { /* card details are cosmetic */ }
        await markPaid(o, { paymentIntent: s.payment_intent, payment, via: 'webhook' }, origin);
      }
      break;
    }
    case 'checkout.session.expired': {
      const o = await findBySession();
      if (o) await releaseOrder(o, 'expired', 'stripe session expired');
      break;
    }
    case 'charge.refunded': {
      const pi = s.payment_intent;
      if (pi) await q("update orders set refunded = greatest(refunded, $2), status = case when $2 >= total then 'refunded' else status end where payment_intent = $1", [pi, s.amount_refunded || 0]);
      break;
    }
    default: break;
  }
  return { received: true };
}
