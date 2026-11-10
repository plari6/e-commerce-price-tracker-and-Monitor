// Alert delivery. Every channel is optional and configured by env; a failing channel never stops the others.
import { formatAlertText } from '../alerts.js';
import { formatMoney } from '../price.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function post(url, body, { headers = {}, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res;
}

function summaryText(s) {
  const lines = [`Price check finished: ${s.ok}/${s.checked} products read, ${s.alerts} alert(s), ${s.failed} failed (${Math.round(s.ms / 1000)} s)`];
  for (const c of s.changes.slice(0, 15)) lines.push(`• ${c.name}: ${formatMoney(c.prev, c.currency)} → ${formatMoney(c.price, c.currency)} (${c.pct > 0 ? '+' : ''}${c.pct}%)`);
  if (s.changes.length > 15) lines.push(`… and ${s.changes.length - 15} more changes`);
  for (const f of s.failures.slice(0, 10)) lines.push(`✖ ${f.name}: ${f.error}`);
  return lines.join('\n');
}

export function createChannels(env = process.env, { fetchImpl = fetch, quiet = false, log = console.log } = {}) {
  const channels = [];

  if (!quiet) {
    channels.push({
      name: 'console',
      send: async (a) => log(`\n🔔 ${formatAlertText(a).replace(/\n/g, '\n   ')}`),
      summary: async (s) => log(`\n${summaryText(s)}`),
    });
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const send = (text) => Promise.all(env.TELEGRAM_CHAT_ID.split(',').map((chat) => post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chat.trim(), text, parse_mode: 'HTML', disable_web_page_preview: true,
    }, { fetchImpl })));
    channels.push({
      name: 'telegram',
      send: (a) => send([
        `<b>${esc(a.product.name || a.product.store)}</b> · ${esc(a.product.store)}`,
        ...a.events.map((e) => `${esc(e.label)}: ${esc(e.detail)}`),
        a.market?.competitors > 1 ? `<i>Market: cheapest ${esc(formatMoney(a.market.cheapest.price, a.currency))} at ${esc(a.market.cheapest.store)}${a.market.own != null ? `, you rank #${a.market.rank}` : ''}</i>` : null,
        `<a href="${esc(a.product.url)}">Open product</a>`,
      ].filter(Boolean).join('\n')),
      summary: (s) => send(esc(summaryText(s))),
    });
  }

  if (env.SLACK_WEBHOOK_URL) {
    channels.push({
      name: 'slack',
      send: (a) => post(env.SLACK_WEBHOOK_URL, {
        text: formatAlertText(a),
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*<${a.product.url}|${a.product.name || a.product.store}>* · ${a.product.store}\n${a.events.map((e) => `${e.label}: ${e.detail}`).join('\n')}` } },
          ...(a.market?.competitors > 1 ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `Market: cheapest ${formatMoney(a.market.cheapest.price, a.currency)} at ${a.market.cheapest.store}${a.market.own != null ? ` · you rank #${a.market.rank}` : ''}` }] }] : []),
        ],
      }, { fetchImpl }),
      summary: (s) => post(env.SLACK_WEBHOOK_URL, { text: summaryText(s) }, { fetchImpl }),
    });
  }

  if (env.DISCORD_WEBHOOK_URL) {
    channels.push({
      name: 'discord',
      send: (a) => post(env.DISCORD_WEBHOOK_URL, {
        embeds: [{
          title: (a.product.name || a.product.store).slice(0, 250),
          url: a.product.url,
          description: a.events.map((e) => `**${e.label}**: ${e.detail}`).join('\n'),
          color: a.events.some((e) => ['price_drop', 'sale_started', 'undercut', 'all_time_low'].includes(e.type)) ? 0xe74c3c : 0x3498db,
          footer: { text: a.product.store },
          timestamp: new Date().toISOString(),
        }],
      }, { fetchImpl }),
      summary: (s) => post(env.DISCORD_WEBHOOK_URL, { content: summaryText(s).slice(0, 1900) }, { fetchImpl }),
    });
  }

  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) {
    const mail = (subject, text) => post('https://api.resend.com/emails', {
      from: env.ALERT_EMAIL_FROM || 'Price Tracker <onboarding@resend.dev>',
      to: env.ALERT_EMAIL_TO.split(',').map((s) => s.trim()),
      subject,
      text,
    }, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, fetchImpl });
    channels.push({
      name: 'email',
      send: (a) => mail(`${a.events[0].label}: ${a.product.name || a.product.store}`, formatAlertText(a)),
      summary: (s) => (s.alerts || s.failed ? mail(`Price check: ${s.alerts} alerts, ${s.failed} failed`, summaryText(s)) : null),
    });
  }

  if (env.ALERT_WEBHOOK_URL) {
    // Machine-readable payload for Zapier / Make / n8n / a repricing service.
    const headers = env.ALERT_WEBHOOK_SECRET ? { 'X-Price-Tracker-Secret': env.ALERT_WEBHOOK_SECRET } : {};
    channels.push({
      name: 'webhook',
      send: (a) => post(env.ALERT_WEBHOOK_URL, {
        event: 'price_alert',
        types: a.events.map((e) => e.type),
        product: a.product,
        price: a.price,
        previous_price: a.prevPrice,
        list_price: a.listPrice,
        currency: a.currency,
        in_stock: a.inStock,
        market: a.market,
        events: a.events.map(({ type, detail, pct }) => ({ type, detail, pct })),
        checked_at: a.checkedAt,
      }, { headers, fetchImpl }),
      summary: (s) => post(env.ALERT_WEBHOOK_URL, { event: 'run_summary', ...s }, { headers, fetchImpl }),
    });
  }

  return channels;
}

/** Send to every channel; returns names of the channels that succeeded. */
export async function dispatch(channels, kind, payload, { warn = console.warn } = {}) {
  const ok = [];
  await Promise.all(channels.map(async (c) => {
    try {
      await c[kind](payload);
      ok.push(c.name);
    } catch (err) {
      warn(`[notify] ${c.name} failed: ${err.message}`);
    }
  }));
  return ok;
}
