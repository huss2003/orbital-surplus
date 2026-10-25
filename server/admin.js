// server/admin.js
// -----------------------------------------------------------------------------
// Depot admin: server-rendered pages under /admin, behind a session login for
// customers with is_admin = true. Plain HTML forms (urlencoded) with an Origin check
// against CSRF; no client JavaScript needed.
//
//   /admin               dashboard: revenue, open orders, low stock, recent activity
//   /admin/orders        filter by status; detail page fulfils, refunds (Stripe), cancels
//   /admin/products      price, compare-at, status, stock per size, copy; add products
//   /admin/discounts     create and pause codes
//   /admin/customers · /subscribers · /messages · /emails · /events · /settings
// -----------------------------------------------------------------------------
import { q, one, tx, bumpCatalog } from './db.js';
import * as store from './store.js';
import { AppError } from './store.js';
import * as auth from './auth.js';
import * as stripe from './stripe.js';
import * as mail from './email.js';
import { sweepExpired, releaseOrder } from './checkout.js';
import { readRawBody, clientIp } from './security.js';

const esc = mail.esc;
const money = mail.money;
const when = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled', 'expired', 'refunded'];

const CSS = `
:root{--bg:#050505;--panel:#0d0d0d;--line:#222;--txt:#e9e9e9;--mute:#8a8a8a;--lime:#C8FF2E;--red:#ff5a4f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:13px/1.5 "DM Mono",Menlo,Consolas,monospace}
a{color:var(--txt)}a:hover{color:var(--lime)}
.a-shell{display:grid;grid-template-columns:200px 1fr;min-height:100vh}
.a-side{border-right:1px solid var(--line);padding:18px 14px;display:grid;align-content:start;gap:4px;position:sticky;top:0;height:100vh}
.a-brand{font-size:13px;letter-spacing:.14em;margin:0 0 18px;display:block;text-decoration:none}.a-brand b{color:var(--lime)}
.a-side a.n{display:block;padding:6px 8px;text-decoration:none;letter-spacing:.06em;text-transform:uppercase;font-size:12px;color:var(--mute)}
.a-side a.n.on,.a-side a.n:hover{color:var(--bg);background:var(--lime)}
.a-side form{margin-top:18px}
.a-main{padding:26px 32px 60px;min-width:0}
h1{font-size:18px;font-weight:400;letter-spacing:.1em;text-transform:uppercase;margin:0 0 18px}
h2{font-size:13px;font-weight:400;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin:26px 0 10px}
.a-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.a-stat{border:1px solid var(--line);background:var(--panel);padding:14px}.a-stat span{color:var(--mute);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.a-stat strong{display:block;font-size:22px;font-weight:400;margin-top:4px}
.a-table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line)}
.a-table th,.a-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.a-table th{font-weight:400;color:var(--mute);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.a-table tr:hover td{background:#121212}
.b{display:inline-block;padding:1px 6px;border:1px solid var(--line);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.b-paid{border-color:var(--lime);color:var(--lime)}.b-fulfilled{background:var(--lime);color:#000;border-color:var(--lime)}.b-pending{color:#ffd44f;border-color:#6b5a1a}
.b-cancelled,.b-expired{color:var(--mute)}.b-refunded{color:var(--red);border-color:#5a2420}.b-draft{color:#ffd44f}.b-active{color:var(--lime)}
.a-btn,button{font:inherit;background:transparent;color:var(--lime);border:1px solid var(--lime);padding:7px 12px;cursor:pointer;letter-spacing:.06em;text-transform:uppercase;font-size:12px}
.a-btn:hover,button:hover{background:var(--lime);color:#000}
button.ghost{color:var(--mute);border-color:var(--line)}button.danger{color:var(--red);border-color:#5a2420}button.danger:hover{background:var(--red);color:#000}
input,select,textarea{font:inherit;background:#000;color:var(--txt);border:1px solid var(--line);padding:7px 9px;width:100%}
input:focus,select:focus,textarea:focus{outline:1px solid var(--lime);border-color:var(--lime)}
label{display:block;font-size:11px;color:var(--mute);letter-spacing:.06em;text-transform:uppercase;margin:0 0 4px}
.a-form{display:grid;gap:12px;max-width:760px}.a-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.a-note{border:1px solid var(--lime);color:var(--lime);padding:9px 12px;margin:0 0 16px}.a-err{border-color:var(--red);color:var(--red)}
.a-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(260px,1fr);gap:22px;align-items:start}
.a-card{border:1px solid var(--line);background:var(--panel);padding:14px}.a-card dl{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;margin:0}.a-card dt{color:var(--mute)}.a-card dd{margin:0}
.a-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.a-actions form{display:flex;gap:8px;align-items:end}
.a-filter{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}.a-filter a{padding:4px 8px;border:1px solid var(--line);text-decoration:none;font-size:11px;text-transform:uppercase}.a-filter a.on{border-color:var(--lime);color:var(--lime)}
.muted{color:var(--mute)}.lime{color:var(--lime)}.neg{color:var(--red)}
.thumb{width:44px;height:54px;object-fit:cover;background:#111;border:1px solid var(--line)}
.a-savebar{position:sticky;bottom:0;background:var(--bg);padding:12px 0;border-top:1px solid var(--line)}
.a-login{min-height:100vh;display:grid;place-items:center}.a-login form{width:min(360px,90vw);border:1px solid var(--line);background:var(--panel);padding:26px;display:grid;gap:12px}
iframe{width:100%;height:520px;border:1px solid var(--line);background:#000}
@media (max-width:800px){.a-shell{grid-template-columns:1fr}.a-side{position:static;height:auto;grid-template-columns:repeat(3,1fr)}.a-brand{grid-column:1/-1}.a-cols{grid-template-columns:1fr}.a-main{padding:18px}}
`;

const NAV = [['/admin', 'Dashboard'], ['/admin/orders', 'Orders'], ['/admin/products', 'Products'], ['/admin/discounts', 'Discounts'], ['/admin/customers', 'Customers'], ['/admin/subscribers', 'Subscribers'], ['/admin/messages', 'Messages'], ['/admin/emails', 'Email log'], ['/admin/events', 'Events'], ['/admin/settings', 'Settings']];

function page(title, body, { path = '/admin', admin, note, err } = {}) {
  const nav = NAV.map(([href, label]) => `<a class="n${(href === '/admin' ? path === href : path.startsWith(href)) ? ' on' : ''}" href="${href}">${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} — ORBITAL SURPLUS admin</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%23C8FF2E'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"><style>${CSS}</style></head>
<body><div class="a-shell"><aside class="a-side"><a class="a-brand" href="/admin">[ORBITAL SURPLUS] <b>■</b><br><span class="muted">DEPOT ADMIN</span></a>${nav}
<a class="n" href="/" target="_blank" rel="noopener">View store ↗</a>
<form method="post" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form><p class="muted" style="font-size:11px;word-break:break-all">${esc(admin?.email || '')}</p></aside>
<main class="a-main">${note ? `<p class="a-note" role="status">${esc(note)}</p>` : ''}${err ? `<p class="a-note a-err" role="alert">${esc(err)}</p>` : ''}${body}</main></div></body></html>`;
}

const badge = (s) => `<span class="b b-${esc(s)}">${esc(s)}</span>`;
const table = (heads, rows, empty = 'Nothing here yet.') => rows.length
  ? `<table class="a-table"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : `<p class="muted">${empty}</p>`;

async function formBody(req) {
  const raw = await readRawBody(req, 64 * 1024);
  return Object.fromEntries(new URLSearchParams(raw));
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
async function dashboard() {
  await sweepExpired();
  const [rev, counts, recent, low, subs, msgs] = await Promise.all([
    one(`select coalesce(sum(total - refunded),0)::int as gross, count(*)::int as n,
          coalesce(sum(total - refunded) filter (where paid_at > now() - interval '7 days'),0)::int as week
         from orders where status in ('paid','fulfilled','refunded')`),
    q('select status, count(*)::int as n from orders group by status'),
    q('select number, status, email, total, created_at from orders order by id desc limit 8'),
    q(`select p.name, p.slug, v.size, v.stock from variants v join products p on p.id = v.product_id where v.stock <= 2 and p.status = 'active' order by v.stock, p.position limit 12`),
    one('select count(*)::int as n from subscribers'),
    one('select count(*)::int as n from messages where not handled'),
  ]);
  const c = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const avg = rev.n ? Math.round(rev.gross / rev.n) : 0;
  return ['Dashboard', `<h1>Dashboard</h1>
  <div class="a-stats">
    <div class="a-stat"><span>Net revenue</span><strong class="lime">${money(rev.gross)}</strong></div>
    <div class="a-stat"><span>Last 7 days</span><strong>${money(rev.week)}</strong></div>
    <div class="a-stat"><span>Paid orders</span><strong>${rev.n}</strong></div>
    <div class="a-stat"><span>Average order</span><strong>${money(avg)}</strong></div>
    <div class="a-stat"><span>To fulfil</span><strong>${c.paid || 0}</strong></div>
    <div class="a-stat"><span>Open holds</span><strong>${c.pending || 0}</strong></div>
    <div class="a-stat"><span>Subscribers</span><strong>${subs.n}</strong></div>
    <div class="a-stat"><span>Unread messages</span><strong>${msgs.n}</strong></div>
  </div>
  <div class="a-cols" style="margin-top:8px"><section><h2>Recent orders</h2>${table(['#', 'Status', 'Email', 'Total', 'Placed'], recent.map((o) => `<tr><td><a href="/admin/orders/${o.number}">#${o.number}</a></td><td>${badge(o.status)}</td><td>${esc(o.email)}</td><td>${money(o.total)}</td><td class="muted">${when(o.created_at)}</td></tr>`))}</section>
  <section><h2>Low stock</h2>${table(['Product', 'Size', 'Left'], low.map((r) => `<tr><td><a href="/admin/products/${r.slug}">${esc(r.name)}</a></td><td>${esc(r.size)}</td><td class="${r.stock ? '' : 'neg'}">${r.stock}</td></tr>`), 'Every size has at least 3 units.')}</section></div>`];
}

async function ordersList(url) {
  await sweepExpired();
  const status = url.searchParams.get('status');
  const qstr = (url.searchParams.get('q') || '').trim();
  const where = [], params = [];
  if (STATUSES.includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
  if (qstr) { params.push(`%${qstr.toLowerCase()}%`); where.push(`(lower(email) like $${params.length} or lower(name) like $${params.length} or number::text like $${params.length})`); }
  const rows = await q(`select number, status, email, name, total, items, created_at from orders ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit 200`, params);
  const filt = `<div class="a-filter"><a href="/admin/orders" class="${!status ? 'on' : ''}">All</a>${STATUSES.map((s) => `<a href="/admin/orders?status=${s}" class="${status === s ? 'on' : ''}">${s}</a>`).join('')}</div>
  <form method="get" action="/admin/orders" style="max-width:360px;margin:0 0 14px">${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}<input name="q" value="${esc(qstr)}" placeholder="Search number, email or name" aria-label="Search orders"></form>`;
  return ['Orders', `<h1>Orders</h1>${filt}${table(['#', 'Status', 'Customer', 'Items', 'Total', 'Placed'], rows.map((o) => `<tr><td><a href="/admin/orders/${o.number}">#${o.number}</a></td><td>${badge(o.status)}</td><td>${esc(o.name)}<br><span class="muted">${esc(o.email)}</span></td><td>${o.items.reduce((s, i) => s + i.quantity, 0)}</td><td>${money(o.total)}</td><td class="muted">${when(o.created_at)}</td></tr>`), 'No orders match.')}`];
}

async function orderDetail(number) {
  const o = await one('select * from orders where number = $1', [Number(number) || 0]);
  if (!o) return null;
  const ev = await q("select type, data, created_at from events where ref = $1 and source <> 'stripe' order by id", [String(o.number)]);
  const a = o.address || {};
  const actions = [];
  if (o.status === 'paid') actions.push(`<form method="post" action="/admin/orders/${o.number}/fulfil"><div><label for="carrier">Carrier</label><select id="carrier" name="carrier"><option>Orbital Post</option><option>UPS</option><option>DHL</option><option>USPS</option></select></div><div><label for="tn">Tracking number</label><input id="tn" name="tracking_number" required maxlength="40"></div><button type="submit">Mark launched</button></form>`);
  if (['paid', 'fulfilled'].includes(o.status) && o.total > o.refunded) actions.push(`<form method="post" action="/admin/orders/${o.number}/refund"><div><label for="ra">Refund (USD)</label><input id="ra" name="amount" value="${((o.total - o.refunded) / 100).toFixed(2)}" inputmode="decimal" style="width:110px"></div><button class="danger" type="submit">Refund${o.payment_intent?.startsWith('pi_test_') || !o.payment_intent ? '' : ' via Stripe'}</button></form>`);
  if (o.status === 'pending') actions.push(`<form method="post" action="/admin/orders/${o.number}/cancel"><button class="danger" type="submit">Cancel and release stock</button></form>`);
  return [`Order #${o.number}`, `<p><a href="/admin/orders" class="muted">← Orders</a></p><h1>Order #${o.number} ${badge(o.status)}</h1>
  <div class="a-cols"><section>
    ${table(['', 'Item', 'Size', 'Qty', 'Price', 'Total'], o.items.map((i) => `<tr><td><img class="thumb" src="${esc(i.image)}" alt=""></td><td>${esc(i.name)}<br><span class="muted">${esc(i.color || '')} · SKU ${esc(i.sku || '')}</span></td><td>${esc(i.size)}</td><td>${i.quantity}</td><td>${money(i.unit_price)}</td><td>${money(i.line_total)}</td></tr>`))}
    <div class="a-card" style="margin-top:10px"><dl><dt>Subtotal</dt><dd>${money(o.subtotal)}</dd>${o.discount ? `<dt>Discount</dt><dd class="neg">−${money(o.discount)} (${esc(o.discount_code)})</dd>` : ''}<dt>Shipping</dt><dd>${o.shipping?.amount ? money(o.shipping.amount) : 'FREE'} · ${esc(o.shipping?.label || '')}</dd><dt>Tax</dt><dd>${money(o.tax)}</dd><dt>Total</dt><dd class="lime">${money(o.total)}</dd>${o.refunded ? `<dt>Refunded</dt><dd class="neg">−${money(o.refunded)}</dd>` : ''}</dl></div>
    <h2>Actions</h2><div class="a-actions">${actions.join('') || '<p class="muted">No actions for this status.</p>'}</div>
    <h2>Timeline</h2>${table(['When', 'Event', 'Detail'], ev.map((e) => `<tr><td class="muted">${when(e.created_at)}</td><td>${esc(e.type)}</td><td class="muted">${esc(e.data ? JSON.stringify(e.data) : '')}</td></tr>`))}
  </section><aside class="a-card"><dl>
    <dt>Customer</dt><dd>${esc(o.name)}<br><a href="mailto:${esc(o.email)}">${esc(o.email)}</a></dd>
    <dt>Ship to</dt><dd>${esc(a.line1)}${a.line2 ? '<br>' + esc(a.line2) : ''}<br>${esc(a.city)} ${esc(a.state)} ${esc(a.postal_code)}<br>${esc(a.country)}</dd>
    <dt>Placed</dt><dd>${when(o.created_at)}</dd><dt>Paid</dt><dd>${when(o.paid_at)}</dd><dt>Launched</dt><dd>${when(o.fulfilled_at)}</dd>
    ${o.status === 'pending' ? `<dt>Hold ends</dt><dd>${when(o.expires_at)}</dd>` : ''}
    <dt>Payment</dt><dd>${o.payment ? `${esc(o.payment.brand).toUpperCase()} ···· ${esc(o.payment.last4)}` : '—'}</dd>
    <dt>Stripe</dt><dd class="muted" style="word-break:break-all">${esc(o.stripe_session_id || '—')}<br>${esc(o.payment_intent || '')}</dd>
    ${o.tracking ? `<dt>Tracking</dt><dd>${esc(o.tracking.carrier)} ${esc(o.tracking.number)}</dd>` : ''}
    ${o.notes ? `<dt>Notes</dt><dd>${esc(o.notes)}</dd>` : ''}
    <dt>Customer view</dt><dd><a href="/order/${esc(o.token)}" target="_blank" rel="noopener">Open ↗</a></dd>
  </dl></aside></div>`];
}

async function productsList() {
  await store.refresh();
  const stockRows = await q('select p.slug, sum(v.stock)::int as units from variants v join products p on p.id = v.product_id group by p.slug');
  const units = Object.fromEntries(stockRows.map((r) => [r.slug, r.units]));
  const sold = Object.fromEntries((await q(`select i->>'slug' as slug, sum((i->>'quantity')::int)::int as n from orders, jsonb_array_elements(items) i where status in ('paid','fulfilled') group by 1`)).map((r) => [r.slug, r.n]));
  return ['Products', `<h1>Products</h1><p><a class="a-btn" href="/admin/products/new">+ New product</a></p>${table(['', 'Product', 'SKU', 'Status', 'Price', 'Stock', 'Sold'], store.allProductsIncludingDrafts().map((p) => `<tr><td><img class="thumb" src="${esc(p.images[0])}" alt=""></td><td><a href="/admin/products/${p.slug}">${esc(p.name)}</a><br><span class="muted">${esc(p.category)} · ${esc(p.color)}</span></td><td>${esc(p.sku)}</td><td>${badge(p.status)}</td><td>${money(p.price)}${p.compare_at ? ` <s class="muted">${money(p.compare_at)}</s>` : ''}</td><td>${units[p.slug] ?? 0}</td><td>${sold[p.slug] || 0}</td></tr>`))}`];
}

const VARIANT_OPTIONS = ['moto', 'bomber', 'puffer', 'shell', 'field', 'coach'];
function productForm(p, stock, action) {
  const v = (k) => esc(p?.[k] ?? '');
  const sizes = p?.sizes?.length ? p.sizes : ['S', 'M', 'L', 'XL', 'XXL'];
  return `<form class="a-form" method="post" action="${action}">
  <div class="a-row"><div><label for="name">Name</label><input id="name" name="name" required maxlength="80" value="${v('name')}"></div><div><label for="sku">SKU</label><input id="sku" name="sku" required maxlength="12" value="${v('sku')}"></div></div>
  <div class="a-row"><div><label for="category">Category</label><input id="category" name="category" maxlength="40" value="${v('category')}"></div><div><label for="color">Colour</label><input id="color" name="color" maxlength="40" value="${v('color')}"></div>
    <div><label for="variant">3D model</label><select id="variant" name="variant">${VARIANT_OPTIONS.map((o) => `<option ${p?.model?.variant === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div></div>
  <div class="a-row"><div><label for="price">Price (USD)</label><input id="price" name="price" required inputmode="decimal" value="${p ? (p.price / 100).toFixed(2) : ''}"></div>
    <div><label for="compare_at">Compare-at (USD)</label><input id="compare_at" name="compare_at" inputmode="decimal" value="${p?.compare_at ? (p.compare_at / 100).toFixed(2) : ''}"></div>
    <div><label for="status">Status</label><select id="status" name="status"><option ${p?.status === 'active' ? 'selected' : ''}>active</option><option ${p?.status !== 'active' ? 'selected' : ''}>draft</option></select></div></div>
  <div><label>Stock per size</label><div class="a-row">${sizes.map((s) => `<div><label for="stock_${s}">${s}</label><input id="stock_${s}" name="stock_${s}" type="number" min="0" max="9999" value="${stock?.[s] ?? 0}"></div>`).join('')}</div></div>
  <div><label for="description">Description</label><textarea id="description" name="description" rows="8">${v('description')}</textarea></div>
  <div class="a-row"><div><label for="materials">Materials (one per line)</label><textarea id="materials" name="materials" rows="3">${esc((p?.materials || []).join('\n'))}</textarea></div><div><label for="care">Care (one per line)</label><textarea id="care" name="care" rows="3">${esc((p?.care || []).join('\n'))}</textarea></div></div>
  <div><label for="images">Images (one path per line)</label><textarea id="images" name="images" rows="2">${esc((p?.images || []).join('\n'))}</textarea></div>
  <div class="a-savebar"><button type="submit">Save product</button></div></form>`;
}

const cents = (s, field, required = true) => {
  const t = String(s ?? '').trim();
  if (!t && !required) return null;
  const n = Math.round(Number(t.replace(/[$,]/g, '')) * 100);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new AppError(400, 'VALIDATION_ERROR', `${field}: enter an amount like 148.00`);
  return n;
};
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20);
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function saveProduct(b, slug) {
  const name = String(b.name || '').trim().slice(0, 80);
  const sku = String(b.sku || '').trim().slice(0, 12);
  if (!name || !sku) throw new AppError(400, 'VALIDATION_ERROR', 'Name and SKU are required.');
  const price = cents(b.price, 'Price');
  const compare = cents(b.compare_at, 'Compare-at', false);
  const status = b.status === 'active' ? 'active' : 'draft';
  const variant = VARIANT_OPTIONS.includes(b.variant) ? b.variant : 'moto';
  const sizes = ['S', 'M', 'L', 'XL', 'XXL'];
  return tx(async (t) => {
    let id;
    const fields = [name, sku, String(b.category || '').slice(0, 40), String(b.color || '').slice(0, 40), price, compare, status, String(b.description || '').slice(0, 5000),
      JSON.stringify(lines(b.materials)), JSON.stringify(lines(b.care)), JSON.stringify(lines(b.images).length ? lines(b.images) : ['/img/perigee-moto-jacket-front.png']), JSON.stringify({ type: 'procedural', variant })];
    if (slug) {
      const r = await t.q(`update products set name=$2, sku=$3, category=$4, color=$5, price=$6, compare_at=$7, status=$8, description=$9, materials=$10::jsonb, care=$11::jsonb, images=$12::jsonb, model=$13::jsonb, updated_at=now() where slug=$1 returning id, slug`, [slug, ...fields]);
      if (!r.length) throw new AppError(404, 'NOT_FOUND', 'Product not found.');
      id = r[0].id;
    } else {
      let s = slugify(name) || `product-${Date.now()}`;
      if (await t.q('select 1 from products where slug = $1', [s]).then((r) => r.length)) s = `${s}-${sku.toLowerCase()}`;
      const r = await t.q(`insert into products (slug, name, sku, category, color, price, compare_at, status, description, materials, care, images, model, position)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,(select coalesce(max(position),0)+1 from products)) returning id, slug`, [s, ...fields]);
      id = r[0].id; slug = r[0].slug;
    }
    for (const [i, size] of sizes.entries()) {
      const n = Math.max(0, Math.min(9999, Number.parseInt(b[`stock_${size}`] ?? '0', 10) || 0));
      await t.q('insert into variants (product_id, size, stock, position) values ($1,$2,$3,$4) on conflict (product_id, size) do update set stock = excluded.stock', [id, size, n, i]);
    }
    await bumpCatalog(t);
    await store.logEvent('admin', 'product.saved', slug, { price, status }, true, t);
    return slug;
  }).catch((e) => {
    if (/duplicate key/.test(e.message)) throw new AppError(409, 'DUPLICATE', 'That SKU is already used by another product.');
    throw e;
  });
}

async function productEdit(slug) {
  await store.refresh();
  const p = store.allProductsIncludingDrafts().find((x) => x.slug === slug);
  if (!p) return null;
  return [p.name, `<p><a href="/admin/products" class="muted">← Products</a></p><h1>${esc(p.name)} ${badge(p.status)}</h1><p class="muted">Public page: <a href="/shop/${p.slug}" target="_blank" rel="noopener">/shop/${p.slug} ↗</a></p>${productForm(p, store.stockFor(p.slug), `/admin/products/${p.slug}`)}`];
}

async function discountsPage() {
  const rows = await q('select * from discounts order by created_at desc');
  return ['Discounts', `<h1>Discounts</h1>
  <form class="a-form" method="post" action="/admin/discounts"><div class="a-row">
    <div><label for="code">Code</label><input id="code" name="code" required maxlength="24" pattern="[A-Za-z0-9_\\-]+" placeholder="SPRING15"></div>
    <div><label for="kind">Type</label><select id="kind" name="kind"><option value="percent">% off</option><option value="fixed">$ off</option></select></div>
    <div><label for="value">Value</label><input id="value" name="value" required inputmode="decimal" placeholder="15"></div>
    <div><label for="min">Min subtotal ($)</label><input id="min" name="min_subtotal" inputmode="decimal" placeholder="0"></div>
    <div><label for="limit">Usage limit</label><input id="limit" name="usage_limit" inputmode="numeric" placeholder="∞"></div>
  </div><div><button type="submit">Create code</button></div></form>
  <h2>All codes</h2>${table(['Code', 'Offer', 'Minimum', 'Used', 'Status', ''], rows.map((d) => `<tr><td><strong>${esc(d.code)}</strong><br><span class="muted">${esc(d.label)}</span></td><td>${d.kind === 'percent' ? `${d.value}%` : money(d.value)} off</td><td>${d.min_subtotal ? money(d.min_subtotal) : '—'}</td><td>${d.used}${d.usage_limit != null ? ` / ${d.usage_limit}` : ''}</td><td>${badge(d.active ? 'active' : 'draft')}</td><td><form method="post" action="/admin/discounts/${encodeURIComponent(d.code)}/toggle"><button class="ghost" type="submit">${d.active ? 'Pause' : 'Activate'}</button></form></td></tr>`))}`];
}

async function simpleList(kind, url) {
  if (kind === 'customers') {
    const rows = await q(`select c.id, c.email, c.name, c.is_admin, c.accepts_marketing, c.created_at, count(o.id) filter (where o.status in ('paid','fulfilled'))::int as orders, coalesce(sum(o.total) filter (where o.status in ('paid','fulfilled')),0)::int as spent
      from customers c left join orders o on o.customer_id = c.id group by c.id order by c.id desc limit 300`);
    return ['Customers', `<h1>Customers</h1>${table(['Customer', 'Orders', 'Spent', 'Marketing', 'Joined'], rows.map((c) => `<tr><td>${esc(c.name || '—')} ${c.is_admin ? '<span class="b b-paid">admin</span>' : ''}<br><span class="muted">${esc(c.email)}</span></td><td>${c.orders}</td><td>${money(c.spent)}</td><td>${c.accepts_marketing ? 'yes' : '—'}</td><td class="muted">${when(c.created_at)}</td></tr>`))}`];
  }
  if (kind === 'subscribers') {
    const rows = await q('select * from subscribers order by created_at desc limit 500');
    return ['Subscribers', `<h1>Subscribers (${rows.length})</h1><p><a class="a-btn" href="/admin/subscribers.csv">Download CSV</a></p>${table(['Email', 'Source', 'Joined'], rows.map((s) => `<tr><td>${esc(s.email)}</td><td>${esc(s.source)}</td><td class="muted">${when(s.created_at)}</td></tr>`))}`];
  }
  if (kind === 'messages') {
    const rows = await q('select * from messages order by handled, id desc limit 200');
    return ['Messages', `<h1>Messages</h1>${table(['From', 'Message', 'Received', ''], rows.map((m) => `<tr><td>${esc(m.name)}<br><a class="muted" href="mailto:${esc(m.email)}">${esc(m.email)}</a></td><td style="white-space:pre-wrap;max-width:520px">${esc(m.body)}</td><td class="muted">${when(m.created_at)}</td><td>${m.handled ? '<span class="muted">done</span>' : `<form method="post" action="/admin/messages/${m.id}/handled"><button class="ghost" type="submit">Mark done</button></form>`}</td></tr>`))}`];
  }
  if (kind === 'emails') {
    const id = Number(url.searchParams.get('id') || 0);
    if (id) {
      const e = await one('select * from emails where id = $1', [id]);
      if (!e) return null;
      return ['Email', `<p><a href="/admin/emails" class="muted">← Email log</a></p><h1>${esc(e.subject)}</h1><p class="muted">To ${esc(e.to_email)} · ${when(e.created_at)} · ${esc(e.status)}</p><iframe sandbox="" srcdoc="${esc(e.html)}" title="Email preview"></iframe>`];
    }
    const rows = await q('select id, to_email, subject, kind, status, created_at from emails order by id desc limit 200');
    return ['Email log', `<h1>Email log</h1><p class="muted">${process.env.RESEND_API_KEY ? 'Sending through Resend.' : 'RESEND_API_KEY is not set, so emails are logged here instead of sent.'}</p>${table(['To', 'Subject', 'Kind', 'Status', 'When'], rows.map((e) => `<tr><td>${esc(e.to_email)}</td><td><a href="/admin/emails?id=${e.id}">${esc(e.subject)}</a></td><td>${esc(e.kind)}</td><td>${esc(e.status)}</td><td class="muted">${when(e.created_at)}</td></tr>`))}`];
  }
  if (kind === 'events') {
    const rows = await q('select * from events order by id desc limit 200');
    return ['Events', `<h1>Events</h1><p class="muted">Stripe webhooks (deduplicated by event id) and the order timeline.</p>${table(['When', 'Source', 'Type', 'Ref', 'Verified', 'Data'], rows.map((e) => `<tr><td class="muted">${when(e.created_at)}</td><td>${esc(e.source)}</td><td>${esc(e.type)}</td><td>${e.source !== 'stripe' && /^\d+$/.test(e.ref || '') ? `<a href="/admin/orders/${e.ref}">#${e.ref}</a>` : esc(e.ref || '')}</td><td>${e.verified ? 'yes' : '<span class="neg">no</span>'}</td><td class="muted" style="max-width:340px;word-break:break-all">${esc(e.data ? JSON.stringify(e.data) : '')}</td></tr>`))}`];
  }
  return null;
}

async function settingsPage(origin) {
  const wh = await one("select value from meta where key = 'stripe_webhook_secret'");
  const mode = stripe.stripeEnabled() ? (stripe.stripeTestMode() ? 'Stripe test mode' : 'Stripe LIVE mode') : 'Built-in test card (no STRIPE_SECRET_KEY)';
  return ['Settings', `<h1>Settings</h1><div class="a-card"><dl>
    <dt>Payments</dt><dd>${esc(mode)}</dd>
    <dt>Webhook</dt><dd>${process.env.STRIPE_WEBHOOK_SECRET ? 'STRIPE_WEBHOOK_SECRET env var' : wh ? `Connected → ${esc(wh.value.url)}<br><span class="muted">${when(wh.value.created)}</span>` : '<span class="neg">Not connected</span>'}</dd>
    <dt>Email</dt><dd>${process.env.RESEND_API_KEY ? 'Resend' : 'Logged only (set RESEND_API_KEY to send)'}</dd>
    <dt>Database</dt><dd>${process.env.DATABASE_URL || process.env.POSTGRES_URL ? 'Postgres (Neon)' : 'PGlite (local)'}</dd>
    <dt>Origin</dt><dd>${esc(origin)}</dd></dl></div>
  ${stripe.stripeEnabled() ? `<h2>Stripe webhook</h2><p class="muted">Registers ${esc(origin)}/api/webhooks/stripe with Stripe for checkout.session.completed / async_payment_succeeded / expired and charge.refunded, and stores the signing secret. Run it again after changing domains.</p>
  <form method="post" action="/admin/settings/webhook"><button type="submit">${wh ? 'Reconnect' : 'Connect'} webhook</button></form>` : ''}`];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function orderAction(number, action, b, origin) {
  const o = await one('select * from orders where number = $1', [Number(number) || 0]);
  if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found.');
  if (action === 'fulfil') {
    if (o.status !== 'paid') throw new AppError(409, 'BAD_STATE', 'Only paid orders can be launched.');
    const tracking = { carrier: String(b.carrier || 'Orbital Post').slice(0, 30), number: String(b.tracking_number || '').trim().slice(0, 40) };
    if (!tracking.number) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a tracking number.');
    const [u] = await q("update orders set status = 'fulfilled', fulfilled_at = now(), tracking = $2::jsonb where id = $1 and status = 'paid' returning *", [o.id, JSON.stringify(tracking)]);
    await store.logEvent('admin', 'order.fulfilled', String(o.number), tracking);
    if (u) await mail.shippingConfirmation(u, origin);
    return 'Marked as launched and the customer was emailed.';
  }
  if (action === 'refund') {
    if (!['paid', 'fulfilled'].includes(o.status)) throw new AppError(409, 'BAD_STATE', 'Only paid orders can be refunded.');
    const amount = Math.min(cents(b.amount, 'Amount'), o.total - o.refunded);
    if (amount <= 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing left to refund.');
    if (o.payment_intent && !o.payment_intent.startsWith('pi_test_') && stripe.stripeEnabled()) await stripe.refund(o.payment_intent, amount);
    const total = o.refunded + amount;
    await q("update orders set refunded = $2, status = case when $2 >= total then 'refunded' else status end where id = $1", [o.id, total]);
    await store.logEvent('admin', 'order.refunded', String(o.number), { amount });
    await mail.refundNotice(o, amount, origin);
    return `Refunded ${money(amount)}.`;
  }
  if (action === 'cancel') {
    if (o.stripe_session_id && stripe.stripeEnabled()) { try { await stripe.expireSession(o.stripe_session_id); } catch { /* already gone */ } }
    const r = await releaseOrder(o, 'cancelled', 'cancelled by admin');
    return r ? 'Cancelled and the stock was released.' : 'The order was no longer pending.';
  }
  throw new AppError(404, 'NOT_FOUND', 'Unknown action.');
}

async function createDiscount(b) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) throw new AppError(400, 'VALIDATION_ERROR', 'Codes use 3–24 letters, digits, _ or -.');
  const kind = b.kind === 'fixed' ? 'fixed' : 'percent';
  const raw = Number(String(b.value || '').replace(/[$%]/g, ''));
  if (!(raw > 0)) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a value above zero.');
  const value = kind === 'fixed' ? Math.round(raw * 100) : Math.min(90, Math.round(raw));
  const min = cents(b.min_subtotal, 'Min subtotal', false) || 0;
  const limit = b.usage_limit ? Math.max(1, Number.parseInt(b.usage_limit, 10) || 1) : null;
  const label = `${kind === 'fixed' ? money(value) : value + '%'} off${min ? ` orders of ${money(min)}+` : ''}`;
  const r = await q('insert into discounts (code, kind, value, min_subtotal, label, usage_limit) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning code', [code, kind, value, min, label, limit]);
  if (!r.length) throw new AppError(409, 'DUPLICATE', `${code} already exists.`);
  return `${code} created.`;
}

// ---------------------------------------------------------------------------
// Entry point from server.js
// ---------------------------------------------------------------------------
function sameOrigin(req, origin) {
  const o = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '');
  return !o || o === origin;
}
const redirect = (res, to, cookie) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) }); res.end(); };
const html = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };

function loginPage(err, next = '/admin') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in — ORBITAL SURPLUS admin</title><style>${CSS}</style></head>
  <body><main class="a-login"><form method="post" action="/admin/login"><p class="a-brand">[ORBITAL SURPLUS] <b>■</b><br><span class="muted">DEPOT ADMIN</span></p>
  ${err ? `<p class="a-note a-err" role="alert">${esc(err)}</p>` : ''}<input type="hidden" name="next" value="${esc(next)}">
  <div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
  <div><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
  <button type="submit">Sign in</button><a class="muted" href="/">← Back to the store</a></form></main></body></html>`;
}

export async function handleAdmin(ctx, { origin, secure }) {
  const { req, res, url } = ctx;
  const path = url.pathname.replace(/\/+$/, '') || '/admin';
  const method = req.method;
  await store.boot();
  await auth.ensureAdmin();

  if (method === 'POST' && !sameOrigin(req, origin)) return html(res, 403, 'Cross-site request refused.');

  if (path === '/admin/login') {
    if (method === 'POST') {
      const b = await formBody(req);
      try {
        const c = await auth.login(b.email, b.password, clientIp(req));
        if (!c.is_admin) throw new auth.AuthError('This account does not have admin access.');
        const tok = await auth.createSession(c.id);
        const next = String(b.next || '/admin');
        return redirect(res, next.startsWith('/admin') ? next : '/admin', auth.sessionCookie(tok, secure));
      } catch (e) {
        if (!(e instanceof auth.AuthError)) throw e;
        return html(res, 401, loginPage(e.message, b.next));
      }
    }
    return html(res, 200, loginPage(null, url.searchParams.get('next') || '/admin'));
  }

  const admin = await auth.sessionCustomer(ctx.cookies.os_sid);
  if (!admin?.is_admin) {
    if (method !== 'GET') return html(res, 401, 'Sign in first.');
    return redirect(res, `/admin/login?next=${encodeURIComponent(path)}`);
  }
  if (path === '/admin/logout' && method === 'POST') { await auth.destroySession(ctx.cookies.os_sid); return redirect(res, '/admin/login', auth.clearSessionCookie(secure)); }

  const note = url.searchParams.get('note'), errQ = url.searchParams.get('err');
  const back = (to, msg, isErr = false) => redirect(res, `${to}${to.includes('?') ? '&' : '?'}${isErr ? 'err' : 'note'}=${encodeURIComponent(msg)}`);

  if (method === 'POST') {
    const b = await formBody(req);
    let m;
    try {
      if ((m = path.match(/^\/admin\/orders\/(\d+)\/(fulfil|refund|cancel)$/))) return back(`/admin/orders/${m[1]}`, await orderAction(m[1], m[2], b, origin));
      if (path === '/admin/products/new') { const slug = await saveProduct(b, null); return back(`/admin/products/${slug}`, 'Product created.'); }
      if ((m = path.match(/^\/admin\/products\/([a-z0-9-]+)$/))) { await saveProduct(b, m[1]); return back(path, 'Saved. The storefront picks it up on the next request.'); }
      if (path === '/admin/discounts') return back('/admin/discounts', await createDiscount(b));
      if ((m = path.match(/^\/admin\/discounts\/([^/]+)\/toggle$/))) { await q('update discounts set active = not active where code = $1', [decodeURIComponent(m[1])]); return back('/admin/discounts', 'Updated.'); }
      if ((m = path.match(/^\/admin\/messages\/(\d+)\/handled$/))) { await q('update messages set handled = true where id = $1', [Number(m[1])]); return back('/admin/messages', 'Marked as done.'); }
      if (path === '/admin/settings/webhook') { const ep = await stripe.connectWebhook(origin); return back('/admin/settings', `Webhook connected (${ep.id}).`); }
    } catch (e) {
      if (e instanceof AppError) return back(path.replace(/\/(fulfil|refund|cancel|toggle|handled)$/, '').replace(/\/[^/]+\/toggle$/, '') || '/admin', e.message, true);
      if (e.stripe) return back(path.replace(/\/(fulfil|refund|cancel)$/, ''), `Stripe: ${e.message}`, true);
      throw e;
    }
    return html(res, 404, 'Not found');
  }

  if (path === '/admin/subscribers.csv') {
    const rows = await q('select email, source, created_at from subscribers order by created_at');
    const csv = 'email,source,created_at\n' + rows.map((r) => `${r.email},${r.source},${new Date(r.created_at).toISOString()}`).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"', 'Cache-Control': 'no-store' });
    return res.end(csv);
  }

  let out = null, m;
  if (path === '/admin') out = await dashboard();
  else if (path === '/admin/orders') out = await ordersList(url);
  else if ((m = path.match(/^\/admin\/orders\/(\d+)$/))) out = await orderDetail(m[1]);
  else if (path === '/admin/products') out = await productsList();
  else if (path === '/admin/products/new') out = ['New product', `<p><a href="/admin/products" class="muted">← Products</a></p><h1>New product</h1>${productForm(null, null, '/admin/products/new')}`];
  else if ((m = path.match(/^\/admin\/products\/([a-z0-9-]+)$/))) out = await productEdit(m[1]);
  else if (path === '/admin/discounts') out = await discountsPage();
  else if ((m = path.match(/^\/admin\/(customers|subscribers|messages|emails|events)$/))) out = await simpleList(m[1], url);
  else if (path === '/admin/settings') out = await settingsPage(origin);
  if (!out) return html(res, 404, page('Not found', '<h1>Not found</h1>', { path, admin }));
  return html(res, 200, page(out[0], out[1], { path, admin, note, err: errQ }));
}
