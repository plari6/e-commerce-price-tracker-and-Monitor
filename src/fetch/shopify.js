// Shopify stores expose every product as JSON at /products/<handle>.js: exact price, compare-at price,
// stock per variant. Far more stable than scraping the theme, and no browser needed.
import { httpGet } from './http.js';

const currencyCache = new Map();

export function shopifyHandle(url) {
  const m = new URL(url).pathname.match(/\/products\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\.(js|json)$/, '') : null;
}

export function parseShopifyProduct(json, url) {
  const variantId = new URL(url).searchParams.get('variant');
  const variants = json.variants || [];
  const v = (variantId && variants.find((x) => String(x.id) === variantId)) || variants.find((x) => x.available) || variants[0];
  const cents = (n) => (n == null ? null : typeof n === 'string' && n.includes('.') ? Number(n) : Number(n) / 100);
  const price = cents(v ? v.price : json.price);
  const compare = cents(v ? v.compare_at_price : json.compare_at_price);
  if (price == null || Number.isNaN(price)) return null;
  return {
    price,
    listPrice: compare && compare > price ? compare : null,
    inStock: v ? Boolean(v.available) : Boolean(json.available),
    title: v && variants.length > 1 && v.title && v.title !== 'Default Title' ? `${json.title} - ${v.title}` : json.title,
    sku: v?.sku || null,
    method: 'shopify-json',
  };
}

export async function fetchShopify(url, { timeoutMs, currencyHint, fetchImpl } = {}) {
  const handle = shopifyHandle(url);
  if (!handle) return null;
  const u = new URL(url);
  const res = await httpGet(`${u.origin}/products/${encodeURIComponent(handle)}.js`, { timeoutMs, retries: 0, accept: 'application/json', fetchImpl });
  if (res.status !== 200 || !/^\s*\{/.test(res.body)) return null;
  let json;
  try { json = JSON.parse(res.body); } catch { return null; }
  if (!json || !Array.isArray(json.variants)) return null;
  const r = parseShopifyProduct(json, url);
  if (!r) return null;
  r.currency = currencyHint || (await shopCurrency(u.origin, { timeoutMs, fetchImpl }));
  r.ms = res.ms;
  return r;
}

async function shopCurrency(origin, opts) {
  if (!currencyCache.has(origin)) {
    currencyCache.set(origin, httpGet(`${origin}/cart.js`, { ...opts, retries: 0, accept: 'application/json' })
      .then((r) => JSON.parse(r.body).currency || null)
      .catch(() => null));
  }
  return currencyCache.get(origin);
}
