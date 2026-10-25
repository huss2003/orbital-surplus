// main.js — app shell (the original's index.js): GSAP, cursor, sound, Navbar/Footer,
// RevealOverlay curtain, Preloader (first visit to "/"), CartDrawer, router.
import { loadGsap } from './core/gsap.js';
import { initCursor } from './core/cursor.js';
import { sound } from './core/sound.js';
import { refreshCart } from './core/store.js';
import { createRouter } from './router.js';
import { createNavbar } from './components/Navbar.js';
import { createPageCurtain } from './components/PageCurtain.js';
import { createProgress, shouldShowPreloader, showPreloader } from './components/Preloader.js';
import { createCartDrawer } from './components/CartDrawer.js';

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

async function boot() {
  // GSAP from the CDN (fallback engine if unreachable) + fonts (4 s timeout, like the original)
  await Promise.all([
    withTimeout(loadGsap(), 6000),
    withTimeout(Promise.all([document.fonts?.load('16px DotGothic16'), document.fonts?.load('700 16px "DM Mono"')]).catch(() => {}), 4000),
  ]);

  const app = document.getElementById('app');
  const curtain = createPageCurtain();
  curtain.mount(document.body);
  // the white curtain now covers the page; keep #boot only if the preloader is about to take over
  if (!(location.pathname === '/' && shouldShowPreloader())) document.getElementById('boot')?.classList.add('is-gone');
  initCursor();
  sound.resumeOnGesture();

  const drawer = createCartDrawer();
  const navbar = createNavbar({ onCart: () => drawer.open() });
  document.body.append(navbar.nav, navbar.footer);
  refreshCart();

  let progress = null, gate = null;
  const router = createRouter({
    app, curtain,
    onRoute(route) {
      document.documentElement.classList.toggle('is-404', route.name === 'notfound');
      document.documentElement.classList.toggle('hide-nav', !!route.hideNav);
      document.documentElement.classList.toggle('hide-nav-footer', !!route.commerce);
      navbar.setRoute(route);
    },
    makeCtx(route, { first }) {
      // Preloader only on the first visit, and only when entering on "/" (original: every load of "/")
      if (first && route.name === 'home' && shouldShowPreloader()) {
        progress = createProgress();
        const fonts = progress.step(1); fonts(1);
        const data = progress.step(1), scene = progress.step(2);
        gate = showPreloader(progress);
        document.getElementById('boot')?.classList.add('is-gone');
        return {
          navigate: router.navigate, replace: router.replace, openCart: () => drawer.open(),
          progress: { data, scene: (f) => { scene(f); if (f >= 1) progress.complete(); } },
          gate: () => gate,
        };
      }
      return { navigate: router.navigate, replace: router.replace, openCart: () => drawer.open(), progress: { data() {}, scene() {} } };
    },
  });
  await router.start();
  document.getElementById('boot')?.classList.add('is-gone');
  setTimeout(() => document.getElementById('boot')?.remove(), 400);
  window.__nv = { router, sound, drawer };   // handy in devtools
}

boot().catch((err) => {
  console.error('[boot]', err);
  const b = document.getElementById('boot'); if (b) b.textContent = '[ORBITAL SURPLUS] — failed to start';
});
