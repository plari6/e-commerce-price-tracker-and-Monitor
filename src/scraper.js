// One product URL -> one price reading. Engines, cheapest first:
//   Shopify JSON  ->  plain HTTP + extractors  ->  Puppeteer Stealth + extractors  ->  AI on page text.
import { extractFromHtml, looksBlocked } from './extract/index.js';
import { httpGet } from './fetch/http.js';
import { fetchShopify, shopifyHandle } from './fetch/shopify.js';
import { robotsAllows } from './fetch/robots.js';
import { aiAvailable, aiExtract } from './ai-extract.js';

export class ScrapeError extends Error {
  constructor(kind, message, attempts = []) {
    super(message);
    this.kind = kind; // robots | blocked | not_found | http | timeout | network | no_price | browser
    this.attempts = attempts;
  }
}

/**
 * @param {object} product  row from the products table (url, selector, stock_selector, currency, engine, learned_engine)
 * @param {{ settings: object, browser?: object|null, fetchImpl?: typeof fetch, ai?: object, env?: object }} ctx
 */
export async function scrapeProduct(product, ctx) {
  const { settings } = ctx;
  const env = ctx.env || process.env;
  const url = product.url;
  const t0 = Date.now();
  const attempts = [];
  const hint = product.currency || null;
  const opts = { url, selector: product.selector, stockSelector: product.stock_selector, currencyHint: hint || settings.defaultCurrency };
  let mode = product.engine && product.engine !== 'auto' ? product.engine : settings.engine;
  if (mode === 'auto' && product.learned_engine === 'browser' && ctx.browser) mode = 'browser';

  if (settings.respectRobots && !(await robotsAllows(url, { fetchImpl: ctx.fetchImpl }))) {
    throw new ScrapeError('robots', 'robots.txt disallows this URL (set RESPECT_ROBOTS=false only if you have permission)');
  }

  const done = (r, engine) => ({
    ...r,
    currency: r.currency || hint || settings.defaultCurrency,
    engine,
    ms: Date.now() - t0,
    confidence: r.confidence || 'high',
    attempts,
  });
  let bestText = null;
  let bestTitle = null;
  let blocked = false;
  let notFound = false;

  // 1. Shopify product JSON
  if (!product.selector && mode !== 'browser' && shopifyHandle(url)) {
    try {
      const r = await fetchShopify(url, { timeoutMs: settings.timeoutMs, currencyHint: hint, fetchImpl: ctx.fetchImpl });
      attempts.push({ engine: 'api', ok: Boolean(r) });
      if (r) return done(r, 'api');
    } catch (err) {
      attempts.push({ engine: 'api', ok: false, error: err.message });
    }
  }

  // 2. Plain HTTP
  if (mode === 'auto' || mode === 'http') {
    try {
      const res = await httpGet(url, { timeoutMs: settings.timeoutMs, retries: settings.retries, fetchImpl: ctx.fetchImpl });
      if (res.status === 404 || res.status === 410) notFound = true;
      const isBlocked = looksBlocked(res.body, res.status);
      if (res.status >= 200 && res.status < 300) {
        const r = extractFromHtml(res.body, { ...opts, url: res.url || url });
        attempts.push({ engine: 'http', ok: r.price != null, status: res.status, method: r.method });
        if (r.price != null) return done(r, 'http');
        blocked = blocked || r.blocked || isBlocked;
        if (!r.blocked) { bestText = r.text; bestTitle = r.title; }
      } else {
        blocked = blocked || isBlocked;
        attempts.push({ engine: 'http', ok: false, status: res.status, error: isBlocked ? 'blocked' : `HTTP ${res.status}` });
      }
    } catch (err) {
      attempts.push({ engine: 'http', ok: false, error: err.message });
      if (mode === 'http' && !aiAvailable(env)) throw new ScrapeError(err.kind || 'network', err.message, attempts);
    }
  }

  // 3. Headless Chrome (stealth)
  if ((mode === 'auto' || mode === 'browser') && ctx.browser && !notFound) {
    try {
      const res = await ctx.browser.fetchPage(url, { timeoutMs: settings.timeoutMs + 10000, waitForSelector: product.selector || undefined });
      if (res.status === 404 || res.status === 410) notFound = true;
      const r = extractFromHtml(res.body, { ...opts, url: res.url || url });
      attempts.push({ engine: 'browser', ok: r.price != null, status: res.status, method: r.method });
      if (r.price != null) return done(r, 'browser');
      blocked = r.blocked || looksBlocked(res.body, res.status);
      if (!r.blocked && r.text) { bestText = r.text; bestTitle = r.title; }
    } catch (err) {
      attempts.push({ engine: 'browser', ok: false, error: err.message.split('\n')[0] });
    }
  }

  // 4. AI reads the page text (only when we actually have the product page, never a captcha)
  if (settings.aiExtract && bestText && aiAvailable(env)) {
    const r = await aiExtract({ text: bestText, url, currencyHint: hint, title: bestTitle }, ctx.ai ? { ai: ctx.ai } : undefined);
    attempts.push({ engine: 'ai', ok: Boolean(r) });
    if (r) return done(r, attempts.some((a) => a.engine === 'browser' && a.status) ? 'browser' : 'http');
  }

  if (notFound) throw new ScrapeError('not_found', 'page returns 404/410: product removed or URL changed', attempts);
  if (blocked) throw new ScrapeError('blocked', ctx.browser ? 'blocked by bot protection (captcha/403) even in stealth browser: try PROXY_URL (residential) or a slower schedule' : 'blocked by bot protection: enable the browser engine', attempts);
  const last = attempts[attempts.length - 1];
  if (last?.error && !last.status) throw new ScrapeError('network', last.error, attempts);
  throw new ScrapeError('no_price', 'no price found on the page: add a CSS selector for this product (price-tracker test-url <url>)', attempts);
}
