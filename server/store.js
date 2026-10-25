// server/store.js
// -----------------------------------------------------------------------------
// Catalog, stock, carts, discounts, shipping and tax, backed by Postgres (db.js).
//
// The catalog is small, so every server instance keeps it in memory and reloads it
// when `meta.catalog_version` changes (the admin bumps it on every product edit).
// Stock is re-read on every request in the same round trip, so serverless instances
// never sell from a stale count. That keeps the SEO renderer and the product views
// synchronous: call `await refresh()` once per request, then use the sync getters.
//
// Money is always an integer number of cents. Never use floats for money.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, one, tx, ensureSchema, setMeta, bumpCatalog, SCHEMA_VERSION } from './db.js';

export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Short random ids like `c_9f2k…` (cart) or `l_…` (cart line). */
export const newId = (prefix, bytes = 9) => `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;

// ---------------------------------------------------------------------------
// Boot: schema + seed (idempotent; safe if two cold starts race)
// ---------------------------------------------------------------------------
const SEED = () => JSON.parse(fs.readFileSync(config.catalogFile, 'utf8'));

const SEED_DISCOUNTS = [
  { code: 'LAUNCH10', kind: 'percent', value: 10, min_subtotal: 0, label: '10% off your first order' },
  { code: 'ORBIT20', kind: 'percent', value: 20, min_subtotal: 25000, label: '20% off orders of $250+' },
  { code: 'DOCKED15', kind: 'fixed', value: 1500, min_subtotal: 10000, label: '$15 off orders of $100+' },
];

let booted = null;
export function boot() {
  booted ??= (async () => {
    if (await ensureSchema()) {
      const seed = SEED();
      await seedProducts(seed.products);
      for (const d of SEED_DISCOUNTS) {
        await q('insert into discounts (code, kind, value, min_subtotal, label) values ($1,$2,$3,$4,$5) on conflict do nothing', [d.code, d.kind, d.value, d.min_subtotal, d.label]);
      }
      await setMeta('size_chart', seed.size_chart);
      await setMeta('schema_version', SCHEMA_VERSION);
      await bumpCatalog();
    }
  })().catch((e) => { booted = null; throw e; });
  return booted;
}

export async function seedProducts(products) {
  let pos = 0;
  for (const p of products) {
    const row = await one(`insert into products (slug, sku, name, category, color, price, currency, description, materials, care, images, model, position)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13) on conflict (slug) do nothing returning id`,
    [p.slug, p.sku, p.name, p.category, p.color, p.price, p.currency || 'USD', p.description, JSON.stringify(p.materials), JSON.stringify(p.care), JSON.stringify(p.images), JSON.stringify(p.model), pos++]);
    if (!row) continue;
    let i = 0;
    for (const s of p.sizes) await q('insert into variants (product_id, size, stock, position) values ($1,$2,$3,$4) on conflict do nothing', [row.id, s, p.inventory?.[s] ?? 0, i++]);
  }
}

// ---------------------------------------------------------------------------
// Catalog cache
// ---------------------------------------------------------------------------
const cache = { version: null, products: [], all: [], sizeChart: { unit: 'cm', sizes: [], rows: [] } };
let stock = new Map(); // slug → { size: units }

/** One round trip: catalog version + live stock. Reloads products only if the version moved. */
export async function refresh() {
  await boot();
  const rows = await q(`select p.slug, v.size, v.stock, (select value from meta where key = 'catalog_version') as ver
    from variants v join products p on p.id = v.product_id`);
  const next = new Map();
  for (const r of rows) {
    if (!next.has(r.slug)) next.set(r.slug, {});
    next.get(r.slug)[r.size] = r.stock;
  }
  stock = next;
  const ver = rows[0]?.ver ?? 0;
  if (ver !== cache.version) await loadCatalog(ver);
}

async function loadCatalog(ver) {
  const [products, variants, chart] = await Promise.all([
    q('select * from products order by position, id'),
    q('select product_id, size from variants order by position, size'),
    one("select value from meta where key = 'size_chart'"),
  ]);
  const sizes = new Map();
  for (const v of variants) { if (!sizes.has(v.product_id)) sizes.set(v.product_id, []); sizes.get(v.product_id).push(v.size); }
  cache.all = products.map((p) => ({
    id: p.slug, db_id: p.id, sku: p.sku, slug: p.slug, name: p.name, category: p.category, color: p.color,
    price: p.price, compare_at: p.compare_at, currency: p.currency, sizes: sizes.get(p.id) || [],
    description: p.description, materials: p.materials, care: p.care, images: p.images, model: p.model, status: p.status,
  }));
  cache.products = cache.all.filter((p) => p.status === 'active');
  if (chart) cache.sizeChart = chart.value;
  cache.version = ver;
}

const findProduct = (slug) => cache.products.find((p) => p.slug === slug);
export const findProductBySku = (sku) => cache.products.find((p) => p.sku === sku);
export const allProducts = () => cache.products;
export const allProductsIncludingDrafts = () => cache.all;
export const availableQty = (slug, size) => stock.get(slug)?.[size] ?? 0;
export const stockFor = (slug) => ({ ...(stock.get(slug) || {}) });

/** Public product view. Raw stock counts are not exposed, only which sizes can be bought. */
export function publicProduct(p) {
  const { db_id, status, ...rest } = p;
  return {
    ...rest,
    available_sizes: p.sizes.filter((s) => availableQty(p.slug, s) > 0),
    low_stock_sizes: p.sizes.filter((s) => { const n = availableQty(p.slug, s); return n > 0 && n <= 2; }),
    in_stock: p.sizes.some((s) => availableQty(p.slug, s) > 0),
    url: `/shop/${p.slug}`,
    ar_url: `/ar/${p.sku}`,
  };
}
export const listProducts = () => cache.products.map(publicProduct);
export function getProduct(slug) {
  const p = findProduct(slug);
  return p ? publicProduct(p) : null;
}

export function sizeChart() {
  const { unit = 'cm', sizes = [], rows = [] } = cache.sizeChart;
  return { unit, sizes, rows: rows.map((r) => ({ label: r.label, values: r.values, cells: sizes.map((s) => r.values[s]) })) };
}

// ---------------------------------------------------------------------------
// Discounts, shipping, tax
// ---------------------------------------------------------------------------
export const getDiscount = (code) => (code ? one('select * from discounts where code = $1', [String(code).toUpperCase()]) : null);

export function discountAmount(d, subtotal) {
  if (!d || !d.active || subtotal < d.min_subtotal) return 0;
  if (d.usage_limit != null && d.used >= d.usage_limit) return 0;
  return Math.min(subtotal, d.kind === 'fixed' ? d.value : Math.round((subtotal * d.value) / 100));
}

export const FREE_SHIPPING_OVER = 20000; // $200

/** Shipping options for a destination country (ISO-2). */
export function shippingRates(country, subtotal) {
  const c = (country || 'US').toUpperCase();
  if (c === 'US') {
    return [
      { id: 'us_ground', label: 'Ground Shuttle', amount: subtotal >= FREE_SHIPPING_OVER ? 0 : 1200, eta: '3–5 business days' },
      { id: 'us_express', label: 'Express Burn (2-day)', amount: 2500, eta: '2 business days' },
    ];
  }
  if (c === 'CA') return [{ id: 'ca_standard', label: 'Northern Relay', amount: 1800, eta: '5–8 business days' }];
  return [{ id: 'intl', label: 'Interplanetary (DHL)', amount: 3500, eta: '7–14 business days' }];
}

// Simplified US sales tax by state (a real store would use Stripe Tax).
const TAX_RATES = { NY: 0.08875, CA: 0.0725, WA: 0.065, TX: 0.0625 };
export function taxFor(address, taxableCents) {
  if (!address || (address.country || '').toUpperCase() !== 'US') return 0;
  const rate = TAX_RATES[(address.state || '').toUpperCase()] || 0;
  return Math.round(taxableCents * rate);
}

// ---------------------------------------------------------------------------
// Carts
// ---------------------------------------------------------------------------
export async function getCart(id) {
  if (!id || !/^c_[\w-]{6,20}$/.test(id)) return null;
  return one('select * from carts where id = $1', [id]);
}

export async function createCart(customerId = null) {
  return one("insert into carts (id, customer_id) values ($1, $2) returning *", [newId('c'), customerId]);
}

async function save(cart) {
  await q('update carts set items = $2::jsonb, discount_code = $3, customer_id = coalesce($4, customer_id), updated_at = now() where id = $1',
    [cart.id, JSON.stringify(cart.items), cart.discount_code, cart.customer_id ?? null]);
}

/** Line totals from the stored cart. Prices always come from the catalog, never from the client. */
export function cartLines(cart) {
  return (cart.items || []).map((it) => {
    const p = findProduct(it.slug);
    const unit = p ? p.price : 0;
    return {
      line_id: it.line_id, slug: it.slug, sku: p?.sku, name: p ? p.name : it.slug, color: p?.color, size: it.size, quantity: it.quantity,
      unit_price: unit, line_total: unit * it.quantity, image: p ? p.images[0] : null,
      available: p ? availableQty(it.slug, it.size) : 0, missing: !p,
    };
  });
}

export async function cartTotals(cart) {
  const items = cartLines(cart);
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const d = cart.discount_code ? await getDiscount(cart.discount_code) : null;
  return { items, subtotal, discount: discountAmount(d, subtotal), discountRow: d };
}

/** The Cart shape the frontend uses. */
export async function cartView(cart) {
  const { items, subtotal, discount, discountRow } = await cartTotals(cart);
  const shipping = items.length === 0 ? 0 : shippingRates('US', subtotal - discount)[0].amount;
  return {
    id: cart.id,
    currency: 'USD',
    items,
    item_count: items.reduce((s, i) => s + i.quantity, 0),
    subtotal,
    discount: { code: cart.discount_code, amount: discount, label: discountRow?.label || null },
    free_shipping_over: FREE_SHIPPING_OVER,
    shipping_estimate: shipping,
    tax: 0,
    total: subtotal - discount + shipping,
  };
}

export const MAX_LINE_QTY = 10;

function assertStock(slug, size, wanted) {
  const left = availableQty(slug, size);
  if (wanted > left) {
    throw new AppError(409, 'OUT_OF_STOCK', left === 0 ? `Size ${size} is out of stock.` : `Only ${left} left in size ${size}.`, { available: left });
  }
}

export async function addItem(cart, { slug, size, quantity }) {
  const p = findProduct(slug);
  if (!p) throw new AppError(404, 'PRODUCT_NOT_FOUND', `No product "${slug}".`);
  if (!p.sizes.includes(size)) throw new AppError(400, 'INVALID_SIZE', `Size must be one of ${p.sizes.join(', ')}.`);
  const existing = cart.items.find((i) => i.slug === slug && i.size === size);
  const newQty = (existing ? existing.quantity : 0) + quantity;
  if (newQty > MAX_LINE_QTY) throw new AppError(400, 'QUANTITY_LIMIT', `Max ${MAX_LINE_QTY} per size.`);
  assertStock(slug, size, newQty);
  if (existing) existing.quantity = newQty;
  else cart.items.push({ line_id: newId('l', 6), slug, size, quantity });
  await save(cart);
}

export async function updateItem(cart, lineId, quantity) {
  const line = cart.items.find((i) => i.line_id === lineId);
  if (!line) throw new AppError(404, 'LINE_NOT_FOUND', 'That item is not in your cart.');
  if (quantity === 0) return removeItem(cart, lineId);
  if (quantity > MAX_LINE_QTY) throw new AppError(400, 'QUANTITY_LIMIT', `Max ${MAX_LINE_QTY} per size.`);
  if (quantity > line.quantity) assertStock(line.slug, line.size, quantity);
  line.quantity = quantity;
  await save(cart);
}

export async function removeItem(cart, lineId) {
  const before = cart.items.length;
  cart.items = cart.items.filter((i) => i.line_id !== lineId);
  if (cart.items.length === before) throw new AppError(404, 'LINE_NOT_FOUND', 'That item is not in your cart.');
  await save(cart);
}

export async function applyDiscount(cart, rawCode) {
  const code = String(rawCode).trim().toUpperCase();
  const d = await getDiscount(code);
  if (!d || !d.active) throw new AppError(400, 'INVALID_DISCOUNT', 'That code is not valid.');
  if (d.usage_limit != null && d.used >= d.usage_limit) throw new AppError(400, 'DISCOUNT_USED_UP', 'That code has been fully redeemed.');
  const subtotal = cartLines(cart).reduce((s, i) => s + i.line_total, 0);
  if (subtotal < d.min_subtotal) throw new AppError(400, 'DISCOUNT_NOT_ELIGIBLE', `${code} needs a subtotal of $${(d.min_subtotal / 100).toFixed(0)} or more.`);
  cart.discount_code = code;
  await save(cart);
}

export async function removeDiscount(cart) {
  cart.discount_code = null;
  await save(cart);
}

export async function clearCart(cartId) {
  if (cartId) await q("update carts set items = '[]'::jsonb, discount_code = null, updated_at = now() where id = $1", [cartId]);
}

/** Signed-in shopper: adopt the visitor cart, or merge it into the one they left on another device. */
export async function attachCart(cart, customerId) {
  if (!cart || cart.customer_id === customerId) return cart;
  const older = await one('select * from carts where customer_id = $1 and id <> $2 order by updated_at desc limit 1', [customerId, cart.id]);
  if (older?.items?.length) {
    for (const it of older.items) {
      const ex = cart.items.find((i) => i.slug === it.slug && i.size === it.size);
      if (ex) ex.quantity = Math.min(MAX_LINE_QTY, Math.max(ex.quantity, it.quantity));
      else cart.items.push(it);
    }
    cart.discount_code ??= older.discount_code;
    await q("update carts set items = '[]'::jsonb where id = $1", [older.id]);
  }
  cart.customer_id = customerId;
  await save(cart);
  return cart;
}

// ---------------------------------------------------------------------------
// Stock movements (used inside checkout transactions)
// ---------------------------------------------------------------------------
/** Take units for every line or throw (the caller's transaction rolls everything back). */
export async function takeStock(t, lines) {
  for (const l of lines) {
    const r = await t.q(`update variants set stock = stock - $3 where product_id = (select id from products where slug = $1) and size = $2 and stock >= $3 returning stock`, [l.slug, l.size, l.quantity]);
    if (!r.length) {
      const left = availableQty(l.slug, l.size);
      throw new AppError(409, 'OUT_OF_STOCK', left ? `Only ${left} left of ${l.name} in size ${l.size}.` : `${l.name} in size ${l.size} just sold out.`, { slug: l.slug, size: l.size, available: left });
    }
  }
}
export async function returnStock(t, lines) {
  for (const l of lines) await t.q('update variants set stock = stock + $3 where product_id = (select id from products where slug = $1) and size = $2', [l.slug, l.size, l.quantity]);
}
/** Late payment for an order whose hold already lapsed: take what is there, never go negative. */
export async function forceTakeStock(t, lines) {
  for (const l of lines) await t.q('update variants set stock = greatest(stock - $3, 0) where product_id = (select id from products where slug = $1) and size = $2', [l.slug, l.size, l.quantity]);
}

// ---------------------------------------------------------------------------
// Marketing + contact + event log
// ---------------------------------------------------------------------------
export async function addSubscriber(email, source = 'footer') {
  const r = await q('insert into subscribers (email, source) values ($1, $2) on conflict do nothing returning email', [email.toLowerCase(), source]);
  return r.length > 0;
}
export const addMessage = (name, email, body) => q('insert into messages (name, email, body) values ($1,$2,$3)', [name, email, body]);
export const logEvent = (source, type, ref, data, verified = true, t) => (t || { q }).q('insert into events (source, type, ref, verified, data) values ($1,$2,$3,$4,$5::jsonb)', [source, type, ref, verified, data ? JSON.stringify(data) : null]);

export { tx, q, one, bumpCatalog };
