import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, marketPosition, formatAlertText } from '../src/alerts.js';
import { getSettings, ALL_ALERT_TYPES } from '../src/config.js';

const settings = { ...getSettings({}), alertTypes: ALL_ALERT_TYPES };
const product = { id: 7, name: 'Earbuds', store: 'shop.test', url: 'https://shop.test/e', currency: 'USD' };
const types = (ev) => ev.map((e) => e.type).sort();

test('first reading never alerts on drops', () => {
  assert.deepEqual(evaluate({ product, prev: null, cur: { price: 50 }, stats: { low: null, count: 0 }, settings }), []);
});

test('price drop over threshold, ignored under threshold, per-product override', () => {
  const prev = { price: 100, list_price: null, in_stock: 1 };
  assert.deepEqual(types(evaluate({ product, prev, cur: { price: 96 }, stats: { low: 100, count: 1 }, settings })), []);
  assert.deepEqual(types(evaluate({ product, prev, cur: { price: 90 }, stats: { low: 100, count: 1 }, settings })), ['price_drop']);
  assert.deepEqual(types(evaluate({ product: { ...product, drop_pct: 3 }, prev, cur: { price: 96 }, stats: { low: 100, count: 1 }, settings })), ['price_drop']);
});

test('drop by absolute amount', () => {
  const ev = evaluate({ product, prev: { price: 1000 }, cur: { price: 980 }, stats: { low: 1000, count: 1 }, settings: { ...settings, dropAmount: 20 } });
  assert.deepEqual(types(ev), ['price_drop']);
});

test('sale started, then only a deeper sale re-alerts', () => {
  const s = { ...settings, alertTypes: ['sale_started'] };
  assert.deepEqual(types(evaluate({ product, prev: { price: 100 }, cur: { price: 100, listPrice: 125 }, stats: { count: 1 }, settings: s })), ['sale_started']);
  assert.deepEqual(types(evaluate({ product, prev: { price: 100, list_price: 125 }, cur: { price: 100, listPrice: 125 }, stats: { count: 2 }, settings: s })), []);
  const deeper = evaluate({ product, prev: { price: 100, list_price: 125 }, cur: { price: 90, listPrice: 125 }, stats: { count: 2 }, settings: s });
  assert.equal(deeper[0].label, '🏷️ Deeper discount');
});

test('target reached only when crossing', () => {
  const p = { ...product, target_price: 80 };
  const s = { ...settings, alertTypes: ['target_reached'] };
  assert.equal(evaluate({ product: p, prev: { price: 85 }, cur: { price: 79 }, stats: { count: 1 }, settings: s }).length, 1);
  assert.equal(evaluate({ product: p, prev: { price: 79 }, cur: { price: 78 }, stats: { count: 2 }, settings: s }).length, 0);
  assert.equal(evaluate({ product: p, prev: null, cur: { price: 70 }, stats: { count: 0 }, settings: s }).length, 1);
});

test('all-time low needs history', () => {
  const s = { ...settings, alertTypes: ['all_time_low'] };
  assert.equal(evaluate({ product, prev: { price: 60 }, cur: { price: 55 }, stats: { low: 60, count: 1 }, settings: s }).length, 0);
  assert.equal(evaluate({ product, prev: { price: 60 }, cur: { price: 55 }, stats: { low: 58, count: 5 }, settings: s }).length, 1);
});

test('undercut own price when crossing, with gap in detail', () => {
  const p = { ...product, own_price: 100 };
  const s = { ...settings, alertTypes: ['undercut'] };
  const ev = evaluate({ product: p, prev: { price: 105 }, cur: { price: 95 }, stats: { count: 1 }, settings: s });
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail, /\$5\.00 \(5%\) cheaper/);
  assert.equal(evaluate({ product: p, prev: { price: 95 }, cur: { price: 94 }, stats: { count: 2 }, settings: s }).length, 0);
});

test('stock transitions and price increase', () => {
  assert.deepEqual(types(evaluate({ product, prev: { price: 50, in_stock: 0 }, cur: { price: 50, inStock: true }, stats: { count: 1 }, settings })), ['back_in_stock']);
  assert.deepEqual(types(evaluate({ product, prev: { price: 50, in_stock: 1 }, cur: { price: 50, inStock: false }, stats: { count: 1 }, settings })), ['out_of_stock']);
  assert.deepEqual(types(evaluate({ product, prev: { price: 50, in_stock: null }, cur: { price: 50, inStock: false }, stats: { count: 1 }, settings })), []);
  assert.deepEqual(types(evaluate({ product, prev: { price: 50 }, cur: { price: 60 }, stats: { low: 50, count: 1 }, settings })), ['price_increase']);
});

test('disabled alert types are skipped', () => {
  const ev = evaluate({ product, prev: { price: 100 }, cur: { price: 50 }, stats: { low: 100, count: 3 }, settings: { ...settings, alertTypes: ['undercut'] } });
  assert.deepEqual(ev, []);
});

test('dedupe keys: price events include price, stock events do not', () => {
  const ev = evaluate({ product, prev: { price: 100, in_stock: 1 }, cur: { price: 80, inStock: false }, stats: { low: 100, count: 1 }, settings });
  assert.ok(ev.find((e) => e.type === 'price_drop').dedupeKey === '7:price_drop:80');
  assert.ok(ev.find((e) => e.type === 'out_of_stock').dedupeKey === '7:out_of_stock');
});

test('market position ranks you against in-stock competitors', () => {
  const rows = [
    { store: 'a', price: 90, in_stock: 1, url: 'u1' },
    { store: 'b', price: 80, in_stock: 0, url: 'u2' },
    { store: 'c', price: 110, in_stock: 1, url: 'u3' },
  ];
  const m = marketPosition(rows, 100);
  assert.deepEqual([m.cheapest.store, m.competitors, m.rank, m.gap], ['a', 2, 2, 10]);
  assert.equal(marketPosition(rows, 85).rank, 1);
  const text = formatAlertText({ product, events: [{ label: 'X', detail: 'y' }], price: 90, prevPrice: 100, currency: 'USD', market: m });
  assert.match(text, /you rank #2/);
});
