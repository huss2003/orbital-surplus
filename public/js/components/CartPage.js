// components/CartPage.js — /cart: the full-page version of the CartDrawer.
import { h } from '../core/dialog.js';
import { refreshCart } from '../core/store.js';
import { renderCart } from './CartDrawer.js';

export async function mount(root, route, ctx) {
  document.title = 'Cargo hold — ORBITAL SURPLUS';
  root.classList.add('is-scroll');
  const inner = h('div', { class: 'shop-page-inner' }, h('h1', {}, 'YOUR CARGO HOLD'));
  root.append(h('main', { class: 'shop-page', id: 'main', tabindex: '-1' }, inner));
  const ready = refreshCart().then(() => ctx.progress?.data(1));
  const view = renderCart(inner);
  return { ready, destroy() { view.destroy(); } };
}
