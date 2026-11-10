import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { runCheck } from '../src/monitor.js';
import { getSettings } from '../src/config.js';
import { startFakeStores, demoProducts } from '../src/demo.js';
import { clearRobotsCache } from '../src/fetch/robots.js';

const base = () => ({ ...getSettings({}), dbPath: ':memory:', engine: 'http', domainDelayMs: 0, alertCooldownHours: 24, runSummary: true, aiExtract: false });
const capture = () => {
  const sent = { send: [], summary: [] };
  return { sent, channels: [{ name: 'test', send: async (a) => sent.send.push(a), summary: async (s) => sent.summary.push(s) }] };
};
const quiet = { log: () => {}, warn: () => {} };

test('three-day run over the fake stores (HTTP engine): readings, alerts, dedupe, summary', async () => {
  clearRobotsCache();
  const shop = await startFakeStores();
  const db = openDb(':memory:');
  for (const p of demoProducts(shop.base, { browser: false })) db.addProduct(p);
  const { sent, channels } = capture();
  const settings = base();
  try {
    const d1 = await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.deepEqual([d1.checked, d1.ok, d1.failed, d1.alerts], [4, 4, 0, 0]);
    assert.equal(sent.summary.length, 1);

    shop.setDay(1);
    const d2 = await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.equal(d2.ok, 4);
    const tech = sent.send.find((a) => a.product.store === 'techmart.example');
    assert.deepEqual(tech.events.map((e) => e.type).sort(), ['price_drop', 'sale_started', 'undercut']);
    assert.equal(tech.market.own, 115);
    assert.ok(sent.send.find((a) => a.product.store === 'gadgetzone.example').events.some((e) => e.type === 'out_of_stock'));
    assert.equal(d2.changes.length, 3, 'techmart, plainshop, euroshop changed');

    // Same day again: no new data -> no duplicate alerts.
    const before = sent.send.length;
    const again = await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.equal(again.alerts, 0);
    assert.equal(sent.send.length, before);

    shop.setDay(2);
    await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    const euro = sent.send.find((a) => a.product.store === 'euroshop.example');
    assert.deepEqual(euro.events.map((e) => e.type).sort(), ['all_time_low', 'price_drop', 'sale_started', 'target_reached']);
    assert.equal(euro.currency, 'EUR');
    assert.ok(sent.send.some((a) => a.product.store === 'gadgetzone.example' && a.events.some((e) => e.type === 'back_in_stock')));

    const hist = db.history(db.findProduct(`${shop.base}/techmart/earbuds-pro`).id);
    assert.deepEqual(hist.map((h) => h.price), [129.99, 99.99, 99.99, 94.99]);
    assert.ok(db.listAlerts(100).every((a) => JSON.parse(a.channels).includes('test')));
    assert.equal(db.lastRun().ok, 4);
  } finally {
    db.close();
    await shop.close();
  }
});

test('dry run writes nothing and sends nothing', async () => {
  clearRobotsCache();
  const shop = await startFakeStores();
  const db = openDb(':memory:');
  db.addProduct(demoProducts(shop.base)[0]);
  const { sent, channels } = capture();
  try {
    const r = await runCheck(db, { settings: base(), channels, dryRun: true, useBrowser: false, ...quiet });
    assert.equal(r.ok, 1);
    assert.equal(db.lastObservation(1), undefined);
    assert.equal(sent.summary.length + sent.send.length, 0);
  } finally {
    db.close();
    await shop.close();
  }
});

/** Small server whose responses the test controls. */
async function server(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
}

test('failures: tracker_failing alert after N failed runs, robots.txt respected, blocked detection', async () => {
  clearRobotsCache();
  const srv = await server((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end('User-agent: *\nDisallow: /private\n'); }
    if (req.url === '/captcha') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>Just a moment...</title>'); }
    if (req.url === '/gone') { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><p>No price here</p></body></html>');
  });
  const db = openDb(':memory:');
  const a = db.addProduct({ url: `${srv.url}/no-price`, name: 'A' });
  const b = db.addProduct({ url: `${srv.url}/private/x`, name: 'B' });
  const c = db.addProduct({ url: `${srv.url}/captcha`, name: 'C' });
  const d = db.addProduct({ url: `${srv.url}/gone`, name: 'D' });
  const { sent, channels } = capture();
  const settings = { ...base(), failAlertAfter: 2 };
  try {
    const r1 = await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.equal(r1.failed, 4);
    const kinds = Object.fromEntries(r1.failures.map((f) => [f.name, f.kind]));
    assert.deepEqual(kinds, { A: 'no_price', B: 'robots', C: 'blocked', D: 'not_found' });
    assert.equal(sent.send.length, 0);
    await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.equal(sent.send.length, 4);
    assert.ok(sent.send.every((x) => x.events[0].type === 'tracker_failing'));
    assert.equal(db.getProduct(a).fail_count, 2);
    await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.equal(sent.send.length, 4, 'failing alert is sent once, not every run');
    assert.ok([b, c, d].every((id) => db.getProduct(id).last_status));
  } finally {
    db.close();
    await srv.close();
  }
});

test('suspicious huge drop is re-read; unstable readings are not stored', async () => {
  clearRobotsCache();
  let n = 0;
  let mode = 'stable';
  const srv = await server((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    n++;
    const price = mode === 'first' ? 100 : mode === 'stable' ? 20 : n % 2 ? 20 : 30;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<script type="application/ld+json">{"@type":"Product","name":"P","offers":{"price":"${price}","priceCurrency":"USD"}}</script>`);
  });
  const db = openDb(':memory:');
  const id = db.addProduct({ url: `${srv.url}/p` });
  const { sent, channels } = capture();
  const settings = base();
  try {
    mode = 'first';
    await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    mode = 'flaky';
    const r = await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.equal(r.failures[0]?.kind, 'unstable');
    assert.equal(db.lastObservation(id).price, 100);
    mode = 'stable';
    await runCheck(db, { settings, channels, useBrowser: false, ...quiet });
    assert.equal(db.lastObservation(id).price, 20);
    const alert = sent.send.at(-1);
    assert.equal(alert.verified, true);
    assert.ok(alert.events.some((e) => e.type === 'price_drop'));
  } finally {
    db.close();
    await srv.close();
  }
});
