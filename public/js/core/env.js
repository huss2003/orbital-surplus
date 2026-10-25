// core/env.js — capability + preference detection shared by every module.

const params = new URLSearchParams(location.search);

/** prefers-reduced-motion, or ?motion=reduce / <html class="reduce-motion"> for testing. */
export function reducedMotion() {
  if (params.get('motion') === 'reduce' || document.documentElement.classList.contains('reduce-motion')) return true;
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Same breakpoint the original uses everywhere: `isMobile = innerWidth <= 768`. */
export const isMobile = () => innerWidth <= 768;
export const isTablet = () => innerWidth > 768 && innerWidth <= 1024;
export function isCoarse() {
  try { return matchMedia('(pointer: coarse)').matches; } catch { return false; }
}
/** UA test used to decide whether to mount <model-viewer> for AR (3d-ar-notes §5). */
export function isMobileUA() {
  const ua = navigator.userAgent;
  return /android|iphone|ipad|ipod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

let glCache;
/**
 * three r182 is WebGL2-only, so detect WebGL2 (the original never checked and simply
 * threw inside onMounted). `?nogl` forces the static-SVG fallback for testing.
 */
export function hasWebGL() {
  if (params.has('nogl')) return false;
  if (glCache !== undefined) return glCache;
  try {
    const c = document.createElement('canvas');
    const gl = window.WebGL2RenderingContext && c.getContext('webgl2');
    glCache = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { glCache = false; }
  return glCache;
}

/** Speed multiplier for every GSAP tween (`?speed=4` makes the 5 s transitions ~1.25 s). */
export const timeScale = Math.max(0.1, Number(params.get('speed')) || 1);

export const storage = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => { const h = (e) => fn(e.detail); bus.addEventListener(type, h); return () => bus.removeEventListener(type, h); };
