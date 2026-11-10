import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load .env from the working directory, then the project folder (first value wins). */
export async function loadEnv() {
  if (process.env.PRICE_TRACKER_SKIP_DOTENV === '1') return;
  const { config } = await import('dotenv');
  for (const file of [path.resolve('.env'), path.join(ROOT, '.env')]) {
    if (fs.existsSync(file)) config({ path: file, quiet: true });
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);

export const ALL_ALERT_TYPES = [
  'price_drop', 'sale_started', 'target_reached', 'all_time_low', 'undercut',
  'back_in_stock', 'out_of_stock', 'price_increase', 'tracker_failing',
];
const DEFAULT_ALERTS = ALL_ALERT_TYPES.filter((t) => t !== 'price_increase');

export function getSettings(env = process.env) {
  return {
    dbPath: path.resolve(env.DB_PATH || path.join(ROOT, 'data', 'prices.db')),
    cron: env.CHECK_CRON || '0 8 * * *',
    timezone: env.TZ_NAME || env.CHECK_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultCurrency: env.DEFAULT_CURRENCY || 'USD',
    engine: env.ENGINE || 'auto', // auto | http | browser
    concurrency: num(env.CONCURRENCY, 4),
    browserConcurrency: num(env.BROWSER_CONCURRENCY, 2),
    domainDelayMs: num(env.DOMAIN_DELAY_MS, 3000),
    timeoutMs: num(env.REQUEST_TIMEOUT_MS, 25000),
    retries: num(env.RETRIES, 1),
    respectRobots: bool(env.RESPECT_ROBOTS, true),
    headless: env.HEADLESS === 'false' ? false : true,
    chromePath: env.CHROME_PATH || undefined,
    proxyUrl: env.PROXY_URL || undefined,
    debugDir: env.DEBUG_SCREENSHOTS === 'true' ? path.join(ROOT, 'data', 'debug') : null,
    // Alert rules
    alertTypes: list(env.ALERT_TYPES, DEFAULT_ALERTS),
    dropPct: num(env.DROP_PCT, 5),
    dropAmount: num(env.DROP_AMOUNT, 0),
    increasePct: num(env.INCREASE_PCT, 10),
    minSalePct: num(env.MIN_SALE_PCT, 5),
    suspiciousDropPct: num(env.SUSPICIOUS_DROP_PCT, 60),
    alertCooldownHours: num(env.ALERT_COOLDOWN_HOURS, 20),
    failAlertAfter: num(env.FAIL_ALERT_AFTER, 3),
    runSummary: bool(env.RUN_SUMMARY, true),
    // AI extraction fallback (only used when the normal extractors find no price)
    aiExtract: env.AI_EXTRACT !== 'off',
  };
}
