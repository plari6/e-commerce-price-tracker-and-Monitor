// Alert rules. Pure functions: (previous reading, new reading, history stats, product, settings) -> events.
import { formatMoney, pctChange, round2 } from './price.js';

export const LABELS = {
  price_drop: '📉 Price drop',
  sale_started: '🏷️ Discount started',
  target_reached: '🎯 Target price reached',
  all_time_low: '🏆 Lowest price ever recorded',
  undercut: '⚠️ Competitor undercuts your price',
  back_in_stock: '✅ Back in stock',
  out_of_stock: '🚫 Out of stock',
  price_increase: '📈 Price increase',
  tracker_failing: '🛠️ Tracker failing',
};

/**
 * @param {{ product: object, prev: object|null, cur: {price:number, listPrice?:number|null, inStock?:boolean|null, currency?:string},
 *           stats: {low:number|null, count:number}, settings: object }} input
 *   `prev` is the last stored observation row (price, list_price, in_stock 0/1/null); `stats` is computed BEFORE storing `cur`.
 */
export function evaluate({ product, prev, cur, stats, settings }) {
  const events = [];
  const cy = cur.currency || product.currency;
  const m = (n) => formatMoney(n, cy);
  const on = (t) => settings.alertTypes.includes(t);
  const price = cur.price;
  const prevPrice = prev?.price ?? null;

  if (prevPrice != null && price < prevPrice) {
    const pct = round2(((prevPrice - price) / prevPrice) * 100);
    const threshold = product.drop_pct ?? settings.dropPct;
    if (on('price_drop') && (pct >= threshold || (settings.dropAmount > 0 && prevPrice - price >= settings.dropAmount))) {
      events.push({ type: 'price_drop', detail: `−${pct}% (${m(prevPrice)} → ${m(price)}, save ${m(round2(prevPrice - price))})`, pct });
    }
  }
  if (on('price_increase') && prevPrice != null && price > prevPrice) {
    const pct = pctChange(prevPrice, price);
    if (pct >= settings.increasePct) events.push({ type: 'price_increase', detail: `+${pct}% (${m(prevPrice)} → ${m(price)})`, pct });
  }
  if (on('sale_started') && cur.listPrice && cur.listPrice > price) {
    const off = round2(((cur.listPrice - price) / cur.listPrice) * 100);
    const wasOnSale = prev && prev.list_price && prev.list_price > prev.price;
    const deeper = wasOnSale && price < prev.price;
    if (off >= settings.minSalePct && (!wasOnSale || deeper)) {
      events.push({ type: 'sale_started', detail: `${off}% off (was ${m(cur.listPrice)}, now ${m(price)})`, pct: off, ...(deeper ? { label: '🏷️ Deeper discount' } : {}) });
    }
  }
  if (on('target_reached') && product.target_price != null && price <= product.target_price && (prevPrice == null || prevPrice > product.target_price)) {
    events.push({ type: 'target_reached', detail: `${m(price)} ≤ target ${m(product.target_price)}` });
  }
  if (on('all_time_low') && stats.count >= 2 && stats.low != null && price < stats.low) {
    events.push({ type: 'all_time_low', detail: `${m(price)} (previous low ${m(stats.low)} over ${stats.count} checks)` });
  }
  if (on('undercut') && product.own_price != null && price < product.own_price && (prevPrice == null || prevPrice >= product.own_price)) {
    const gap = round2(product.own_price - price);
    events.push({ type: 'undercut', detail: `${m(price)} vs your ${m(product.own_price)}: ${m(gap)} (${round2((gap / product.own_price) * 100)}%) cheaper` });
  }
  if (prev && prev.in_stock === 0 && cur.inStock === true && on('back_in_stock')) {
    events.push({ type: 'back_in_stock', detail: `available again at ${m(price)}` });
  }
  if (prev && prev.in_stock === 1 && cur.inStock === false && on('out_of_stock')) {
    events.push({ type: 'out_of_stock', detail: 'competitor sold out: chance to hold or raise your price' });
  }

  for (const e of events) {
    e.label = e.label || LABELS[e.type];
    e.dedupeKey = ['back_in_stock', 'out_of_stock'].includes(e.type) ? `${product.id}:${e.type}` : `${product.id}:${e.type}:${price}`;
  }
  return events;
}

/** Same SKU sold by several stores: who is cheapest right now, and where you rank. */
export function marketPosition(rows, ownPrice) {
  const priced = rows.filter((r) => r.price != null && r.in_stock !== 0).sort((a, b) => a.price - b.price);
  if (!priced.length) return null;
  const cheapest = priced[0];
  const out = { cheapest: { store: cheapest.store, price: cheapest.price, url: cheapest.url }, competitors: priced.length };
  if (ownPrice != null) {
    out.own = ownPrice;
    out.rank = priced.filter((r) => r.price < ownPrice).length + 1; // 1 = you are the cheapest
    out.gap = round2(ownPrice - cheapest.price);
  }
  return out;
}

/** Plain text used by the console, email and as fallback text for chat apps. */
export function formatAlertText(alert) {
  const { product, events, price, currency, prevPrice, market } = alert;
  const lines = [`${product.name || product.store} (${product.store})`];
  for (const e of events) lines.push(`${e.label}: ${e.detail}`);
  if (prevPrice == null && price != null) lines.push(`Price: ${formatMoney(price, currency)}`);
  if (market?.competitors > 1) {
    let s = `Market: cheapest ${formatMoney(market.cheapest.price, currency)} at ${market.cheapest.store} (in stock at ${market.competitors} stores)`;
    if (market.own != null) s += market.rank === 1 ? ' — you are the cheapest' : ` — you rank #${market.rank} at ${formatMoney(market.own, currency)}`;
    lines.push(s);
  }
  if (alert.verified) lines.push('(big change double-checked with a second scrape)');
  lines.push(product.url);
  return lines.join('\n');
}
