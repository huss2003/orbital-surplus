// ---------------------------------------------------------------------------
// Stripe, called over its REST API with fetch (no SDK needed).
//   • Checkout Sessions for payment (hosted, PCI handled by Stripe)
//   • Refunds from the admin
//   • Webhook endpoint registration + signature verification
// The secret key only ever lives in the STRIPE_SECRET_KEY environment variable.
// ---------------------------------------------------------------------------
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getMeta, setMeta } from './db.js';

const KEY = () => process.env.STRIPE_SECRET_KEY || '';
export const stripeEnabled = () => KEY().startsWith('sk_');
export const stripeTestMode = () => KEY().startsWith('sk_test_');

/** Stripe wants application/x-www-form-urlencoded with bracketed nesting */
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

export async function stripe(method, path, params, idempotencyKey) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY()}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: method === 'GET' ? undefined : encode(params || {}),
  });
  const json = await res.json();
  if (!res.ok) { const e = new Error(json.error?.message || `Stripe ${res.status}`); e.stripe = json.error; throw e; }
  return json;
}

export async function createCheckoutSession(order, origin) {
  const abs = (u) => (u && u.startsWith('/') && origin.startsWith('https://') ? origin + u : u && u.startsWith('http') ? u : undefined);
  const line_items = order.items.map((l) => ({
    quantity: l.quantity,
    price_data: {
      currency: 'usd', unit_amount: l.unit_price,
      product_data: { name: l.name, description: `Size ${l.size}${l.color ? ' · ' + l.color : ''}`, images: abs(l.image) ? [abs(l.image)] : undefined, metadata: { slug: l.slug, size: l.size } },
    },
  }));
  if (order.tax > 0) line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: order.tax, product_data: { name: 'Sales tax' } } });
  const meta = { order_token: order.token, order_number: String(order.number) };
  const params = {
    mode: 'payment',
    payment_method_types: ['card'], // cards only (Apple/Google Pay included): no delayed methods, so a hold never outlives its payment
    customer_email: order.email,
    client_reference_id: order.token,
    line_items,
    shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: order.shipping.label, fixed_amount: { amount: order.shipping.amount, currency: 'usd' } } }],
    metadata: meta,
    payment_intent_data: { metadata: meta, description: `ORBITAL SURPLUS order #${order.number}` },
    success_url: `${origin}/order/${order.token}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/checkout?cancelled=${order.token}`,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
  };
  if (order.discount > 0) {
    const coupon = await stripe('POST', 'coupons', { amount_off: order.discount, currency: 'usd', duration: 'once', name: (order.discount_code || 'Discount').slice(0, 40), max_redemptions: 1 }, `coupon-${order.token}`);
    params.discounts = [{ coupon: coupon.id }];
  }
  return stripe('POST', 'checkout/sessions', params, `session-${order.token}`);
}

export const retrieveSession = (id) => stripe('GET', `checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge`);
export const expireSession = (id) => stripe('POST', `checkout/sessions/${encodeURIComponent(id)}/expire`, {});
export const refund = (paymentIntent, amount, reason) => stripe('POST', 'refunds', { payment_intent: paymentIntent, amount, reason: reason || 'requested_by_customer' });

/* ---------------- webhooks ---------------- */
export const WEBHOOK_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'charge.refunded'];

export async function webhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || (await getMeta('stripe_webhook_secret', null))?.secret || null;
}

/** Admin button: register this deployment's /webhooks/stripe endpoint with Stripe and store the signing secret */
export async function connectWebhook(origin) {
  const url = `${origin}/api/webhooks/stripe`;
  const existing = await getMeta('stripe_webhook_secret', null);
  if (existing?.id) { try { await stripe('POST', `webhook_endpoints/${existing.id}`, { disabled: 'true' }); } catch { /* already gone */ } }
  const ep = await stripe('POST', 'webhook_endpoints', { url, enabled_events: WEBHOOK_EVENTS, description: 'ORBITAL SURPLUS storefront' });
  await setMeta('stripe_webhook_secret', { id: ep.id, url, secret: ep.secret, created: Date.now() });
  return ep;
}

/** Verify the Stripe-Signature header (t=…,v1=…) over the raw body; reject stale timestamps */
export function verifySignature(raw, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')).map(([k, ...v]) => [k, v.join('=')]));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
