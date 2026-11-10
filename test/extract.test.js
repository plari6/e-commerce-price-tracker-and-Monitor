import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, looksBlocked } from '../src/extract/index.js';
import { parseShopifyProduct, shopifyHandle } from '../src/fetch/shopify.js';

const page = (body, head = '') => `<html><head>${head}</head><body>${body}</body></html>`;
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

test('JSON-LD Product with list price and availability', () => {
  const html = page('', ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, {
    '@type': 'Product', name: 'Widget', offers: { '@type': 'Offer', price: '79.00', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock',
      priceSpecification: [{ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/ListPrice', price: 99 }] },
  }] }));
  const r = extractFromHtml(html, { url: 'https://shop.test/p/widget' });
  assert.equal(r.price, 79);
  assert.equal(r.currency, 'USD');
  assert.equal(r.listPrice, 99);
  assert.equal(r.inStock, false);
  assert.equal(r.title, 'Widget');
  assert.equal(r.method, 'json-ld');
});

test('JSON-LD AggregateOffer / variant selection by ?variant=', () => {
  const html = page('', ld({ '@type': 'Product', name: 'Shoe', offers: [
    { '@type': 'Offer', price: 120, priceCurrency: 'EUR', sku: '111', availability: 'InStock' },
    { '@type': 'Offer', price: 95, priceCurrency: 'EUR', sku: '222', availability: 'InStock' },
  ] }));
  assert.equal(extractFromHtml(html, { url: 'https://s.test/p?variant=222' }).price, 95);
  assert.equal(extractFromHtml(html, { url: 'https://s.test/p' }).price, 120);
  const agg = page('', ld({ '@type': 'Product', name: 'X', offers: { '@type': 'AggregateOffer', lowPrice: '15.50', highPrice: '30', priceCurrency: 'GBP' } }));
  assert.equal(extractFromHtml(agg, { url: 'https://s.test/p' }).price, 15.5);
});

test('broken JSON-LD falls through to meta tags', () => {
  const html = page('', '<script type="application/ld+json">{ not json</script><meta property="product:price:amount" content="24.95"><meta property="product:price:currency" content="CAD"><meta property="og:title" content="Mug">');
  const r = extractFromHtml(html, { url: 'https://s.test/mug' });
  assert.deepEqual([r.price, r.currency, r.method, r.title], [24.95, 'CAD', 'meta', 'Mug']);
});

test('microdata with European format and nearby old price', () => {
  const html = page('<main itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Laptop</h1><div><span itemprop="price">1.179,00 €</span><meta itemprop="priceCurrency" content="EUR"><s>1.349,00 €</s></div></main>');
  const r = extractFromHtml(html, { url: 'https://s.test/l' });
  assert.deepEqual([r.price, r.currency, r.listPrice, r.method], [1179, 'EUR', 1349, 'microdata']);
});

test('custom selector wins over everything and reads sibling <del>', () => {
  const html = page(`<div class="x"><b class="now">$109.00</b><del>$119.00</del></div>`, ld({ '@type': 'Product', offers: { price: 5, priceCurrency: 'USD' } }));
  const r = extractFromHtml(html, { url: 'https://s.test', selector: '.now' });
  assert.deepEqual([r.price, r.listPrice, r.method], [109, 119, 'selector']);
});

test('selector@attribute form', () => {
  const html = page('<div id="p" data-amount="42.10">see below</div>');
  assert.equal(extractFromHtml(html, { url: 'https://s.test', selector: '#p@data-amount' }).price, 42.1);
});

test('known site rules: Amazon layout', () => {
  const html = page('<span id="productTitle"> Echo Dot </span><div id="corePriceDisplay_desktop_feature_div"><span class="priceToPay"><span class="a-offscreen">$29.99</span></span><span class="basisPrice"><span class="a-offscreen">$49.99</span></span></div><div id="availability">In Stock</div>');
  const r = extractFromHtml(html, { url: 'https://www.amazon.com/dp/B0TEST' });
  assert.deepEqual([r.price, r.listPrice, r.inStock, r.title, r.method], [29.99, 49.99, true, 'Echo Dot', 'site:amazon']);
});

test('WooCommerce theme detection', () => {
  const html = page('<div class="product woocommerce"><div class="summary"><p class="price"><del><span class="woocommerce-Price-amount amount">£80.00</span></del> <ins><span class="woocommerce-Price-amount amount">£63.00</span></ins></p><p class="stock in-stock">12 in stock</p></div></div>');
  const r = extractFromHtml(html, { url: 'https://wp.test/shop/x' });
  assert.deepEqual([r.price, r.listPrice, r.currency, r.inStock], [63, 80, 'GBP', true]);
});

test('heuristic ignores related-products and old prices, marks low confidence', () => {
  const html = page('<main><div class="product-price"><span class="price-old">$50.00</span><span class="price sale">$39.00</span></div></main><aside class="related"><span class="price">$5.00</span></aside>');
  const r = extractFromHtml(html, { url: 'https://s.test' });
  assert.equal(r.price, 39);
  assert.equal(r.confidence, 'low');
});

test('sold-out text detection (multilingual) and no-price result', () => {
  const r = extractFromHtml(page('<main><h1>Lamp</h1><span class="price">29,90 €</span><p>Ausverkauft</p></main>'), { url: 'https://s.de' });
  assert.equal(r.inStock, false);
  assert.equal(r.price, 29.9);
  const none = extractFromHtml(page('<main><h1>About us</h1><p>We love lamps.</p></main>'), { url: 'https://s.de/about' });
  assert.equal(none.price, null);
  assert.match(none.text, /love lamps/);
});

test('blocked page detection', () => {
  assert.ok(looksBlocked('<html><title>Just a moment...</title></html>', 200));
  assert.ok(looksBlocked('<form action="/errors/validateCaptcha">', 200));
  assert.ok(looksBlocked('', 403));
  assert.ok(!looksBlocked('<html><title>Shoe</title></html>', 200));
});

test('Shopify product JSON: cents, compare-at, variant and stock', () => {
  assert.equal(shopifyHandle('https://s.test/collections/all/products/cool-tee?variant=2'), 'cool-tee');
  assert.equal(shopifyHandle('https://s.test/pages/about'), null);
  const json = { title: 'Cool Tee', price: 2500, available: true, variants: [
    { id: 1, title: 'S', price: 2500, compare_at_price: 3500, available: false },
    { id: 2, title: 'M', price: 2200, compare_at_price: 3500, available: true },
  ] };
  const a = parseShopifyProduct(json, 'https://s.test/products/cool-tee');
  assert.deepEqual([a.price, a.listPrice, a.inStock, a.title], [22, 35, true, 'Cool Tee - M']);
  const b = parseShopifyProduct(json, 'https://s.test/products/cool-tee?variant=1');
  assert.deepEqual([b.price, b.inStock], [25, false]);
});
