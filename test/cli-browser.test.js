import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFakeStores } from '../src/demo.js';
import { createBrowserPool } from '../src/fetch/browser.js';
import { scrapeProduct } from '../src/scraper.js';
import { getSettings } from '../src/config.js';

const run = promisify(execFile);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'price-tracker.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
const env = { ...process.env, PRICE_TRACKER_SKIP_DOTENV: '1', DOMAIN_DELAY_MS: '0', RUN_SUMMARY: 'false' };
const cli = (args, db = path.join(tmp, 'cli.db')) => run(process.execPath, [BIN, ...args, '--db', db], { env, timeout: 60000 });

test('CLI: add, import, check, list, history, compare, alerts, report, export', async () => {
  const shop = await startFakeStores();
  try {
    let r = await cli(['add', `${shop.base}/techmart/earbuds-pro`, '--sku', 'aurora', '--own-price', '115', '--engine', 'http']);
    assert.match(r.stdout, /Tracking #1/);
    const csv = path.join(tmp, 'p.csv');
    fs.writeFileSync(csv, `url;sku;own_price;selector;engine\n${shop.base}/plainshop/item/42;aurora;115;.pp-now;http\n`);
    r = await cli(['import', csv]);
    assert.match(r.stdout, /Imported 1\/1/);
    r = await cli(['check', '--engine', 'http']);
    assert.match(r.stdout, /2\/2 read/);
    shop.setDay(1);
    r = await cli(['check', '--engine', 'http']);
    assert.match(r.stdout, /Price drop/);
    r = await cli(['list']);
    assert.match(r.stdout, /\$99\.99/);
    r = await cli(['history', '1']);
    assert.match(r.stdout, /2 readings/);
    r = await cli(['compare', 'aurora']);
    assert.match(r.stdout, /rank #3 of 3/);
    r = await cli(['alerts']);
    assert.match(r.stdout, /undercuts your price/);
    const out = path.join(tmp, 'rep');
    r = await cli(['report', '--out', out, '--format', 'xlsx,html,csv,json']);
    for (const ext of ['xlsx', 'html', 'csv', 'json']) assert.ok(fs.statSync(`${out}.${ext}`).size > 200, ext);
    assert.match(fs.readFileSync(`${out}.html`, 'utf8'), /cheaper than you/);
    assert.match(fs.readFileSync(`${out}.csv`, 'utf8'), /Link/);
    r = await cli(['export']);
    assert.equal(JSON.parse(r.stdout).length, 2);
    await assert.rejects(cli(['remove', '99']), /No product/);
    await assert.rejects(cli(['frobnicate']), /Unknown command/);
  } finally {
    await shop.close();
  }
});

test('CLI demo without browser runs end to end', async () => {
  const r = await run(process.execPath, [BIN, 'demo', '--no-browser'], { env, timeout: 90000 });
  assert.match(r.stdout, /Day 3/);
  assert.match(r.stdout, /Target price reached/);
  assert.match(r.stdout, /Reports:/);
});

// Real Chrome: the JavaScript-only store page has no price over plain HTTP.
const chromeOk = await (async () => {
  if (process.env.SKIP_BROWSER_TESTS) return false;
  try {
    const { default: p } = await import('puppeteer');
    return fs.existsSync(await p.executablePath());
  } catch { return false; }
})();

test('stealth browser reads a JavaScript-rendered price that HTTP cannot', { skip: !chromeOk && 'Chrome not installed', timeout: 120000 }, async () => {
  const shop = await startFakeStores();
  const settings = { ...getSettings({}), respectRobots: true, aiExtract: false };
  const browser = createBrowserPool(settings);
  try {
    const product = { url: `${shop.base}/reactstore/p/earbuds`, engine: 'auto' };
    await assert.rejects(scrapeProduct({ ...product, engine: 'http' }, { settings, browser: null }), (e) => e.kind === 'no_price');
    const r = await scrapeProduct(product, { settings, browser });
    assert.equal(r.price, 124);
    assert.equal(r.engine, 'browser');
    assert.deepEqual(r.attempts.map((a) => a.engine), ['http', 'browser']);
  } finally {
    await browser.close();
    await shop.close();
  }
});
