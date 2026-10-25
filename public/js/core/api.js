// core/api.js — client for the contract endpoints (CONTRACT.md "API").
// Cart identity is the httpOnly `os_cart` cookie, sign-in is the httpOnly `os_sid` cookie, so every call is same-origin with credentials.

export class ApiError extends Error {
  constructor(status, code, message, data) { super(message || code); this.status = status; this.code = code; this.data = data; }
}

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw new ApiError(0, 'NETWORK', 'Network error — is the server running?'); }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(res.status, data?.error || `HTTP_${res.status}`, data?.message || res.statusText, data);
  return data;
}

export const api = {
  products: () => req('GET', '/api/products'),
  product: (slug) => req('GET', `/api/products/${encodeURIComponent(slug)}`),
  sizeChart: () => req('GET', '/api/size-chart'),
  cart: () => req('GET', '/api/cart'),
  addItem: (slug, size, quantity = 1) => req('POST', '/api/cart/items', { slug, size, quantity }),
  setQty: (lineId, quantity) => req('PATCH', `/api/cart/items/${encodeURIComponent(lineId)}`, { quantity }),
  removeItem: (lineId) => req('DELETE', `/api/cart/items/${encodeURIComponent(lineId)}`),
  applyDiscount: (code) => req('POST', '/api/cart/discount', { code }),
  removeDiscount: () => req('DELETE', '/api/cart/discount'),
  shippingRates: (country, state = '') => req('GET', `/api/shipping-rates?country=${encodeURIComponent(country)}&state=${encodeURIComponent(state)}`),
  createSession: (payload) => req('POST', '/api/checkout/session', payload),
  confirm: (id, card_number) => req('POST', `/api/checkout/session/${encodeURIComponent(id)}/confirm`, { card_number }),
  cancelCheckout: (token) => req('POST', '/api/checkout/cancel', { token }),
  order: (token, sessionId) => req('GET', `/api/orders/${encodeURIComponent(token)}${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`),
  me: () => req('GET', '/api/account'),
  login: (email, password) => req('POST', '/api/account/login', { email, password }),
  register: (payload) => req('POST', '/api/account/register', payload),
  logout: () => req('POST', '/api/account/logout', {}),
  updateAccount: (payload) => req('PATCH', '/api/account', payload),
  forgot: (email) => req('POST', '/api/account/forgot', { email }),
  reset: (token, password) => req('POST', '/api/account/reset', { token, password }),
  newsletter: (email) => req('POST', '/api/newsletter', { email }),
  contact: (payload) => req('POST', '/api/contact', payload),
};

/** Cents → "$140.00" */
export function money(cents, currency = 'USD') {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100); }
  catch { return '$' + ((cents || 0) / 100).toFixed(2); }
}
