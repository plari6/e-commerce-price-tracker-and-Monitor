// Reports for the client: Excel workbook (clickable links), CSV, and a self-contained HTML dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { marketPosition } from './alerts.js';
import { formatMoney, pctChange, round2 } from './price.js';

export function buildRows(store, { days = 90 } = {}) {
  const latest = store.latestAll({ activeOnly: false });
  return latest.map((p) => {
    const hist = store.history(p.id, days);
    const prev = hist.length > 1 ? hist[hist.length - 2].price : null;
    const stats = store.stats(p.id);
    const currency = p.obs_currency || p.currency;
    return {
      id: p.id, name: p.name || p.title || p.store, store: p.store, sku: p.sku, url: p.url, currency,
      price: p.price, prev, changePct: pctChange(prev, p.price), listPrice: p.list_price,
      discountPct: p.list_price && p.price ? round2(((p.list_price - p.price) / p.list_price) * 100) : null,
      low: stats.low, high: stats.high, avg30: stats.avg30 != null ? round2(stats.avg30) : null,
      target: p.target_price, own: p.own_price,
      gapVsOwn: p.own_price != null && p.price != null ? round2(p.price - p.own_price) : null,
      inStock: p.in_stock == null ? null : p.in_stock === 1,
      checkedAt: p.checked_at, status: p.last_status, error: p.last_error, active: p.active === 1, method: p.method,
      history: hist.map((h) => ({ t: h.checked_at, price: h.price })),
    };
  });
}

export function buildMarket(rows) {
  const groups = new Map();
  for (const r of rows.filter((x) => x.sku && x.active)) {
    if (!groups.has(r.sku)) groups.set(r.sku, []);
    groups.get(r.sku).push(r);
  }
  return [...groups.entries()].map(([sku, list]) => {
    const own = list.find((r) => r.own != null)?.own ?? null;
    const pos = marketPosition(list.map((r) => ({ ...r, in_stock: r.inStock === false ? 0 : 1 })), own);
    return { sku, name: list[0].name, currency: list[0].currency, stores: list.length, own, ...(pos || {}) };
  });
}

export async function writeXlsx(file, rows, market, alerts) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'E-Commerce Price Tracker';
  const money = '#,##0.00';
  const pct = '0.0"%"';

  const ws = wb.addWorksheet('Prices', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'ID', key: 'id', width: 6 }, { header: 'Product', key: 'name', width: 42 }, { header: 'Store', key: 'store', width: 22 },
    { header: 'SKU group', key: 'sku', width: 14 }, { header: 'Price', key: 'price', width: 11, style: { numFmt: money } },
    { header: 'Cur', key: 'currency', width: 6 }, { header: 'Previous', key: 'prev', width: 11, style: { numFmt: money } },
    { header: 'Change %', key: 'changePct', width: 10, style: { numFmt: pct } }, { header: 'Was (list)', key: 'listPrice', width: 11, style: { numFmt: money } },
    { header: 'Discount %', key: 'discountPct', width: 11, style: { numFmt: pct } }, { header: 'Lowest', key: 'low', width: 11, style: { numFmt: money } },
    { header: 'Highest', key: 'high', width: 11, style: { numFmt: money } }, { header: '30d avg', key: 'avg30', width: 11, style: { numFmt: money } },
    { header: 'Target', key: 'target', width: 11, style: { numFmt: money } }, { header: 'Your price', key: 'own', width: 11, style: { numFmt: money } },
    { header: 'vs yours', key: 'gapVsOwn', width: 10, style: { numFmt: money } }, { header: 'In stock', key: 'stock', width: 9 },
    { header: 'Last checked', key: 'checkedAt', width: 20 }, { header: 'Status', key: 'status', width: 10 }, { header: 'Link', key: 'link', width: 14 },
  ];
  for (const r of rows) {
    const row = ws.addRow({ ...r, stock: r.inStock == null ? '?' : r.inStock ? 'yes' : 'no', checkedAt: r.checkedAt ? r.checkedAt.replace('T', ' ').slice(0, 16) : '', link: { text: 'Open product', hyperlink: r.url } });
    row.getCell('link').font = { color: { argb: 'FF0563C1' }, underline: true };
    if (r.changePct < 0) row.getCell('changePct').font = { color: { argb: 'FFC00000' }, bold: true };
    if (r.gapVsOwn != null && r.gapVsOwn < 0) row.getCell('gapVsOwn').font = { color: { argb: 'FFC00000' }, bold: true };
  }
  styleHeader(ws);

  const wm = wb.addWorksheet('Market', { views: [{ state: 'frozen', ySplit: 1 }] });
  wm.columns = [
    { header: 'SKU group', key: 'sku', width: 16 }, { header: 'Product', key: 'name', width: 40 }, { header: 'Stores', key: 'stores', width: 8 },
    { header: 'Cheapest store', key: 'cheapestStore', width: 22 }, { header: 'Cheapest price', key: 'cheapestPrice', width: 14, style: { numFmt: money } },
    { header: 'Your price', key: 'own', width: 12, style: { numFmt: money } }, { header: 'Gap', key: 'gap', width: 10, style: { numFmt: money } },
    { header: 'Your rank', key: 'rank', width: 10 }, { header: 'Link', key: 'link', width: 14 },
  ];
  for (const m of market) {
    const row = wm.addRow({ ...m, cheapestStore: m.cheapest?.store, cheapestPrice: m.cheapest?.price, link: m.cheapest ? { text: 'Open cheapest', hyperlink: m.cheapest.url } : '' });
    row.getCell('link').font = { color: { argb: 'FF0563C1' }, underline: true };
  }
  styleHeader(wm);

  const wa = wb.addWorksheet('Alerts', { views: [{ state: 'frozen', ySplit: 1 }] });
  wa.columns = [{ header: 'When', key: 'when', width: 18 }, { header: 'Type', key: 'type', width: 16 }, { header: 'Product', key: 'name', width: 40 }, { header: 'Alert', key: 'message', width: 70 }, { header: 'Sent to', key: 'sent', width: 18 }, { header: 'Link', key: 'link', width: 14 }];
  for (const a of alerts) {
    const row = wa.addRow({ when: a.created_at.replace('T', ' ').slice(0, 16), type: a.type, name: a.name || a.store, message: a.message, sent: JSON.parse(a.channels || '[]').join(', '), link: a.url ? { text: 'Open product', hyperlink: a.url } : '' });
    row.getCell('link').font = { color: { argb: 'FF0563C1' }, underline: true };
  }
  styleHeader(wa);

  const wh = wb.addWorksheet('Price history', { views: [{ state: 'frozen', ySplit: 1 }] });
  wh.columns = [{ header: 'Product ID', key: 'id', width: 10 }, { header: 'Product', key: 'name', width: 40 }, { header: 'Store', key: 'store', width: 22 }, { header: 'Checked at', key: 't', width: 20 }, { header: 'Price', key: 'price', width: 11, style: { numFmt: money } }];
  for (const r of rows) for (const h of r.history) wh.addRow({ id: r.id, name: r.name, store: r.store, t: h.t.replace('T', ' ').slice(0, 16), price: h.price });
  styleHeader(wh);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return file;
}

function styleHeader(ws) {
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
}

export function writeCsv(file, rows, sep = ',') {
  const cols = ['id', 'name', 'store', 'sku', 'price', 'currency', 'prev', 'changePct', 'listPrice', 'discountPct', 'low', 'high', 'avg30', 'target', 'own', 'gapVsOwn', 'inStock', 'checkedAt', 'status', 'url'];
  const cell = (v) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [cols.map((c) => (c === 'url' ? 'Link' : c)).join(sep), ...rows.map((r) => cols.map((c) => cell(r[c])).join(sep))].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '﻿' + out + '\n');
  return file;
}

const h = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sparkline(points, w = 120, ht = 28) {
  if (points.length < 2) return '<span class="muted">—</span>';
  const ys = points.map((p) => p.price);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const coords = ys.map((y, i) => `${round2((i / (ys.length - 1)) * (w - 4) + 2)},${round2(ht - 3 - ((y - min) / span) * (ht - 6))}`);
  const last = coords[coords.length - 1].split(',');
  const down = ys[ys.length - 1] < ys[0];
  return `<svg width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}" role="img" aria-label="price history"><polyline fill="none" stroke="var(--${down ? 'down' : 'line'})" stroke-width="1.6" points="${coords.join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="var(--${down ? 'down' : 'line'})"/></svg>`;
}

export function writeHtml(file, rows, market, alerts, { title = 'Competitor Price Monitor' } = {}) {
  const m = (v, c) => (v == null ? '—' : formatMoney(v, c));
  const chg = (v) => (v == null ? '<span class="muted">—</span>' : `<span class="${v < 0 ? 'down' : v > 0 ? 'up' : 'muted'}">${v > 0 ? '+' : ''}${v}%</span>`);
  const active = rows.filter((r) => r.active);
  const drops = active.filter((r) => r.changePct < 0).length;
  const onSale = active.filter((r) => r.discountPct > 0).length;
  const undercut = active.filter((r) => r.gapVsOwn != null && r.gapVsOwn < 0).length;
  const failing = active.filter((r) => r.status && r.status !== 'ok').length;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2430;--muted:#6b7380;--border:#e3e6eb;--down:#c62828;--up:#2e7d32;--line:#2f5d9e;--accent:#1f3a5f}
@media (prefers-color-scheme:dark){:root{--bg:#12151a;--card:#1b1f26;--text:#e6e8ec;--muted:#98a0ab;--border:#2b313a;--down:#ef6b6b;--up:#6cc070;--line:#7aa7e8;--accent:#9cc0f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px 16px}
.wrap{max-width:1200px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}.tile{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}th{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
td.num{text-align:right;font-variant-numeric:tabular-nums}.down{color:var(--down);font-weight:600}.up{color:var(--up);font-weight:600}a{color:var(--line)}
.name{max-width:320px;overflow:hidden;text-overflow:ellipsis}.tag{display:inline-block;padding:1px 7px;border-radius:9px;font-size:12px;border:1px solid var(--border)}
</style></head><body><div class="wrap">
<h1>${h(title)}</h1><div class="muted">Generated ${h(new Date().toISOString().replace('T', ' ').slice(0, 16))} UTC · ${active.length} products tracked</div>
<div class="tiles"><div class="tile"><b>${active.length}</b>products</div><div class="tile"><b class="down">${drops}</b>price drops (last check)</div><div class="tile"><b>${onSale}</b>on sale now</div><div class="tile"><b class="down">${undercut}</b>cheaper than you</div><div class="tile"><b>${failing}</b>need attention</div></div>
${market.length ? `<h2>Market position by product</h2><div class="card"><table><thead><tr><th>Product</th><th>Stores</th><th>Cheapest</th><th class="num">Price</th><th class="num">Your price</th><th class="num">Gap</th><th>Your rank</th></tr></thead><tbody>
${market.map((g) => `<tr><td class="name">${h(g.name)}</td><td>${g.stores}</td><td>${g.cheapest ? `<a href="${h(g.cheapest.url)}" target="_blank" rel="noopener">${h(g.cheapest.store)}</a>` : '—'}</td><td class="num">${m(g.cheapest?.price, g.currency)}</td><td class="num">${m(g.own, g.currency)}</td><td class="num ${g.gap > 0 ? 'down' : ''}">${g.gap == null ? '—' : m(g.gap, g.currency)}</td><td>${g.rank ? (g.rank === 1 ? '<span class="up">#1 cheapest</span>' : `#${g.rank}`) : '—'}</td></tr>`).join('')}
</tbody></table></div>` : ''}
<h2>All tracked products</h2><div class="card"><table><thead><tr><th>Product</th><th>Store</th><th class="num">Price</th><th>Change</th><th class="num">Was</th><th class="num">Lowest</th><th>History</th><th>Stock</th><th>Checked</th></tr></thead><tbody>
${rows.map((r) => `<tr><td class="name"><a href="${h(r.url)}" target="_blank" rel="noopener" title="${h(r.name)}">${h(r.name)}</a>${r.status && r.status !== 'ok' ? ` <span class="tag down" title="${h(r.error)}">${h(r.status)}</span>` : ''}</td><td>${h(r.store)}</td><td class="num">${m(r.price, r.currency)}</td><td>${chg(r.changePct)}</td><td class="num muted">${r.listPrice ? `<s>${m(r.listPrice, r.currency)}</s>` : '—'}</td><td class="num">${m(r.low, r.currency)}</td><td>${sparkline(r.history)}</td><td>${r.inStock == null ? '<span class="muted">?</span>' : r.inStock ? '<span class="up">in stock</span>' : '<span class="down">sold out</span>'}</td><td class="muted">${h(r.checkedAt ? r.checkedAt.replace('T', ' ').slice(0, 16) : 'never')}</td></tr>`).join('')}
</tbody></table></div>
${alerts.length ? `<h2>Recent alerts</h2><div class="card"><table><thead><tr><th>When</th><th>Product</th><th>Alert</th></tr></thead><tbody>
${alerts.map((a) => `<tr><td class="muted">${h(a.created_at.replace('T', ' ').slice(0, 16))}</td><td class="name">${a.url ? `<a href="${h(a.url)}" target="_blank" rel="noopener">${h(a.name || a.store)}</a>` : h(a.name)}</td><td>${h(a.message)}</td></tr>`).join('')}
</tbody></table></div>` : ''}
</div></body></html>`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return file;
}

export async function writeReports(store, { out = 'data/report', formats = ['xlsx', 'html'], sep = ',', days = 90, title } = {}) {
  const rows = buildRows(store, { days });
  const market = buildMarket(rows);
  const alerts = store.listAlerts(200);
  const files = [];
  if (formats.includes('xlsx')) files.push(await writeXlsx(`${out}.xlsx`, rows, market, alerts));
  if (formats.includes('csv')) files.push(writeCsv(`${out}.csv`, rows, sep));
  if (formats.includes('html')) files.push(writeHtml(`${out}.html`, rows, market, alerts.slice(0, 50), { title }));
  if (formats.includes('json')) {
    fs.mkdirSync(path.dirname(`${out}.json`), { recursive: true });
    fs.writeFileSync(`${out}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), products: rows, market, alerts }, null, 2));
    files.push(`${out}.json`);
  }
  return { files, rows, market };
}
