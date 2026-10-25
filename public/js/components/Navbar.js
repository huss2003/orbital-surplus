// components/Navbar.js — Navbar + Footer + Contact overlay (design-notes §2 Global chrome).
// Left: [ORBITAL SURPLUS] + SOUND [ON]/[OFF]; centre: the mark (toggles dither + glitch, §4.8);
// right: SHOP, PLAYGROUND, ACCOUNT and CARGO (n) — the cart.
// Nav labels use the sequential "type-on" ScrambleText preset (40 ms × 10).
import { h, createDialog } from '../core/dialog.js';
import { scramble, PRESET } from '../core/ScrambleText.js';
import { sound } from '../core/sound.js';
import { on } from '../core/env.js';
import { toggleFx, fxState } from '../core/fx.js';
import { api } from '../core/api.js';

const MARK = `<svg viewBox="0 0 12 10" aria-hidden="true" shape-rendering="crispEdges">
  <g fill="#fff"><rect x="3" y="1" width="4" height="1"/><rect x="2" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="1" y="3" width="1" height="1"/><rect x="8" y="3" width="1" height="1"/><rect x="0" y="4" width="12" height="1"/><rect x="1" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="7" y="6" width="1" height="1"/><rect x="3" y="7" width="4" height="1"/>
  <rect x="0" y="9" width="12" height="1" opacity=".6"/></g><rect class="eye" x="9" y="0" width="2" height="2" fill="#C8FF2E"/></svg>`;

export function createNavbar({ onCart }) {
  const navLink = (label, href, extra = {}) => h('a', { class: 'nav-link', href, 'data-nav': href, ...extra }, scramble(label, PRESET.nav));

  const soundState = h('span', { class: 'sound-state' }, sound.enabled ? '[ON]' : '[OFF]');
  const soundBtn = h('button', { class: 'nav-link nav-sound', type: 'button', 'aria-pressed': String(sound.enabled), 'aria-label': 'Sound' }, scramble('SOUND', PRESET.nav), soundState);
  soundBtn.addEventListener('click', () => { sound.toggle(); });
  on('sound', (v) => { soundBtn.setAttribute('aria-pressed', String(v)); soundState.textContent = v ? '[ON]' : '[OFF]'; });

  const logo = h('button', { class: 'nav-logo', type: 'button', 'aria-pressed': String(fxState.on), 'aria-label': 'Toggle dither and glitch effect', title: 'Toggle dither / glitch FX', html: MARK });
  logo.addEventListener('click', () => { sound.play('click'); logo.setAttribute('aria-pressed', String(toggleFx())); });

  const count = h('span', { class: 'nav-count' }, '');
  const cartBtn = h('button', { class: 'nav-link', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Open cargo hold (cart)' }, scramble('CARGO', PRESET.nav), count);
  cartBtn.addEventListener('click', () => { sound.play('click'); onCart?.(); });
  on('cart', (c) => { const n = c?.item_count || 0; count.textContent = n ? ` (${n})` : ''; cartBtn.setAttribute('aria-label', `Open cargo hold (cart), ${n} item${n === 1 ? '' : 's'}`); });

  const nav = h('nav', { class: 'navbar', 'aria-label': 'Main' },
    h('div', { class: 'nav-group' },
      navLink('[ORBITAL SURPLUS]', '/', { class: 'nav-link nav-logo-text', 'aria-label': 'ORBITAL SURPLUS home' }),
      soundBtn),
    logo,
    h('div', { class: 'nav-group nav-group--right' },
      navLink('SHOP', '/shop'), navLink('PLAYGROUND', '/playground', { class: 'nav-link nav-hide-sm' }), navLink('ACCOUNT', '/account'), cartBtn));
  nav.querySelectorAll('a.nav-link').forEach((a) => a.addEventListener('click', () => sound.play('click')));

  // ---- Contact overlay (POST /api/contact)
  const contact = createDialog({ label: 'Contact', className: 'overlay--modal', preset: 'small' });
  const status = h('p', { class: 'form-ok', 'aria-live': 'polite' });
  const form = h('form', { class: 'contact-form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'c-name' }, 'Name'), h('input', { id: 'c-name', name: 'name', required: true, autocomplete: 'name' })),
    h('div', { class: 'field' }, h('label', { for: 'c-email' }, 'Email'), h('input', { id: 'c-email', name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    h('div', { class: 'field' }, h('label', { for: 'c-msg' }, 'Message'), h('textarea', { id: 'c-msg', name: 'message', rows: 4, required: true })),
    h('button', { class: 'btn-bracket', type: 'submit' }, '[ SEND ]'), status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const fd = new FormData(form); status.className = 'form-ok'; status.textContent = 'SENDING…';
    try { await api.contact({ name: fd.get('name'), email: fd.get('email'), message: fd.get('message') }); status.textContent = 'TRANSMISSION RECEIVED. WE REPLY WITHIN TWO WORKING DAYS.'; form.reset(); }
    catch (err) { status.className = 'form-error'; status.textContent = err.message; }
  });
  // ---- Newsletter (POST /api/newsletter → welcome email with LAUNCH10)
  const nlStatus = h('p', { class: 'form-ok', 'aria-live': 'polite' });
  const nl = h('form', { class: 'contact-form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'nl-email' }, 'Email'), h('input', { id: 'nl-email', name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    h('button', { class: 'btn-bracket', type: 'submit' }, '[ JOIN THE MANIFEST ]'), nlStatus);
  nl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nl.reportValidity()) return;
    nlStatus.className = 'form-ok'; nlStatus.textContent = 'SENDING…';
    try { await api.newsletter(new FormData(nl).get('email')); nlStatus.textContent = 'YOU ARE ON THE MANIFEST. CHECK YOUR INBOX FOR 10% OFF.'; nl.reset(); }
    catch (err) { nlStatus.className = 'form-error'; nlStatus.textContent = err.message; }
  });
  contact.body.append(
    h('h2', { class: 'overlay-title', id: 'contact-title' }, 'CONTACT'),
    h('dl', { class: 'contact-grid' },
      h('dt', {}, 'WHAT'), h('dd', {}, 'ORBITAL SURPLUS is an outerwear depot in low orbit, 2051 — a portfolio project. Payments run in Stripe test mode and nothing ships.'),
      h('dt', {}, 'ADDRESS'), h('dd', {}, 'Docking Ring C, Bay 14, Low Earth Orbit'),
      h('dt', {}, 'WRITE'), h('dd', {}, form),
      h('dt', {}, 'DROPS'), h('dd', {}, h('p', { class: 'cart-line-meta' }, 'NEW JACKETS AND RESTOCKS, FIRST. 10% OFF YOUR FIRST ORDER.'), nl)));

  const contactBtn = h('button', { class: 'nav-link', type: 'button', 'aria-haspopup': 'dialog' }, scramble('CONTACT', PRESET.nav));
  contactBtn.addEventListener('click', () => { sound.play('click'); contact.open(); });
  const footer = h('footer', { class: 'footer' },
    h('div', { class: 'footer-copy' }, h('span', { class: 'c', 'aria-hidden': 'true' }, '©'), h('span', { class: 'sr-only' }, 'Copyright'), '2026 ', scramble('[ORBITAL SURPLUS]', PRESET.nav)),
    h('p', { class: 'footer-tagline' }, 'ORBITAL SURPLUS — OUTERWEAR DEPOT IN ORBIT, 2051. A PORTFOLIO PROJECT: TEST-MODE PAYMENTS, NOTHING SHIPS.'),
    h('div', {}, contactBtn));

  return {
    nav, footer,
    setRoute(route) {
      nav.querySelectorAll('a[data-nav]').forEach((a) => {
        const href = a.getAttribute('data-nav');
        const cur = href === '/' ? route.path === '/' : route.path.startsWith(href);
        if (cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        if (route.name === 'notfound') a.setAttribute('tabindex', '-1'); else a.removeAttribute('tabindex');
      });
    },
  };
}
