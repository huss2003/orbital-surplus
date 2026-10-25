// server/seo.js
// -----------------------------------------------------------------------------
// Per-route SEO, done at request time.
//
// The original site ran a custom Vite plugin at BUILD time that wrote one HTML
// file per route with its own <title>, meta description, canonical, Open Graph
// tags and a JSON-LD @graph. We do the same thing on every request instead:
// read public/index.html (the SPA shell), strip its generic head tags, and
// inject the tags for the requested route. The SPA then boots as usual.
//
// Unknown routes (and unknown product slugs / AR skus) get a real 404 status,
// like the original's /404.html, so search engines don't index soft-404s.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { allProducts, findProductBySku, availableQty } from './store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** JSON inside <script> must not contain "</script>": escape `<`. */
const jsonForScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

const dollars = (cents) => (cents / 100).toFixed(2);

/** The public origin, e.g. https://nullvault.example (no trailing slash). */
export function originFor(req) {
  if (config.siteUrl) return config.siteUrl;
  const host = String(req.headers.host || '');
  // Never reflect a weird Host header into HTML.
  const safeHost = /^[a-z0-9.\-]+(:\d{1,5})?$/i.test(host) ? host : `localhost:${config.port}`;
  const https = process.env.VERCEL || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
  return `${https ? 'https' : 'http'}://${safeHost}`;
}

// ---------------------------------------------------------------------------
// Structured data builders (schema.org)
// ---------------------------------------------------------------------------
const org = (origin) => ({
  '@type': 'Organization',
  '@id': `${origin}/#org`,
  name: config.brand,
  url: `${origin}/`,
  logo: `${origin}/img/icon.svg`,
});

const website = (origin) => ({
  '@type': 'WebSite',
  '@id': `${origin}/#website`,
  name: config.brand,
  url: `${origin}/`,
  publisher: { '@id': `${origin}/#org` },
});

function breadcrumbs(origin, trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${origin}${p}` })),
  };
}

function productLd(origin, p) {
  return {
    '@type': 'Product',
    '@id': `${origin}/shop/${p.slug}#product`,
    name: p.name,
    sku: p.sku,
    description: p.description.split('\n')[0],
    category: p.category,
    color: p.color,
    material: p.materials.join(', '),
    brand: { '@type': 'Brand', name: config.brand },
    image: p.images.map((i) => `${origin}${i}`),
    size: p.sizes,
    offers: {
      '@type': 'Offer',
      url: `${origin}/shop/${p.slug}`,
      priceCurrency: p.currency,
      price: dollars(p.price),
      itemCondition: 'https://schema.org/NewCondition',
      // Unlike the original (always InStock), this reflects real stock.
      availability: p.sizes.some((s) => availableQty(p.slug, s) > 0) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller: { '@id': `${origin}/#org` },
    },
  };
}

function itemList(origin) {
  return {
    '@type': 'ItemList',
    itemListElement: allProducts().map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/shop/${p.slug}`, name: p.name })),
  };
}

// ---------------------------------------------------------------------------
// Route table: path → page meta. Returns null for unknown paths.
// ---------------------------------------------------------------------------
const B = config.brand;
const NOINDEX = 'noindex, follow';

export function resolveRoute(pathname, origin) {
  const products = allProducts();
  const base = [org(origin), website(origin)];
  const productLines = products.map((p) => `${p.name} — ${p.category}, $${dollars(p.price)}`).join('. ');

  if (pathname === '/') {
    return {
      title: `${B} — Outerwear depot in orbit, 2051`,
      description: `${B} is an outerwear depot from 2051: six jackets you can spin in real-time 3D and try on in AR. ${productLines}.`.slice(0, 300),
      canonical: '/',
      jsonld: [...base, { '@type': 'WebPage', name: B, url: `${origin}/` }, itemList(origin)],
      text: `${B}. ${productLines}.`,
    };
  }
  if (pathname === '/shop') {
    return {
      title: `Shop the depot — ${B}`,
      description: `Browse every ${B} jacket in an interactive 3D grid: ${productLines}.`.slice(0, 300),
      canonical: '/shop',
      jsonld: [...base, { '@type': 'CollectionPage', name: `Shop — ${B}`, url: `${origin}/shop` }, itemList(origin), breadcrumbs(origin, [['Home', '/'], ['Shop', '/shop']])],
      text: `Shop. ${productLines}.`,
    };
  }
  const shop = pathname.match(/^\/shop\/([a-z0-9-]+)$/);
  if (shop) {
    const p = products.find((x) => x.slug === shop[1]);
    if (!p) return null;
    return {
      title: `${p.name} — ${p.category} | ${B}`,
      description: `${p.name}: ${p.color.toLowerCase()} ${p.category.toLowerCase()} in ${p.materials.join(' / ')}. $${dollars(p.price)} USD. Sizes ${p.sizes.join('–')}. View in 3D or AR.`.slice(0, 300),
      canonical: `/shop/${p.slug}`,
      ogType: 'product',
      image: p.images[0],
      extraMeta: [
        ['property', 'product:price:amount', dollars(p.price)],
        ['property', 'product:price:currency', p.currency],
      ],
      jsonld: [
        ...base,
        { '@type': 'ItemPage', name: p.name, url: `${origin}/shop/${p.slug}` },
        productLd(origin, p),
        breadcrumbs(origin, [['Home', '/'], ['Shop', '/shop'], [p.name, `/shop/${p.slug}`]]),
      ],
      text: `${p.name}. ${p.description}`,
    };
  }
  if (pathname === '/playground') {
    return {
      title: `Playground — ${B}`,
      description: `An experimental WebGL image gallery from ${B}.`,
      canonical: '/playground',
      jsonld: [...base, { '@type': 'WebPage', name: 'Playground', url: `${origin}/playground` }, breadcrumbs(origin, [['Home', '/'], ['Playground', '/playground']])],
      text: 'Playground: WebGL gallery.',
    };
  }
  const ar = pathname.match(/^\/ar\/([A-Za-z0-9-]+)$/);
  if (ar) {
    const p = findProductBySku(ar[1]);
    if (!p) return null;
    return {
      title: `${p.name} in AR — ${B}`,
      description: `Place the ${p.name} in your room with WebXR (Android) or Quick Look (iOS).`,
      canonical: `/ar/${p.sku}`,
      robots: NOINDEX,
      image: p.images[0],
      jsonld: [...base, { '@type': 'WebPage', name: `${p.name} AR`, url: `${origin}/ar/${p.sku}` }, breadcrumbs(origin, [['Home', '/'], ['Shop', '/shop'], [p.name, `/shop/${p.slug}`], ['AR', `/ar/${p.sku}`]])],
      text: `${p.name} augmented reality view.`,
    };
  }
  // Transactional pages: useful to render, useless (or private) in search.
  const privatePages = [
    [/^\/cart$/, 'Your cargo hold'],
    [/^\/account$/, 'Your account'],
    [/^\/account\/reset\/[A-Za-z0-9]{1,128}$/, 'Reset password'],
    [/^\/checkout$/, 'Checkout'],
    [/^\/checkout\/pay\/[A-Za-z0-9_-]{1,64}$/, 'Payment'],
    [/^\/order\/[A-Za-z0-9_-]{1,64}$/, 'Your order'],
  ];
  for (const [re, name] of privatePages) {
    if (re.test(pathname)) {
      return {
        title: `${name} — ${B}`,
        description: `${name} at ${B}.`,
        canonical: pathname.startsWith('/order/') || pathname.startsWith('/checkout/pay/') ? null : pathname,
        robots: 'noindex, nofollow',
        jsonld: base,
        text: name,
      };
    }
  }
  return null;
}

export function notFoundMeta() {
  return {
    title: `Page not found — ${B}`,
    description: 'This page does not exist.',
    canonical: null,
    robots: 'noindex, nofollow',
    jsonld: null, // filled with org+website below
    text: '404 — page not found.',
  };
}

// ---------------------------------------------------------------------------
// HTML template + injection
// ---------------------------------------------------------------------------

/** Used when public/index.html is absent (e.g. backend-only checkout, tests). */
const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${B}</title>
<style>body{margin:0;background:#050505;color:#e8e8e8;font:14px/1.5 ui-monospace,monospace;display:grid;place-items:center;min-height:100vh}a{color:#9cf}</style>
</head>
<body>
<div id="app"><p>${B} backend is running. The frontend shell (server/shell.html) is missing. Try <a href="/api/products">/api/products</a> or <a href="/admin">/admin</a>.</p></div>
</body>
</html>`;

let cache = { mtimeMs: -1, html: null };

/** Read the SPA shell (server/shell.html, kept out of public/ so the CDN never serves it without SEO tags + nonce). */
function loadTemplate() {
  const file = path.join(config.ROOT || path.resolve(config.publicDir, '..'), 'server', 'shell.html');
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(file, 'utf8') };
    return cache.html;
  } catch {
    return FALLBACK_TEMPLATE;
  }
}

/** Build the tag block for one page. */
function headTags(meta, origin) {
  const url = meta.canonical ? `${origin}${meta.canonical}` : null;
  const image = `${origin}${meta.image || '/img/og.png'}`;
  const t = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" data-seo>`,
    `<meta name="robots" content="${esc(meta.robots || 'index, follow')}" data-seo>`,
    url ? `<link rel="canonical" href="${esc(url)}" data-seo>` : '',
    `<meta property="og:site_name" content="${esc(B)}" data-seo>`,
    `<meta property="og:type" content="${esc(meta.ogType || 'website')}" data-seo>`,
    `<meta property="og:title" content="${esc(meta.title)}" data-seo>`,
    `<meta property="og:description" content="${esc(meta.description)}" data-seo>`,
    url ? `<meta property="og:url" content="${esc(url)}" data-seo>` : '',
    `<meta property="og:image" content="${esc(image)}" data-seo>`,
    `<meta name="twitter:card" content="summary_large_image" data-seo>`,
    `<meta name="twitter:title" content="${esc(meta.title)}" data-seo>`,
    `<meta name="twitter:description" content="${esc(meta.description)}" data-seo>`,
    ...(meta.extraMeta || []).map(([attr, key, val]) => `<meta ${attr}="${esc(key)}" content="${esc(val)}" data-seo>`),
    `<script type="application/ld+json" data-seo>${jsonForScript({ '@context': 'https://schema.org', '@graph': meta.jsonld })}</script>`,
  ];
  return t.filter(Boolean).join('\n');
}

/** Remove the shell's generic tags so the injected ones are the only ones. */
function stripHead(html) {
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/i, '')
    // Anything the shell marked `data-seo` is a placeholder for us to replace.
    .replace(/<(meta|link)\b[^>]*\sdata-seo\b[^>]*>\s*/gi, '')
    .replace(/<meta\s+[^>]*name=["'](description|robots|twitter:[^"']*)["'][^>]*>\s*/gi, '')
    .replace(/<meta\s+[^>]*property=["'](og:[^"']*|product:[^"']*)["'][^>]*>\s*/gi, '')
    .replace(/<link\s+[^>]*rel=["']canonical["'][^>]*>\s*/gi, '')
    .replace(/<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
}

/** Give every <script> the CSP nonce (import map, inline boot code, JSON-LD). */
const addNonce = (html, nonce) => html.replace(/<script(?![^>]*\snonce=)/gi, `<script nonce="${nonce}"`);

/**
 * Render the HTML for a page route.
 * @returns {{ status: number, html: string }}
 */
export function renderPage(pathname, { origin, nonce }) {
  let meta = resolveRoute(pathname, origin);
  let status = 200;
  if (!meta) {
    status = 404;
    meta = notFoundMeta();
    meta.jsonld = [org(origin), website(origin)];
  }

  let html = stripHead(loadTemplate());
  const tags = headTags(meta, origin);
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tags}\n</head>`) : `${tags}\n${html}`;

  // Text version of the page for crawlers without JS (the original used a
  // hidden #seo-content div; <noscript> never interferes with the SPA).
  const text = `<noscript id="seo-content"><h1>${esc(meta.title)}</h1><p>${esc(meta.text || meta.description)}</p></noscript>`;
  html = html.replace(/<body([^>]*)>/i, (m) => `${m}\n${text}`);

  return { status, html: addNonce(html, nonce) };
}

// ---------------------------------------------------------------------------
// Crawler files
// ---------------------------------------------------------------------------
export function robotsTxt(origin) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /cart',
    'Disallow: /checkout',
    'Disallow: /order/',
    'Disallow: /account',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(origin) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: '/', priority: '1.0' },
    { loc: '/shop', priority: '0.9' },
    ...allProducts().map((p) => ({ loc: `/shop/${p.slug}`, priority: '0.8', images: p.images })),
    { loc: '/playground', priority: '0.5' },
  ];
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${esc(origin + u.loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${u.priority}</priority>\n` +
        (u.images || []).map((i) => `    <image:image><image:loc>${esc(origin + i)}</image:loc></image:image>\n`).join('') +
        '  </url>',
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`;
}

export function llmsTxt(origin) {
  const products = allProducts()
    .map((p) => `- ${p.name} (${p.category}, ${p.color}) — $${dollars(p.price)} USD — sizes ${p.sizes.join(', ')} — ${origin}/shop/${p.slug}`)
    .join('\n');
  return `# ${B}

> ${B} is a portfolio-project online store: an outerwear depot "in orbit, 2051" selling six jackets with interactive 3D and AR previews. Prices are in USD. Payments run in Stripe test mode and nothing ships.

## Products
${products}

## Pages
- ${origin}/ — home with a 3D turntable
- ${origin}/shop — product grid; /shop/{slug} for one product
- ${origin}/ar/{sku} — augmented-reality viewer
- ${origin}/playground — WebGL gallery

## Public JSON API
- GET /api/products — list products (with available sizes)
- GET /api/products/{slug} — one product
- GET /api/size-chart — measurements in cm
- GET /api/shipping-rates?country=XX — shipping options
- GET /api/cart, POST /api/cart/items, PATCH|DELETE /api/cart/items/{lineId} — cart (cookie session)
- POST /api/checkout/session — creates a Stripe Checkout Session (test mode) and holds stock for 31 minutes
- GET /api/orders/{token} — order status for the holder of the token

Prices in the API are integer cents.
`;
}

export function webManifest() {
  return {
    name: B,
    short_name: B,
    description: 'Outerwear depot in orbit, 2051. Jackets in real-time 3D and AR.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#050505',
    theme_color: '#050505',
    icons: [
      { src: '/img/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/img/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
