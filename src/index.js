// Library entry: use the tracker from your own code (an Express API, n8n custom node, another bot).
export { openDb } from './db.js';
export { getSettings, loadEnv } from './config.js';
export { scrapeProduct, ScrapeError } from './scraper.js';
export { extractFromHtml, looksBlocked } from './extract/index.js';
export { runCheck } from './monitor.js';
export { evaluate, marketPosition, formatAlertText } from './alerts.js';
export { createChannels, dispatch } from './notify/index.js';
export { writeReports } from './report.js';
export { parsePrice, formatMoney } from './price.js';
export { createBrowserPool } from './fetch/browser.js';
