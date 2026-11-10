import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, parseAmount, detectCurrency, priceAppearsIn, pctChange, formatMoney } from '../src/price.js';

test('parses US, European, Swiss and Asian price formats', () => {
  const cases = [
    ['$1,299.99', 1299.99, 'USD'],
    ['1.299,99 €', 1299.99, 'EUR'],
    ['€ 49,90', 49.9, 'EUR'],
    ['£51.77', 51.77, 'GBP'],
    ["CHF 1'299.50", 1299.5, 'CHF'],
    ['1 299,00 zł', 1299, 'PLN'],
    ['¥12,800', 12800, 'JPY'],
    ['1.299,–', 1299, null],
    ['12,-', 12, null],
    ['R$ 2.499,90', 2499.9, 'BRL'],
    ['AED 3,499', 3499, 'AED'],
    ['299 kr', 299, 'SEK'],
    ['Now only $9.99!', 9.99, 'USD'],
    ['1,299', 1299, null],
    ['0,999', 0.999, null],
  ];
  for (const [raw, amount, cur] of cases) {
    const p = parsePrice(raw);
    assert.equal(p.amount, Math.round(amount * 100) / 100, raw);
    assert.equal(p.currency, cur, raw);
  }
});

test('structured (JSON-LD) values use "." as decimal mark', () => {
  assert.equal(parseAmount('1299.99', { structured: true }), 1299.99);
  assert.equal(parseAmount('19.5', { structured: true }), 19.5);
  assert.equal(parseAmount(42), 42);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
});

test('currency hint resolves the shared $ symbol', () => {
  assert.equal(detectCurrency('$19.99', 'CAD'), 'CAD');
  assert.equal(detectCurrency('$19.99'), 'USD');
  assert.equal(detectCurrency('19.99', 'EUR'), 'EUR');
  assert.equal(detectCurrency('A$ 20'), 'AUD');
});

test('priceAppearsIn guards against invented AI prices', () => {
  assert.ok(priceAppearsIn('Sale now €1.299,00 instead of 1.499', 1299));
  assert.ok(priceAppearsIn('Only $ 19.99 today', 19.99));
  assert.ok(!priceAppearsIn('Only $19.99 today', 17.99));
});

test('pctChange and formatMoney', () => {
  assert.equal(pctChange(100, 80), -20);
  assert.equal(pctChange(null, 80), null);
  assert.equal(formatMoney(1299.5, 'EUR'), '€1,299.50');
  assert.equal(formatMoney(12800, 'JPY'), '¥12,800');
});
