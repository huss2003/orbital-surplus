// router.js — History-API router with the original's page transition (design-notes §4.1):
//   leave: page opacity 1→0 AND curtain uProgress 1→0, 2.8 s circ.inOut (tweens #5/#6)
//   enter: await page ready → page opacity 0→1 AND curtain 0→1, 2.2 s power2.out (#7/#8)
//   woosh sound 100 ms after navigation starts when the route name changes; the custom
//   cursor is swapped for a native red square while the curtain is closed.
// Differences: commerce routes (cart/checkout/pay/order) use 30 % of those durations (fix #5),
// reduced motion uses a .3 s fade with no curtain, same-view changes (/shop ↔ /shop/:slug)
// call view.update() without any transition.
import { gsap } from './core/gsap.js';
import { reducedMotion } from './core/env.js';
import { sound } from './core/sound.js';
import { cursor } from './core/cursor.js';
import { dialogStack } from './core/dialog.js';

const ROUTES = [
  { name: 'home', re: /^\/$/, load: () => import('./components/HomePage.js') },
  { name: 'shop', re: /^\/shop(?:\/([^/]+))?\/?$/, keys: ['slug'], view: 'shop', load: () => import('./components/ShopPage.js') },
  { name: 'playground', re: /^\/playground\/?$/, load: () => import('./components/PlaygroundPage.js') },
  { name: 'ar', re: /^\/ar\/([^/]+)\/?$/, keys: ['sku'], hideNav: true, load: () => import('./components/ArPage.js') },
  { name: 'cart', re: /^\/cart\/?$/, commerce: true, load: () => import('./components/CartPage.js') },
  { name: 'checkout', re: /^\/checkout\/?$/, commerce: true, load: () => import('./components/Checkout.js') },
  { name: 'pay', re: /^\/checkout\/pay\/([^/]+)\/?$/, keys: ['id'], commerce: true, load: () => import('./components/Checkout.js') },
  { name: 'account', re: /^\/account(?:\/reset\/([A-Za-z0-9]+))?\/?$/, keys: ['reset'], commerce: true, load: () => import('./components/AccountPage.js') },
  { name: 'order', re: /^\/order\/([^/]+)\/?$/, keys: ['token'], commerce: true, load: () => import('./components/OrderPage.js') },
  { name: 'notfound', re: /.*/, load: () => import('./components/NotFound.js') },
];

export function resolve(path, forceNotFound = false) {
  const pathname = path.split(/[?#]/)[0] || '/';
  for (const r of forceNotFound ? ROUTES.slice(-1) : ROUTES) {
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = {}; (r.keys || []).forEach((k, i) => { if (m[i + 1]) params[k] = decodeURIComponent(m[i + 1]); });
    return { ...r, path: pathname, full: path, params, view: r.view || r.name };
  }
}

export function createRouter({ app, curtain, onRoute, makeCtx }) {
  let current = null;         // { route, view, el }
  let busy = false, pending = null, first = true;

  const durations = (from, to) => {
    if (reducedMotion()) return { leave: 0.3, enter: 0.3, curtain: false };
    const k = from?.commerce || to?.commerce ? 0.3 : 1;
    return { leave: 2.8 * k, enter: 2.2 * k, curtain: true };
  };

  async function go(path, { replace = false, pop = false, notFound = false } = {}) {
    if (busy) { pending = { path, replace, pop, notFound }; return; }
    const route = resolve(path, notFound);
    // same view, different params → in-place update, no curtain
    if (!first && !notFound && current && current.route.view === route.view && current.view.update) {
      if (!pop) history[replace ? 'replaceState' : 'pushState']({}, '', path);
      current.view.update(route); current.route = route; onRoute?.(route);
      return;
    }
    busy = true;
    try {
      dialogStack.slice().forEach((d) => d.close());
      const d = durations(current?.route, route);
      if (!first) {
        if (current?.route.name !== route.name) setTimeout(() => sound.play('woosh'), 100);
        cursor.native(true);
        await Promise.all([
          gsap.to(current.el, { opacity: 0, duration: d.leave, ease: 'circ.inOut' }),
          d.curtain ? curtain.to(0, { duration: d.leave, ease: 'circ.inOut' }) : Promise.resolve(),
        ]);
        try { current.view.destroy?.(); } catch (e) { console.warn(e); }
        current.el.remove();
        if (!pop) history[replace ? 'replaceState' : 'pushState']({}, '', path);
        const seo = document.getElementById('seo-content'); if (seo) seo.hidden = true;   // stale after client nav
      }
      onRoute?.(route);
      const el = document.createElement('div');
      el.className = 'page page--' + route.name;
      el.style.opacity = '0';
      app.append(el);
      const ctx = makeCtx(route, { first });
      let view;
      try { const mod = await route.load(); view = await mod.mount(el, route, ctx); }
      catch (err) { console.error('[router] view failed', err); view = { ready: Promise.resolve(), destroy() {} }; el.textContent = 'Something broke while loading this page.'; }
      current = { route, view, el };
      await Promise.race([Promise.resolve(view.ready).catch((e) => console.error(e)), new Promise((r) => setTimeout(r, 25000))]);
      await ctx.gate?.();                                  // preloader gate (first visit only)
      cursor.native(false);
      try { view.enter?.(); } catch (e) { console.error(e); }
      const enter = first && !d.curtain ? { ...d, enter: 0.3 } : d;
      await Promise.all([
        gsap.to(el, { opacity: 1, duration: enter.enter, ease: 'power2.out' }),
        enter.curtain ? curtain.to(1, { duration: enter.enter, ease: 'power2.out' }) : (curtain.set(1), Promise.resolve()),
      ]);
      if (!first) el.querySelector('#main, h1')?.focus?.({ preventScroll: true });
    } finally {
      busy = false; first = false;
      if (pending) { const p = pending; pending = null; go(p.path, p); }
    }
  }

  return {
    go,
    navigate: (path, opts) => go(path, opts),
    /** Change the URL without a transition (shop focus state). */
    replace(path) { history.replaceState({}, '', path); if (current) { current.route = resolve(path); onRoute?.(current.route); } },
    get current() { return current?.route; },
    start() {
      addEventListener('popstate', () => go(location.pathname + location.search, { pop: true }));
      document.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest?.('a[href]');
        if (!a || a.target || a.hasAttribute('download') || a.dataset.native !== undefined) return;
        const url = new URL(a.href, location.href);
        if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/admin' || /\.\w+$/.test(url.pathname)) return;
        e.preventDefault();
        go(url.pathname + url.search);
      });
      return go(location.pathname + location.search, { replace: true });
    },
  };
}
