// HTML -> price result. Layers, most reliable first; the first one that yields a price wins,
// later layers only fill gaps (stock, title, list price).
import * as cheerio from 'cheerio';
import { parsePrice } from '../price.js';
import { fromJsonLd, fromMicrodata, fromMeta, stockFromText } from './structured.js';
import { rulesFor, readSelector } from './sites.js';

const OUT_OF_STOCK = /\b(out of stock|sold out|currently unavailable|temporarily unavailable|no longer available|ausverkauft|nicht (mehr )?verfügbar|nicht lieferbar|épuisé|rupture de stock|agotado|sin stock|esaurito|non disponibile|uitverkocht|niet op voorraad|slutsåld|wyprzedane)\b|غير متوفر|نفذت الكمية|نفذ من المخزون/i;
const IN_STOCK = /\b(in stock|add to (cart|bag|basket)|buy now|in den warenkorb|auf lager|ajouter au panier|en stock|añadir al carrito|aggiungi al carrello|disponible)\b|أضف إلى (السلة|العربة)|متوفر/i;

const BLOCK_MARKERS = [
  /<title>\s*(just a moment|attention required|access denied|robot check|are you a robot|security check|pardon our interruption)/i,
  /cf-chl-|challenge-platform|cf_chl_opt/i,
  /px-captcha|perimeterx/i,
  /captcha-delivery\.com|datadome/i,
  /\/errors\/validateCaptcha|api-services-support@amazon\.com/i,
  /g-recaptcha|h-captcha|hcaptcha\.com/i,
];

export function looksBlocked(html, status) {
  if ([401, 403, 429, 503].includes(status)) return true;
  if (!html) return false;
  return BLOCK_MARKERS.some((re) => re.test(html.slice(0, 60000)));
}

/**
 * @param {string} html
 * @param {{ url: string, selector?: string|null, stockSelector?: string|null, currencyHint?: string|null }} opts
 */
export function extractFromHtml(html, opts) {
  const $ = cheerio.load(html);
  const url = new URL(opts.url);
  const hint = opts.currencyHint || null;
  const found = [];

  // 1. The user's own selector always wins.
  if (opts.selector) {
    const raw = readSelector($, opts.selector);
    const p = raw && parsePrice(raw, { currencyHint: hint });
    if (p) found.push({ price: p.amount, currency: p.currency, listPrice: nearbyListPrice($, opts.selector.split('@')[0], p), method: 'selector' });
  }
  // 2. Structured data published for Google Shopping.
  for (const fn of [fromJsonLd, fromMicrodata, fromMeta]) {
    const r = fn($, { url: opts.url, currencyHint: hint });
    if (r) found.push(r);
  }
  // 3. Known stores and platform themes.
  for (const rule of rulesFor(url.hostname, html)) {
    const r = fromRule($, rule, hint);
    if (r) found.push(r);
  }
  // 4. Generic "price"-class heuristic.
  const h = heuristic($, hint);
  if (h) found.push(h);

  const best = found.find((f) => f.price > 0);
  if (!best) {
    return { price: null, title: pageTitle($), inStock: stockHeuristic($, opts.stockSelector), blocked: looksBlocked(html), text: visibleText($) };
  }

  const result = { ...best };
  for (const f of found) {
    if (result.listPrice == null && f.listPrice != null && f.listPrice > result.price) result.listPrice = f.listPrice;
    if (result.inStock == null && f.inStock != null) result.inStock = f.inStock;
    if (!result.title && f.title) result.title = f.title;
    if (!result.currency && f.currency) result.currency = f.currency;
  }
  if (result.listPrice == null && result.method === 'microdata') {
    result.listPrice = nearbyListPrice($, '[itemprop="price"]', { amount: result.price, currency: result.currency });
  }
  if (opts.stockSelector) {
    const s = stockHeuristic($, opts.stockSelector);
    if (s != null) result.inStock = s;
  }
  if (result.inStock == null) result.inStock = stockHeuristic($);
  if (!result.title) result.title = pageTitle($);
  result.currency = (result.currency || hint || '').toUpperCase() || null;
  result.listPrice = result.listPrice ?? null;
  result.confidence = best.method === 'heuristic' ? 'low' : 'high';
  return result;
}

function fromRule($, rule, hint) {
  let price = null;
  for (const sel of rule.price) {
    const raw = readSelector($, sel);
    const p = raw && parsePrice(raw, { currencyHint: hint, structured: sel.includes('@data-price-amount') });
    if (p && p.amount > 0) { price = p; break; }
  }
  if (!price) return null;
  let listPrice = null;
  for (const sel of rule.list) {
    const raw = readSelector($, sel);
    const p = raw && parsePrice(raw, { currencyHint: price.currency || hint, structured: sel.includes('@data-price-amount') });
    if (p && p.amount > price.amount) { listPrice = p.amount; break; }
  }
  let inStock = null;
  for (const sel of rule.stock) {
    const raw = readSelector($, sel);
    if (raw) { inStock = textStock(raw); if (inStock != null) break; }
  }
  let title = null;
  for (const sel of rule.title) { title = readSelector($, sel); if (title) break; }
  return { price: price.amount, currency: price.currency, listPrice, inStock, title, method: `site:${rule.name}` };
}

const NOT_CURRENT = /(old|was|compare|regular|original|strike|before|rrp|msrp|list|save|saving|discount|unit|per-|percent|installment|klarna|afterpay|range|filter|slider)/i;
const CURRENT_HINT = /(sale|current|final|now|special|actual|offer|our|selling|product-price|price--main|main-price)/i;
const NOISE_AREA = 'header, footer, nav, aside, [class*="related" i], [class*="recommend" i], [class*="carousel" i], [class*="upsell" i], [class*="cross-sell" i], [class*="recent" i], [id*="related" i]';

function heuristic($, hint) {
  const cands = [];
  $('[class*="price" i], [id*="price" i], [data-price], [data-testid*="price" i]').each((i, el) => {
    if (cands.length > 200) return false;
    const $el = $(el);
    const cls = `${$el.attr('class') || ''} ${$el.attr('id') || ''} ${$el.attr('data-testid') || ''}`;
    if (NOT_CURRENT.test(cls) && !CURRENT_HINT.test(cls)) return;
    if ($el.closest('del, s, strike').length) return;
    // Wrapper around several price elements (old + new): score the inner ones instead.
    if ($el.find('[class*="price" i], [id*="price" i]').length) return;
    const text = $el.clone().find('del, s, strike, script, style').remove().end().text().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40 || !/\d/.test(text)) return;
    const p = parsePrice(text, { currencyHint: hint });
    if (!p || p.amount <= 0) return;
    let score = 0;
    if (/[$€£¥₹]|[A-Z]{3}|zł|kr/.test(text)) score += 3;
    if (CURRENT_HINT.test(cls)) score += 2;
    if ($el.closest('main, [class*="product-info" i], [class*="product-detail" i], [class*="pdp" i], [id*="product" i]').length) score += 2;
    if ($el.closest(NOISE_AREA).length) score -= 4;
    if ($el.children().length > 3) score -= 1;
    score -= i * 0.01;
    const old = $el.parent().find('del, s, strike, [class*="old" i], [class*="was" i], [class*="compare" i]').first().text();
    const lp = old ? parsePrice(old, { currencyHint: p.currency || hint }) : null;
    cands.push({ price: p.amount, currency: p.currency, listPrice: lp && lp.amount > p.amount ? lp.amount : null, score, method: 'heuristic' });
  });
  cands.sort((a, b) => b.score - a.score);
  return cands[0] && cands[0].score > 0 ? cands[0] : null;
}

/** Crossed-out "was" price next to a price element (<del>, <s>, .old-price, .was ...). */
function nearbyListPrice($, sel, price) {
  const el = $(sel).first();
  for (const scope of [el.parent(), el.parent().parent()]) {
    const raw = scope.find('del, s, strike, [class*="old" i], [class*="was" i], [class*="compare" i], [class*="regular" i]').first().text();
    const lp = raw ? parsePrice(raw, { currencyHint: price.currency }) : null;
    if (lp && lp.amount > price.amount) return lp.amount;
  }
  return null;
}

function textStock(text) {
  const s = stockFromText(text);
  if (s != null) return s;
  if (OUT_OF_STOCK.test(text)) return false;
  if (IN_STOCK.test(text)) return true;
  return null;
}

function stockHeuristic($, stockSelector) {
  if (stockSelector) {
    const el = $(stockSelector).first();
    if (!el.length) return null;
    const txt = el.text().replace(/\s+/g, ' ').trim();
    const t = textStock(txt) ?? null;
    if (t != null) return t;
    return el.is('[disabled]') ? false : null;
  }
  const main = $('main, [class*="product-info" i], [class*="product-detail" i], [id*="product" i]').first();
  const area = (main.length ? main : $('body')).clone();
  area.find(`script, style, ${NOISE_AREA}`).remove();
  const text = area.text().replace(/\s+/g, ' ').slice(0, 20000);
  if (OUT_OF_STOCK.test(text)) return false;
  const btn = $('button[name="add"], button[name="add-to-cart"], #add-to-cart-button, .single_add_to_cart_button, [data-testid*="add-to-cart" i]').first();
  if (btn.length) return !btn.is('[disabled]');
  return null;
}

function pageTitle($) {
  const t = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text();
  return t ? t.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
}

/** Readable page text for the AI fallback, product area first. */
export function visibleText($) {
  const root = $('main').first().length ? $('main').first().clone() : $('body').clone();
  root.find('script, style, noscript, svg, header, footer, nav, iframe').remove();
  return root.text().replace(/\s+/g, ' ').trim().slice(0, 8000);
}
