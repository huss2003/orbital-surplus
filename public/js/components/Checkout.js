// components/Checkout.js — /checkout and /checkout/pay/:id.
//   /checkout:         email, name, address, shipping rate (GET /api/shipping-rates) →
//                      POST /api/checkout/session (server prices the cart and holds the stock) →
//                      redirect to Stripe Checkout (payment_url). Back from Stripe's cancel link
//                      (?cancelled=token) the hold is released straight away.
//   /checkout/pay/:id: built-in test card step, only used when the server has no Stripe key.
import { h } from '../core/dialog.js';
import { api, money } from '../core/api.js';
import { refreshCart, cartState, setCart } from '../core/store.js';
import { sound } from '../core/sound.js';

const COUNTRIES = [['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['IN', 'India'], ['JP', 'Japan'], ['AU', 'Australia']];
const field = (id, label, attrs = {}) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, name: id, ...attrs }));

function summary(cart, shipping = null, tax = 0) {
  const row = (l, v, cls = '') => h('tr', { class: cls }, h('th', { scope: 'row' }, l), h('td', {}, v));
  const ship = shipping ? shipping.amount : cart.shipping_estimate || 0;
  const total = (cart.subtotal || 0) - (cart.discount?.amount || 0) + ship + tax;
  return h('section', { 'aria-label': 'Order summary' },
    h('h2', {}, 'SUMMARY'),
    h('ul', { class: 'cart-lines' }, ...cart.items.map((it) => h('li', { class: 'cart-line' }, h('img', { src: it.image, alt: '' }),
      h('div', {}, h('div', { class: 'cart-line-name' }, it.name), h('div', { class: 'cart-line-meta' }, `SIZE ${it.size} × ${it.quantity}`)),
      h('div', { class: 'cart-line-right' }, money(it.line_total, cart.currency))))),
    h('table', { class: 'totals' }, h('tbody', {},
      row('Subtotal', money(cart.subtotal, cart.currency)),
      cart.discount?.amount ? row(`Discount (${cart.discount.code})`, h('span', { class: 'neg' }, '−' + money(cart.discount.amount, cart.currency))) : null,
      row('Shipping', shipping ? (shipping.amount ? money(shipping.amount, cart.currency) : 'FREE') : '—'),
      tax ? row('Sales tax', money(tax, cart.currency)) : null,
      row('Total', money(total, cart.currency), 'total'))));
}

export async function mount(root, route, ctx) {
  root.classList.add('is-scroll');
  const inner = h('div', { class: 'shop-page-inner' });
  root.append(h('main', { class: 'shop-page', id: 'main', tabindex: '-1' }, inner));
  if (route.name === 'pay') return mountPay(inner, route, ctx);

  document.title = 'Checkout — ORBITAL SURPLUS';
  const cancelled = new URLSearchParams(location.search).get('cancelled');
  if (cancelled) { try { await api.cancelCheckout(cancelled); } catch { /* the sweep releases it anyway */ } history.replaceState({}, '', '/checkout'); }
  const [cart, me] = await Promise.all([refreshCart(), api.me().catch(() => ({ customer: null }))]);
  const customer = me?.customer;
  ctx.progress?.data(1);
  inner.append(h('h1', {}, 'CHECKOUT'));
  if (cancelled) inner.append(h('p', { class: 'form-ok', role: 'status' }, 'PAYMENT CANCELLED. YOUR STOCK HOLD WAS RELEASED — YOUR CARGO IS STILL HERE.'));
  if (!cart || !cart.items?.length) {
    inner.append(h('p', { class: 'cart-empty' }, cartState.offline ? 'THE VAULT IS OFFLINE — START THE SERVER TO CHECK OUT.' : 'YOUR CARGO HOLD IS EMPTY.'), h('a', { class: 'btn-bracket', href: '/shop' }, '[ BROWSE THE DEPOT ]'));
    return { ready: Promise.resolve(), destroy() {} };
  }

  const err = h('p', { class: 'form-error', role: 'alert' });
  const country = h('select', { id: 'country', name: 'country', autocomplete: 'country', required: true }, ...COUNTRIES.map(([c, n]) => h('option', { value: c }, n)));
  const rates = h('div', { class: 'rates', role: 'radiogroup', 'aria-labelledby': 'rates-label' });
  const sumHost = h('div');
  let rateList = [], chosen = null, tax = 0;
  const drawSummary = () => { sumHost.textContent = ''; sumHost.append(summary(cart, rateList.find((r) => r.id === chosen), tax)); };

  async function loadRates() {
    // keep the old options on screen while refreshing: a collapsing list would move the pay button under the cursor
    if (!rateList.length) rates.textContent = 'LOADING RATES…';
    rates.setAttribute('aria-busy', 'true');
    try {
      const d = await api.shippingRates(country.value, country.value === 'US' ? form.querySelector('#state')?.value || '' : '');
      const prev = chosen;
      rateList = Array.isArray(d) ? d : d?.rates || [];
      tax = d?.tax || 0;
      rates.textContent = ''; rates.removeAttribute('aria-busy');
      chosen = rateList.some((r) => r.id === prev) ? prev : rateList[0]?.id || null;
      rateList.forEach((r, i) => {
        const input = h('input', { type: 'radio', name: 'shipping_rate', value: r.id, checked: r.id === chosen });
        input.addEventListener('change', () => { chosen = r.id; drawSummary(); });
        rates.append(h('label', { class: 'rate' }, input, h('span', {}, `${r.label}${r.eta ? ' · ' + r.eta : ''}`), h('span', {}, r.amount ? money(r.amount, cart.currency) : 'FREE')));
      });
    } catch (e) { rates.textContent = ''; err.textContent = e.message; }
    drawSummary();
  }
  country.addEventListener('change', loadRates);

  const submit = h('button', { class: 'btn-primary', type: 'submit' }, '[ CONTINUE TO PAYMENT ]');
  const addr = customer?.default_address || {};
  const stateField = field('state', 'State (US)', { autocomplete: 'address-level1', maxlength: 2, value: addr.state || '', placeholder: 'NY' });
  const saveAddr = customer ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'save_address', checked: !customer.default_address }), h('span', {}, 'SAVE THIS ADDRESS TO MY ACCOUNT')) : null;
  const who = customer
    ? h('p', { class: 'cart-line-meta' }, `SIGNED IN AS ${customer.email.toUpperCase()}`)
    : h('p', { class: 'cart-line-meta' }, 'HAVE AN ACCOUNT? ', h('a', { href: '/account?next=/checkout' }, 'SIGN IN'), ' — OR CHECK OUT AS A GUEST.');
  const form = h('form', { novalidate: true, 'aria-label': 'Shipping details' },
    h('h2', {}, 'CONTACT'), who,
    field('email', 'Email', { type: 'email', required: true, autocomplete: 'email', inputmode: 'email', value: customer?.email || '' }),
    field('name', 'Full name', { required: true, autocomplete: 'name', value: customer?.name || '' }),
    h('h2', {}, 'SHIPPING ADDRESS'),
    field('line1', 'Address', { required: true, autocomplete: 'address-line1', value: addr.line1 || '' }),
    h('div', { class: 'field-row' }, field('city', 'City', { required: true, autocomplete: 'address-level2', value: addr.city || '' }), field('postal_code', 'Postal code', { required: true, autocomplete: 'postal-code', value: addr.postal_code || '' })),
    h('div', { class: 'field-row' }, h('div', { class: 'field' }, h('label', { for: 'country' }, 'Country'), country), stateField),
    saveAddr,
    h('fieldset', { class: 'field' }, h('legend', { id: 'rates-label' }, 'Shipping'), rates),
    err, submit,
    h('p', { class: 'cart-line-meta pay-note' }, 'PAYMENT IS HANDLED BY STRIPE IN TEST MODE — NO REAL MONEY MOVES. TEST CARD 4242 4242 4242 4242, ANY FUTURE DATE, ANY CVC. YOUR SIZES ARE HELD FOR 30 MINUTES WHILE YOU PAY.'));
  if (addr.country) country.value = addr.country;
  const syncState = () => { stateField.hidden = country.value !== 'US'; };
  country.addEventListener('change', syncState); syncState();
  stateField.querySelector('input').addEventListener('change', loadRates);

  form.addEventListener('input', (e) => {
    if (e.target.matches('input[required]') && e.target.hasAttribute('aria-invalid')) e.target.setAttribute('aria-invalid', String(!e.target.checkValidity()));
    if (form.checkValidity()) err.textContent = '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    form.querySelectorAll('input[required]').forEach((i) => i.setAttribute('aria-invalid', String(!i.checkValidity())));
    if (!form.checkValidity()) { const bad = form.querySelector(':invalid'); bad?.focus(); err.textContent = 'PLEASE COMPLETE THE HIGHLIGHTED FIELDS.'; return; }
    const fd = new FormData(form);
    submit.disabled = true; submit.textContent = '[ RESERVING STOCK… ]'; sound.play('click');
    try {
      const s = await api.createSession({
        email: fd.get('email'), name: fd.get('name'),
        address: { line1: fd.get('line1'), city: fd.get('city'), postal_code: fd.get('postal_code'), country: fd.get('country'), state: fd.get('country') === 'US' ? (fd.get('state') || '') : '' },
        shipping_rate: chosen, save_address: fd.get('save_address') === 'on',
      });
      try { sessionStorage.setItem(`os:session:${s.session_id}`, JSON.stringify({ amount: s.amount, currency: cart.currency, email: fd.get('email') })); } catch { /* ignore */ }
      if (/^https:\/\//.test(s.payment_url || '')) { submit.textContent = '[ OPENING STRIPE… ]'; window.location.assign(s.payment_url); return; }
      ctx.navigate(s.payment_url || `/checkout/pay/${s.session_id}`);
    } catch (e2) {
      err.textContent = e2.message; submit.disabled = false; submit.textContent = '[ CONTINUE TO PAYMENT ]';
    }
  });

  inner.append(h('div', { class: 'cols' }, form, sumHost));
  await loadRates();
  return { ready: Promise.resolve(), destroy() {} };
}

function mountPay(inner, route, ctx) {
  document.title = 'Payment — ORBITAL SURPLUS';
  ctx.progress?.data(1);
  const id = route.params.id;
  let info = null; try { info = JSON.parse(sessionStorage.getItem(`os:session:${id}`) || 'null'); } catch { /* ignore */ }
  const err = h('p', { class: 'form-error', role: 'alert' });
  const card = h('input', { id: 'card', name: 'card', inputmode: 'numeric', autocomplete: 'cc-number', required: true, placeholder: '4242 4242 4242 4242', maxlength: 23, 'aria-describedby': 'test-card' });
  card.addEventListener('input', () => { const d = card.value.replace(/\D/g, '').slice(0, 19); card.value = d.replace(/(.{4})/g, '$1 ').trim(); });
  const pay = h('button', { class: 'btn-primary', type: 'submit' }, info ? `[ PAY ${money(info.amount, info.currency)} ]` : '[ PAY ]');
  const form = h('form', { novalidate: true, 'aria-label': 'Payment' },
    h('div', { class: 'test-card', id: 'test-card' },
      'TEST MODE — NO REAL PAYMENT IS TAKEN.', h('br'),
      'SUCCESS: ', h('code', {}, '4242 4242 4242 4242'), h('br'),
      'DECLINE: ', h('code', {}, '4000 0000 0000 0002'), h('br'),
      'ANY FUTURE EXPIRY · ANY CVC'),
    h('div', { class: 'field' }, h('label', { for: 'card' }, 'Card number'), card),
    h('div', { class: 'field-row' },
      field('exp', 'Expiry (MM/YY)', { autocomplete: 'cc-exp', placeholder: '12/34', inputmode: 'numeric' }),
      field('cvc', 'CVC', { autocomplete: 'cc-csc', placeholder: '123', inputmode: 'numeric', maxlength: 4 })),
    h('p', { class: 'cart-line-meta' }, 'Only the card number is sent to the mock payment endpoint; expiry and CVC never leave this page.'),
    err, pay);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const num = card.value.replace(/\D/g, '');
    if (num.length < 12) { card.setAttribute('aria-invalid', 'true'); card.focus(); err.textContent = 'ENTER A CARD NUMBER (USE THE TEST CARD ABOVE).'; return; }
    card.setAttribute('aria-invalid', 'false');
    pay.disabled = true; const label = pay.textContent; pay.textContent = '[ CONFIRMING… ]'; sound.play('click');
    try {
      const r = await api.confirm(id, num);
      setCart(null); refreshCart();
      const token = r.order?.token || r.order_token;
      ctx.navigate(`/order/${encodeURIComponent(token)}`);
    } catch (e2) {
      if (e2.code === 'ALREADY_PAID' && e2.data?.order_token) { ctx.navigate(`/order/${encodeURIComponent(e2.data.order_token)}`); return; }
      err.textContent = e2.code === 'card_declined' ? 'YOUR CARD WAS DECLINED. TRY 4242 4242 4242 4242.' : e2.message;
      pay.disabled = false; pay.textContent = label;
    }
  });
  inner.append(h('h1', {}, 'PAYMENT'), h('div', { class: 'cols' }, form,
    h('section', { 'aria-label': 'Session' }, h('h2', {}, 'SESSION'), h('dl', { class: 'order-meta' },
      h('dt', {}, 'ID'), h('dd', {}, id),
      info ? [h('dt', {}, 'AMOUNT'), h('dd', {}, money(info.amount, info.currency)), h('dt', {}, 'RECEIPT TO'), h('dd', {}, info.email)] : null,
      h('dt', {}, 'HOLD'), h('dd', {}, 'Stock is reserved for 30 minutes.')))));
  return { ready: Promise.resolve(), destroy() {} };
}
