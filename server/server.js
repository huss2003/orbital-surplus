// server/server.js
// -----------------------------------------------------------------------------
// Entry point. A zero-dependency HTTP server built on node:http.
//
// Request pipeline (in order):
//   1. security headers on every response (security.js)
//   2. /api/*            → JSON API (router table below)
//   3. /admin            → admin page (admin.js)
//   4. crawler files     → robots.txt, sitemap.xml, llms.txt, site.webmanifest
//   5. /img/*            → public/img first, else generated SVG (images.js)
//   6. paths with a file extension → static files from public/
//   7. everything else   → SPA shell with per-route SEO tags (seo.js), 404 if unknown
//
// Run:  npm start   (PORT=3000 by default)
// -----------------------------------------------------------------------------
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import * as store from './store.js';
import { AppError } from './store.js';
import * as checkout from './checkout.js';
import * as seo from './seo.js';
import * as auth from './auth.js';
import * as stripe from './stripe.js';
import * as mail from './email.js';
import { q } from './db.js';
import { generatedImage } from './images.js';
import { handleAdmin } from './admin.js';
import {
  securityHeaders, makeNonce, rateLimit, readJsonBody, readRawBody,
  vString, vEmail, vInt, parseCookies, clientIp,
} from './security.js';

const quiet = process.env.QUIET === '1';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', // API answers are per-user and live
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', cache = 'no-cache') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const sendError = (res, err) =>
  sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });

// ---------------------------------------------------------------------------
// A minimal router: route('GET', '/api/products/:slug', handler)
// ---------------------------------------------------------------------------
const routes = [];

function route(method, pattern, handler, { mutating = method !== 'GET' } = {}) {
  // '/api/cart/items/:lineId' → /^\/api\/cart\/items\/([^/]+)$/ with keys ['lineId']
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
  );
  routes.push({ method, re, keys, handler, mutating });
}

function match(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return { route: r, params };
  }
  return { route: null, pathMatched };
}

// ---------------------------------------------------------------------------
// Cookies: cart (anonymous, 30 days) + session (signed-in customer)
// ---------------------------------------------------------------------------
const CART_COOKIE = 'os_cart';

function isHttps(req) {
  return config.siteUrl.startsWith('https://') || Boolean(process.env.VERCEL) ||
    (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
}

function addCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

/** The shopper's cart from the cookie, creating one (and the cookie) if needed. */
async function cartFor(ctx) {
  let cart = await store.getCart(ctx.cookies[CART_COOKIE]);
  if (!cart) {
    cart = await store.createCart(ctx.customer?.id ?? null);
    const attrs = [`${CART_COOKIE}=${cart.id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${30 * 24 * 3600}`];
    if (isHttps(ctx.req)) attrs.push('Secure');
    addCookie(ctx.res, attrs.join('; '));
    ctx.cookies[CART_COOKIE] = cart.id;
  }
  if (ctx.customer && cart.customer_id !== ctx.customer.id) cart = await store.attachCart(cart, ctx.customer.id);
  return cart;
}

async function customerFor(ctx) {
  if (ctx.customer === undefined) ctx.customer = await auth.sessionCustomer(ctx.cookies.os_sid);
  return ctx.customer;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
route('GET', '/api/health', async () => ({ ok: true, db: (await q('select 1 as ok'))[0]?.ok === 1, payments: stripe.stripeEnabled() ? 'stripe' : 'test-card' }));

route('GET', '/api/products', () => ({ products: store.listProducts() }));

route('GET', '/api/products/:slug', ({ params }) => {
  const product = store.getProduct(params.slug);
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', `No product "${params.slug}".`);
  return { product };
});

route('GET', '/api/size-chart', () => store.sizeChart());

route('GET', '/api/shipping-rates', async (ctx) => {
  const country = (ctx.query.get('country') || 'US').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new AppError(400, 'VALIDATION_ERROR', 'country: use a 2-letter ISO code');
  const state = (ctx.query.get('state') || '').toUpperCase().slice(0, 2);
  const cart = await store.getCart(ctx.cookies[CART_COOKIE]);
  const t = cart ? await store.cartTotals(cart) : { subtotal: 0, discount: 0 };
  // rates + the sales tax this address would pay (the server recomputes both when the order is created)
  return { rates: store.shippingRates(country, t.subtotal - t.discount), tax: store.taxFor({ country, state }, t.subtotal - t.discount) };
});

// --- cart --------------------------------------------------------------------
route('GET', '/api/cart', async (ctx) => store.cartView(await cartFor(ctx)));

route('POST', '/api/cart/items', async (ctx) => {
  const b = ctx.body;
  const slug = vString(b.slug, 'slug', { max: 80, pattern: /^[a-z0-9-]+$/ });
  const size = vString(b.size, 'size', { max: 5 }).toUpperCase();
  const quantity = b.quantity === undefined ? 1 : vInt(b.quantity, 'quantity', { min: 1, max: store.MAX_LINE_QTY });
  const cart = await cartFor(ctx);
  await store.addItem(cart, { slug, size, quantity });
  return store.cartView(cart);
});

route('PATCH', '/api/cart/items/:lineId', async (ctx) => {
  const quantity = vInt(ctx.body.quantity, 'quantity', { min: 0, max: store.MAX_LINE_QTY });
  const cart = await cartFor(ctx);
  await store.updateItem(cart, ctx.params.lineId, quantity);
  return store.cartView(cart);
});

route('DELETE', '/api/cart/items/:lineId', async (ctx) => {
  const cart = await cartFor(ctx);
  await store.removeItem(cart, ctx.params.lineId);
  return store.cartView(cart);
});

route('POST', '/api/cart/discount', async (ctx) => {
  const code = vString(ctx.body.code, 'code', { max: 32 });
  const cart = await cartFor(ctx);
  await store.applyDiscount(cart, code);
  return store.cartView(cart);
});

route('DELETE', '/api/cart/discount', async (ctx) => {
  const cart = await cartFor(ctx);
  await store.removeDiscount(cart);
  return store.cartView(cart);
});

// --- checkout ------------------------------------------------------------------
route('POST', '/api/checkout/session', async (ctx) => {
  ctx.status = 201;
  return checkout.createSession(await cartFor(ctx), ctx.body, { origin: ctx.origin, customer: ctx.customer });
});
route('POST', '/api/checkout/cancel', async (ctx) => checkout.cancelByToken(vString(ctx.body.token, 'token', { max: 64 })));

// Built-in test card page (only used when STRIPE_SECRET_KEY is not set)
route('GET', '/api/checkout/session/:id', async ({ params }) => ({ session: await checkout.testSessionView(params.id) }));
route('POST', '/api/checkout/session/:id/confirm', async (ctx) => checkout.confirmTestPayment(ctx.params.id, ctx.body, ctx.origin));

route('GET', '/api/orders/:token', async (ctx) => {
  // Returning from Stripe: confirms the payment (idempotently) before showing the order
  return checkout.orderForReturn(ctx.params.token, ctx.query.get('session_id'), ctx.origin);
});

// --- accounts ------------------------------------------------------------------
const meView = async (c) => {
  if (!c) return { customer: null };
  const orders = await q('select number, token, status, total, items, created_at from orders where customer_id = $1 and status <> \'pending\' order by id desc limit 50', [c.id]);
  return {
    customer: { email: c.email, name: c.name, accepts_marketing: c.accepts_marketing, default_address: c.default_address, is_admin: c.is_admin, created_at: c.created_at },
    orders: orders.map((o) => ({ number: o.number, token: o.token, status: o.status, total: o.total, created_at: o.created_at, item_count: o.items.reduce((s, i) => s + i.quantity, 0), image: o.items[0]?.image })),
  };
};
const authFail = (e) => { if (e instanceof auth.AuthError) throw new AppError(400, 'AUTH', e.message); throw e; };
async function startSession(ctx, c) {
  const tok = await auth.createSession(c.id);
  addCookie(ctx.res, auth.sessionCookie(tok, isHttps(ctx.req)));
  ctx.customer = c;
  const cart = await store.getCart(ctx.cookies[CART_COOKIE]);
  if (cart) await store.attachCart(cart, c.id);
}

route('GET', '/api/account', async (ctx) => meView(ctx.customer));
route('POST', '/api/account/register', async (ctx) => {
  const b = ctx.body;
  const c = await auth.register({ email: b.email, password: b.password, name: b.name, accepts_marketing: b.accepts_marketing === true }).catch(authFail);
  await startSession(ctx, c);
  mail.accountWelcome(c, ctx.origin).catch(() => {});
  ctx.status = 201;
  return meView(await auth.sessionCustomerById(c.id));
});
route('POST', '/api/account/login', async (ctx) => {
  const c = await auth.login(ctx.body.email, ctx.body.password, clientIp(ctx.req)).catch(authFail);
  await startSession(ctx, c);
  return meView(await auth.sessionCustomerById(c.id));
});
route('POST', '/api/account/logout', async (ctx) => {
  await auth.destroySession(ctx.cookies.os_sid);
  addCookie(ctx.res, auth.clearSessionCookie(isHttps(ctx.req)));
  // the cart belongs to the account now: give this browser a fresh one
  addCookie(ctx.res, `${CART_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return { customer: null };
});
route('PATCH', '/api/account', async (ctx) => {
  const c = ctx.customer;
  if (!c) throw new AppError(401, 'SIGN_IN', 'Sign in first.');
  const b = ctx.body;
  const name = b.name === undefined ? c.name : vString(b.name, 'name', { min: 0, max: 100 });
  const marketing = b.accepts_marketing === undefined ? c.accepts_marketing : b.accepts_marketing === true;
  let addr = c.default_address;
  if (b.address) {
    const a = b.address;
    addr = { line1: vString(a.line1 || '', 'line1', { min: 0, max: 120 }), city: vString(a.city || '', 'city', { min: 0, max: 80 }), state: vString(a.state || '', 'state', { min: 0, max: 40 }).toUpperCase(), postal_code: vString(a.postal_code || '', 'postal_code', { min: 0, max: 16 }), country: vString(a.country || 'US', 'country', { max: 2, pattern: /^[A-Za-z]{2}$/ }).toUpperCase() };
  }
  await q('update customers set name = $2, accepts_marketing = $3, default_address = $4::jsonb where id = $1', [c.id, name, marketing, addr ? JSON.stringify(addr) : null]);
  if (marketing) await store.addSubscriber(c.email, 'account');
  return meView(await auth.sessionCustomerById(c.id));
});
route('POST', '/api/account/forgot', async (ctx) => {
  const email = vEmail(ctx.body.email);
  const r = await auth.createReset(email);
  if (r) await mail.passwordResetEmail(r.email, `${ctx.origin}/account/reset/${r.token}`, ctx.origin);
  return { ok: true }; // same answer either way: don't reveal which emails have accounts
});
route('POST', '/api/account/reset', async (ctx) => {
  const id = await auth.useReset(ctx.body.token, ctx.body.password).catch(authFail);
  const c = await auth.sessionCustomerById(id);
  await startSession(ctx, c);
  return meView(c);
});

// --- marketing / contact -------------------------------------------------------
route('POST', '/api/newsletter', async (ctx) => {
  const email = vEmail(ctx.body.email);
  if (await store.addSubscriber(email, 'footer')) await mail.welcomeEmail(email, ctx.origin);
  return { ok: true };
});

route('POST', '/api/contact', async (ctx) => {
  const name = vString(ctx.body.name, 'name', { max: 100 });
  const email = vEmail(ctx.body.email);
  const message = vString(ctx.body.message, 'message', { min: 5, max: 4000 });
  await store.addMessage(name, email, message);
  await mail.contactAck(name, email, ctx.origin);
  return { ok: true };
});

// --- Stripe webhook (raw body needed for the signature) ----------------------
route(
  'POST',
  '/api/webhooks/stripe',
  async (ctx) => checkout.handleStripeWebhook(await readRawBody(ctx.req, 512 * 1024), ctx.req.headers['stripe-signature'], ctx.origin),
  { mutating: false }, // not rate limited, no JSON parsing up front
);

async function handleApi(ctx) {
  const { route: r, params, pathMatched } = match(ctx.req.method, ctx.pathname);
  if (!r) {
    if (pathMatched) throw new AppError(405, 'METHOD_NOT_ALLOWED', `${ctx.req.method} is not allowed here.`);
    throw new AppError(404, 'NOT_FOUND', `No API route ${ctx.pathname}.`);
  }
  ctx.params = params;
  await store.refresh();
  await customerFor(ctx);
  if (r.mutating) {
    // Cross-site requests can't read our JSON, but they could still fire one: refuse foreign origins.
    const o = ctx.req.headers.origin;
    if (o && o !== ctx.origin) throw new AppError(403, 'CROSS_ORIGIN', 'Cross-site request refused.');
    rateLimit(ctx.req, ctx.res);
    // Requiring JSON bodies also blocks classic cross-site <form> CSRF; the
    // SameSite=Lax cookie covers the rest.
    ctx.body = await readJsonBody(ctx.req);
  }
  const data = await r.handler(ctx);
  sendJson(ctx.res, ctx.status || 200, data);
}

// ---------------------------------------------------------------------------
// Static files from public/
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

/** Cache policy by path (the original left hashed assets un-cacheable). */
function cacheControlFor(pathname, ext) {
  if (ext === '.html') return 'no-cache';
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'; // content-hashed names
  if (ext === '.js' || ext === '.mjs' || ext === '.css') return 'public, max-age=3600';
  if (pathname.startsWith('/img/')) return 'public, max-age=86400';
  return 'public, max-age=86400';
}

/**
 * Resolve a URL path inside public/ safely. Returns an absolute file path or
 * null. Blocks `..` traversal, NUL bytes and dotfiles (.env, .git …).
 */
function safePublicPath(pathname) {
  if (pathname.includes('\0')) return null;
  if (pathname.split('/').some((seg) => seg.startsWith('.'))) return null;
  const abs = path.resolve(config.publicDir, '.' + pathname);
  if (abs !== config.publicDir && !abs.startsWith(config.publicDir + path.sep)) return null;
  return abs;
}

/** Try to serve a file from public/. Returns true if a response was sent. */
function serveStatic(req, res, pathname) {
  const abs = safePublicPath(pathname);
  if (!abs) return false;
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = path.extname(abs).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControlFor(pathname, ext),
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(abs).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const started = Date.now();
  const nonce = makeNonce();
  for (const [k, v] of Object.entries(securityHeaders(nonce))) res.setHeader(k, v);

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
    decodeURIComponent(url.pathname); // throws on malformed %-escapes
  } catch {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'Malformed URL.' });
  }
  const pathname = url.pathname;
  const ctx = { req, res, url, pathname, query: url.searchParams, cookies: parseCookies(req), params: {}, body: {}, origin: seo.originFor(req), customer: undefined };

  res.on('finish', () => {
    if (!quiet) console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, HEAD, POST, PATCH, DELETE, OPTIONS' });
      return res.end();
    }

    if (pathname.startsWith('/api/')) return await handleApi(ctx);
    if (pathname === '/admin' || pathname.startsWith('/admin/')) return await handleAdmin(ctx, { origin: ctx.origin, secure: isHttps(req) });

    // Everything below is read-only.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are allowed here.');
    }

    // Canonical URLs have no trailing slash (same as the original, 308).
    if (pathname.length > 1 && pathname.endsWith('/')) {
      res.writeHead(308, { Location: pathname.replace(/\/+$/, '') + url.search });
      return res.end();
    }

    const origin = ctx.origin;
    if (!path.extname(pathname) || ['/sitemap.xml', '/llms.txt'].includes(pathname)) await store.refresh();

    if (pathname === '/robots.txt') return sendText(res, 200, seo.robotsTxt(origin), 'text/plain; charset=utf-8', 'public, max-age=3600');
    if (pathname === '/sitemap.xml') return sendText(res, 200, seo.sitemapXml(origin), 'application/xml; charset=utf-8', 'public, max-age=3600');
    if (pathname === '/llms.txt') return sendText(res, 200, seo.llmsTxt(origin), 'text/plain; charset=utf-8', 'public, max-age=3600');
    if (pathname === '/site.webmanifest') {
      return sendText(res, 200, JSON.stringify(seo.webManifest(), null, 2), 'application/manifest+json', 'public, max-age=86400');
    }

    if (pathname.startsWith('/img/')) {
      if (serveStatic(req, res, pathname)) return; // frontend-shipped image wins
      const svg = generatedImage(pathname.slice('/img/'.length));
      if (svg) return sendText(res, 200, svg, 'image/svg+xml', 'public, max-age=86400');
      return sendText(res, 404, 'Not found');
    }

    // Files (anything with an extension). index.html is only served via the SEO path.
    if (path.extname(pathname)) {
      if (pathname !== '/index.html' && serveStatic(req, res, pathname)) return;
      return sendText(res, 404, 'Not found');
    }

    // SPA routes: HTML shell + route-specific SEO tags; real 404 for unknown paths.
    const { status, html } = seo.renderPage(pathname, { origin, nonce });
    return sendText(res, status, html, 'text/html; charset=utf-8', 'no-cache');
  } catch (err) {
    if (err instanceof AppError) return sendError(res, err);
    console.error('[error]', req.method, pathname, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: 'Something went wrong.' });
    else res.end();
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
/** The request handler, shared by the local server and the Vercel Function (api/index.js). */
export const handler = handle;

export async function start({ port = config.port, host = config.host } = {}) {
  await store.boot();
  await auth.ensureAdmin();
  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  // Slowloris protection: drop clients that trickle headers/bodies.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      console.log(`${config.brand} listening on http://localhost:${actual}`);
      resolve(server);
    });
  });
}

// Run when executed directly (`node server/server.js`), not when imported.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await start();
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); // drop idle keep-alive sockets (Node 18.2+)
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
