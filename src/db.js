// SQLite store (built-in node:sqlite, no native build). Tables: products, observations, alerts, runs.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseAmount } from './price.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT,
  sku TEXT,                 -- group key: the same product sold by several competitors
  store TEXT,               -- hostname, filled automatically
  currency TEXT,
  target_price REAL,        -- alert when the price reaches this
  own_price REAL,           -- your price: alert when a competitor undercuts it
  selector TEXT,            -- optional CSS selector for the price
  stock_selector TEXT,      -- optional CSS selector whose presence means "out of stock"
  engine TEXT DEFAULT 'auto',
  learned_engine TEXT,      -- 'browser' once HTTP proved not enough
  drop_pct REAL,            -- per-product override of DROP_PCT
  tags TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_error TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  price REAL NOT NULL,
  list_price REAL,          -- "was" / compare-at price shown next to the price
  currency TEXT,
  in_stock INTEGER,         -- 1, 0 or NULL (unknown)
  title TEXT,
  method TEXT,              -- which extractor found the price
  engine TEXT,              -- http | browser | api
  ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obs_product ON observations(product_id, checked_at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  message TEXT NOT NULL,
  price REAL,
  prev_price REAL,
  data TEXT,
  channels TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_key ON alerts(dedupe_key, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  checked INTEGER DEFAULT 0,
  ok INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  alerts INTEGER DEFAULT 0,
  note TEXT
);
`;

const PRODUCT_FIELDS = ['url', 'name', 'sku', 'store', 'currency', 'target_price', 'own_price', 'selector', 'stock_selector', 'engine', 'drop_pct', 'tags', 'active'];

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return createStore(db);
}

function createStore(db) {
  const q = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();

  return {
    db,
    close: () => db.close(),

    addProduct(p) {
      const row = normalizeProduct(p);
      const cols = PRODUCT_FIELDS.filter((f) => row[f] !== undefined);
      const sql = `INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
        ON CONFLICT(url) DO UPDATE SET ${cols.filter((c) => c !== 'url').map((c) => `${c}=excluded.${c}`).join(',') || 'url=url'}
        RETURNING id`;
      return q(sql).get(...cols.map((c) => row[c])).id;
    },
    updateProduct(id, patch) {
      const row = normalizeProduct(patch, false);
      const cols = PRODUCT_FIELDS.filter((f) => row[f] !== undefined);
      if (!cols.length) return;
      q(`UPDATE products SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => row[c]), id);
    },
    removeProduct: (id) => q('DELETE FROM products WHERE id=?').run(id).changes,
    getProduct: (id) => q('SELECT * FROM products WHERE id=?').get(id),
    findProduct: (idOrUrl) => (/^\d+$/.test(String(idOrUrl)) ? q('SELECT * FROM products WHERE id=?').get(Number(idOrUrl)) : q('SELECT * FROM products WHERE url=?').get(idOrUrl)),
    listProducts({ activeOnly = false } = {}) {
      return q(`SELECT * FROM products ${activeOnly ? 'WHERE active=1' : ''} ORDER BY COALESCE(sku, name), id`).all();
    },

    recordSuccess(productId, obs) {
      q(`INSERT INTO observations (product_id, checked_at, price, list_price, currency, in_stock, title, method, engine, ms)
         VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        productId, obs.checkedAt || now(), obs.price, obs.listPrice ?? null, obs.currency ?? null,
        obs.inStock == null ? null : obs.inStock ? 1 : 0, obs.title ?? null, obs.method ?? null, obs.engine ?? null, obs.ms ?? null,
      );
      q(`UPDATE products SET fail_count=0, last_status='ok', last_error=NULL, last_checked_at=?,
         learned_engine=CASE WHEN ?='browser' THEN 'browser' ELSE learned_engine END WHERE id=?`).run(obs.checkedAt || now(), obs.engine ?? '', productId);
    },
    recordFailure(productId, status, error) {
      q('UPDATE products SET fail_count=fail_count+1, last_status=?, last_error=?, last_checked_at=? WHERE id=?').run(status, String(error).slice(0, 500), now(), productId);
      return q('SELECT fail_count FROM products WHERE id=?').get(productId)?.fail_count ?? 0;
    },

    lastObservation: (productId) => q('SELECT * FROM observations WHERE product_id=? ORDER BY checked_at DESC, id DESC LIMIT 1').get(productId),
    history(productId, days = 3650) {
      const since = new Date(Date.now() - days * 864e5).toISOString();
      return q('SELECT * FROM observations WHERE product_id=? AND checked_at>=? ORDER BY checked_at, id').all(productId, since);
    },
    stats(productId, days = 30) {
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const all = q('SELECT MIN(price) low, MAX(price) high, COUNT(*) n FROM observations WHERE product_id=?').get(productId);
      const recent = q('SELECT AVG(price) avg FROM observations WHERE product_id=? AND checked_at>=?').get(productId, since);
      return { low: all.low, high: all.high, count: all.n, avg30: recent.avg };
    },

    /** Every product with its latest reading (LEFT JOIN: never-read products included with price NULL). */
    latestAll({ sku, activeOnly = true } = {}) {
      return q(`SELECT p.*, o.price, o.list_price, o.in_stock, o.currency AS obs_currency, o.checked_at, o.method, o.engine AS obs_engine, o.title
        FROM products p LEFT JOIN observations o ON o.id = (SELECT id FROM observations WHERE product_id=p.id ORDER BY checked_at DESC, id DESC LIMIT 1)
        WHERE (? IS NULL OR p.sku = ?) ${activeOnly ? 'AND p.active=1' : ''} ORDER BY COALESCE(p.sku, p.name), o.price`).all(sku ?? null, sku ?? null);
    },

    recentAlert(dedupeKey, hours) {
      const since = new Date(Date.now() - hours * 36e5).toISOString();
      return q('SELECT * FROM alerts WHERE dedupe_key=? AND created_at>=? LIMIT 1').get(dedupeKey, since);
    },
    addAlert(a) {
      return q(`INSERT INTO alerts (product_id, type, dedupe_key, message, price, prev_price, data, channels, created_at)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`).get(
        a.productId ?? null, a.type, a.dedupeKey, a.message, a.price ?? null, a.prevPrice ?? null,
        JSON.stringify(a.data ?? {}), JSON.stringify(a.channels ?? []), a.createdAt || now(),
      ).id;
    },
    setAlertChannels: (id, channels) => q('UPDATE alerts SET channels=? WHERE id=?').run(JSON.stringify(channels), id),
    listAlerts(limit = 50) {
      return q(`SELECT a.*, p.name, p.url, p.store FROM alerts a LEFT JOIN products p ON p.id=a.product_id ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(limit);
    },

    startRun: () => q('INSERT INTO runs (started_at) VALUES (?) RETURNING id').get(now()).id,
    finishRun(id, r) {
      q('UPDATE runs SET finished_at=?, checked=?, ok=?, failed=?, alerts=?, note=? WHERE id=?').run(now(), r.checked, r.ok, r.failed, r.alerts, r.note ?? null, id);
    },
    lastRun: () => q('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get(),
  };
}

function normalizeProduct(p, requireUrl = true) {
  const out = {};
  if (p.url !== undefined) {
    const u = new URL(p.url);
    out.url = u.toString();
    out.store = p.store || u.hostname.replace(/^www\./, '');
  } else if (requireUrl) throw new Error('Product needs a url');
  for (const f of ['name', 'sku', 'currency', 'selector', 'stock_selector', 'engine', 'tags']) {
    const v = p[f] ?? p[camel(f)];
    if (v !== undefined) out[f] = v === '' ? null : String(v);
  }
  if (out.currency) out.currency = out.currency.toUpperCase();
  if (out.engine && !['auto', 'http', 'browser'].includes(out.engine)) throw new Error(`engine must be auto, http or browser (got ${out.engine})`);
  for (const f of ['target_price', 'own_price', 'drop_pct']) {
    const v = p[f] ?? p[camel(f)];
    if (v !== undefined) out[f] = v === '' || v === null ? null : typeof v === 'number' ? v : /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : parseAmount(String(v)) ?? NaN;
    if (out[f] !== undefined && out[f] !== null && Number.isNaN(out[f])) throw new Error(`${f} must be a number`);
  }
  if (p.active !== undefined) out.active = p.active === false || p.active === 0 || p.active === '0' || p.active === 'false' ? 0 : 1;
  if (Array.isArray(p.tags)) out.tags = p.tags.join(',');
  return out;
}

const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
