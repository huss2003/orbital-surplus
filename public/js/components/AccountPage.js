// components/AccountPage.js — /account and /account/reset/:token.
//   signed out: SIGN IN / CREATE ACCOUNT / FORGOT tabs (POST /api/account/login|register|forgot)
//   signed in:  order history, saved address, profile + marketing opt-in, sign out
// The session is an HttpOnly cookie, so this page never sees a token.
import { h } from '../core/dialog.js';
import { api, money } from '../core/api.js';
import { refreshCart } from '../core/store.js';
import { sound } from '../core/sound.js';

const field = (id, label, attrs = {}) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, name: id, ...attrs }));
const COUNTRIES = [['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['IN', 'India'], ['JP', 'Japan'], ['AU', 'Australia']];

function busyForm(form, btn, fn) {
  const err = h('p', { class: 'form-error', role: 'alert' });
  form.append(err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!form.reportValidity()) return;
    const label = btn.textContent; btn.disabled = true; btn.textContent = '[ WORKING… ]'; sound.play('click');
    try { await fn(new FormData(form), err); }
    catch (x) { err.textContent = x.message; }
    finally { btn.disabled = false; btn.textContent = label; }
  });
  return form;
}

export async function mount(root, route, ctx) {
  document.title = 'Account — ORBITAL SURPLUS';
  root.classList.add('is-scroll');
  const inner = h('div', { class: 'shop-page-inner' });
  root.append(h('main', { class: 'shop-page', id: 'main', tabindex: '-1' }, inner));
  const next = new URLSearchParams(location.search).get('next');
  const after = () => (next && next.startsWith('/') && !next.startsWith('//') ? ctx.navigate(next) : render());

  async function render() {
    inner.textContent = '';
    if (route.params.reset) return renderReset();
    let me = { customer: null };
    try { me = await api.me(); } catch { /* offline */ }
    ctx.progress?.data(1);
    if (me.customer) return renderSignedIn(me);
    renderSignedOut();
  }

  function renderSignedOut(tab = 'login') {
    inner.textContent = '';
    inner.append(h('h1', {}, 'CREW ACCESS'));
    const tabs = [['login', 'SIGN IN'], ['register', 'CREATE ACCOUNT'], ['forgot', 'FORGOT PASSWORD']];
    inner.append(h('div', { class: 'tabs', role: 'tablist' }, ...tabs.map(([k, l]) => {
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === tab) }, `[ ${l} ]`);
      b.addEventListener('click', () => renderSignedOut(k));
      return b;
    })));
    const panel = h('div', { class: 'cols' });
    inner.append(panel);
    if (tab === 'login') {
      const btn = h('button', { class: 'btn-primary', type: 'submit' }, '[ SIGN IN ]');
      panel.append(busyForm(h('form', { novalidate: true, 'aria-label': 'Sign in' },
        field('email', 'Email', { type: 'email', required: true, autocomplete: 'email' }),
        field('password', 'Password', { type: 'password', required: true, autocomplete: 'current-password', minlength: 8 }), btn), btn,
      async (fd) => { await api.login(fd.get('email'), fd.get('password')); await refreshCart(); after(); }),
      h('section', {}, h('h2', {}, 'WHY AN ACCOUNT'), h('p', { class: 'cart-line-meta', style: { lineHeight: 1.9 } },
        'TRACK EVERY ORDER IN ONE PLACE. SAVE YOUR ADDRESS FOR FASTER CHECKOUT. YOUR CARGO HOLD FOLLOWS YOU BETWEEN DEVICES. ORDERS YOU PLACED AS A GUEST APPEAR AS SOON AS YOU REGISTER WITH THE SAME EMAIL.')));
    } else if (tab === 'register') {
      const btn = h('button', { class: 'btn-primary', type: 'submit' }, '[ CREATE ACCOUNT ]');
      panel.append(busyForm(h('form', { novalidate: true, 'aria-label': 'Create account' },
        field('name', 'Name', { required: true, autocomplete: 'name', maxlength: 100 }),
        field('email', 'Email', { type: 'email', required: true, autocomplete: 'email' }),
        field('password', 'Password (8+ characters)', { type: 'password', required: true, autocomplete: 'new-password', minlength: 8 }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'accepts_marketing' }), h('span', {}, 'SEND ME NEW DROPS AND RESTOCKS')), btn), btn,
      async (fd) => { await api.register({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password'), accepts_marketing: fd.get('accepts_marketing') === 'on' }); await refreshCart(); after(); }));
    } else {
      const btn = h('button', { class: 'btn-primary', type: 'submit' }, '[ SEND RESET LINK ]');
      const ok = h('p', { class: 'form-ok', role: 'status' });
      panel.append(busyForm(h('form', { novalidate: true, 'aria-label': 'Reset password' },
        h('p', { class: 'cart-line-meta' }, 'ENTER YOUR EMAIL AND WE WILL SEND A LINK THAT WORKS FOR ONE HOUR.'),
        field('email', 'Email', { type: 'email', required: true, autocomplete: 'email' }), btn, ok), btn,
      async (fd) => { await api.forgot(fd.get('email')); ok.textContent = 'IF THAT EMAIL HAS AN ACCOUNT, A RESET LINK IS ON ITS WAY.'; }));
    }
    inner.querySelector('input')?.focus();
  }

  function renderReset() {
    ctx.progress?.data(1);
    document.title = 'Reset password — ORBITAL SURPLUS';
    const btn = h('button', { class: 'btn-primary', type: 'submit' }, '[ SET PASSWORD ]');
    inner.append(h('h1', {}, 'NEW PASSWORD'), busyForm(h('form', { novalidate: true, 'aria-label': 'Choose a new password', style: { maxWidth: '420px' } },
      field('password', 'New password (8+ characters)', { type: 'password', required: true, autocomplete: 'new-password', minlength: 8 }), btn), btn,
    async (fd) => { await api.reset(route.params.reset, fd.get('password')); ctx.navigate('/account'); }));
  }

  function renderSignedIn({ customer: c, orders }) {
    document.title = 'Your account — ORBITAL SURPLUS';
    const out = h('button', { class: 'btn-bracket', type: 'button' }, '[ SIGN OUT ]');
    out.addEventListener('click', async () => { sound.play('click'); await api.logout(); await refreshCart(); render(); });
    const a = c.default_address || {};
    const country = h('select', { id: 'country', name: 'country', autocomplete: 'country' }, ...COUNTRIES.map(([v, n]) => h('option', { value: v, selected: (a.country || 'US') === v }, n)));
    const save = h('button', { class: 'btn-primary', type: 'submit' }, '[ SAVE ]');
    const ok = h('p', { class: 'form-ok', role: 'status' });
    const profile = busyForm(h('form', { novalidate: true, 'aria-label': 'Profile and address' },
      field('name', 'Name', { autocomplete: 'name', value: c.name || '', maxlength: 100 }),
      h('h2', { style: { marginTop: '1.5rem' } }, 'SAVED ADDRESS'),
      field('line1', 'Address', { autocomplete: 'address-line1', value: a.line1 || '' }),
      h('div', { class: 'field-row' }, field('city', 'City', { autocomplete: 'address-level2', value: a.city || '' }), field('postal_code', 'Postal code', { autocomplete: 'postal-code', value: a.postal_code || '' })),
      h('div', { class: 'field-row' }, h('div', { class: 'field' }, h('label', { for: 'country' }, 'Country'), country), field('state', 'State (US)', { value: a.state || '', maxlength: 2 })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'accepts_marketing', checked: !!c.accepts_marketing }), h('span', {}, 'SEND ME NEW DROPS AND RESTOCKS')),
      save, ok), save,
    async (fd) => {
      await api.updateAccount({ name: fd.get('name'), accepts_marketing: fd.get('accepts_marketing') === 'on',
        address: { line1: fd.get('line1'), city: fd.get('city'), postal_code: fd.get('postal_code'), country: fd.get('country'), state: fd.get('state') } });
      ok.textContent = 'SAVED.';
    });
    inner.append(
      h('h1', {}, `CREW FILE · ${(c.name || c.email).toUpperCase()}`),
      h('p', { class: 'cart-line-meta' }, `${c.email.toUpperCase()} · ON THE MANIFEST SINCE ${new Date(c.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase()}`, c.is_admin ? [' · ', h('a', { href: '/admin' }, 'DEPOT ADMIN')] : null),
      h('div', { class: 'cols', style: { marginTop: '2rem' } },
        h('section', { 'aria-label': 'Orders' }, h('h2', {}, `ORDERS (${orders.length})`),
          orders.length
            ? h('ul', { class: 'acct-orders' }, ...orders.map((o) => h('li', {}, h('a', { href: `/order/${o.token}` },
              h('img', { src: o.image || '', alt: '' }),
              h('div', {}, h('div', { class: 'cart-line-name' }, `#${o.number} · ${o.status.toUpperCase()}`), h('div', { class: 'cart-line-meta' }, `${new Date(o.created_at).toLocaleDateString()} · ${o.item_count} ITEM${o.item_count === 1 ? '' : 'S'}`)),
              h('span', {}, money(o.total))))))
            : h('p', { class: 'cart-empty' }, 'NO ORDERS YET.'),
          h('a', { class: 'btn-bracket', href: '/shop' }, '[ BROWSE THE DEPOT ]')),
        h('section', { 'aria-label': 'Profile' }, h('h2', {}, 'PROFILE'), profile, out)));
  }

  await render();
  return { ready: Promise.resolve(), destroy() {} };
}
