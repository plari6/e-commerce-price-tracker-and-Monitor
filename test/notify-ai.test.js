import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels, dispatch } from '../src/notify/index.js';
import { aiExtract } from '../src/ai-extract.js';
import { createLLMRouter } from '../src/ai/index.js';

const alert = {
  product: { id: 1, name: 'Earbuds <Pro>', store: 'shop.test', url: 'https://shop.test/e', sku: 'g' },
  events: [{ type: 'price_drop', label: '📉 Price drop', detail: '−20%', pct: 20 }],
  price: 80, prevPrice: 100, currency: 'USD', inStock: true,
  market: { cheapest: { store: 'shop.test', price: 80, url: 'https://shop.test/e' }, competitors: 3, own: 90, rank: 2, gap: 10 },
  checkedAt: '2026-11-10T08:00:00Z',
};

test('every configured channel gets a well-formed request; a failing channel does not stop others', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (url.includes('discord')) return new Response('down', { status: 500 });
    return new Response('{}', { status: 200 });
  };
  const env = {
    TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '111,222', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', DISCORD_WEBHOOK_URL: 'https://discord.test/x',
    RESEND_API_KEY: 'R', ALERT_EMAIL_TO: 'a@b.test', ALERT_WEBHOOK_URL: 'https://hook.test/in', ALERT_WEBHOOK_SECRET: 's3',
  };
  const channels = createChannels(env, { fetchImpl, quiet: true });
  assert.deepEqual(channels.map((c) => c.name), ['telegram', 'slack', 'discord', 'email', 'webhook']);
  const warnings = [];
  const ok = await dispatch(channels, 'send', alert, { warn: (m) => warnings.push(m) });
  assert.deepEqual(ok.sort(), ['email', 'slack', 'telegram', 'webhook']);
  assert.equal(warnings.length, 1);
  const tg = calls.filter((c) => c.url.includes('api.telegram.org'));
  assert.deepEqual(tg.map((c) => c.body.chat_id).sort(), ['111', '222']);
  assert.match(tg[0].body.text, /Earbuds &lt;Pro&gt;/, 'HTML escaped');
  const hook = calls.find((c) => c.url === 'https://hook.test/in');
  assert.deepEqual(hook.body.types, ['price_drop']);
  assert.equal(hook.body.previous_price, 100);
  assert.equal(hook.headers['X-Price-Tracker-Secret'], 's3');
  assert.equal(calls.find((c) => c.url.includes('resend')).headers.Authorization, 'Bearer R');
});

test('no env -> console channel only', () => {
  const lines = [];
  const ch = createChannels({}, { log: (l) => lines.push(l) });
  assert.deepEqual(ch.map((c) => c.name), ['console']);
});

const fakeRouter = (reply) => createLLMRouter({
  chain: [{ provider: 'fake', model: 'm1' }],
  providers: { fake: { configured: true, complete: async () => ({ text: typeof reply === 'string' ? reply : JSON.stringify(reply) }) } },
});
const text = 'Aurora Earbuds Pro. Brand new. Now €1.299,00 (was €1.499,00). Free shipping over €50. In stock.';

test('AI fallback accepts a price that appears on the page', async () => {
  const r = await aiExtract({ text, url: 'https://s.test', currencyHint: 'EUR' }, { ai: fakeRouter({ price: 1299, currency: 'EUR', list_price: 1499, in_stock: true, title: 'Aurora', price_text: '€1.299,00' }) });
  assert.deepEqual([r.price, r.currency, r.listPrice, r.inStock], [1299, 'EUR', 1499, true]);
  assert.match(r.method, /^ai:fake:m1/);
});

test('AI fallback rejects invented prices, bad JSON and total outage', async () => {
  assert.equal(await aiExtract({ text, url: 'https://s.test' }, { ai: fakeRouter({ price: 999, currency: 'EUR' }) }), null);
  assert.equal(await aiExtract({ text, url: 'https://s.test' }, { ai: fakeRouter('not json at all') }), null);
  const down = createLLMRouter({ chain: [{ provider: 'fake', model: 'm' }], providers: { fake: { configured: true, complete: async () => { throw new Error('503'); } } } });
  assert.equal(await aiExtract({ text, url: 'https://s.test' }, { ai: down }), null);
});
