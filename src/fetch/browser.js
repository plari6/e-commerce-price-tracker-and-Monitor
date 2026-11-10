// Headless Chrome with puppeteer-extra-plugin-stealth, for JavaScript-rendered pages and sites that
// block plain HTTP clients. One browser per run, a fresh incognito context per page, limited concurrency.
import fs from 'node:fs';
import path from 'node:path';
import { jitter, sleep } from './http.js';

const CHALLENGE_TITLE = /just a moment|checking your browser|attention required|please wait|one moment/i;

export function semaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export function createBrowserPool(settings = {}) {
  let browserP = null;
  const limit = semaphore(settings.browserConcurrency || 2);
  const proxy = settings.proxyUrl ? new URL(settings.proxyUrl) : null;

  async function getBrowser() {
    if (!browserP) {
      browserP = (async () => {
        const { default: puppeteer } = await import('puppeteer-extra');
        const { default: Stealth } = await import('puppeteer-extra-plugin-stealth');
        puppeteer.use(Stealth());
        const args = ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-US,en', '--window-size=1366,900', '--disable-blink-features=AutomationControlled'];
        if (proxy) args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);
        const b = await puppeteer.launch({ headless: settings.headless !== false, executablePath: settings.chromePath, args, defaultViewport: null });
        b.on('disconnected', () => { browserP = null; });
        return b;
      })().catch((err) => { browserP = null; throw err; });
    }
    return browserP;
  }

  async function fetchPage(url, { timeoutMs = 30000, waitForSelector, acceptLanguage = 'en-US,en;q=0.9' } = {}) {
    return limit(async () => {
      const t0 = Date.now();
      const browser = await getBrowser();
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      try {
        await page.setViewport({ width: 1280 + Math.floor(Math.random() * 160), height: 800 + Math.floor(Math.random() * 100) });
        await page.setExtraHTTPHeaders({ 'Accept-Language': acceptLanguage });
        if (proxy?.username) await page.authenticate({ username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const t = req.resourceType();
          if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
          else req.continue().catch(() => {});
        });

        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        // Wait out "Just a moment..." interstitials (Cloudflare and similar), max ~15 s.
        for (let i = 0; i < 15 && CHALLENGE_TITLE.test(await page.title().catch(() => '')); i++) await sleep(1000);
        await Promise.all([
          page.waitForNetworkIdle({ idleTime: 700, timeout: 8000 }).catch(() => {}),
          waitForSelector ? page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => {}) : null,
        ]);
        // A little human-like scrolling triggers lazy price widgets.
        await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 500)).catch(() => {});
        await sleep(jitter(600));
        const body = await page.content();
        return { status: resp?.status() ?? 0, body, url: page.url(), ms: Date.now() - t0 };
      } catch (err) {
        if (settings.debugDir) await screenshot(page, settings.debugDir, url);
        throw err;
      } finally {
        await ctx.close().catch(() => {});
      }
    });
  }

  return {
    fetchPage,
    get launched() { return Boolean(browserP); },
    async close() {
      if (!browserP) return;
      const b = await browserP.catch(() => null);
      browserP = null;
      await b?.close().catch(() => {});
    },
  };
}

async function screenshot(page, dir, url) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new URL(url).hostname}-${Date.now()}.png`;
    await page.screenshot({ path: path.join(dir, name), fullPage: false });
  } catch { /* best effort */ }
}
