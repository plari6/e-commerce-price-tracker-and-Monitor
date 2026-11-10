// One monitoring run: scrape every active product politely, store readings, evaluate alert rules, notify.
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, marketPosition, LABELS } from './alerts.js';
import { createBrowserPool, semaphore } from './fetch/browser.js';
import { jitter, sleep } from './fetch/http.js';
import { createChannels, dispatch } from './notify/index.js';
import { pctChange, round2 } from './price.js';
import { scrapeProduct } from './scraper.js';

/**
 * @param {ReturnType<import('./db.js').openDb>} store
 * @param {{ settings: object, env?: object, ids?: number[], dryRun?: boolean, notify?: boolean, browser?: object|null,
 *           useBrowser?: boolean, channels?: object[], fetchImpl?: typeof fetch, ai?: object, log?: Function, onProgress?: Function }} opts
 */
export async function runCheck(store, opts) {
  const { settings, dryRun = false } = opts;
  const env = opts.env || process.env;
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;
  const t0 = Date.now();
  let products = store.listProducts({ activeOnly: !opts.ids?.length });
  if (opts.ids?.length) products = products.filter((p) => opts.ids.includes(p.id));

  const summary = { checked: products.length, ok: 0, failed: 0, alerts: 0, changes: [], failures: [], ms: 0, startedAt: new Date(t0).toISOString() };
  if (!products.length) {
    log('No products to check. Add one with: price-tracker add <url>');
    return summary;
  }

  const lock = dryRun ? null : acquireLock(settings.dbPath);
  const ownBrowser = !opts.browser && opts.useBrowser !== false && settings.engine !== 'http';
  const browser = opts.browser ?? (ownBrowser ? createBrowserPool(settings) : null);
  const channels = opts.channels ?? createChannels(env, { fetchImpl: opts.fetchImpl, log });
  const notify = opts.notify !== false && !dryRun;
  const runId = dryRun ? null : store.startRun();
  const ctx = { settings, env, browser, fetchImpl: opts.fetchImpl, ai: opts.ai };

  // Same store = one request at a time with a human-like gap; different stores run in parallel.
  const byStore = new Map();
  for (const p of products) {
    if (!byStore.has(p.store)) byStore.set(p.store, []);
    byStore.get(p.store).push(p);
  }
  const limit = semaphore(Math.max(1, settings.concurrency));

  try {
    await Promise.all([...byStore.values()].map((list) => limit(async () => {
      for (let i = 0; i < list.length; i++) {
        if (i > 0) await sleep(jitter(settings.domainDelayMs));
        await checkOne(list[i]);
      }
    })));
  } finally {
    if (ownBrowser) await browser?.close();
    lock?.release();
  }

  async function checkOne(product) {
    const name = product.name || product.store;
    try {
      let r = await scrapeProduct(product, ctx);
      const prev = store.lastObservation(product.id);
      const stats = store.stats(product.id);
      let verified = false;

      if (prev?.currency && r.currency && prev.currency !== r.currency) {
        throw Object.assign(new Error(`currency changed ${prev.currency} → ${r.currency} (geo redirect?): reading skipped`), { kind: 'currency' });
      }
      // Very large drops are usually a parsing slip (unit price, instalment, wrong variant). Read again to confirm.
      const drop = prev ? -(pctChange(prev.price, r.price) ?? 0) : 0;
      if (prev && drop >= settings.suspiciousDropPct) {
        await sleep(jitter(1500));
        const again = await scrapeProduct(product, ctx);
        if (Math.abs(again.price - r.price) / r.price > 0.02) {
          throw Object.assign(new Error(`unstable reading (${r.price} then ${again.price}): skipped`), { kind: 'unstable' });
        }
        verified = true;
        r = again;
      }

      const checkedAt = new Date().toISOString();
      if (!dryRun) store.recordSuccess(product.id, { ...r, checkedAt });
      summary.ok++;
      if (!product.name && r.title && !dryRun) store.updateProduct(product.id, { name: r.title.slice(0, 200) });
      const pct = prev ? pctChange(prev.price, r.price) : null;
      if (prev && pct) summary.changes.push({ id: product.id, name, prev: prev.price, price: r.price, pct, currency: r.currency });
      opts.onProgress?.({ product, result: r, prev, pct });

      const events = evaluate({ product: { ...product, currency: product.currency || r.currency }, prev, cur: r, stats, settings })
        .filter((e) => dryRun || !store.recentAlert(e.dedupeKey, settings.alertCooldownHours));
      if (!events.length) return;

      let market = null;
      if (product.sku) {
        const group = store.latestAll({ sku: product.sku });
        const own = group.find((g) => g.own_price != null)?.own_price ?? null;
        market = marketPosition(group.map((g) => (g.id === product.id ? { ...g, price: r.price, in_stock: r.inStock === false ? 0 : 1 } : g)), own);
      }
      const alert = {
        product: { id: product.id, name: r.title && !product.name ? r.title : name, store: product.store, url: product.url, sku: product.sku },
        events, price: r.price, prevPrice: prev?.price ?? null, listPrice: r.listPrice, currency: r.currency, inStock: r.inStock, market, verified, checkedAt,
      };
      const sent = notify ? await dispatch(channels, 'send', alert, { warn }) : [];
      if (!dryRun) for (const e of events) store.addAlert({ productId: product.id, type: e.type, dedupeKey: e.dedupeKey, message: `${e.label}: ${e.detail}`, price: r.price, prevPrice: prev?.price, data: { pct: e.pct, market }, channels: sent });
      summary.alerts += events.length;
      if (!notify) log(`  [${dryRun ? 'dry-run' : 'notify off'}] alert not sent: ${events.map((e) => e.type).join(', ')} for ${name}`);
    } catch (err) {
      summary.failed++;
      summary.failures.push({ id: product.id, name, kind: err.kind || 'error', error: err.message });
      opts.onProgress?.({ product, error: err });
      if (dryRun) return;
      const fails = store.recordFailure(product.id, err.kind || 'error', err.message);
      if (fails === settings.failAlertAfter && settings.alertTypes.includes('tracker_failing')) {
        const e = { type: 'tracker_failing', label: LABELS.tracker_failing, detail: `${fails} checks in a row: ${err.message}`, dedupeKey: `${product.id}:tracker_failing` };
        const alert = { product: { id: product.id, name, store: product.store, url: product.url, sku: product.sku }, events: [e], price: null, prevPrice: null, currency: product.currency, checkedAt: new Date().toISOString() };
        const sent = notify ? await dispatch(channels, 'send', alert, { warn }) : [];
        store.addAlert({ productId: product.id, type: e.type, dedupeKey: e.dedupeKey, message: `${e.label}: ${e.detail}`, channels: sent });
        summary.alerts++;
      }
    }
  }

  summary.ms = Date.now() - t0;
  summary.changes.sort((a, b) => a.pct - b.pct);
  if (runId) store.finishRun(runId, { ...summary, note: summary.failures.length ? `${summary.failures.length} failed` : null });
  if (notify && settings.runSummary) await dispatch(channels.filter((c) => c.name !== 'console'), 'summary', summary, { warn });
  summary.avgMs = round2(summary.ms / Math.max(1, summary.checked));
  return summary;
}

/** Cross-process lock so a cron run and a manual run never write at the same time. */
function acquireLock(dbPath) {
  if (dbPath === ':memory:') return { release() {} };
  const file = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.lock`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 2 * 3600e3) {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* not running */ }
      if (alive && pid !== process.pid) throw new Error(`another price check is running (pid ${pid}); remove ${file} if that is wrong`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, String(process.pid));
  return { release: () => fs.rmSync(file, { force: true }) };
}
