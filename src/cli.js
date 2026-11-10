import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getSettings, loadEnv, ROOT, ALL_ALERT_TYPES } from './config.js';
import { openDb } from './db.js';
import { formatMoney, pctChange } from './price.js';

const HELP = `E-Commerce Price Tracker & Monitor

Usage: price-tracker <command> [options]

Watchlist
  add <url> [--name --sku --target --own-price --selector --stock-selector --engine --currency --drop-pct --tags]
  import <file.json|file.csv>      add/update many products (columns: url,name,sku,target_price,own_price,selector,...)
  export [file.json]               write the watchlist as JSON (stdout if no file)
  list [--json]                    products with latest price and status
  edit <id> [same options as add]  change a product (e.g. --target 89 --own-price 99)
  enable <id> | disable <id> | remove <id>

Checking
  test-url <url> [--selector --engine --currency --json]   read one page now, show which method found the price
  check [--id 1,2] [--dry-run] [--no-notify] [--engine http|browser|auto]
  start [--cron "0 8 * * *"] [--run-now] [--health-port 8080]   run on a schedule (node-cron)

Insights
  history <id> [--days 90]         price history with a sparkline
  compare [sku]                    same product across competitors: cheapest store, your rank
  alerts [--limit 30]              recent alerts
  report [--out data/report] [--format xlsx,html,csv,json] [--sep ";"]

Setup
  demo [--no-browser]              offline demo: 5 fake competitor stores, 3 days of price changes
  notify-test                      send a sample alert to every configured channel
  doctor [--ping]                  check database, Chrome, alert channels, AI models

Global: --db <file> (default data/prices.db)   Env: see .env.example
`;

const OPTIONS = {
  name: { type: 'string' }, sku: { type: 'string' }, target: { type: 'string' }, 'own-price': { type: 'string' },
  selector: { type: 'string' }, 'stock-selector': { type: 'string' }, engine: { type: 'string' }, currency: { type: 'string' },
  'drop-pct': { type: 'string' }, tags: { type: 'string' }, id: { type: 'string' }, 'dry-run': { type: 'boolean' },
  'no-notify': { type: 'boolean' }, cron: { type: 'string' }, 'run-now': { type: 'boolean' }, 'health-port': { type: 'string' },
  days: { type: 'string' }, limit: { type: 'string' }, out: { type: 'string' }, format: { type: 'string' }, sep: { type: 'string' },
  'no-browser': { type: 'boolean' }, ping: { type: 'boolean' }, json: { type: 'boolean' }, db: { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

export async function main(argv = process.argv.slice(2)) {
  await loadEnv();
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...args] = positionals;
  if (!cmd || o.help || cmd === 'help') return void console.log(HELP);

  const settings = getSettings();
  if (o.db) settings.dbPath = path.resolve(o.db);
  if (o.engine && ['check', 'test-url'].includes(cmd)) settings.engine = o.engine;
  if (o.cron) settings.cron = o.cron;

  if (cmd === 'demo') {
    const { runDemo } = await import('./demo.js');
    return void (await runDemo({ settings, browser: !o['no-browser'] }));
  }
  if (cmd === 'test-url') return testUrl(args[0], o, settings);
  if (cmd === 'notify-test') return notifyTest();
  if (cmd === 'doctor') return doctor(settings, o);

  const store = openDb(settings.dbPath);
  try {
    switch (cmd) {
      case 'add': {
        if (!args[0]) throw new Error('Usage: price-tracker add <url> [--name ...]');
        const id = store.addProduct({ url: args[0], ...productOpts(o) });
        const p = store.getProduct(id);
        console.log(`✔ Tracking #${id} ${p.name || ''} (${p.store}). Try it now: price-tracker check --id ${id}`);
        return;
      }
      case 'edit': {
        const p = need(store, args[0]);
        store.updateProduct(p.id, productOpts(o));
        console.log(`✔ Updated #${p.id}`);
        return;
      }
      case 'enable': case 'disable': {
        const p = need(store, args[0]);
        store.updateProduct(p.id, { active: cmd === 'enable' });
        console.log(`✔ #${p.id} ${cmd}d`);
        return;
      }
      case 'remove': {
        const p = need(store, args[0]);
        store.removeProduct(p.id);
        console.log(`✔ Removed #${p.id} and its history`);
        return;
      }
      case 'import': return importFile(store, args[0]);
      case 'export': {
        const rows = store.listProducts().map(({ url, name, sku, currency, target_price, own_price, selector, stock_selector, engine, drop_pct, tags, active }) => ({ url, name, sku, currency, target_price, own_price, selector, stock_selector, engine, drop_pct, tags, active: active === 1 }));
        const json = JSON.stringify(rows, null, 2);
        if (args[0]) { fs.writeFileSync(args[0], json); console.log(`✔ ${rows.length} products → ${args[0]}`); } else console.log(json);
        return;
      }
      case 'list': return listProducts(store, o);
      case 'check': {
        const { runCheck } = await import('./monitor.js');
        const ids = o.id ? o.id.split(',').map(Number) : undefined;
        const sum = await runCheck(store, {
          settings, ids, dryRun: o['dry-run'], notify: !o['no-notify'],
          onProgress: ({ product, result, error, pct }) => console.log(error
            ? `  ✖ #${product.id} ${label(product)} — ${error.message}`
            : `  ✔ #${product.id} ${label(product)} — ${formatMoney(result.price, result.currency)}${pct ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''} via ${result.engine}/${result.method}${result.inStock === false ? ' · sold out' : ''}`),
        });
        console.log(`\n${sum.ok}/${sum.checked} read · ${sum.alerts} alert(s) · ${sum.failed} failed · ${(sum.ms / 1000).toFixed(1)} s${o['dry-run'] ? ' (dry run: nothing saved)' : ''}`);
        if (sum.failed && sum.failed === sum.checked) process.exitCode = 2;
        return;
      }
      case 'start': {
        const { startScheduler } = await import('./scheduler.js');
        await startScheduler(store, { settings, runNow: o['run-now'], healthPort: Number(o['health-port'] || process.env.HEALTH_PORT) || null });
        return new Promise(() => {}); // keep running
      }
      case 'history': return history(store, args[0], Number(o.days || 90), o.json);
      case 'compare': return await compare(store, args[0], o.json);
      case 'alerts': {
        const rows = store.listAlerts(Number(o.limit || 30));
        if (o.json) return void console.log(JSON.stringify(rows, null, 2));
        if (!rows.length) return void console.log('No alerts yet.');
        for (const a of rows) console.log(`${a.created_at.slice(0, 16).replace('T', ' ')}  #${a.product_id ?? '-'} ${a.name || a.store || ''}\n   ${a.message}${a.channels && a.channels !== '[]' ? `  → ${JSON.parse(a.channels).join(', ')}` : ''}`);
        return;
      }
      case 'report': {
        const { writeReports } = await import('./report.js');
        const formats = (o.format || 'xlsx,html').split(',').map((s) => s.trim());
        const { files, rows } = await writeReports(store, { out: o.out || path.join(ROOT, 'data', 'report'), formats, sep: o.sep || ',', days: Number(o.days || 90) });
        console.log(`✔ Report for ${rows.length} products:\n${files.map((f) => `  ${path.resolve(f)}`).join('\n')}`);
        return;
      }
      default:
        throw new Error(`Unknown command "${cmd}". Run price-tracker --help`);
    }
  } finally {
    if (cmd !== 'start') store.close();
  }
}

function productOpts(o) {
  const map = { name: 'name', sku: 'sku', target: 'target_price', 'own-price': 'own_price', selector: 'selector', 'stock-selector': 'stock_selector', engine: 'engine', currency: 'currency', 'drop-pct': 'drop_pct', tags: 'tags' };
  const out = {};
  for (const [k, v] of Object.entries(map)) if (o[k] !== undefined) out[v] = o[k];
  return out;
}

function need(store, idOrUrl) {
  const p = idOrUrl && store.findProduct(idOrUrl);
  if (!p) throw new Error(`No product "${idOrUrl ?? ''}". See: price-tracker list`);
  return p;
}

const label = (p) => (p.name || p.store).slice(0, 48);

export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  const keys = header.map((h) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()]).filter(([, v]) => v !== '')));
}

function importFile(store, file) {
  if (!file || !fs.existsSync(file)) throw new Error('Usage: price-tracker import <products.json|products.csv>');
  const text = fs.readFileSync(file, 'utf8');
  const items = file.toLowerCase().endsWith('.csv') ? parseCsv(text) : JSON.parse(text);
  const list = Array.isArray(items) ? items : items.products;
  let ok = 0;
  for (const [i, item] of list.entries()) {
    try { store.addProduct(item); ok++; } catch (err) { console.warn(`  row ${i + 1}: ${err.message}`); }
  }
  console.log(`✔ Imported ${ok}/${list.length} products (existing URLs updated).`);
}

function listProducts(store, o) {
  const rows = store.latestAll({ activeOnly: false });
  if (o.json) return void console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return void console.log('Watchlist is empty. Add a product: price-tracker add <url> --target 99');
  console.log(table(['ID', 'Product', 'Store', 'SKU', 'Price', 'Target', 'Yours', 'Stock', 'Checked', 'Status'], rows.map((r) => [
    r.id + (r.active ? '' : ' (off)'), (r.name || r.title || '').slice(0, 38), r.store.slice(0, 22), r.sku || '',
    r.price != null ? formatMoney(r.price, r.obs_currency || r.currency) : '—', r.target_price ?? '', r.own_price ?? '',
    r.in_stock == null ? '?' : r.in_stock ? 'yes' : 'no', r.checked_at ? r.checked_at.slice(0, 16).replace('T', ' ') : 'never',
    r.last_status === 'ok' || !r.last_status ? (r.last_status || '') : `${r.last_status}×${r.fail_count}`,
  ])));
}

function history(store, id, days, asJson) {
  const p = need(store, id);
  const rows = store.history(p.id, days);
  if (asJson) return void console.log(JSON.stringify(rows, null, 2));
  console.log(`#${p.id} ${p.name || p.store} — ${rows.length} readings in ${days} days\n${p.url}\n`);
  if (!rows.length) return;
  console.log(`${sparkline(rows.map((r) => r.price))}  low ${formatMoney(Math.min(...rows.map((r) => r.price)), rows[0].currency)} · high ${formatMoney(Math.max(...rows.map((r) => r.price)), rows[0].currency)}\n`);
  console.log(table(['Checked', 'Price', 'Change', 'Was', 'Stock', 'Via'], rows.map((r, i) => {
    const c = i ? pctChange(rows[i - 1].price, r.price) : null;
    return [r.checked_at.slice(0, 16).replace('T', ' '), formatMoney(r.price, r.currency), c ? `${c > 0 ? '+' : ''}${c}%` : '', r.list_price ? formatMoney(r.list_price, r.currency) : '', r.in_stock == null ? '?' : r.in_stock ? 'yes' : 'no', `${r.engine}/${r.method}`];
  })));
}

async function compare(store, sku, asJson) {
  const { buildRows, buildMarket } = await import('./report.js');
  const market = buildMarket(buildRows(store)).filter((m) => !sku || m.sku === sku);
  if (asJson) return void console.log(JSON.stringify(market, null, 2));
  if (!market.length) return void console.log('No SKU groups yet. Give the same --sku to the same product at different stores.');
  for (const m of market) {
    const rows = store.latestAll({ sku: m.sku });
    console.log(`\n${m.sku} — ${m.name}${m.own != null ? `  (your price ${formatMoney(m.own, m.currency)}, rank #${m.rank ?? '?'} of ${m.competitors + 1})` : ''}`);
    console.log(table(['Store', 'Price', 'vs yours', 'Stock', 'Link'], rows.map((r) => [r.store, r.price != null ? formatMoney(r.price, r.obs_currency || r.currency) : '—', m.own != null && r.price != null ? formatMoney(r.price - m.own, r.obs_currency || r.currency) : '', r.in_stock == null ? '?' : r.in_stock ? 'yes' : 'no', r.url])));
  }
}

async function testUrl(url, o, settings) {
  if (!url) throw new Error('Usage: price-tracker test-url <url> [--selector ".price"]');
  const { scrapeProduct } = await import('./scraper.js');
  const { createBrowserPool } = await import('./fetch/browser.js');
  const browser = settings.engine === 'http' || o['no-browser'] ? null : createBrowserPool(settings);
  const product = { url, selector: o.selector, stock_selector: o['stock-selector'], currency: o.currency, engine: o.engine || 'auto' };
  try {
    const r = await scrapeProduct(product, { settings, browser });
    if (o.json) return void console.log(JSON.stringify(r, null, 2));
    console.log(`✔ ${r.title || '(no title)'}\n  Price:    ${formatMoney(r.price, r.currency)}${r.listPrice ? `  (was ${formatMoney(r.listPrice, r.currency)})` : ''}\n  In stock: ${r.inStock == null ? 'unknown' : r.inStock ? 'yes' : 'no'}\n  Found by: ${r.method} via ${r.engine} in ${r.ms} ms (confidence ${r.confidence})\n  Tries:    ${r.attempts.map((a) => `${a.engine}${a.status ? ` ${a.status}` : ''} ${a.ok ? 'ok' : a.error || 'no price'}`).join(' → ')}`);
    if (r.confidence === 'low') console.log('  Tip: confidence is low (generic guess). Pin it with --selector "<css>" when adding the product.');
  } catch (err) {
    console.log(`✖ ${err.message}${err.attempts?.length ? `\n  Tries: ${err.attempts.map((a) => `${a.engine}${a.status ? ` ${a.status}` : ''} ${a.error || 'no price'}`).join(' → ')}` : ''}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

async function notifyTest() {
  const { createChannels, dispatch } = await import('./notify/index.js');
  const channels = createChannels();
  const sample = {
    product: { id: 0, name: 'Sample product (test alert)', store: 'competitor.example', url: 'https://example.com/product', sku: 'demo' },
    events: [{ type: 'price_drop', label: '📉 Price drop', detail: '−20% ($129.99 → $103.99, save $26.00)', pct: 20 }, { type: 'undercut', label: '⚠️ Competitor undercuts your price', detail: '$103.99 vs your $115.00' }],
    price: 103.99, prevPrice: 129.99, currency: 'USD', inStock: true, market: { cheapest: { store: 'competitor.example', price: 103.99, url: 'https://example.com/product' }, competitors: 3, own: 115, rank: 2, gap: 11.01 }, checkedAt: new Date().toISOString(),
  };
  const ok = await dispatch(channels, 'send', sample);
  const remote = channels.filter((c) => c.name !== 'console').map((c) => c.name);
  console.log(`\nDelivered to: ${ok.join(', ')}${remote.length ? '' : '\nNo remote channel configured: set TELEGRAM_*, SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL, RESEND_API_KEY + ALERT_EMAIL_TO or ALERT_WEBHOOK_URL in .env'}`);
  if (remote.some((n) => !ok.includes(n))) process.exitCode = 1;
}

async function doctor(settings, o) {
  const line = (ok, msg) => console.log(`${ok === null ? '•' : ok ? '✔' : '✖'} ${msg}`);
  const store = openDb(settings.dbPath);
  const products = store.listProducts();
  line(true, `Database ${settings.dbPath} (${products.length} products, ${products.filter((p) => p.active).length} active)`);
  const failing = products.filter((p) => p.active && p.fail_count > 0);
  if (failing.length) line(false, `${failing.length} product(s) failing: ${failing.slice(0, 5).map((p) => `#${p.id} ${p.last_status}`).join(', ')}`);
  store.close();

  const { default: cron } = await import('node-cron');
  line(cron.validate(settings.cron), `Schedule "${settings.cron}" in ${settings.timezone}`);
  line(null, `Alerts: ${settings.alertTypes.join(', ')} (drop ≥ ${settings.dropPct}%, cooldown ${settings.alertCooldownHours} h)${settings.alertTypes.length < ALL_ALERT_TYPES.length ? `; off: ${ALL_ALERT_TYPES.filter((t) => !settings.alertTypes.includes(t)).join(', ')}` : ''}`);
  line(null, `Engine ${settings.engine}, ${settings.concurrency} stores in parallel, ${settings.domainDelayMs} ms between pages of one store, robots.txt ${settings.respectRobots ? 'respected' : 'ignored'}${settings.proxyUrl ? ', proxy on' : ''}`);

  if (settings.engine !== 'http') {
    const { createBrowserPool } = await import('./fetch/browser.js');
    const pool = createBrowserPool(settings);
    try {
      const r = await pool.fetchPage('data:text/html,<title>ok</title><p>ok</p>', { timeoutMs: 30000 });
      line(r.body.includes('ok'), 'Chrome (Puppeteer Stealth) launches');
    } catch (err) {
      line(false, `Chrome failed to launch: ${err.message.split('\n')[0]} (run: npx puppeteer browsers install chrome, or set CHROME_PATH)`);
    } finally {
      await pool.close();
    }
  }

  const { createChannels } = await import('./notify/index.js');
  const ch = createChannels(process.env, { quiet: true }).map((c) => c.name);
  line(ch.length > 0, `Alert channels: ${ch.length ? ch.join(', ') : 'none (console only) — set Telegram/Slack/Discord/email/webhook in .env'}`);

  const { aiAvailable, getRouter } = await import('./ai-extract.js');
  if (!aiAvailable()) return line(null, 'AI fallback: off (no AI keys; optional — only used when no extractor finds a price)');
  const ai = getRouter();
  const st = ai.status().filter((s) => s.enabled);
  line(st.length > 0, `AI fallback chain: ${st.length} model(s): ${st.map((s) => s.id).join(', ')}`);
  if (o.ping) {
    for (const t of st) {
      const t0 = Date.now();
      try {
        await ai.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with OK' }], maxTokens: 1024, timeoutMs: 15000 });
        line(true, `  ${t.id} ${Date.now() - t0} ms`);
      } catch (err) {
        line(false, `  ${t.id} ${err.kind || ''} ${err.message.slice(0, 100)}`);
      }
    }
  }
}

function table(head, rows) {
  const w = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
  const fmt = (r) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd();
  return [fmt(head), w.map((n) => '─'.repeat(n)).join('  '), ...rows.map(fmt)].join('\n');
}

function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  return values.slice(-60).map((v) => bars[Math.round(((v - min) / span) * 7)]).join('');
}
