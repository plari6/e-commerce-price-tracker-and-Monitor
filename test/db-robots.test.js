import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { parseRobots, isAllowed } from '../src/fetch/robots.js';
import { parseCsv } from '../src/cli.js';

test('products: upsert by URL, validation, update, remove', () => {
  const db = openDb(':memory:');
  const id = db.addProduct({ url: 'https://www.shop.test/p/1', name: 'One', targetPrice: '49.5', sku: 'g1' });
  const p = db.getProduct(id);
  assert.equal(p.store, 'shop.test');
  assert.equal(p.target_price, 49.5);
  assert.equal(db.addProduct({ url: 'https://www.shop.test/p/1', name: 'One v2' }), id, 'same URL updates the row');
  assert.equal(db.getProduct(id).name, 'One v2');
  assert.throws(() => db.addProduct({ url: 'not a url' }));
  assert.throws(() => db.addProduct({ url: 'https://x.test', engine: 'warp' }), /engine/);
  assert.throws(() => db.addProduct({ url: 'https://x.test', own_price: 'cheap' }), /own_price/);
  db.updateProduct(id, { active: false, own_price: 60 });
  assert.equal(db.listProducts({ activeOnly: true }).length, 0);
  assert.equal(db.findProduct(String(id)).own_price, 60);
  assert.equal(db.removeProduct(id), 1);
  db.close();
});

test('observations, stats, failures, learned engine, alerts dedupe', () => {
  const db = openDb(':memory:');
  const id = db.addProduct({ url: 'https://s.test/a', sku: 'g' });
  const t = (d) => new Date(Date.now() - d * 864e5).toISOString();
  db.recordSuccess(id, { price: 100, currency: 'USD', inStock: true, engine: 'http', checkedAt: t(2) });
  db.recordSuccess(id, { price: 80, currency: 'USD', inStock: false, engine: 'browser', checkedAt: t(1) });
  assert.equal(db.lastObservation(id).price, 80);
  assert.equal(db.lastObservation(id).in_stock, 0);
  assert.deepEqual(db.stats(id), { low: 80, high: 100, count: 2, avg30: 90 });
  assert.equal(db.getProduct(id).learned_engine, 'browser');
  assert.equal(db.recordFailure(id, 'blocked', 'captcha'), 1);
  assert.equal(db.recordFailure(id, 'blocked', 'captcha'), 2);
  db.recordSuccess(id, { price: 81, engine: 'http' });
  assert.equal(db.getProduct(id).fail_count, 0);
  assert.equal(db.latestAll({ sku: 'g' })[0].price, 81);

  db.addAlert({ productId: id, type: 'price_drop', dedupeKey: 'k1', message: 'm' });
  assert.ok(db.recentAlert('k1', 24));
  assert.ok(!db.recentAlert('k2', 24));
  assert.equal(db.listAlerts(5)[0].url, 'https://s.test/a');
  db.close();
});

test('robots.txt parsing with wildcards and allow overrides', () => {
  const rules = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /checkout\nDisallow: /*?sort=\nAllow: /checkout/help$\n');
  assert.ok(isAllowed(rules, '/products/shoe'));
  assert.ok(!isAllowed(rules, '/checkout/pay'));
  assert.ok(isAllowed(rules, '/checkout/help'));
  assert.ok(!isAllowed(rules, '/c/shoes?sort=price'));
  assert.ok(isAllowed(parseRobots(''), '/anything'));
});

test('CSV import parser: auto separator, quotes, BOM', () => {
  const rows = parseCsv('﻿url;name;target_price\n"https://s.test/a";"Shoe; red";49,90\nhttps://s.test/b;Hat;\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { url: 'https://s.test/a', name: 'Shoe; red', target_price: '49,90' });
  assert.deepEqual(rows[1], { url: 'https://s.test/b', name: 'Hat' });
  assert.equal(parseCsv('url,name\nhttps://x.test,"He said ""hi"""\n')[0].name, 'He said "hi"');
});
