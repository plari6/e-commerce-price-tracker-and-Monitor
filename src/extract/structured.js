// Machine-readable price data: JSON-LD (schema.org Product/Offer), microdata and meta tags.
import { parsePrice } from '../price.js';

export function stockFromText(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (/(instock|in_stock|in stock|limitedavailability|onlineonly|presale|preorder|backorder)/.test(s.replace(/\s+/g, ' ')) && !/outofstock|out of stock/.test(s)) return true;
  if (/(outofstock|out_of_stock|out of stock|soldout|sold out|discontinued|instoreonly)/.test(s)) return false;
  return null;
}

// ---------- JSON-LD ----------

export function jsonLdBlocks($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Some sites put several objects or trailing commas in one block; try a light repair.
      try { out.push(JSON.parse(raw.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]+/g, ' '))); } catch { /* ignore */ }
    }
  });
  return out;
}

function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n, depth + 1);
    return;
  }
  yield node;
  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant']) if (node[key]) yield* walk(node[key], depth + 1);
}

const isType = (node, t) => [].concat(node['@type'] || []).some((x) => String(x).toLowerCase() === t.toLowerCase());

export function fromJsonLd($, { url, currencyHint } = {}) {
  const products = [];
  for (const block of jsonLdBlocks($)) for (const node of walk(block)) if (isType(node, 'Product') || isType(node, 'ProductGroup')) products.push(node);
  if (!products.length) return null;

  const variantId = url ? new URL(url).searchParams.get('variant') : null;
  const candidates = [];
  for (const prod of products) {
    for (const offer of offersOf(prod.offers)) {
      const price = offerPrice(offer, currencyHint);
      if (!price) continue;
      candidates.push({ prod, offer, ...price });
    }
  }
  if (!candidates.length) return null;

  let pick = null;
  if (variantId) pick = candidates.find((c) => [c.offer.url, c.offer.sku, c.prod.sku, c.prod.url].some((v) => v && String(v).includes(variantId)));
  if (!pick && url) pick = candidates.find((c) => c.offer.url && sameUrl(c.offer.url, url));
  if (!pick) pick = candidates.find((c) => stockFromText(c.offer.availability) !== false) || candidates[0];

  const name = pick.prod.name || products[0].name;
  return {
    price: pick.amount,
    currency: pick.currency,
    listPrice: pick.listPrice ?? null,
    inStock: stockFromText(pick.offer.availability),
    title: typeof name === 'string' ? name.trim() : null,
    sku: pick.offer.sku || pick.prod.sku || null,
    method: 'json-ld',
  };
}

function offersOf(offers) {
  const out = [];
  for (const o of [].concat(offers || [])) {
    if (!o || typeof o !== 'object') continue;
    if (isType(o, 'AggregateOffer') && o.offers) out.push(...offersOf(o.offers));
    out.push(o);
  }
  return out;
}

function offerPrice(offer, currencyHint) {
  const specs = [].concat(offer.priceSpecification || []);
  const currency = offer.priceCurrency || specs.find((s) => s.priceCurrency)?.priceCurrency || currencyHint;
  const listSpec = specs.find((s) => /ListPrice|StrikethroughPrice|MSRP/i.test(String(s.priceType || '')));
  const saleSpec = specs.find((s) => s !== listSpec && s.price != null);
  const raw = offer.price ?? saleSpec?.price ?? offer.lowPrice;
  const parsed = parsePrice(raw, { currencyHint: currency, structured: true });
  if (!parsed || parsed.amount <= 0) return null;
  const list = listSpec ? parsePrice(listSpec.price, { currencyHint: currency, structured: true })?.amount : null;
  return { amount: parsed.amount, currency: (currency || parsed.currency || '').toUpperCase() || null, listPrice: list && list > parsed.amount ? list : null };
}

function sameUrl(a, b) {
  try {
    const x = new URL(a, b);
    const y = new URL(b);
    return x.hostname === y.hostname && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

// ---------- Microdata ----------

export function fromMicrodata($, { currencyHint } = {}) {
  const scope = $('[itemtype*="schema.org/Product" i]').first();
  const root = scope.length ? scope : $.root();
  const priceEl = root.find('[itemprop="price"]').first();
  if (!priceEl.length) return null;
  const raw = priceEl.attr('content') ?? priceEl.attr('value') ?? priceEl.text();
  const curEl = root.find('[itemprop="priceCurrency"]').first();
  const currency = curEl.attr('content') || curEl.text().trim() || null;
  const parsed = parsePrice(raw, { currencyHint: currency || currencyHint, structured: priceEl.attr('content') != null });
  if (!parsed || parsed.amount <= 0) return null;
  const avail = root.find('[itemprop="availability"]').first();
  const name = root.find('[itemprop="name"]').first();
  return {
    price: parsed.amount,
    currency: (currency || parsed.currency || '').toUpperCase() || null,
    listPrice: null,
    inStock: stockFromText(avail.attr('href') || avail.attr('content') || avail.text()),
    title: (name.attr('content') || name.text() || '').trim() || null,
    method: 'microdata',
  };
}

// ---------- Meta tags (Open Graph / Facebook catalog / Pinterest) ----------

export function fromMeta($, { currencyHint } = {}) {
  const meta = (names) => {
    for (const n of names) {
      const v = $(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`).first().attr('content');
      if (v) return v.trim();
    }
    return null;
  };
  const raw = meta(['product:price:amount', 'og:price:amount', 'product:sale_price:amount', 'twitter:data1']);
  if (!raw) return null;
  const currency = meta(['product:price:currency', 'og:price:currency', 'product:sale_price:currency']) || currencyHint;
  const parsed = parsePrice(raw, { currencyHint: currency, structured: /^\d+(\.\d+)?$/.test(raw) });
  if (!parsed || parsed.amount <= 0) return null;
  const sale = meta(['product:sale_price:amount']);
  const regular = meta(['product:original_price:amount', 'og:price:standard_amount']);
  const listPrice = regular ? parsePrice(regular, { currencyHint: currency, structured: true })?.amount : null;
  return {
    price: sale ? parsePrice(sale, { currencyHint: currency, structured: true })?.amount ?? parsed.amount : parsed.amount,
    currency: (currency || parsed.currency || '').toUpperCase() || null,
    listPrice: listPrice && listPrice > parsed.amount ? listPrice : null,
    inStock: stockFromText(meta(['product:availability', 'og:availability'])),
    title: meta(['og:title', 'twitter:title']),
    method: 'meta',
  };
}
