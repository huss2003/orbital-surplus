// Backend end-to-end tests: real HTTP against the server on a random port, Postgres via
// in-memory PGlite, built-in test-card payments (no Stripe key). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_MEMORY = '1';
process.env.QUIET = '1';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-password-1';

const { start } = await import('../server/server.js');
let server, base;

before(async () => { server = await start({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }));

/** Tiny cookie-keeping client */
function client() {
  const jar = new Map();
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { origin: base, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body && typeof body === 'object' ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar.set(k, v); else jar.delete(k); }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}
const ADDRESS = { line1: '14 Docking Ring C', city: 'Brooklyn', state: 'NY', postal_code: '11201', country: 'US' };

test('catalog: six active products, no raw stock counts', async () => {
  const c = client();
  const { status, data } = await c('GET', '/api/products');
  assert.equal(status, 200);
  assert.equal(data.products.length, 6);
  const p = data.products.find((x) => x.slug === 'perigee-moto-jacket');
  assert.deepEqual(p.available_sizes, ['S', 'M', 'L', 'XL']); // XXL starts at 0
  assert.equal(p.inventory, undefined);
  assert.equal(p.price, 14800);
});

test('SEO: product pages are server-rendered with JSON-LD; unknown paths are real 404s', async () => {
  const c = client();
  const ok = await c('GET', '/shop/reentry-puffer');
  assert.equal(ok.status, 200);
  assert.match(ok.data, /<title>Reentry Puffer — Puffer Jacket \| ORBITAL SURPLUS<\/title>/);
  assert.match(ok.data, /"@type":"Product"/);
  assert.match(ok.headers.get('content-security-policy'), /nonce-/);
  assert.equal((await c('GET', '/shop/nope')).status, 404);
});

test('cart: add, stock limit, discount rules, server-side pricing', async () => {
  const c = client();
  let r = await c('POST', '/api/cart/items', { slug: 'perigee-moto-jacket', size: 'XL', quantity: 4 });
  assert.equal(r.status, 200);
  r = await c('POST', '/api/cart/items', { slug: 'perigee-moto-jacket', size: 'XL', quantity: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'OUT_OF_STOCK');
  r = await c('POST', '/api/cart/discount', { code: 'orbit20' });
  assert.equal(r.status, 200); // $592 ≥ $250
  assert.equal(r.data.discount.amount, Math.round(59200 * 0.2));
  r = await c('POST', '/api/cart/discount', { code: 'NOPE' });
  assert.equal(r.data.error, 'INVALID_DISCOUNT');
  r = await c('PATCH', `/api/cart/items/${r.data.items?.[0]?.line_id || (await c('GET', '/api/cart')).data.items[0].line_id}`, { quantity: 1 });
  assert.equal(r.data.subtotal, 14800);
});

test('CSRF: mutating API calls from a foreign origin are refused', async () => {
  const c = client();
  const r = await c('POST', '/api/cart/items', { slug: 'apogee-bomber', size: 'M' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('checkout holds stock, test card pays, cart clears, order is idempotent', async () => {
  const c = client();
  await c('POST', '/api/cart/items', { slug: 'reentry-puffer', size: 'XXL', quantity: 2 }); // all of XXL
  const s = await c('POST', '/api/checkout/session', { email: 'ada@example.com', name: 'Ada Vega', address: ADDRESS, shipping_rate: 'us_express' });
  assert.equal(s.status, 201);
  assert.equal(s.data.provider, 'test');
  assert.equal(s.data.amount, 42000 + 2500 + Math.round(42000 * 0.08875));
  // held: another shopper can't buy it
  const other = client();
  assert.equal((await other('POST', '/api/cart/items', { slug: 'reentry-puffer', size: 'XXL' })).status, 409);
  // decline, then pay
  assert.equal((await c('POST', `/api/checkout/session/${s.data.session_id}/confirm`, { card_number: '4000000000000002' })).status, 402);
  const paid = await c('POST', `/api/checkout/session/${s.data.session_id}/confirm`, { card_number: '4242424242424242' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.order.status, 'paid');
  assert.equal((await c('GET', '/api/cart')).data.item_count, 0);
  const again = await c('POST', `/api/checkout/session/${s.data.session_id}/confirm`, { card_number: '4242424242424242' });
  assert.equal(again.data.error, 'ALREADY_PAID');
  const o = await c('GET', `/api/orders/${s.data.order_token}`);
  assert.equal(o.data.number, paid.data.order.number);
  assert.equal(o.data.payment.last4, '4242');
});

test('cancel from the payment page releases the hold', async () => {
  const c = client();
  await c('POST', '/api/cart/items', { slug: 'apogee-bomber', size: 'XXL', quantity: 3 }); // all 3
  const s = await c('POST', '/api/checkout/session', { email: 'b@example.com', name: 'B', address: { ...ADDRESS, country: 'GB', state: '' } });
  assert.equal(s.status, 201);
  assert.deepEqual((await c('GET', '/api/products/apogee-bomber')).data.product.available_sizes.includes('XXL'), false);
  await c('POST', '/api/checkout/cancel', { token: s.data.order_token });
  assert.equal((await c('GET', '/api/products/apogee-bomber')).data.product.available_sizes.includes('XXL'), true);
  assert.equal((await c('GET', `/api/orders/${s.data.order_token}`)).data.status, 'cancelled');
  assert.equal((await c('GET', '/api/cart')).data.item_count, 3); // cart kept
});

test('accounts: register, guest orders are claimed, login throttles, logout', async () => {
  const guest = client();
  await guest('POST', '/api/cart/items', { slug: 'drift-coach-jacket', size: 'S' });
  const s = await guest('POST', '/api/checkout/session', { email: 'crew@example.com', name: 'Crew', address: ADDRESS });
  await guest('POST', `/api/checkout/session/${s.data.session_id}/confirm`, { card_number: '4242424242424242' });

  const c = client();
  const reg = await c('POST', '/api/account/register', { email: 'Crew@Example.com', password: 'short' });
  assert.equal(reg.status, 400);
  const ok = await c('POST', '/api/account/register', { email: 'crew@example.com', password: 'docking-bay-14', name: 'Crew Member' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.orders.length, 1);
  assert.equal((await c('GET', '/api/account')).data.customer.email, 'crew@example.com');
  await c('POST', '/api/account/logout', {});
  assert.equal((await c('GET', '/api/account')).data.customer, null);
  for (let i = 0; i < 8; i++) await c('POST', '/api/account/login', { email: 'crew@example.com', password: 'wrong-password' });
  const locked = await c('POST', '/api/account/login', { email: 'crew@example.com', password: 'docking-bay-14' });
  assert.match(locked.data.message, /Too many attempts/);
});

test('admin: login required, fulfil + refund a paid order, edit stock', async () => {
  const c = client();
  const anon = await c('GET', '/admin/orders');
  assert.equal(anon.status, 303);
  const form = (o) => new URLSearchParams(o).toString();
  const h = { 'content-type': 'application/x-www-form-urlencoded' };
  const bad = await c('POST', '/admin/login', form({ email: 'admin@test.local', password: 'nope-nope' }), h);
  assert.equal(bad.status, 401);
  const login = await c('POST', '/admin/login', form({ email: 'admin@test.local', password: 'admin-password-1' }), h);
  assert.equal(login.status, 303);
  const dash = await c('GET', '/admin');
  assert.match(dash.data, /Net revenue/);
  const f = await c('POST', '/admin/orders/1001/fulfil', form({ carrier: 'UPS', tracking_number: '1Z999' }), h);
  assert.match(f.headers.get('location'), /note=Marked/);
  const r = await c('POST', '/admin/orders/1001/refund', form({ amount: '5.00' }), h);
  assert.match(r.headers.get('location'), /Refunded/);
  await c('POST', '/admin/products/perigee-moto-jacket', form({ name: 'Perigee Moto Jacket', sku: '001', price: '148', status: 'active', variant: 'moto', stock_S: '0', stock_M: '1', stock_L: '1', stock_XL: '1', stock_XXL: '5', images: '/img/perigee-moto-jacket-front.png' }), h);
  const p = (await c('GET', '/api/products/perigee-moto-jacket')).data.product;
  assert.deepEqual(p.available_sizes, ['M', 'L', 'XL', 'XXL']);
  const cross = await c('POST', '/admin/discounts', form({ code: 'EVIL50', value: '50' }), { ...h, origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
});

test('Stripe webhook rejects bad signatures', async () => {
  const c = client();
  const r = await c('POST', '/api/webhooks/stripe', JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }), { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'BAD_SIGNATURE');
});
