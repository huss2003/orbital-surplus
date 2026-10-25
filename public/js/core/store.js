// core/store.js — product catalogue (API with built-in mock fallback) + cart state.
import { api } from './api.js';
import { emit } from './env.js';

/** Small built-in copy so the UI renders when /api/products fails (no backend / offline). */
export const MOCK_PRODUCTS = [
 {
  "sku": "001",
  "slug": "perigee-moto-jacket",
  "name": "Perigee Moto Jacket",
  "category": "Moto Jacket",
  "color": "Vacuum Black",
  "price": 14800,
  "currency": "USD",
  "sizes": [
   "S",
   "M",
   "L",
   "XL",
   "XXL"
  ],
  "images": [
   "/img/perigee-moto-jacket-front.png",
   "/img/perigee-moto-jacket-back.png"
  ],
  "model": {
   "type": "procedural",
   "variant": "moto"
  },
  "materials": [
   "75% PU Faux Leather",
   "25% Polyester lining"
  ],
  "care": [
   "Do not machine wash",
   "Wipe clean with a damp cloth",
   "Do not bleach",
   "Do not tumble dry",
   "Store away from direct sunlight (and solar flares)"
  ],
  "id": "perigee-moto-jacket",
  "description": "Cut for the closest point of the orbit. The Perigee is a cropped moto in high-gloss faux leather with an asymmetric front zip that runs from the hem to a notched lapel."
 },
 {
  "sku": "002",
  "slug": "apogee-bomber",
  "name": "Apogee Bomber",
  "category": "Bomber Jacket",
  "color": "Vacuum Black",
  "price": 16200,
  "currency": "USD",
  "sizes": [
   "S",
   "M",
   "L",
   "XL",
   "XXL"
  ],
  "images": [
   "/img/apogee-bomber-front.png",
   "/img/apogee-bomber-back.png"
  ],
  "model": {
   "type": "procedural",
   "variant": "bomber"
  },
  "materials": [
   "75% PU Faux Leather",
   "25% Polyester",
   "Rib: 95% Cotton, 5% Elastane"
  ],
  "care": [
   "Do not machine wash",
   "Wipe clean with a damp cloth",
   "Do not bleach",
   "Do not tumble dry",
   "Store flat or on a wide hanger"
  ],
  "id": "apogee-bomber",
  "description": "Built for the far end of the orbit. A straight-fit bomber in faux leather pressed with a hexagonal hull texture, finished with knit rib at the collar, cuffs and hem."
 },
 {
  "sku": "003",
  "slug": "reentry-puffer",
  "name": "Reentry Puffer",
  "category": "Puffer Jacket",
  "color": "Flight Orange",
  "price": 21000,
  "currency": "USD",
  "sizes": [
   "S",
   "M",
   "L",
   "XL",
   "XXL"
  ],
  "images": [
   "/img/reentry-puffer-front.png",
   "/img/reentry-puffer-back.png"
  ],
  "model": {
   "type": "procedural",
   "variant": "puffer"
  },
  "materials": [
   "Shell: 100% Recycled Nylon ripstop",
   "Fill: 100% Recycled Polyester",
   "Rib: Polyester/Elastane"
  ],
  "care": [
   "Machine wash cold, gentle cycle",
   "Tumble dry low with dryer balls to restore loft",
   "Do not iron",
   "Do not dry clean"
  ],
  "id": "reentry-puffer",
  "description": "Flight-orange so the recovery crew can find you. The Reentry is a boxy puffer with horizontal baffles from collar to hem and quilted sleeves that keep their loft when compressed into a locker."
 },
 {
  "sku": "004",
  "slug": "tether-shell",
  "name": "Tether Shell",
  "category": "Hooded Shell",
  "color": "Lunar Grey",
  "price": 18600,
  "currency": "USD",
  "sizes": [
   "S",
   "M",
   "L",
   "XL",
   "XXL"
  ],
  "images": [
   "/img/tether-shell-front.png",
   "/img/tether-shell-back.png"
  ],
  "model": {
   "type": "procedural",
   "variant": "shell"
  },
  "materials": [
   "3-layer Recycled Polyester with PFC-free DWR",
   "Seam tape: Polyurethane"
  ],
  "care": [
   "Machine wash cold with technical wash",
   "Close all zips before washing",
   "Tumble dry low to reactivate DWR",
   "Do not use fabric softener"
  ],
  "id": "tether-shell",
  "description": "A three-layer hooded shell for wet decks and worse. Every seam is taped in signal lime so you can see the build, and the hood has a stiffened peak with lime toggle cords."
 },
 {
  "sku": "005",
  "slug": "ballast-field-jacket",
  "name": "Ballast Field Jacket",
  "category": "Field Jacket",
  "color": "Hab Olive",
  "price": 17400,
  "currency": "USD",
  "sizes": [
   "S",
   "M",
   "L",
   "XL",
   "XXL"
  ],
  "images": [
   "/img/ballast-field-jacket-front.png",
   "/img/ballast-field-jacket-back.png"
  ],
  "model": {
   "type": "procedural",
   "variant": "field"
  },
  "materials": [
   "100% Organic Cotton twill, 340 gsm",
   "Lining: 100% Cotton poplin"
  ],
  "care": [
   "Machine wash cold, inside out",
   "Line dry",
   "Warm iron if needed",
   "Colour may soften with wear"
  ],
  "id": "ballast-field-jacket",
  "description": "Four pockets, no wasted mass. The Ballast is a heavy cotton-twill field jacket in habitat olive, with two bellowed chest pockets, two big cargo pockets and a snap on every flap."
 },
 {
  "sku": "006",
  "slug": "drift-coach-jacket",
  "name": "Drift Coach Jacket",
  "category": "Coach Jacket",
  "color": "Deep-Space Navy",
  "price": 12800,
  "currency": "USD",
  "sizes": [
   "S",
   "M",
   "L",
   "XL",
   "XXL"
  ],
  "images": [
   "/img/drift-coach-jacket-front.png",
   "/img/drift-coach-jacket-back.png"
  ],
  "model": {
   "type": "procedural",
   "variant": "coach"
  },
  "materials": [
   "Shell: 100% Nylon taslan",
   "Lining: 100% Polyester mesh"
  ],
  "care": [
   "Machine wash cold",
   "Hang to dry",
   "Do not iron the print",
   "Do not bleach"
  ],
  "id": "drift-coach-jacket",
  "description": "The off-shift layer. A light coach jacket in deep-space navy nylon with a snap front, a turn-down collar and a drawcord hem with lime toggles."
 }
];
export const MOCK_SIZE_CHART = {
  sizes: ['S', 'M', 'L', 'XL', 'XXL'],
  rows: [
    { label: 'Shoulder Width', values: [44, 46, 48, 50, 52] },
    { label: 'Chest', values: [104, 110, 116, 122, 128] },
    { label: 'Body Length', values: [66, 68, 70, 72, 74] },
    { label: 'Sleeve Length', values: [63, 64, 65, 67, 69] },
  ],
};

let productsP = null;
export let usingMock = false;

export function getProducts() {
  if (!productsP) {
    productsP = api.products()
      .then((d) => { const list = d?.products || d; if (!Array.isArray(list) || !list.length) throw new Error('empty'); return list.map(normalise); })
      .catch((e) => { console.warn('[store] /api/products failed, using built-in mock data:', e.message); usingMock = true; return MOCK_PRODUCTS.map(normalise); });
  }
  return productsP;
}
export async function getProduct(slugOrSku) {
  const list = await getProducts();
  return list.find((p) => p.slug === slugOrSku || p.sku === slugOrSku || p.id === slugOrSku) || null;
}
export function variantOf(p) { return p?.model?.variant || (/bomber/i.test(p?.category || '') ? 'bomber' : 'moto'); }

function normalise(p) {
  return {
    ...p,
    sizes: p.sizes || ['S', 'M', 'L', 'XL', 'XXL'],
    available_sizes: p.available_sizes || p.sizes || [],
    images: p.images?.length ? p.images : [`/img/${p.slug}-front.png`, `/img/${p.slug}-back.png`],
    materials: p.materials || [], care: p.care || [],
  };
}

/** Size chart: accept {sizes, rows:[{label, values|cm|s/m/l...}]} and normalise to values[]. */
export async function getSizeChart() {
  try {
    const d = await api.sizeChart();
    const sizes = d.sizes || MOCK_SIZE_CHART.sizes;
    const rows = (d.rows || []).map((r) => {
      let values = Array.isArray(r.cells) ? r.cells : Array.isArray(r.values) ? r.values : null;
      if (!values) { const src = (r.values && typeof r.values === 'object') ? r.values : r; values = sizes.map((s) => src[s] ?? src[s.toLowerCase()]); }
      return { label: r.label || r.name, values };
    });
    return rows.length ? { sizes, rows } : MOCK_SIZE_CHART;
  } catch { return MOCK_SIZE_CHART; }
}

// ------------------------------------------------------------------ cart state
export const cartState = { cart: null, offline: false };
export function setCart(cart) { cartState.cart = cart; emit('cart', cart); return cart; }
export async function refreshCart() {
  try { cartState.offline = false; return setCart(await api.cart()); }
  catch (e) { cartState.offline = true; emit('cart', cartState.cart); return null; }
}
