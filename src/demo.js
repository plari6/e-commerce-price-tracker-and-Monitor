// Offline demo: a local server plays 5 competitor stores whose prices change over 3 "days".
// Shows every engine (Shopify JSON, HTTP + JSON-LD, custom selector, Puppeteer for a JavaScript-only page)
// and every main alert, with no internet and no keys.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from './db.js';
import { runCheck } from './monitor.js';
import { writeReports } from './report.js';
import { ROOT } from './config.js';

const DAYS = {
  techmart: [{ price: 129.99 }, { price: 99.99, list: 129.99 }, { price: 94.99, list: 129.99 }],
  gadgetzone: [{ price: 12499, stock: true }, { price: 12499, stock: false }, { price: 11999, stock: true }], // cents
  plainshop: [{ price: '$119.00' }, { price: '$109.00', was: '$119.00' }, { price: '$109.00', was: '$119.00' }],
  reactstore: [{ price: 124.0 }, { price: 124.0 }, { price: 112.5 }],
  euroshop: [{ price: '1.349,00 €' }, { price: '1.299,00 €' }, { price: '1.179,00 €', was: '1.349,00 €' }],
};

export function startFakeStores() {
  let day = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    const d = (k) => DAYS[k][Math.min(day, DAYS[k].length - 1)];
    switch (u.pathname) {
      case '/robots.txt': return send(200, 'User-agent: *\nDisallow: /private/\n', 'text/plain');
      case '/techmart/earbuds-pro': {
        const s = d('techmart');
        const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Aurora Earbuds Pro', sku: 'AUR-PRO', offers: { '@type': 'Offer', price: s.price.toFixed(2), priceCurrency: 'USD', availability: 'https://schema.org/InStock', ...(s.list ? { priceSpecification: [{ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/ListPrice', price: s.list, priceCurrency: 'USD' }] } : {}) } };
        return send(200, `<html><head><title>Aurora Earbuds Pro | TechMart</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Aurora Earbuds Pro</h1><span class="price">$${s.price}</span></body></html>`);
      }
      case '/products/earbuds-pro.js': {
        const s = d('gadgetzone');
        return send(200, JSON.stringify({ title: 'Aurora Earbuds Pro', price: s.price, compare_at_price: null, available: s.stock, variants: [{ id: 1, title: 'Default Title', price: s.price, compare_at_price: null, available: s.stock, sku: 'GZ-AUR' }] }), 'application/json');
      }
      case '/cart.js': return send(200, JSON.stringify({ currency: 'USD', items: [] }), 'application/json');
      case '/products/earbuds-pro': return send(200, '<html><body>Shopify page (theme)</body></html>');
      case '/plainshop/item/42': {
        const s = d('plainshop');
        return send(200, `<html><body><div class="buy"><h2>Aurora Earbuds Pro (black)</h2><p>Our price: <b class="pp-now">${s.price}</b>${s.was ? ` <del>${s.was}</del>` : ''}</p><button>Add to cart</button></div><aside class="related"><span class="price">$9.99</span></aside></body></html>`);
      }
      case '/reactstore/p/earbuds': {
        const s = d('reactstore');
        // Price only exists after JavaScript runs: plain HTTP sees an empty shell.
        return send(200, `<html><head><title>ReactStore</title></head><body><div id="root">Loading…</div><script>setTimeout(function(){document.getElementById('root').innerHTML='<main><h1>Aurora Earbuds Pro</h1><div class="product-price current">$${s.price.toFixed(2)}</div><button>Add to cart</button></main>';},300)</script></body></html>`);
      }
      case '/euroshop/laptop-14': {
        const s = d('euroshop');
        return send(200, `<html><body><main itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">ZenBook 14 OLED</h1><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><span itemprop="price">${s.price}</span><meta itemprop="priceCurrency" content="EUR"><link itemprop="availability" href="https://schema.org/InStock"></div>${s.was ? `<s class="old-price">${s.was}</s>` : ''}</main></body></html>`);
      }
      default: return send(404, 'not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, setDay: (n) => { day = n; }, close: () => new Promise((r) => server.close(r)) });
  }));
}

export function demoProducts(base, { browser = true } = {}) {
  const list = [
    { url: `${base}/techmart/earbuds-pro`, store: 'techmart.example', sku: 'aurora-pro', own_price: 115 },
    { url: `${base}/products/earbuds-pro`, store: 'gadgetzone.example', sku: 'aurora-pro', own_price: 115 },
    { url: `${base}/plainshop/item/42`, store: 'plainshop.example', sku: 'aurora-pro', own_price: 115, selector: '.pp-now', name: 'Aurora Earbuds Pro (PlainShop)' },
    { url: `${base}/euroshop/laptop-14`, store: 'euroshop.example', sku: 'zenbook-14', currency: 'EUR', target_price: 1200 },
  ];
  if (browser) list.splice(3, 0, { url: `${base}/reactstore/p/earbuds`, store: 'reactstore.example', sku: 'aurora-pro', own_price: 115, engine: 'auto' });
  return list;
}

export async function runDemo({ settings, browser = true, log = console.log, dbPath = path.join(ROOT, 'data', 'demo.db'), out = path.join(ROOT, 'data', 'demo-report'), env = {} } = {}) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  const shop = await startFakeStores();
  const store = openDb(dbPath);
  const s = { ...settings, dbPath, domainDelayMs: 150, alertCooldownHours: 0, runSummary: false, aiExtract: false, engine: browser ? 'auto' : 'http' };
  for (const p of demoProducts(shop.base, { browser })) store.addProduct(p);
  const summaries = [];
  try {
    for (let day = 0; day < 3; day++) {
      shop.setDay(day);
      log(`\n━━━ Day ${day + 1} ${day === 0 ? '(first readings, no alerts yet)' : ''} ━━━`);
      const sum = await runCheck(store, {
        settings: s, env, useBrowser: browser, log,
        onProgress: ({ product, result, error }) => log(error
          ? `  ✖ ${product.store.padEnd(20)} ${error.message}`
          : `  ✔ ${product.store.padEnd(20)} ${String(result.price).padStart(8)} ${result.currency}  via ${result.engine}/${result.method}${result.inStock === false ? '  (sold out)' : ''}`),
      });
      summaries.push(sum);
      log(`  → ${sum.ok}/${sum.checked} read, ${sum.alerts} alert event(s), ${(sum.ms / 1000).toFixed(1)} s`);
    }
    const rep = await writeReports(store, { out, formats: ['xlsx', 'html', 'csv'], title: 'Demo: Competitor Price Monitor' });
    log(`\nReports: ${rep.files.join(' | ')}`);
    return { summaries, files: rep.files, alerts: store.listAlerts(100) };
  } finally {
    store.close();
    await shop.close();
  }
}
